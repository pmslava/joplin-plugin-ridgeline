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
 *     THIS repo's absolute `.e2e-cache/squashfs-root` path so it can never touch the user's real
 *     desktop Joplin (which runs from /tmp/.mount_*).
 *   - Best-effort in-process teardown on SIGINT / SIGTERM / uncaughtException / process 'exit' that
 *     SIGKILLs each live Joplin process GROUP (spawn uses detached:true), removes its profile, and
 *     releases the lock.
 *   - A soft RAM gate that aborts a local run when memory is too low to launch Joplin safely.
 *
 * The logic is repo-agnostic: every repo-specific path is derived from this file's own location
 * (`<repo>/e2e/guard.ts`), so the three forked harnesses can carry a byte-identical copy of it.
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
//   * the holder removes the directory to release.
const LOCK_DIR = path.join(os.homedir(), '.cache', 'joplin-plugin-e2e.lock');
const LOCK_PID_FILE = path.join(LOCK_DIR, 'pid');
const LOCK_OWNER_FILE = path.join(LOCK_DIR, 'owner');

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
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(`/proc/${name}/cmdline`);
    } catch {
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

function readLockPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(LOCK_PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
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

/** How long the lock directory has existed, or Infinity when it cannot be stat'ed. */
function lockAgeMs(): number {
  try {
    return Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
  } catch {
    return Infinity;
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
  | { status: 'retry' };

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
    // Stale: the holder is gone (crashed / SIGKILLed before its teardown). Break it by RENAMING the
    // directory aside rather than removing it in place — rename(2) succeeds for exactly one process,
    // so two reclaimers racing cannot both conclude they own the lock (the loser gets ENOENT, sees
    // 'retry' and comes back round to a plain mkdir).
    warn(`reclaiming stale E2E lock ${LOCK_DIR} (dead holder ${holder ?? 'unknown'})`);
    const aside = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(LOCK_DIR, aside);
    } catch {
      return { status: 'retry' }; // another process broke it first
    }
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      /* the lock is already gone as far as the protocol is concerned */
    }
    return { status: 'retry' };
  }

  weOwnLock = true;
  try {
    fs.writeFileSync(LOCK_PID_FILE, String(process.pid), 'utf8'); // first: a pid-less lock is ambiguous
    fs.writeFileSync(LOCK_OWNER_FILE, `${REPO_ROOT} since ${new Date().toISOString()}`, 'utf8');
  } catch {
    /* both files are advisory; the directory itself is the lock */
  }
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
      // Each retry means someone (us or another acquirer) just broke a stale lock, so the loop makes
      // progress; the cap only guarantees termination if the lock directory is somehow pathological.
      if (++breaks > 100) {
        throw new Error(`Could not settle the E2E lock ${LOCK_DIR}: it keeps reappearing stale.`);
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
  // Never remove a directory that is no longer ours: if a stale-lock reclaim elsewhere ever took it
  // from us, deleting it would hand a third run the lock a live run is holding.
  const holder = readLockPid();
  if (holder !== null && holder !== process.pid) {
    warn(`E2E lock ${LOCK_DIR} is now held by pid ${holder}; leaving it alone`);
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

/** (a) Kill leftover Joplin processes from a previous dead run of THIS repo's harness. */
function sweepJoplinProcesses(procs: ProcInfo[]): void {
  const self = process.pid;
  const parent = process.ppid;
  for (const p of procs) {
    if (p.pid === self || p.pid === parent) continue; // never target ourselves / our shell
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

async function sweepOrphans(): Promise<void> {
  const procs = listProcesses();
  sweepJoplinProcesses(procs);
  await sweepXvfb(procs);
  sweepProfiles();
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
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
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
