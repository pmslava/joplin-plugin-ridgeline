import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Resource-discipline guard for the real-app Joplin E2E harness.
 *
 * The E2E suite launches a real Joplin desktop (Electron) under Xvfb. Two failure modes have twice
 * collapsed the 16 GiB laptop desktop (2026-08-21):
 *   1. A crashed / SIGKILLed run (e.g. earlyoom) skips Playwright's per-spec `afterAll`, leaking the
 *      Joplin process tree, the Xvfb server, its /tmp/.X<n>-lock, and the throwaway profile dir.
 *   2. Two runs (different repos / worktrees / sessions) each start `xvfb-run playwright test` with no
 *      coordination, stacking multiple real Joplins on 16 GiB of RAM.
 *
 * This module fixes both without touching plugin source:
 *   - A single machine-wide lock (a directory under ~/.cache, shared by all three plugin repos) so
 *     only ONE E2E run may be active at a time; a run that finds the lock held queues behind the
 *     holder instead of failing on the spot.
 *   - A deterministic pre-run orphan sweep that reaps leftovers from previous dead runs, anchored on
 *     THIS repo's absolute `.e2e-cache/squashfs-root` path — and on the process being an orphan —
 *     so it can never touch the user's real desktop Joplin (which runs from /tmp/.mount_*), nor a
 *     LIVE run of this same checkout.
 *   - Best-effort in-process teardown on SIGINT / SIGTERM / uncaughtException / process 'exit' that
 *     SIGKILLs each live Joplin process GROUP (spawn uses detached:true), removes its profile, and
 *     releases the lock.
 *   - A soft RAM gate that aborts a local run when memory is too low to launch Joplin safely.
 *
 * LOCKSTEP: the machine-wide LOCK PROTOCOL below — its constants, its staleness rules and its
 * reclaim sequence — is kept in SEMANTIC lockstep with the sibling harnesses (cockpit / harper /
 * ridgeline); the repos stop excluding each other the moment those semantics diverge. The rest of
 * this file is neither byte-identical nor required to be: the sweeps, the teardown and the logging
 * style have each evolved to fit their own repo.
 *
 * On GitHub runners (CI=true) each repo runs in its own isolated VM, so the lock trivially acquires,
 * the sweep finds nothing, and the RAM gate warns instead of aborting.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
// The extracted Joplin binary tree used by THIS repo's harness. This absolute path is the only thing
// the Joplin sweep matches on — it can never collide with the user's real desktop Joplin, which runs
// from /tmp/.mount_*. Keep in lockstep with e2e/launch.ts.
const EXTRACT_DIR = path.join(REPO_ROOT, '.e2e-cache', 'squashfs-root');
const PROFILES_ROOT = path.join(REPO_ROOT, 'e2e', '.profiles');

// The virtual-display geometry the harness passes to xvfb-run (see package.json "test:e2e"). Used to
// recognise an Xvfb server that belongs to this harness rather than the machine's real X display.
const XVFB_SERVER_ARGS = '-screen 0 1920x1080x24';

// One lock for ALL three plugin repos on this machine (same $HOME), so two runs cannot stack Joplins.
// PROTOCOL — must stay identical in every sibling repo, or the repos stop excluding each other:
//   * the lock is the DIRECTORY below (mkdir is an atomic test-and-set on every filesystem);
//   * the holder writes its pid into `<lock>/pid`; a lock whose pid is not alive is stale and may be
//     reclaimed; `<lock>/owner` is an advisory extra (repo path + start time) a waiter reports and a
//     sibling repo that does not write it is still fully compatible;
//   * the holder removes the directory to release;
//   * a stale lock is broken only from under the reclaim lock below, and only after re-checking the
//     lock directory's identity there — see reclaimStaleLock().
const LOCK_DIR = path.join(os.homedir(), '.cache', 'joplin-plugin-e2e.lock');
const LOCK_PID_FILE = path.join(LOCK_DIR, 'pid');
const LOCK_OWNER_FILE = path.join(LOCK_DIR, 'owner');

/**
 * Reclaim intent lock — the fix for the stale-reclaim race.
 *
 * Breaking a stale lock is a judge-then-rename sequence, and rename(2) is atomic but UNCONDITIONAL:
 * it moves whatever sits at the path, not the incarnation the verdict was formed about. Two
 * acquirers that both judged the SAME stale lock therefore each renamed "the lock" aside, and the
 * loser carried off the winner's freshly created LIVE lock, leaving the path free for a third
 * mkdir — two runs, one lock (reproduced in 20-40% of six-way races).
 *
 * mkdir is the only compare-and-swap a filesystem offers, so the judge-then-rename sequence is
 * serialised behind a SECOND mkdir: only the holder of this directory may break a stale lock, and
 * it re-forms its verdict while holding it.
 *
 * This directory is itself broken by the SAME rename-and-prove sequence, never by an unconditional
 * remove — breaking it the sloppy way would just move the original race down one level. It is
 * breakable only when its holder is dead, or when it never named one and has sat past its TTL: a
 * reclaimer that is merely slow (suspended, blocked on a hung filesystem) is waited out rather than
 * broken, and LOCK_RETRY_CAP bounds that wait with a diagnostic rather than a hang.
 */
