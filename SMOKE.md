# Ridgeline — manual checklist (Phase 2, v0.2.4)

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

## Round-4 re-check (v0.2.4)

Re-verify each on Joplin 3.7.x with the Markdown editor's **inline rendering ON** (Settings → Editor
→ *Render markup in editor*), your real **dark theme** and **120% zoom**, strip on the **left**, and —
for Z3 — your **Cockpit panel** docked to the left of the editor. Use a note with many `#`…`######`
headings and at least one **very long** heading.

- [ ] **Z1 — Vertical condensing (~2×).** The bars are packed **about twice as tightly** vertically
      (top-to-top pitch ≈ 7px, was 15) so a heading-dense note's stack is roughly half as tall. The bar
      **thickness is unchanged** (thin inactive, clearly bolder current). Critically, at your 120% zoom
      the inactive bars still look **perfectly even** — no bar heavier than its neighbours. (Positions
      are now snapped to whole **device** pixels via `devicePixelRatio`, so evenness holds at any zoom,
      not just the old 15px-pitch special case.)
- [ ] **Z2 — Show/hide the minimap (no relaunch).** Settings → Ridgeline → **Show minimap** → **off**:
      the strip **vanishes** in the editor **and** the viewer, immediately, in **every** window — the
      plugin stays enabled. Turn it back **on**: it returns. The same flip is on **Tools → Ridgeline:
      Toggle minimap** (accelerator **Ctrl+Alt+M**). The **note-toolbar button** (staggered-lines
      `fa-stream` icon, in the note's top-right toolbar) also toggles the minimap.
- [ ] **Z3 — Transit into the Cockpit panel: no popup, no stuck-open.** ① **Swipe from the note text
      leftward across the strip into your Cockpit panel** (even at speed) — the TOC must **NOT** pop
      open. ② Now **open the TOC** (rest on the bars) and then **move the pointer into the Cockpit
      panel** — the TOC must **close by itself** within the grace, **without** you moving back into the
      note or pressing Esc. Repeat crossing into the **rendered viewer** pane and into any other plugin
      panel. Esc still closes it; dwell still opens it; click-to-jump still works.

Round-1/2/3 behaviours (top anchor, right-aligned bars, panel overlay, single-line ellipsized rows,
hover-intent dwell + grace + Esc, pointer cursor on rows, uniform bars, click-to-jump, multi-window,
reserve mode, maxDepth, live settings) remain in force — spot-check them. The round-2 P1 finding
(leading-space heading indent is the third-party **Wrapped Line Indent** plugin, not Ridgeline) still
stands. Internal this round (no user-visible check): the editor strip's container z-index was raised
(50 → 200) to clear Joplin's editor UI, and the viewer's fallback tokens were re-synced to `tokens.ts`.

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
