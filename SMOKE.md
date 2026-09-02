# Ridgeline — manual test checklist

Ridgeline draws a **compact minimap** at one edge of the Markdown editor and the rendered viewer: a
vertical stack of thin horizontal bars, one per heading, where **bar length encodes heading level**
(H1 longest → H6 shortest) and the **current section's bar** is bold and white (on dark themes) /
full-strength (on light). Hovering the strip **expands a full table of contents**; clicking a row
jumps there.

## Install

1. Build (or use the committed artifact): `npm install && npm run dist` → produces
   `publish/io.github.pmslava.ridgeline.jpl`.
2. In Joplin desktop (3.3 or newer): **Settings → Plugins → Install from file**, pick
   `publish/io.github.pmslava.ridgeline.jpl`.
3. **Fully quit and relaunch Joplin.** Do **not** use Ctrl+R — it reloads the renderer without
   re-running plugin startup cleanly. Installing or updating the plugin needs a relaunch; settings
   changes below do **not**.

## Test setup

Use a note with several headings at **different levels** (a mix of `#`…`######`) and enough text to
scroll. Include at least one heading that carries **inline markup** — e.g. `## [Some note](:/<32-hex>)`
(paste a real note link with *Copy Markdown link*) — so the display-text checks below have something to
bite on. Exercise with the Markdown editor's **inline rendering ON** (Settings → Editor → *Render markup
in editor*), a **dark theme**, and **120% zoom**, strip on the **left**, unless a check says otherwise.

## Minimap

- [ ] **Compact minimap (editor).** Open a note with headings. A vertical stack of thin bars sits at
      the **left** edge of the editor. Longer bars = higher-level headings. There is **no text label**
      in the compact state.
- [ ] **Uniform inactive bars.** Bars of the same heading level share one length; bars sit at integer
      (device-pixel-even) positions with no sub-pixel blur, including at 120% zoom.
- [ ] **Top-anchored, edge-aligned.** The stack is anchored to the top of the pane and hugs the chosen
      edge (right-aligned when parked on the right).
- [ ] **Theme-aware colours.** The bars are drawn from the editor's own foreground colour (dimmed);
      the current-section bar is brighter/white. Switch Joplin between a light and a dark theme — the
      bars re-derive their colours (no relaunch), never a hardcoded blue/purple.
- [ ] **Vertical condensing.** The stack condenses roughly 2× vertically versus a naive one-bar-per-line
      layout, so a long note's whole shape stays in view.

## Current-section tracking

- [ ] **Current section tracks scroll.** Scroll the editor — the bold/tall **current bar** moves to
      the heading now at the top of the viewport (it tracks the viewport top, not the cursor).
- [ ] **Current bar is THICKER, not LONGER.** Scroll so the current section is, say, an **H3**. Its bar
      is **the same length as the other H3 bars** — only **thicker and brighter**. It must **never**
      grow longer than its level (an H3 no longer masquerades as an H2). Scroll through every level and
      confirm the current bar's *length* always equals its level's inactive length.
- [ ] **Current bar sits CENTRED between its neighbours.** The thicker current bar is **vertically
      centred in its slot**, lined up midway between the bar above and the bar below — **not dropped
      toward the bar below it**. As you scroll and a different bar becomes current, its **neighbours do
      not shift** — only the newly-current bar thickens/centres in place.

## Hover table of contents

- [ ] **Hover TOC.** Move the pointer onto the strip — after a short dwell it expands into a panel
      listing every heading, indented by level, with the current heading's row **bold**. Move away — it
      collapses after a short grace delay (no flicker when crossing from strip to panel). **Esc** also
      closes it.
- [ ] **Panel presentation.** The panel overlays the text; each row is a single line, ellipsized if too
      long; the pointer shows a **pointer cursor** over rows.
- [ ] **Hover intent.** A quick trip *across* the strip (into another pane) does **not** pop the TOC —
      only a deliberate dwell does. An already-open TOC closes itself when the pointer leaves into
      another pane (a side panel or the viewer).
- [ ] **Hover open delay (live).** Settings → Ridgeline → **Hover open delay (ms)** (default **300**,
      range 100–1000). Raise it to 1000 — the dwell needed before the TOC opens is visibly longer, with
      no relaunch. Set it back to 300.
- [ ] **Click to jump.** Click a row in the expanded TOC (or click a bar) — the editor jumps to that
      heading. In split view the rendered note follows too.

## Viewer

- [ ] **Viewer minimap.** Switch to split or viewer mode (Ctrl+L). The same minimap + hover TOC
      appears at the edge of the rendered note, tracks its own scroll, and jumps on click. Edit the
      note and switch notes — there is still **exactly one** strip (no duplicates).

## Headings parsing

- [ ] **Setext headings.** A note using `Title` + `======` / `------` underlines shows those headings
      in the minimap too, and the editor and viewer agree on the same set (a `# heading` inside a
      fenced code block is correctly ignored).