const LOCK_RECLAIM_DIR = `${LOCK_DIR}.reclaim`;
const LOCK_RECLAIM_PID_FILE = path.join(LOCK_RECLAIM_DIR, 'pid');
/**
 * How long a reclaim lock that names NO pid may sit before it counts as stranded. It is held for a
 * handful of syscalls and names its holder immediately, so this is four orders of magnitude of
 * headroom. A reclaim lock that DOES name a pid is judged by that pid alone, never by age.
 */
const LOCK_RECLAIM_TTL_MS = 10_000;
/**
 * How many 'retry' rounds acquireLock() tolerates before declaring the lock pathological. A retry
 * costs 50 ms, so this is a 20 s ceiling — deliberately well past LOCK_RECLAIM_TTL_MS, so a reclaim
 * lock stranded pid-less always self-heals before an acquirer gives up on it.
 */
const LOCK_RETRY_CAP = 400;

/**
 * How long to queue behind a live run before giving up (`E2E_LOCK_WAIT_MS` overrides; 0 = fail fast).
 * Two sibling repos are routinely driven from two sessions, and a run that simply waits its turn is
 * worth far more than one that aborts and leaves a human to poll by hand. The budget is added to the
 * suite's globalTimeout locally (see playwright.config.ts), so waiting never eats the suite's time.
 */
export const LOCK_WAIT_MS = resolveLockWaitMs();
const LOCK_POLL_MS = 2_000;
const LOCK_PROGRESS_MS = 30_000;
/**
 * A lock whose `pid` file has not appeared yet is presumed LIVE for this long. The holder writes its
 * pid microseconds after the mkdir, so a pid-less lock is almost always a run that has just this
 * instant taken it — reading that as "stale" would let a second run break a live lock (observed with
 * five acquirers polling in lockstep). Only a pid-less lock older than this is debris.
 */
const LOCK_PID_GRACE_MS = 30_000;

function resolveLockWaitMs(): number {
  const raw = process.env.E2E_LOCK_WAIT_MS;
  if (raw === undefined || raw.trim() === '') return 10 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10 * 60_000;
}

// Abort a local run below this much available memory: a cold Joplin (3.7.x) launch needs headroom.
const RAM_GATE_BYTES = 3 * 1024 * 1024 * 1024; // 3 GiB

// ---------------------------------------------------------------------------------------------------
// Module-local state (per process — guard.ts is imported by both the Playwright main process, via
// globalSetup/globalTeardown, and each test worker, via launch.ts).
// ---------------------------------------------------------------------------------------------------

interface TrackedInstance {
  pid: number;
  profileDir: string;
}

/** Joplin instances spawned by THIS process, for the best-effort signal teardown. */
const liveInstances = new Map<number, TrackedInstance>();

/** True only in the process that currently holds the machine-wide lock (the Playwright main process). */
let weOwnLock = false;

/** The incarnation of LOCK_DIR this process created; see incarnationOf() and releaseLock(). */
let ourLockIncarnation: string | null = null;

