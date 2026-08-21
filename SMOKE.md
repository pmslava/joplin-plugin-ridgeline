# Ridgeline — manual checklist (Phase 2, v0.2.6)

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

## Round-5 re-check (v0.2.6)

Re-verify each on Joplin 3.7.x with the Markdown editor's **inline rendering ON** (Settings → Editor
→ *Render markup in editor*), your real **dark theme** and **120% zoom**, strip on the **left**. Use a
note with headings at **several different levels** (e.g. an `#`, a couple of `##`/`###`, and a deeper
one) and enough text to scroll.

- [ ] **W1 — Current bar is THICKER, not LONGER.** Scroll so the current section is, say, an **H3**.
      Its bar is **the same length as the other H3 bars** — only **thicker and brighter**. It must
      **never** grow longer than its level (an H3 no longer masquerades as an H2). Scroll through every
      level and confirm the current bar's *length* always equals its level's inactive length.
- [ ] **W2 — Current bar sits CENTRED between its neighbours.** The thicker current bar is **vertically
      centred in its slot**, so it lines up midway between the bar above and the bar below — **not
      dropped toward the bar below it** (the old look). As you scroll and a different bar becomes
      current, its **neighbours do not shift** — only the newly-current bar thickens/centres in place.
- [ ] **W3 — Hide when the note has no headings.** Open a note with **no headings at all**: there is
      **no strip** and (in *Reserve margin* mode) **no reserved margin** — the text uses the full width,
      in both the editor and the viewer. **Type a heading** (`# Something`): the strip **appears**
      immediately (and the margin returns in reserve mode), **no relaunch**. **Delete that last
      heading**: it **disappears** again. Settings → Ridgeline → **Hide minimap when the note has no
      headings** (default **on**) controls this; turn it **off** (or run **Tools → Ridgeline: Toggle
      hide-when-empty**, accelerator **Ctrl+Alt+H**) to keep the empty strip + margin as before — with a
      heading-less note open, toggling it flips the empty strip + margin on/off **live**, no relaunch.
      **Show minimap = off** still hides everything regardless.

Round-1/2/3/4 behaviours remain in force — spot-check them: top-anchored right-aligned bars, panel
overlay with single-line ellipsized rows, hover-intent dwell + grace + Esc, pointer cursor on rows,
uniform inactive bars, click-to-jump, multi-window, reserve mode, maxDepth, live settings; **Z1** (~2×
vertical condensing, device-pixel-even bars at 120% zoom), **Z2** (Show-minimap toggle — Settings, Tools
→ Ridgeline: Toggle minimap / Ctrl+Alt+M, and the `fa-stream` note-toolbar button — hides both surfaces
in every window live), and **Z3** (swiping across the strip into the Cockpit panel / viewer never pops
the TOC, and an open TOC closes itself when the pointer leaves into another pane). The round-2 P1
finding (leading-space heading indent is the third-party **Wrapped Line Indent** plugin, not Ridgeline)
still stands.

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
