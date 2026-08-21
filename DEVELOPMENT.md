# Developing Ridgeline

Everything a contributor needs beyond the quick build in the [README](README.md): the end-to-end test
suite, regenerating the showcase screenshots, and a tour of the repository layout. For the release flow,
see [PUBLISHING.md](PUBLISHING.md).

## Building

```
git clone https://github.com/pmslava/joplin-plugin-ridgeline
cd joplin-plugin-ridgeline
npm install
npm run dist
```

`npm run dist` builds the publishable plugin to `publish/io.github.pmslava.ridgeline.jpl`. To type-check
without building, run `npx tsc --noEmit`.

## End-to-end tests

The E2E suite drives a real Joplin desktop (Electron) build with the plugin loaded, under a virtual
display. It needs Xvfb and the Playwright Chromium host dependencies installed.

First fetch the Joplin AppImage the tests run against (downloaded once, then cached under `.e2e-cache/`):

```
npm run setup:e2e
```

The version is pinned in `scripts/setup-e2e.sh` and overridable — it must be at least the manifest's
`app_min_version`:

```
JOPLIN_E2E_VERSION=3.7.6 npm run setup:e2e
```

`npm run test:e2e` runs the whole suite in one process (it wraps `playwright test` in `xvfb-run`). The
suite launches Joplin many times serially, so a full single-command run takes roughly **14 minutes** and
is uncomfortable to sit through on a laptop — there is effectively no fast single-command path. It is far
more comfortable to run it in **four shards**, each in the foreground:

```
npm run dist
npm run setup:e2e
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test --shard=1/4
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test --shard=2/4
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test --shard=3/4
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test --shard=4/4
```

The `-screen 0 1920x1080x24` server args give the virtual display enough room for the split-pane layouts
the specs assert against.

Run the four shards **sequentially** on the laptop — one foreground command finishing before the next —
never concurrently. Parallel `xvfb-run` invocations multiply the RAM and /tmp load and risk the desktop
collapses described below.

### Resource discipline (laptop)

After two desktop collapses on 2026-08-21, treat a local E2E run as a heavyweight job:

- The harness is already headless (`xvfb-run -a`, auto-numbered virtual display) and serial within a run
  (`workers:1`) — test windows never touch the live display. The laptop risks are RAM and /tmp, not
  displays.
- ONE E2E run machine-wide: before starting, `pgrep -f e2e-cache` must be empty (covers cockpit +
  ridgeline + all worktrees). Don't shard locally into parallel `xvfb-run` invocations.
- RAM gate: check `free -h` before a run; don't launch Joplin instances when available memory is under
  ~4G. earlyoom SIGTERMs the session's processes below 10% available — a desktop collapse costs more than
  a deferred test run.
- /tmp is a 7.7G tmpfs shared with the live desktop. Point bulk scratch (`TMPDIR`) at disk, clean session
  task scratch after runs, never let /tmp approach 100% — a full /tmp breaks glycin PNG decoding and can
  kill the whole XFCE session (libwnck `g_assert`, incident #1).
- Reap orphans after any killed/crashed run (teardown only runs on the happy path): stray Joplin
  processes whose cmdline contains `.e2e-cache`, leftover `Xvfb` servers (`pgrep -a Xvfb`), stale
  `/tmp/.X*-lock` files, and `e2e/.profiles/profile-*` dirs.
- Always launch via `npm run test:e2e` — a bare `npx playwright test` would inherit the live `:0`
  display.
- A `/tmp/appimage_extracted_*` Joplin is NEVER the harness — that's the real desktop app in
  extract-and-run fallback; remove the stale extraction once the app isn't using it.

## Regenerating the showcase screenshots

The README/manifest screenshots are produced by a separate, opt-in spec that captures (rather than
asserts) against a throwaway profile forced to Joplin's dark theme:

```
npm run dist
npm run setup:e2e
SHOWCASE=1 xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test e2e/showcase.spec.ts
```

It writes the PNGs into `docs/images/`. Its content is fictional ("Acme Rocket Skates") — it never
touches your real Joplin profile.

## Repository layout

- `src/` — the plugin source.
  - `index.ts` — plugin entry point: registers settings, commands, and the coordinator.
  - `headings.ts` — heading parsing shared by the editor and viewer.
  - `tokens.ts` — the single file of design tokens (bar lengths per level, thickness, gaps, hover-panel
    sizing, colour opacity). Change a number here, rebuild, and both surfaces update.
  - `common.ts` — shared helpers.
  - `contentScripts/` — the CodeMirror editor extension and the rendered-viewer script.
  - `manifest.json` — the plugin manifest (id, version, `app_min_version`, screenshots).
- `e2e/` — the Playwright end-to-end specs, plus `launch.ts`/`helpers.ts` for driving Joplin and
  `showcase.spec.ts` for the screenshots.
- `scripts/setup-e2e.sh` — fetches and caches the Joplin AppImage the E2E suite runs against.
- `webpack.config.js`, `plugin.config.json`, `tsconfig.json` — the build.
- `playwright.config.ts` — the E2E runner configuration.
- `docs/images/` — the screenshots referenced by the README and manifest.
