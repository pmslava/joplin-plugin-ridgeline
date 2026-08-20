import { chromium, Browser, Page } from 'playwright';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';

/**
 * Launch a real Joplin desktop (Electron) instance with the Ridgeline plugin loaded as a
 * development plugin, against a throwaway profile, and drive it with Playwright over CDP.
 *
 * Adapted from joplin-plugin-cockpit's harness. Why CDP instead of Playwright's `_electron.launch`:
 * Joplin rejects unknown process flags (Playwright injects `--inspect=0`), so we spawn Joplin
 * ourselves with only Chromium-consumed flags + `--remote-debugging-port`, then attach via
 * `chromium.connectOverCDP`. This drives Joplin's own bundled Electron — no browser download.
 *
 * The Joplin AppImage is downloaded + extracted by `scripts/setup-e2e.sh` into
 * `.e2e-cache/squashfs-root/`.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.e2e-cache');
const EXTRACT_DIR = path.join(CACHE_DIR, 'squashfs-root');
const JOPLIN_BINARY = path.join(EXTRACT_DIR, 'joplin');
const PLUGIN_DIST = path.join(REPO_ROOT, 'dist');

// Must match src/manifest.json. Joplin embeds it in plugin webview URLs and in File-storage setting
// keys (plugin-<id>.<key>), which the harness seeds to exercise the `side`/`mode` settings.
export const PLUGIN_ID = 'io.github.pmslava.ridgeline';

export interface JoplinInstance {
  browser: Browser;
  child: ChildProcess;
  /** The main Joplin window (renderer page). */
  win: Page;
  profileDir: string;
  port: number;
}

/** Plugin settings to seed into a profile's settings.json (File-storage keys). */
export interface SeedSettings {
  side?: 'left' | 'right';
  editorMode?: 'overlay' | 'reserve';
  viewerMode?: 'overlay' | 'reserve';
  maxDepth?: number;
}

export function assertE2EReady(): void {
  if (!fs.existsSync(JOPLIN_BINARY)) {
    throw new Error(
      `Joplin binary not found at ${JOPLIN_BINARY}.\n` +
        `Run "npm run setup:e2e" first to download and extract the Joplin AppImage.`
    );
  }
  if (!fs.existsSync(path.join(PLUGIN_DIST, 'manifest.json'))) {
    throw new Error(`Built plugin not found at ${PLUGIN_DIST}.\nRun "npm run dist" first.`);
  }
}

/**
 * Create a fresh, isolated Joplin profile that loads this plugin from ./dist. Optionally seed
 * Ridgeline's File-storage settings so a launch starts with e.g. side=right or reserve mode — these
 * are read by the plugin at startup exactly as a user-set value would be.
 */
export function createProfile(loadPlugin = true, seed: SeedSettings = {}): string {
  const profilesRoot = path.join(REPO_ROOT, 'e2e', '.profiles');
  fs.mkdirSync(profilesRoot, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(profilesRoot, 'profile-'));

  const settings: Record<string, unknown> = {
    'welcome.enabled': false,
    'autoUpdateEnabled': false,
    'locale': 'en_GB',
    'sync.target': 0,
    // Match the user's real desktop: the Markdown editor renders markup inline (hidden `#` marks on
    // heading lines, with the editor compensating). This is Joplin's default (true) but is seeded
    // explicitly so the suite is pinned to the environment that surfaces the heading-indentation
    // regression (R8) regardless of any future default change. File storage, top-level key.
    'editor.inlineRendering': true,
  };
  if (loadPlugin) settings['plugins.devPluginPaths'] = PLUGIN_DIST;

  // Ridgeline settings are registered with SettingStorage.File, so keys written here under the
  // plugin namespace are loaded by Joplin at startup.
  const prefix = `plugin-${PLUGIN_ID}.`;
  if (seed.side) settings[`${prefix}side`] = seed.side;
  if (seed.editorMode) settings[`${prefix}editorMode`] = seed.editorMode;
  if (seed.viewerMode) settings[`${prefix}viewerMode`] = seed.viewerMode;
  if (seed.maxDepth != null) settings[`${prefix}maxDepth`] = seed.maxDepth;

  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  return profileDir;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForCDP(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() - start > timeoutMs) reject(new Error('Joplin CDP endpoint never came up'));
          else setTimeout(tick, 500);
        });
    };
    tick();
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
  });
}

export async function launchJoplin(
  opts: { loadPlugin?: boolean; profileDir?: string; seed?: SeedSettings } = {}
): Promise<JoplinInstance> {
  const { loadPlugin = true, seed = {} } = opts;
  assertE2EReady();
  const profileDir = opts.profileDir ?? createProfile(loadPlugin, seed);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await startInstance(profileDir);
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-console
      console.warn(`Joplin failed to start (attempt ${attempt}/3):`, (error as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastError;
}

async function startInstance(profileDir: string): Promise<JoplinInstance> {
  const port = await getFreePort();

  const child = spawn(
    JOPLIN_BINARY,
    ['--profile', profileDir, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`],
    {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${EXTRACT_DIR}:${path.join(EXTRACT_DIR, 'usr', 'lib')}:${
          process.env.LD_LIBRARY_PATH ?? ''
        }`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  try {
    await waitForCDP(port, 90_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const win = await findMainWindow(browser, 60_000);
    await waitForJoplinReady(win);
    return { browser, child, win, profileDir, port };
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await waitForExit(child, 10_000);
    throw error;
  }
}

async function findMainWindow(browser: Browser, timeoutMs: number): Promise<Page> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().includes('index.html')) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Could not find the Joplin main window via CDP');
}

/**
 * Find a secondary Joplin window (opened via openNoteInNewWindow). Joplin opens these with
 * window.open('about:blank') and renders the editor into them via a React portal, so they surface as
 * a new CDP page whose URL is about:blank and whose DOM contains a CodeMirror editor. Returns null if
 * none is found within the timeout.
 */
export async function findSecondaryWindow(
  browser: Browser,
  mainWin: Page,
  timeoutMs: number
): Promise<Page | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p === mainWin) continue;
        if (p.url().includes('index.html')) continue;
        try {
          const hasEditor = await p.evaluate(() => !!document.querySelector('.cm-editor'));
          if (hasEditor) return p;
        } catch {
          /* page may be mid-navigation; keep polling */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export async function waitForJoplinReady(win: Page): Promise<void> {
  await win.waitForFunction(
    () => {
      const root = document.getElementById('react-root');
      return !!root && root.children.length > 0;
    },
    undefined,
    { timeout: 90_000 }
  );
  await win.waitForSelector('text=NOTEBOOKS', { timeout: 30_000 });
}

export async function closeJoplin(
  instance: JoplinInstance,
  opts: { keepProfile?: boolean } = {}
): Promise<void> {
  try {
    await instance.browser.close();
  } catch {
    /* ignore */
  }
  try {
    instance.child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  await waitForExit(instance.child, 15_000);
  await new Promise((r) => setTimeout(r, 2000));
  if (opts.keepProfile) return;
  try {
    fs.rmSync(instance.profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export const E2E_PATHS = { REPO_ROOT, CACHE_DIR, EXTRACT_DIR, JOPLIN_BINARY, PLUGIN_DIST };
