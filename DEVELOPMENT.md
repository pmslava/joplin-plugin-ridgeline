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
