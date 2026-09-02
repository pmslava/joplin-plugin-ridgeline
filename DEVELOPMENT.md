# Developing Ridgeline

Everything a contributor needs beyond the quick build in the [README](README.md): the static checks, the
end-to-end test suite, regenerating the showcase screenshots, and a tour of the repository layout. For
the release flow, see [PUBLISHING.md](PUBLISHING.md).

## Building

`npm install && npm run dist` builds the publishable plugin to
`publish/io.github.pmslava.ridgeline.jpl`. To type-check without building, run `npx tsc --noEmit`.

## Static checks

Ridgeline has one unit-level harness — the heading display/slug matrix — and one source audit. Every
other behaviour is exercised by the real-app E2E suite below. Both run in a second and neither needs a
build:

```
npm run test:sandbox-proxy
npm run test:headings
```

`joplin` is not an object, it is `sandboxProxy(wrappedTarget)`. Its get trap **pushes** the property
name onto a shared pending-call path and only the apply trap **pops** a segment, so a `joplin.*` member
that is read without being called in the same expression leaves that path permanently one segment too
long — and every later call on it is rejected by the host with `Property or method X does not exist
in ...` ([joplin#4569](https://github.com/laurent22/joplin/issues/4569)). The classic way in is a probe:

```ts
const panels = joplin.views.panels;   // WRONG: one get, no call
if (typeof panels.create === 'function') { … }
```

which is doubly useless, because a proxy member is *always* truthy and *always* `typeof 'function'`. The
API cannot be feature-detected by inspection — only called and caught. So the rule the audit enforces
over `src/` is: **every `joplin.*` chain must be one uninterrupted read-and-call**, with `(` as the next
character. Namespace capture is rejected too, even though the proxy nominally tolerates one. A violation
fails the check with `file:line` and the offending chain, and it runs in CI as the first step of the
build gate the publish flow depends on.

### The heading matrix

`npm run test:headings` (`scripts/test-headings.js`) compiles `src/inlineText.ts` + `src/headings.ts`
straight from source with the repo's own TypeScript — never from `dist/`, which can be stale, and into
which `headings.ts` is bundled *twice* — and runs every measured case plus four supporting blocks.

The contract it defends is this: for a given heading line, the strip must show **the text a reader
sees** in the rendered note, and must compute an anchor **byte-identical to the id Joplin's renderer
puts on that heading**. The second half is the reason this exists. A wrong anchor throws nothing and
logs nothing — `resolveLineFromAnchor` returns `null`, `handleJump` skips the editor scroll, and the
jump just quietly does not happen. No type-check, build or lint can see that, and `tsconfig.json`
excludes `e2e/`, so the specs are not type-checked either.

Every expectation was measured against Joplin 3.7.6's real renderer (markdown-it + markdown-it-anchor +
`@joplin/fork-uslug`), and the rows whose anchor changed when the old regex pair was replaced carry a
`was:` comment naming the old value. The blocks are MATRIX (the 61 cases, including three sets that
must be parsed together because they share the duplicate-suffix counter), IDENTITY (every heading
string the E2E suite asserts on, proven to pass through byte-identical), STRUCTURE (fences, HTML
comments, indent limits, setext guards and line numbers), PATHOLOGY (adversarial inputs under a 50 ms
budget, there to fail a future regex rewrite that reintroduces backtracking on the per-keystroke path),
and VIEWER DRIFT GUARD.

**A new heading construct gets a matrix row before it gets code.** If Joplin's live behaviour ever
disagrees with a row, the live app wins: change the row and say why.

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
suite launches Joplin many times serially, so a full run takes roughly **14 minutes**. To break that into
shorter foreground chunks, run it in **four shards**:

```
npm run dist
npm run setup:e2e
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test --shard=1/4
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test --shard=2/4
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test --shard=3/4
xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test --shard=4/4
```

The `-screen 0 1920x1080x24` server args give the virtual display enough room for the split-pane layouts
the specs assert against. Run the shards **sequentially** — one foreground command finishing before the
next starts — never concurrently.

### Resource discipline (laptop)

A local E2E run is a heavyweight job: it launches a real Joplin desktop repeatedly on a 16 GiB laptop,
and two runs stacked on each other collapsed the XFCE session twice on 2026-08-21. `e2e/guard.ts`
(wired in as Playwright's `globalSetup`/`globalTeardown`) now enforces the discipline automatically:

- **One run machine-wide.** A lock directory under `~/.cache` — shared by every plugin repo and worktree
  on this machine — is acquired before any Joplin spawns. A run that finds it held **waits its turn**
  rather than stacking a second Joplin: it names the holder (the lock carries the owner's repo path and
  start time), prints progress every 30 s, and gives up only after `E2E_LOCK_WAIT_MS` (default 10
  minutes; `0` restores fail-fast). This is why parallel `xvfb-run` invocations are pointless as well as
  dangerous — the second one just queues.
- **Pre-run orphan sweep.** Leftovers from a previously killed run are reaped before the new one starts:
  Joplin processes launched from this repo's `.e2e-cache/squashfs-root`, orphaned `Xvfb` servers carrying
  the harness's server-args (plus their stale `/tmp/.X*-lock` files), and `e2e/.profiles/profile-*` dirs.
- **RAM gate.** The run aborts below 3 GiB of `MemAvailable`; `E2E_IGNORE_RAM=1` overrides, and CI only
  warns. earlyoom SIGTERMs the session's processes below 10% available, and a desktop collapse costs more
  than a deferred test run.
- **Signal teardown.** SIGINT/SIGTERM/uncaught exceptions SIGKILL each live Joplin process *group* and
  remove its profile, so an interrupted run no longer leaks.

What the guard cannot do for you:

- **Keep /tmp clear.** It is a 7.7G tmpfs shared with the live desktop. Point bulk scratch (`TMPDIR`) at
  disk and never let /tmp approach 100% — a full /tmp breaks glycin PNG decoding and can kill the whole
  XFCE session.
- **Give you a display.** Always run under `xvfb-run` (`npm run test:e2e` does it for you); a bare
  `npx playwright test` would inherit the live `:0` display.
- A `/tmp/appimage_extracted_*` Joplin is NEVER the harness — that's the real desktop app in
  extract-and-run fallback, and the sweep deliberately never touches it.

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
  - `headings.ts` — the editor-side heading parser: a line scan for BLOCK structure (fences, HTML
    comment blocks, ATX indent limits, setext underlines) plus the slug and its duplicate suffix. That
    scan also collects the note's `[^label]:` footnote definitions, because a `[^1]` in a heading is a
    footnote only if a definition exists somewhere in the body — so the headings are resolved in a
    second phase, after the whole body has been walked. It is **not** shared with the viewer —
    `viewer.js` reads the rendered DOM and cannot import TypeScript.
  - `inlineText.ts` — resolves a heading's inline Markdown into the text a reader sees plus the token
    stream Joplin slugifies; the single source for both the label the strip shows and the anchor it
    jumps to. Pure, dependency-free, and pinned by `npm run test:headings`.
  - `tokens.ts` — the single file of design tokens (bar lengths per level, thickness, gaps, hover-panel
    sizing, colour opacity). Change a number here, rebuild, and both surfaces update.
  - `common.ts` — shared helpers.
  - `contentScripts/` — the CodeMirror editor extension and the rendered-viewer script. `viewer.js` is
    a plain-JS asset copied verbatim, so it duplicates exactly one rule from the TypeScript side: the
    whitespace normaliser `.replace(/\s+/g, ' ').trim()`, which must stay byte-identical to
    `collapse()` in `inlineText.ts`. Its VIEWER DRIFT GUARD lives in `scripts/test-headings.js`; the
    behavioural guard is the editor↔viewer row-array equality in `e2e/heading-links.spec.ts`. Do **not**
    port the Markdown scanner into `viewer.js` — its input is post-render text, where a Markdown
    stripper would eat literal characters the renderer deliberately shows (`` # Use `[x](y)` now ``
    renders as the literal `Use [x](y) now`).
  - `manifest.json` — the plugin manifest (id, version, `app_min_version`, screenshots).
- `e2e/` — the Playwright end-to-end specs (17 spec files), plus `launch.ts`/`helpers.ts` for driving
  Joplin, `guard.ts` (+ `global-setup.ts`/`global-teardown.ts`) for the resource discipline above, and
  `showcase.spec.ts` for the screenshots.
- `scripts/setup-e2e.sh` — fetches and caches the Joplin AppImage the E2E suite runs against.
- `scripts/audit-sandbox-proxy.js` — the sandbox-proxy read-and-call audit described above.
- `scripts/test-headings.js` — the heading display/slug matrix described above.
- `webpack.config.js`, `plugin.config.json`, `tsconfig.json` — the build.
- `playwright.config.ts` — the E2E runner configuration.
- `docs/images/` — the screenshots referenced by the README and manifest.
