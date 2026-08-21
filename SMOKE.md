# Ridgeline — manual checklist (Phase 2, v0.2.3)

Ridgeline draws a **compact minimap** at one edge of the Markdown editor and the rendered viewer: a
vertical stack of thin horizontal bars, one per heading, where **bar length encodes heading level**
(H1 longest → H6 shortest) and the **current section's bar** is bold and white (on dark themes) /
full-strength (on light). Hovering the strip **expands a full table of contents**; clicking a row
jumps there.

## Install

1. Build (or use the committed artifact): `npm install && npm run dist` → produces
   `publish/io.github.pmslava.ridgeline.jpl`.
2. In Joplin desktop (3.7.6): **Settings → Plugins → Install from file**, pick
   `publish/io.github.pmslava.ridgeline.jpl`.
3. **Fully quit and relaunch Joplin.** Do **not** use Ctrl+R — it reloads the renderer without
   re-running plugin startup cleanly. (Settings changes below do **not** need a relaunch — that is
   the point of Phase 2 — only installing/updating the plugin does.)

Use a note with several headings (mix of `#`…`######`) and enough text to scroll.

## Checklist

- [ ] **Compact minimap (editor).** Open a note with headings. A vertical stack of thin bars sits at
      the **left** edge of the editor. Longer bars = higher-level headings. There is **no text label**
      in the compact state.
- [ ] **Theme-aware colours.** The bars are drawn from the editor's own foreground colour (dimmed);
      the current-section bar is brighter/white. Switch Joplin between a light and a dark theme — the
      bars re-derive their colours (no relaunch), never a hardcoded blue/purple.
- [ ] **Current section tracks scroll.** Scroll the editor — the bold/tall **current bar** moves to
      the heading now at the top of the viewport (it tracks the viewport top, not the cursor).
- [ ] **Hover TOC.** Move the pointer onto the strip — it expands into a panel listing every heading,
      indented by level, with the current heading's row **bold**. Move away — it collapses after a
      short grace delay (no flicker when crossing from strip to panel). **Esc** also closes it.
- [ ] **Click to jump.** Click a row in the expanded TOC (or click a bar) — the editor jumps to that
      heading. In split view the rendered note follows too.
- [ ] **Viewer minimap.** Switch to split or viewer mode (Ctrl+L). The same minimap + hover TOC
      appears at the edge of the rendered note, tracks its own scroll, and jumps on click. Edit the
      note and switch notes — there is still **exactly one** strip (no duplicates).
- [ ] **Max heading depth.** Settings → Ridgeline → **Maximum heading depth** → e.g. *H1–H3*. Without
      relaunching, both minimaps drop the H4–H6 bars. Set it back to *H1–H6* — they return.
- [ ] **Side = right (live).** Settings → Ridgeline → *Strip side* → **Right** (or run
      **Tools → Ridgeline: Toggle strip side**, accelerator **Ctrl+Alt+R**). Both strips move to the
      **right** edge immediately, **no relaunch** (the editor one tucked just inside the scrollbar).
- [ ] **Reserve mode.** Settings → Ridgeline → set *Editor strip mode* / *Viewer strip mode* to
      **Reserve margin**. The text is pushed clear of the compact strip so it is no longer drawn over.
      The hover TOC still **overlays** the text (reserve only reserves the compact width). In *Overlay*
      mode the compact strip sits on top of the text.
- [ ] **Setext headings.** A note using `Title` + `======` / `------` underlines shows those headings
      in the minimap too, and the editor and viewer agree on the same set (a `# heading` inside a
      fenced code block is correctly ignored).
- [ ] **Multi-window.** With the note selected, press **Ctrl+Alt+N** (Note → *Open note in new
      window*). The minimap appears in the **new window** too and tracks its own scroll independently.

## Round-3 re-check (v0.2.3)

Re-verify each on Joplin 3.7.x with the Markdown editor's **inline rendering ON** (Settings → Editor
→ *Render markup in editor*), your real **dark theme** and **120% zoom**, strip on the **left**, on a
note with a mix of `#`…`######` headings and at least one **very long** heading.

- [ ] **Q1 — Even slimmer bars + more air.** The bars are **shorter still** (H1 ≈ 20px down to H6 ≈ 6px,
      was 28→8) and there is **visibly more breathing room** between the note text and the minimap than
      before. It should read as a thin sliver floating clear of the text.
- [ ] **Q2 — No TOC on transit (hover-intent).** **Swipe the mouse quickly across the strip** on your
      way to the note list — the outline must **NOT** pop open. Now **rest the pointer on the bars for
      about a third of a second** — it opens. The delay is tunable at Settings → Ridgeline → **Hover open
      delay (ms)** (100–1000, default 300); raise it if a quick trip still catches it, lower it to open
      sooner. Selecting text (button held) dragged across the bars still does **not** open it, **Esc**
      still closes it, and moving from the bars into the open panel keeps it open.
- [ ] **Q3 — Pointer cursor on TOC rows.** Open the outline and move the pointer over the rows — the
      cursor is a **pointer (hand)** everywhere on the panel, in **both** the editor and the rendered
      viewer, exactly like Cockpit's list rows. (This is the fix that failed twice before: the editor
      panel now lives as a fixed element **outside** the CodeMirror editor, so nothing in the editor can
      steal the cursor. Check the **real on-screen cursor**, not just the row highlight.)
- [ ] **Q4 — Uniform inactive bars.** Look at the non-current bars — they must all look **equally bold**
      (same thickness), with **no** bar appearing heavier than its neighbours. The **current** bar is
      still clearly bolder (thicker + brighter + a touch longer). Try it at your usual zoom; the bars are
      snapped to whole pixels so half-pixel fuzz no longer makes some look bold.

Round-1/2 behaviours (top anchor, right-aligned bars, panel overlay, single-line ellipsized rows,
click-to-jump, multi-window, reserve mode, maxDepth, live settings) remain in force — spot-check them.
Note P3's single-line-ellipsis rows are unchanged; the round-2 P1 finding (leading-space heading indent
is the third-party **Wrapped Line Indent** plugin, not Ridgeline) still stands.

## Notes

- Reload the plugin only via a **full quit + relaunch**, never Ctrl+R. **Settings** changes, however,
  now apply live without a relaunch.
- Design tokens (bar lengths per level, thickness, gaps, hover-panel sizing, colours' opacity) all
  live in **one file**, `src/tokens.ts`. Change a number there, rebuild, and both surfaces update —
  the editor imports them directly and the viewer receives them from the coordinator's settings
  response.
- Settings are stored in file storage, so they persist across restarts and can be pre-seeded in a
  profile's `settings.json` under `plugin-io.github.pmslava.ridgeline.<key>` (`side`, `editorMode`,
  `viewerMode`, `maxDepth`) — this is how the E2E suite exercises them without clicking through the UI.