/** The incarnation of LOCK_RECLAIM_DIR this process took; see releaseReclaimLock(). */
let ourReclaimIncarnation: string | null = null;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[e2e-guard] ${msg}`);
}

function warn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[e2e-guard] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------------
// /proc inspection (Linux-only; the harness only ever runs on Linux under Xvfb).
// ---------------------------------------------------------------------------------------------------

interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  /** Full argv joined with single spaces. */
  cmdline: string;
  /** Individual argv entries (NUL-split). */
  args: string[];
}

function listProcesses(): ProcInfo[] {
  const out: ProcInfo[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return out; // no /proc (non-Linux) — nothing to sweep
  }
  // A process that exits between readdir and read is routine and silent; a permission denial is
  // not — it means the sweep is BLIND to that process, so it is counted and reported once per
  // sweep rather than per entry.
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(`/proc/${name}/cmdline`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') procDenied++;
      continue; // process exited between readdir and read, or unreadable
    }
    if (raw.length === 0) continue; // kernel thread (no cmdline)
    const args = raw.toString('utf8').split('\0').filter((s) => s.length > 0);
    const cmdline = args.join(' ');
    let ppid = -1;
    let comm = '';
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // The comm field is wrapped in parens and can itself contain spaces or ')', so slice between the
      // first '(' and the LAST ')'. ppid is the 2nd field after the closing paren (state is the 1st).
      const open = stat.indexOf('(');
      const close = stat.lastIndexOf(')');
      if (open >= 0 && close > open) {
        comm = stat.slice(open + 1, close);
        const rest = stat.slice(close + 2).trim().split(/\s+/);
        ppid = Number(rest[1]);
      }
    } catch {
      /* stat vanished — leave ppid/comm at defaults */
    }
    out.push({ pid, ppid, comm, cmdline, args });
  }
  return out;
}

/**
 * /proc entries this sweep could not read for lack of permission. Module-scoped and reported ONCE
 * per sweep by reportProcDenied() rather than once per scan (let alone once per entry).
 */
let procDenied = 0;

/** One summary line per sweep rather than per-entry noise. Resets the counter. */
function reportProcDenied(): void {
  if (procDenied === 0) return;
  const n = procDenied;
  procDenied = 0;
  warn(
    `could not read ${n} /proc entr${n === 1 ? 'y' : 'ies'} (permission denied): leftover E2E ` +
      `processes owned by another user, or hidden by a hidepid mount, are invisible to the sweep`
  );
}

/** A process is "gone" when its /proc entry is absent or it is a zombie/dead awaiting reap. */
function isProcessGone(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const state = stat.slice(close + 2).trim()[0];
    return state === 'Z' || state === 'X' || state === 'x';
  } catch {
    return true; // /proc entry gone
  }
}

function waitGone(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (isProcessGone(pid) || Date.now() - start > timeoutMs) resolve();
      else setTimeout(tick, 100);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------------------------------
// (1) Machine-wide lock.
// ---------------------------------------------------------------------------------------------------

/** Parse a pid file written by the lock protocol: null when absent, empty or not a pid. */
function readPidFile(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readLockPid(): number | null {
  return readPidFile(LOCK_PID_FILE);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but we may not signal it — still alive for our purposes.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When a lock directory was created. NOT mtime: writing `pid` and `owner` INTO the directory updates
 * its mtime, so an mtime-derived age silently resets the pid grace below. btime is stamped once at
 * mkdir and no later write moves it (verified on this machine's btrfs $HOME and on tmpfs).
 * Filesystems that record no btime report 0 or the epoch; there we fall back to mtime, which is the
 * behaviour this guard has always had.
 */
function createdMs(st: fs.Stats): number {
  const birth = st.birthtimeMs;
  return birth > 0 && birth <= Date.now() + 1_000 ? birth : st.mtimeMs;
}

/** How long the lock directory has existed, or Infinity when it cannot be stat'ed. */
function lockAgeMs(): number {
  try {
    return Date.now() - createdMs(fs.statSync(LOCK_DIR));
  } catch {
    return Infinity;
  }
}

/**
 * A token identifying one INCARNATION of a lock directory, so a reclaim can prove that what it
 * carried off is the same directory its verdict was formed about. Inode numbers are recycled after
 * a delete, so the creation timestamp is folded in: two incarnations would have to share a device,
 * an inode AND a sub-millisecond birth time to be confused. rename(2) preserves all three, so the
 * token survives the move aside.
 */
function incarnationOf(dir: string): string | null {
  try {
    const st = fs.statSync(dir);
    return `${st.dev}:${st.ino}:${createdMs(st)}`;
  } catch {
    return null;
  }
}

/** The holder's advisory description ("<repo> since <time>"), or null when it wrote none. */
function readLockOwner(): string | null {
  try {
    const owner = fs.readFileSync(LOCK_OWNER_FILE, 'utf8').trim();
    return owner.length > 0 ? owner : null;
  } catch {
    return null;
  }
}

function describeHolder(pid: number | null, owner: string | null): string {
  const who = pid === null ? 'unknown pid' : `pid ${pid}`;
  return owner ? `${who}, ${owner}` : who;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins > 0 ? `${mins}m${String(secs).padStart(2, '0')}s` : `${secs}s`;
}

type LockAttempt =
  | { status: 'acquired' }
  /** A live run holds the lock; the caller decides whether to wait. */
  | { status: 'held'; pid: number | null; owner: string | null }
  /** A stale lock was broken, or another process won a race — retry immediately. */
  /** `contended` = another acquirer holds the reclaim lock; `broke` = a stale lock was broken. */
  | { status: 'retry'; reason: 'broke' | 'contended' };

/**
 * True when the reclaim lock was left behind by a process that died mid-reclaim.
 *
 * The pid decides FIRST, and a live pid decides outright: a reclaimer that has stalled — suspended,
 * blocked on a hung filesystem — is slow, not dead, and breaking its intent lock would put two
 * reclaimers back into the sequence this lock exists to serialise. Age is consulted ONLY for a lock
 * that names no pid at all, where it is the only way to tell "created a microsecond ago" from
 * "created by a process that died before it could write".
 */
function reclaimLockIsStranded(): boolean {
  const pid = readPidFile(LOCK_RECLAIM_PID_FILE);
  if (pid !== null) return !pidAlive(pid);
  let ageMs: number;
  try {
    ageMs = Date.now() - createdMs(fs.statSync(LOCK_RECLAIM_DIR));
  } catch {
    return false; // already gone; the caller's next mkdir settles it
  }
  return ageMs >= LOCK_RECLAIM_TTL_MS;
}

/**
 * Take the reclaim intent lock, or report that another acquirer is already breaking the lock.
 *
 * Breaking a STRANDED intent lock is the same hazard one level down, so it is broken the same way
 * the outer lock is: rename the judged incarnation aside, then prove that what was carried off is
 * the incarnation the verdict was formed about. Two acquirers that both judged the same stranded
 * lock cannot therefore both end up holding it — the one whose rename carried off the other's fresh
 * intent lock puts it back and returns false.
 *
 * Once this returns true the caller's exclusivity is self-sustaining: the directory names a LIVE
 * pid, and reclaimLockIsStranded() above never reports a live-pid lock as stranded, so no other
 * acquirer may legitimately break it. The only opening is the instant between the mkdir and the pid
 * write, which the read-back below closes: a holder whose incarnation is no longer at the path lost
 * it during that instant, and is told so rather than proceeding.
 */
function tryTakeReclaimLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOCK_RECLAIM_DIR); // the second compare-and-swap; this one serialises reclaimers
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt > 0) return false; // someone re-took it the instant we cleared it
      const judged = incarnationOf(LOCK_RECLAIM_DIR);
      if (judged === null) continue; // it vanished; go straight back to the mkdir
      if (!reclaimLockIsStranded()) return false;
      warn(`clearing a stranded E2E reclaim lock ${LOCK_RECLAIM_DIR}`);
      const aside = `${LOCK_RECLAIM_DIR}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(LOCK_RECLAIM_DIR, aside);
      } catch {
        return false; // someone broke it first
      }
      const moved = incarnationOf(aside);
      if (moved !== null && moved !== judged) {
        // We carried off an intent lock created AFTER our verdict — someone else broke the stranded
        // one and took it. Put it back and lose deliberately, saying so: a reclaimer that stands
        // down silently is indistinguishable from one that never tried.
        warn(
          `another acquirer took the E2E reclaim lock ${LOCK_RECLAIM_DIR} first; putting its lock ` +
            `back and standing down`
        );
        try {
          fs.renameSync(aside, LOCK_RECLAIM_DIR);
        } catch (err2) {
          warn(`could not restore an E2E reclaim lock: ${(err2 as Error).message}; it is at ${aside}`);
        }
        return false;
      }
      try {
        fs.rmSync(aside, { recursive: true, force: true });
      } catch {
        /* debris only; sweepLockDebris() removes it */
      }
      continue;
    }
    try {
      fs.writeFileSync(LOCK_RECLAIM_PID_FILE, String(process.pid), 'utf8');
    } catch {
      /* the read-back below turns a failed write into a clean loss, never a silent hold */
    }
    // Read back the PID FILE, not the incarnation. The incarnation token is derived from the
    // directory's creation time, and on a filesystem that records no btime that falls back to
    // mtime — which the write above has just moved, so the comparison could never match and every
    // acquirer would spin out its retry budget. The pid is stable on every filesystem and answers
    // the same question: did anyone break our lock in the instant before it named us? A lock that
    // was broken and retaken names someone else; one broken and not yet retaken names nobody.
    if (readPidFile(LOCK_RECLAIM_PID_FILE) !== process.pid) {
      warn(`lost the E2E reclaim lock ${LOCK_RECLAIM_DIR} before it named us; retrying`);
      return false;
    }
    // AFTER the write, for the same reason the outer lock's token is taken after its writes.
    ourReclaimIncarnation = incarnationOf(LOCK_RECLAIM_DIR);
    return true;
  }
  return false;
}