- [ ] **Max heading depth.** Settings → Ridgeline → **Maximum heading depth** → e.g. *H1–H3*. Without
      relaunching, both minimaps drop the H4–H6 bars. Set it back to *H1–H6* — they return.
- [ ] **Headings with inline markup read like the rendered note.** In a note containing
      `## [Some note](:/<32-hex>)`, `## Read [the docs](https://example.com) online`,
      `` ### The `api` method `` and `## A ~~strike~~ word`, both hover outlines (editor and viewer)
      show *Some note* / *Read the docs online* / *The api method* / *A strike word* — the **identical**
      string in each pane, with no raw `[`, `]`, `(`, backtick or `~~` anywhere. Hovering a compact bar
      shows the same text as its native tooltip. Then **click each row in turn**: both panes jump to
      that heading. The last one (`A ~~strike~~ word`) used to jump nowhere at all.
- [ ] **Reference links in headings.** Add `## Read [the guide][guide] first` near the TOP of that
      note and, at the very BOTTOM (after a blank line), the definition `[guide]: https://example.com`.
      Both outlines read *Read the guide first*, and clicking the row jumps in both panes. Now delete
      the definition line: both outlines fall back to the literal `Read [the guide][guide] first`, in
      step, because that is what Joplin renders without it. Put it back and they resolve again — the
      label depends on a line far below the heading, which is the point.

## Settings (live)

- [ ] **Live settings.** Every Ridgeline setting applies immediately, in every open window, without a
      relaunch.
- [ ] **Side = right (live).** Settings → Ridgeline → *Strip side* → **Right** (or run
      **Tools → Ridgeline → Ridgeline: Toggle strip side**, accelerator **Ctrl+Alt+R**). Both strips
      move to the **right** edge immediately, **no relaunch** (the editor one tucked just inside the
      scrollbar).
- [ ] **Reserve mode.** Settings → Ridgeline → set *Editor strip mode* / *Viewer strip mode* to
      **Reserve margin**. The text is pushed clear of the compact strip so it is no longer drawn over.
      The hover TOC still **overlays** the text (reserve only reserves the compact width). In *Overlay*
      mode the compact strip sits on top of the text.
- [ ] **Show-minimap toggle.** Toggle *Show minimap* three ways — Settings → Ridgeline, **Tools →
      Ridgeline → Ridgeline: Toggle minimap** (accelerator **Ctrl+Alt+M**), and the `fa-stream`
      note-toolbar button. Each hides both surfaces in every window live. **Show minimap = off** hides
      everything regardless of the other settings.
- [ ] **Show the toolbar toggle button (restart required).** Settings → Ridgeline → turn **Show the
      toolbar toggle button** *off*. Nothing changes yet — this setting is **not live** (the plugin API
      cannot remove a toolbar button at runtime). **Fully quit and relaunch Joplin**: the `fa-stream`
      note-toolbar button is now **gone**, while **Tools → Ridgeline → Ridgeline: Toggle minimap** and
      **Ctrl+Alt+M** still toggle the strip. Turn it back **on** and relaunch — the button **returns**.
- [ ] **Hide when the note has no headings.** Open a note with **no headings at all**: there is **no
      strip** and (in *Reserve margin* mode) **no reserved margin** — the text uses the full width, in
      both the editor and the viewer. **Type a heading** (`# Something`): the strip **appears**
      immediately (and the margin returns in reserve mode), **no relaunch**. **Delete that last
      heading**: it **disappears** again. Settings → Ridgeline → **Hide minimap when the note has no
      headings** (default **on**) controls this; turn it **off** (or run **Tools → Ridgeline →
      Ridgeline: Toggle hide-when-empty**, accelerator **Ctrl+Alt+H**) to keep the empty strip +
      margin. With a heading-less note open, toggling it flips the empty strip + margin on/off
      **live**, no relaunch.

## Multi-window

- [ ] **Multi-window.** With the note selected, press **Ctrl+Alt+N** (Note → *Open note in new
      window*). The minimap appears in the **new window** too and tracks its own scroll independently.

## Notes

- Reload the plugin only via a **full quit + relaunch**, never Ctrl+R. **Settings** changes, however,
  apply live without a relaunch.
- Leading-space indentation of a heading in the editor, if seen, comes from the third-party **Wrapped
  Line Indent** plugin, not Ridgeline.
- Design tokens (bar lengths per level, thickness, gaps, hover-panel sizing, colours' opacity) all
  live in **one file**, `src/tokens.ts`. Change a number there, rebuild, and both surfaces update.
- Settings are stored in file storage, so they persist across restarts and can be pre-seeded in a
  profile's `settings.json` under `plugin-io.github.pmslava.ridgeline.<key>` (`side`, `editorMode`,
  `viewerMode`, `maxDepth`, `showMinimap`, `hideWhenEmpty`, `showToolbarButton`) — this is how the E2E
  suite exercises them without clicking through the UI.
