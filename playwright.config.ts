import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the real-app Joplin end-to-end tests.
 *
 * These tests launch the actual Joplin desktop (Electron) build with this plugin loaded as a
 * development plugin, and drive the genuine GUI. They are intentionally serial (a single Joplin
 * instance, one profile at a time) and have generous timeouts because launching Joplin and waiting
 * for the plugin/runtime to initialise is slow.
 *
 * Run with:  npm run test:e2e   (which wraps `playwright test` in xvfb-run for a virtual display)
 */
export default defineConfig({
  testDir: './e2e',
  // Resource-discipline guard (e2e/guard.ts): before any worker spawns Joplin, globalSetup acquires a
  // single machine-wide lock, sweeps orphaned Joplin/Xvfb/profile leftovers from previous dead runs,
  // and applies a soft RAM gate; globalTeardown releases the lock. See e2e/guard.ts for the rationale.
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Launching Joplin + waiting for the plugin to register can take a while on a cold profile, and
  // some tests wait out more than one of the panel's fallback refresh intervals.
  timeout: 240_000,
  // A stuck suite must stop itself gracefully (writing the HTML report and traces, which a hard
  // process kill does not) rather than hang forever. The full suite now launches Joplin ~10 times
  // serially (each cold launch ~75s), so a clean pass runs ~13-15 min; add the per-test retry budget
  // and a busy machine and a single unsharded `npm run test:e2e` can approach that. The cap is set
  // well above the realistic worst case so it only ever fires on a genuine hang, never on a slow-but-
  // healthy run. Raise this, not lower it, if you add more Joplin-launching describe blocks.
  globalTimeout: 35 * 60_000,
  expect: { timeout: 20_000 },
  // A single Joplin instance at a time.
  fullyParallel: false,
  workers: 1,
  // How quickly a change reaches the panel depends on when Joplin next brings its search index up
  // to date, which it does on a timer of its own and which slows down when the machine is busy. The
  // specs pass consistently on their own, but back to back a run occasionally overshoots even a
  // generous timeout, so a failed test gets one retry rather than failing the whole run.
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