/** Release the reclaim intent lock — but only the incarnation this process actually took. */
function releaseReclaimLock(): void {
  const ours = ourReclaimIncarnation;
  ourReclaimIncarnation = null;
  // Never remove an intent lock that is not ours: if ours was broken while we held it, removing
  // what replaced it would hand a third reclaimer the sequence its holder is still inside.
  const holder = readPidFile(LOCK_RECLAIM_PID_FILE);
  if (holder !== null && holder !== process.pid) return;
  const current = incarnationOf(LOCK_RECLAIM_DIR);
  if (ours !== null && current !== null && current !== ours) return;
  try {
    fs.rmSync(LOCK_RECLAIM_DIR, { recursive: true, force: true });
  } catch {
    /* the next sweep removes anything we fail to remove */
  }
}

/**
 * Break a lock whose holder is gone. Runs under the reclaim intent lock and re-forms its verdict
 * THERE: a verdict reached before the intent lock was taken is worthless, because that interval is
 * exactly when another reclaimer can have broken the lock and a third acquirer taken it. While we
 * hold the intent lock no one else may rename the lock aside, and the dead holder cannot release
 * it, so the directory at LOCK_DIR cannot change identity between the verdict and the rename.
 */
function reclaimStaleLock(): LockAttempt {
  if (!tryTakeReclaimLock()) return { status: 'retry', reason: 'contended' };
  try {
    // The incarnation the verdict below belongs to.
    const judged = incarnationOf(LOCK_DIR);
    if (judged === null) return { status: 'retry', reason: 'broke' }; // gone already — go race the plain mkdir

    const holder = readLockPid();
    if (holder !== null && pidAlive(holder)) {
      return { status: 'held', pid: holder, owner: readLockOwner() };
    }
    if (holder === null && lockAgeMs() < LOCK_PID_GRACE_MS) {
      return { status: 'held', pid: null, owner: null };
    }

    // Stale: the holder is gone (crashed / SIGKILLed before its teardown). Break it by RENAMING the
    // directory aside rather than removing it in place, so the lock disappears in ONE step and no
    // acquirer ever sees a half-emptied lock directory.
    warn(`reclaiming stale E2E lock ${LOCK_DIR} (dead holder ${holder ?? 'unknown'})`);
    const aside = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(LOCK_DIR, aside);
    } catch {
      return { status: 'retry', reason: 'broke' }; // it vanished under us; the plain mkdir will settle it
    }
    // rename(2) is atomic but unconditional, so prove what we carried off IS the incarnation judged
    // above. Unreachable while the intent lock holds; kept because the cost of being wrong is two
    // concurrent runs, and because it also covers a lock removed out of protocol (a human, a stray
    // rm) and re-created in the same instant.
    const moved = incarnationOf(aside);
    if (moved !== null && moved !== judged) {
      warn(
        `E2E lock ${LOCK_DIR} changed identity mid-reclaim (${judged} -> ${moved}); putting it ` +
          `back and treating it as live`
      );
      try {
        fs.renameSync(aside, LOCK_DIR);
      } catch (err) {
        warn(`could not restore the E2E lock: ${(err as Error).message}; it is at ${aside}`);
      }
      return { status: 'held', pid: readLockPid(), owner: readLockOwner() };
    }
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      // Debris only: the lock is gone as far as the protocol is concerned, and the pre-run sweep
      // (sweepLockDebris) removes what is left behind.
    }
    return { status: 'retry', reason: 'broke' };
  } finally {
    releaseReclaimLock();
  }
}

