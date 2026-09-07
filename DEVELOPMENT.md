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
`was:` comment naming the old value. The blocks are MATRIX (the measured cases, including the sets that
must be parsed together because they share the duplicate-suffix counter or a `[label]:` definition,
and the rows whose body carries that definition with them), IDENTITY (every heading
string the E2E suite asserts on, proven to pass through byte-identical), STRUCTURE (fences, HTML
comments, indent limits, setext guards — including the definition lines a block rule eats before the
setext logic sees them — and line numbers), PATHOLOGY (adversarial inputs under a 50 ms
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
  - `index.ts` — plugin entry point: registers settings, commands, and the coordinator. The coordinator
    answers three content-script messages: `getSettings` (the resolved settings + the design tokens),
    `jump`, and `setSettings` — the outline toolbar writing a setting back. `setSettings` is guarded by
    an **allowlist of exactly three keys** (`outlinePinned`, `outlineWidthPercent`, `maxDepth`), written
    as three literal `in` checks so no key from the payload is ever used to address a setting; each value
    is coerced there exactly as `readSettings` coerces the stored one, and the answer is a fresh
    settings response the calling surface applies at once (the other surface and other windows pick the
    change up through the usual `onChange` push / 700 ms poll).
  - `headings.ts` — the editor-side heading parser: a line scan for BLOCK structure (fences, HTML
    comment blocks, ATX indent limits, setext underlines) plus the slug and its duplicate suffix. That
    scan also collects the note's `[^label]:` footnote definitions and its `[label]: destination` link
    reference definitions, because a `[^1]` or a `[label]` in a heading resolves only if a definition
    exists somewhere in the body — so the headings are resolved in a second phase, after the whole body
    has been walked. It is **not** shared with the viewer — `viewer.js` reads the rendered DOM and
    cannot import TypeScript.
  - `inlineText.ts` — resolves a heading's inline Markdown into the text a reader sees plus the token
    stream Joplin slugifies; the single source for both the label the strip shows and the anchor it
    jumps to. Pure, dependency-free, and pinned by `npm run test:headings`.
  - `tokens.ts` — the single file of design tokens (bar lengths per level, thickness, gaps, hover-panel
    sizing, colour opacity, and the outline's geometry: its min width, its max fraction of the pane, the
    text column that must survive beside a pinned one, the air between the text and its border). Change
    a number here, rebuild, and both surfaces update. It also holds the two width resolvers —
    `outlineWidthPx()` (percent of the pane, clamped) and `outlineRoomPx()` (that width plus the edge
    inset and the air, or 0 when the pane is too narrow) — mirrored in `viewer.js`.
  - `common.ts` — shared constants, message types and the ONE effective-state resolver
    (`outlineToolbarOn` / `outlinePinnedOn` / `outlineMakeRoomOn`), so both surfaces decide "toolbar on /
    pinned / making room" the same way. Note the two DISTINCT margins it names: the **minimap margin**
    (`editorMode`/`viewerMode` = `reserve`) is the thin one that only clears the bars, while the
    **outline room** is the wide one a *pinned* outline gets from `outlineMakeRoom`. The room supersedes
    the thin margin rather than adding to it — the pinned outline covers the bars anyway. User-facing
    wording (labels, descriptions, README) says **minimap**, never "strip"; the code keeps its older
    `strip` identifiers, CSS classes and `data-testid`s, which must not be renamed.
  - `contentScripts/` — the CodeMirror editor extension and the rendered-viewer script. Both draw the
    **outline toolbar** (issue #2): an optional first row inside `.ridgeline-panel` — `.ridgeline-toolbar`
    with `.ridgeline-tb-width` / `.ridgeline-tb-headings` / `.ridgeline-tb-pin`, and a
    `.ridgeline-tb-popover` that opens INSIDE the panel (so the hover hit-test on the panel's own rect
    keeps the outline open while the pointer is on it). What HOLDS the outline open against the collapse
    grace, though, is only the width field having FOCUS — the user is typing. A merely-open popover does
    not hold it: when the pointer leaves the zone the popover is dismissed and the outline collapses
    normally, and when a held field applies or blurs the outline is handed straight back to the grace if
    the pointer has meanwhile moved off it. Without that rule the viewer could strand an outline open
    for good: once the pointer is out of the note iframe no further mousemove arrives there and its
    Escape handler is bound to that window, so nothing was left to close it until the next rebuild. The two implementations are deliberate mirrors, not shared
    code: identical class names, behaviour and layout, with the `data-testid` prefixed per surface. With
    `outlineToolbar` off every path in both files behaves as it did before the toolbar existed —
    that regression contract is what keeps the older specs green — **identical except for four
    deliberate refinements that apply whether or not the toolbar is on**, listed here so the claim is
    not read as broader than it is. (1) `renderPanel` carries the panel's `scrollTop` across a rebuild:
    a pinned outline is open *while* the user types and every doc edit re-renders its rows, so without
    it a long outline snapped back to the top on every keystroke. (2) The editor's `reposition()` now
    re-applies the panel's width cap, so the legacy `panelMaxWidthFraction` cap follows a pane resize
    instead of keeping the width it was built with. (3) The viewer registers a `resize` listener per
    build (torn down with the strip), because the outline's width and room are a percentage of a pane
    that moves. (4) Both containers are stamped with `data-expanded` / `data-pinned` at mount/build
    rather than only on the first `expand()`/`collapse()`, so a reader can never mistake "not yet
    touched" for "closed" — the viewer rebuilds its container wholesale, which made that difference
    observable. Layout notes: pinned, the panel is
    `display:block; top:0; height:100%` of the container (which already spans the pane on both surfaces),
    the toolbar is `position:sticky` and full-bleed (negative side margins, the panel dropping its top
    padding), and the rows scroll under it; a pinned outline on a heading-less note keeps the toolbar and
    shows a single `.ridgeline-panel-empty` row so it can be unpinned in place. The editor's outline room
    lives in the reserve `Compartment`, and reconfiguring it DISPATCHES — so, exactly like `applyVisibility`,
    it is deferred out of any CodeMirror update (and out of the ResizeObserver callback) with a
    `setTimeout 0`, and only when the computed px actually changed; the viewer sets `document.body`'s
    margin and recomputes it on `resize`. `viewer.js` is
    a plain-JS asset copied verbatim, so it duplicates exactly one rule from the TypeScript side: the
    whitespace normaliser `.replace(/\s+/g, ' ').trim()`, which must stay byte-identical to
    `collapse()` in `inlineText.ts`. Its VIEWER DRIFT GUARD lives in `scripts/test-headings.js`; the
    behavioural guard is the editor↔viewer row-array equality in `e2e/heading-links.spec.ts`. Do **not**
    port the Markdown scanner into `viewer.js` — its input is post-render text, where a Markdown
    stripper would eat literal characters the renderer deliberately shows (`` # Use `[x](y)` now ``
    renders as the literal `Use [x](y) now`). `viewer.js` also carries the **export/print guard**
    (issue #3): Joplin copies a content script's assets into the standalone HTML page it writes for
    **Export → PDF**, **File → Print** and **Export → HTML**, so the strip — navigation, not content —
    would otherwise be baked into every exported document. `hostAvailable()` builds nothing when there
    is no `webviewApi` host bridge (there is none outside the live note viewer), and `viewer.css` adds
    an independent `@media print` rule. Both layers are pinned by `e2e/export-print.spec.ts`. That print
    rule has a second half: hiding the strip leaves the GUTTER reserved for it, which would print as a
    blank band — so `viewer.js` stamps `data-ridgeline-margin` on the body for exactly as long as it owns
    that margin, and the print rule zeroes the body margin only for a body carrying that stamp, never a
    margin somebody else set.
    It carries a second, independent **Rich Text (TinyMCE) editor guard** for the same reason. Joplin's
    Rich Text editor loads the very same MarkdownIt assets into its editor iframe and defines a
    `webviewApi` bridge there, so `hostAvailable()` alone is true inside it — but that document is
    `contentEditable`, and a strip built into it is serialised straight back into the note (probed on
    Joplin 3.7.x: one typed word wrote the outline's own row titles into the note body).
    `insideEditorDocument()` refuses to build when the document is editable **or** the body carries
    TinyMCE's root marker class `mce-content-body` (which also covers TinyMCE's read-only mode);
    `stripAllowedHere()` combines both guards and is consulted on all three build paths. Pinned by
    `e2e/rich-text-editor.spec.ts`.
  - `manifest.json` — the plugin manifest (id, version, `app_min_version`, screenshots).
- `e2e/` — the Playwright end-to-end specs (20 spec files), plus `launch.ts`/`helpers.ts` for driving
  Joplin, `guard.ts` (+ `global-setup.ts`/`global-teardown.ts`) for the resource discipline above, and
  `showcase.spec.ts` for the screenshots.
- `scripts/setup-e2e.sh` — fetches and caches the Joplin AppImage the E2E suite runs against.
- `scripts/audit-sandbox-proxy.js` — the sandbox-proxy read-and-call audit described above.
- `scripts/test-headings.js` — the heading display/slug matrix described above.
- `webpack.config.js`, `plugin.config.json`, `tsconfig.json` — the build.
- `playwright.config.ts` — the E2E runner configuration.
- `docs/images/` — the screenshots referenced by the README and manifest.
