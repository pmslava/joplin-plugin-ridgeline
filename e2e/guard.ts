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
 *     only ONE E2E run may be active at a time.
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
// A directory is used because mkdir is atomic; the pid of the owning run is written inside it.
const LOCK_DIR = path.join(os.homedir(), '.cache', 'joplin-plugin-e2e.lock');
const LOCK_PID_FILE = path.join(LOCK_DIR, 'pid');

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

export function acquireLock(): void {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true }); // ensure ~/.cache exists
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOCK_DIR); // atomic: throws EEXIST if another run holds it
      fs.writeFileSync(LOCK_PID_FILE, String(process.pid), 'utf8');
      weOwnLock = true;
      log(`acquired machine-wide E2E lock ${LOCK_DIR} (pid ${process.pid})`);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLockPid();
      if (holder && holder !== process.pid && pidAlive(holder)) {
        throw new Error(
          `Another Joplin E2E run is active (pid ${holder}); one run machine-wide — resource discipline.\n` +
            `Lock: ${LOCK_DIR}. If you are certain no run is active, remove that directory and retry.`
        );
      }
      // Stale lock (holder dead or pid file unreadable): reclaim it, then retry the atomic create.
      log(`reclaiming stale E2E lock ${LOCK_DIR} (dead holder ${holder ?? 'unknown'})`);
      try {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      } catch {
        /* next mkdir will surface any real problem */
      }
    }
  }
  throw new Error(`Could not acquire E2E lock ${LOCK_DIR} after reclaiming a stale holder.`);
}

export function releaseLock(): void {
  if (!weOwnLock) return;
  try {
    // Only remove a lock we still own — never clobber a newer run that reclaimed a stale lock.
    const holder = readLockPid();
    if (holder === null || holder === process.pid) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      log(`released machine-wide E2E lock ${LOCK_DIR}`);
    }
  } catch {
    /* ignore */
  } finally {
    weOwnLock = false;
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
  acquireLock();
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