/** One atomic attempt at the lock. Never blocks: the waiting policy lives in acquireLock(). */
function tryTakeLock(): LockAttempt {
  try {
    fs.mkdirSync(LOCK_DIR); // atomic test-and-set: throws EEXIST if the lock is held
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const holder = readLockPid();
    if (holder !== null && pidAlive(holder)) {
      return { status: 'held', pid: holder, owner: readLockOwner() };
    }
    if (holder === null && lockAgeMs() < LOCK_PID_GRACE_MS) {
      // The lock exists but names no pid yet: whoever won the mkdir a moment ago is about to write
      // it. Treat that as held — breaking it here is exactly how two runs both end up "owning" it.
      return { status: 'held', pid: null, owner: null };
    }
    // Looks stale — but this verdict is only a fast path that decides whether to go for the reclaim
    // lock at all. The verdict that is ACTED on is re-formed under it.
    return reclaimStaleLock();
  }

  weOwnLock = true;
  try {
    fs.writeFileSync(LOCK_PID_FILE, String(process.pid), 'utf8'); // first: a pid-less lock is ambiguous
    fs.writeFileSync(LOCK_OWNER_FILE, `${REPO_ROOT} since ${new Date().toISOString()}`, 'utf8');
  } catch (err) {
    // A lock that names no pid is protected only by LOCK_PID_GRACE_MS; past that, any acquirer may
    // reclaim it while this run is still going. Give the lock back and fail the acquire rather than
    // run a real Joplin under a lock that expires underneath it.
    releaseLock();
    throw new Error(
      `Took the machine-wide E2E lock ${LOCK_DIR} but could not record ownership in it: ` +
        `${(err as Error).message}\nThe lock has been released. Check that ` +
        `${path.dirname(LOCK_DIR)} is writable and has free space, then retry.`
    );
  }
  // AFTER the writes, never before. On a filesystem that reports no btime, createdMs() falls back
  // to mtime — and writing `pid` and `owner` INTO the directory changes its mtime, so a token taken
  // before them is one this process could never match again, and releaseLock() would refuse to
  // remove its OWN lock on every single run. On a btime filesystem this ordering is a no-op.
  ourLockIncarnation = incarnationOf(LOCK_DIR);
  return { status: 'acquired' };
}

/**
 * Acquire the machine-wide lock, queueing behind a live run rather than failing on the spot: two
 * sibling repos are routinely driven from two sessions, and the point of the lock is to serialise
 * them, not to make a human poll. A stale lock left by a dead run is reclaimed at once. Gives up
 * after LOCK_WAIT_MS with an error that names the holder. Must be called before anything spawns.
 */
export async function acquireLock(): Promise<void> {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true }); // ensure ~/.cache exists
  const startedAt = Date.now();
  const deadline = startedAt + LOCK_WAIT_MS;
  let announced = false;
  let lastProgress = startedAt;
  let breaks = 0;

  for (;;) {
    const attempt = tryTakeLock();
    if (attempt.status === 'acquired') {
      const waited = Date.now() - startedAt;
      log(
        `acquired machine-wide E2E lock ${LOCK_DIR} (pid ${process.pid})` +
          (announced ? ` after waiting ${formatDuration(waited)}` : '')
      );
      return;
    }
    if (attempt.status === 'retry') {
      // A retry means someone just broke a stale lock, or another acquirer is mid-reclaim; either
      // way the loop makes progress. The cap only guarantees termination if the lock directory is
      // somehow pathological.
      if (++breaks > LOCK_RETRY_CAP) {
        // Two very different outcomes share this cap. A reclaim lock held by a LIVE process is now
        // waited out by design rather than broken, so hitting the cap that way is not corruption —
        // it is one wedged reclaimer, and saying "keeps reappearing stale" would send the reader
        // hunting for the wrong thing.
        throw new Error(
          attempt.reason === 'contended'
            ? `Could not settle the E2E lock ${LOCK_DIR}: another acquirer has held the reclaim ` +
              `lock ${LOCK_RECLAIM_DIR} for ${formatDuration(Date.now() - startedAt)} without ` +
              `finishing, and its process is still alive, so it is being waited out rather than ` +
              `broken. If that process is genuinely wedged, end it (or remove that directory) and ` +
              `retry.`
            : `Could not settle the E2E lock ${LOCK_DIR}: it keeps reappearing stale.`
        );
      }
      await sleep(50);
      continue;
    }

    const holder = describeHolder(attempt.pid, attempt.owner);
    if (LOCK_WAIT_MS === 0) {
      throw new Error(
        `Another Joplin E2E run is active (${holder}); one run machine-wide — resource discipline.\n` +
          `Lock: ${LOCK_DIR}\nUnset E2E_LOCK_WAIT_MS=0 to queue behind it instead.`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Another Joplin E2E run is STILL active after waiting ` +
          `${formatDuration(Date.now() - startedAt)} (${holder}); one run machine-wide — resource ` +
          `discipline.\nLock: ${LOCK_DIR}\nRetry once that run finishes, raise the budget with ` +
          `E2E_LOCK_WAIT_MS=<ms>, or — only if you are certain no run is active — remove that ` +
          `directory.`
      );
    }
    if (!announced) {
      announced = true;
      lastProgress = Date.now();
      log(
        `machine-wide E2E lock is held by a live run (${holder}); one run machine-wide — waiting ` +
          `up to ${formatDuration(LOCK_WAIT_MS)} for it to finish (E2E_LOCK_WAIT_MS to change).`
      );
    } else if (Date.now() - lastProgress >= LOCK_PROGRESS_MS) {
      lastProgress = Date.now();
      log(
        `still waiting for the E2E lock — ${formatDuration(Date.now() - startedAt)} elapsed, ` +
          `${formatDuration(deadline - Date.now())} left (holder ${holder} is alive)`
      );
    }
    await sleep(LOCK_POLL_MS);
  }
}

/** Release the machine-wide lock, but only if this process owns it. Safe to call repeatedly. */
export function releaseLock(): void {
  if (!weOwnLock) return;
  weOwnLock = false;
  const ours = ourLockIncarnation;
  ourLockIncarnation = null;
  // Never remove a directory that is no longer ours: if a stale-lock reclaim elsewhere ever took it
  // from us, deleting it would hand a third run the lock a live run is holding. Two independent
  // checks — the pid the directory names, and the incarnation we created (which also catches a
  // successor that has not written its pid yet).
  const holder = readLockPid();
  if (holder !== null && holder !== process.pid) {
    warn(`E2E lock ${LOCK_DIR} is now held by pid ${holder}; leaving it alone`);
    return;
  }
  const current = incarnationOf(LOCK_DIR);
  if (ours !== null && current !== null && current !== ours) {
    warn(`E2E lock ${LOCK_DIR} is a newer incarnation than the one we took; leaving it alone`);
    return;
  }
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    log(`released machine-wide E2E lock ${LOCK_DIR}`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------------
// (2) Pre-run orphan sweep.
// ---------------------------------------------------------------------------------------------------

/**
 * (a) Kill ORPHANED leftover Joplin processes from a previous dead run of THIS repo's harness. Both
 * conditions matter, and the orphan one is not redundant: the path alone also matches a CONCURRENT
 * run of this same checkout, so if the machine-wide lock were ever lost — or a sibling worktree on
 * an older protocol raced it — a second run would SIGKILL the first run's live Joplin tree mid-test.
 * A live run's Joplin has a live Playwright worker for a parent; only a run that died leaves its
 * Joplin reparented to init. Same condition sweepXvfb() below has always used.
 */
function sweepJoplinProcesses(procs: ProcInfo[]): void {
  const self = process.pid;
  const parent = process.ppid;
  for (const p of procs) {
    if (p.pid === self || p.pid === parent) continue; // never target ourselves / our shell
    if (p.ppid !== 1) continue; // only orphans; a live run's Joplin has a live parent
    // Anchor strictly on this repo's extracted-binary path. The real desktop Joplin (/tmp/.mount_*)
    // and this repo's own node/playwright process can never contain this substring.
    if (!p.cmdline.includes(EXTRACT_DIR)) continue;
    try {
      process.kill(p.pid, 'SIGKILL');
      log(`swept leftover Joplin process pid=${p.pid} (${p.comm || 'unknown'})`);
    } catch {
      /* already gone */
    }
  }
}

/**
 * (b) Kill orphaned Xvfb servers (reparented to init, PPID 1) that carry THIS harness's server-args,
 * then remove /tmp/.X<n>-lock only for displays whose Xvfb is confirmed dead. The machine's real X
 * display (:0) is an Xorg process with different args and is never matched, so its lock is untouched.
 */
async function sweepXvfb(procs: ProcInfo[]): Promise<void> {
  const killed: Array<{ pid: number; display: number }> = [];
  for (const p of procs) {
    if (p.comm !== 'Xvfb') continue;
    if (p.ppid !== 1) continue; // only orphans reparented to init
    if (!p.cmdline.includes(XVFB_SERVER_ARGS)) continue;
    const displayArg = p.args.find((a) => /^:\d+$/.test(a));
    const display = displayArg ? Number(displayArg.slice(1)) : NaN;
    try {
      process.kill(p.pid, 'SIGKILL');
      log(`swept orphaned Xvfb pid=${p.pid} display=${displayArg ?? '?'}`);
    } catch {
      /* already gone */
    }
    if (Number.isInteger(display)) killed.push({ pid: p.pid, display });
  }
  for (const { pid, display } of killed) {
    await waitGone(pid, 3000);
    if (!isProcessGone(pid)) continue; // still alive somehow — leave its lock in place
    const lockPath = `/tmp/.X${display}-lock`;
    try {
      fs.rmSync(lockPath, { force: true });
      log(`removed stale ${lockPath} (Xvfb confirmed dead)`);
    } catch {
      /* ignore */
    }
  }
}

/** (c) Remove stale throwaway profile dirs left by previous dead runs. */
function sweepProfiles(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(PROFILES_ROOT);
  } catch {
    return; // no profiles dir yet
  }
  for (const name of entries) {
    if (!name.startsWith('profile-')) continue;
    const dir = path.join(PROFILES_ROOT, name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`removed stale profile dir ${dir}`);
    } catch (err) {
      log(`could not remove stale profile dir ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * (d) Remove lock debris beside the lock: `<lock>.stale-<pid>-<ts>` directories a reclaim moved
 * aside but failed to delete, and a reclaim intent lock stranded by a process that died mid-break.
 * Both are inert, but nothing else ever removes them, so they accumulate in ~/.cache.
 */
function sweepLockDebris(): void {
  const parent = path.dirname(LOCK_DIR);
  const base = path.basename(LOCK_DIR);
  // Both kinds of rename-aside debris: from breaking the lock, and from breaking the intent lock.
  const stalePrefixes = [`${base}.stale-`, `${base}.reclaim.stale-`];
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!stalePrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const debris = path.join(parent, name);
    try {
      fs.rmSync(debris, { recursive: true, force: true });
      log(`removed stale-lock debris ${debris}`);
    } catch (err) {
      warn(`could not remove stale-lock debris ${debris}: ${(err as Error).message}`);
    }
  }
  // We hold the lock, so no legitimate reclaim can be in flight: a reclaim lock here is debris.
  if (reclaimLockIsStranded()) {
    try {
      fs.rmSync(LOCK_RECLAIM_DIR, { recursive: true, force: true });
      log(`removed stranded E2E reclaim lock ${LOCK_RECLAIM_DIR}`);
    } catch {
      /* its TTL still bounds it */
    }
  }
}

async function sweepOrphans(): Promise<void> {
  const procs = listProcesses();
  sweepJoplinProcesses(procs);
  await sweepXvfb(procs);
  sweepProfiles();
  sweepLockDebris();
  reportProcDenied();
}

// ---------------------------------------------------------------------------------------------------
// (4) Soft RAM gate.
// ---------------------------------------------------------------------------------------------------

function readMemAvailableBytes(): number | null {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s*kB/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export function ramGate(): void {
  const avail = readMemAvailableBytes();
  if (avail === null) {
    log('RAM gate: could not read MemAvailable from /proc/meminfo — skipping.');
    return;
  }
  const availGiB = (avail / 1024 / 1024 / 1024).toFixed(2);
  if (avail >= RAM_GATE_BYTES) {
    log(`RAM gate: ${availGiB} GiB available — OK.`);
    return;
  }
  const msg =
    `Low memory: only ${availGiB} GiB available (< 3 GiB). A cold Joplin E2E launch needs headroom; ` +
    `starting one now risks the desktop collapses seen on 2026-08-21.`;
  if (process.env.CI || process.env.E2E_IGNORE_RAM) {
    log(`RAM gate WARNING (continuing — ${process.env.CI ? 'CI' : 'E2E_IGNORE_RAM'} set): ${msg}`);
    return;
  }
  throw new Error(`${msg}\nClose apps and retry, or set E2E_IGNORE_RAM=1 to override (resource discipline).`);
}

// ---------------------------------------------------------------------------------------------------
// (3) Best-effort in-process teardown.
// ---------------------------------------------------------------------------------------------------

/** Called by launch.ts right after spawning a Joplin so a crash/signal can still reap it. */
export function registerInstance(child: ChildProcess, profileDir: string): void {
  if (typeof child.pid === 'number') liveInstances.set(child.pid, { pid: child.pid, profileDir });
}

/** Called by launch.ts once a Joplin has been closed the happy-path way (prevents pid-reuse hazards). */
export function unregisterInstance(child: ChildProcess): void {
  if (typeof child.pid === 'number') liveInstances.delete(child.pid);
}

let cleanupDone = false;

/** Synchronous so it is safe from the process 'exit' handler. */
function emergencyCleanup(): void {
  if (cleanupDone) return;
  cleanupDone = true;
  for (const inst of liveInstances.values()) {
    // Negative pid targets the whole process group. spawn used detached:true, so the Joplin main is a
    // group leader and this reaps its renderer/gpu/zygote children too.
    try {
      process.kill(-inst.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(inst.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(inst.profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  liveInstances.clear();
  releaseLock();
}

let handlersInstalled = false;

function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', () => emergencyCleanup());
  // SIGHUP alongside SIGINT/SIGTERM: a run started from a terminal that is then closed (or an SSH
  // session that drops) is hung up, not interrupted, and would otherwise leak its Joplin tree.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      emergencyCleanup();
      process.exit(1);
    });
  }
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[e2e-guard] uncaughtException — running emergency cleanup:', err);
    emergencyCleanup();
    process.exit(1);
  });
}

// Install handlers as soon as this module is loaded, in whichever process loaded it (main or worker).
installSignalHandlers();

// ---------------------------------------------------------------------------------------------------
// Playwright global hooks (wired from playwright.config.ts).
// ---------------------------------------------------------------------------------------------------

export async function globalSetup(): Promise<void> {
  log('globalSetup: acquiring lock, sweeping orphans, checking RAM');
  // Waits out a live run (E2E_LOCK_WAIT_MS, default 10 min); throws only if it never gets the lock.
  await acquireLock();
  try {
    await sweepOrphans();
    ramGate();
  } catch (err) {
    // Anything after acquiring the lock must not leak it (globalTeardown does not run if setup throws).
    releaseLock();
    throw err;
  }
}

export async function globalTeardown(): Promise<void> {
  log('globalTeardown: releasing lock');
  releaseLock();
}
