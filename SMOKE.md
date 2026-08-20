# Ridgeline — manual checklist (Phase 2, v0.2.1)

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

## Round-1 fixes (v0.2.1) — re-check these

These are the eight issues from the first real-desktop test round. Re-verify each on Joplin 3.7.x
with the Markdown editor's **inline rendering ON** (Settings → Editor → *Render markup in editor*),
dark theme, on a note with a mix of `#`…`######` headings and at least one **very long** heading.

- [ ] **R1 — Top anchor.** The bar stack sits near the **top** of the pane (small top offset), not
      floating in the vertical centre.
- [ ] **R2 — Right-aligned bars.** Bars are flush to the strip's **right edge** with ragged left
      ends, on **both** the left and right side (Ctrl+Alt+R to flip and confirm).
- [ ] **R3 — Current bar stands out.** The current-section bar is clearly **thicker + brighter**
      (and a touch longer) than the others — "where am I" is obvious at a glance.
- [ ] **R4 — Panel overlays, no truncation.** Hovering opens the TOC **over** the strip, anchored at
      the pane edge (the strip is covered, not left beside the panel). The **long heading is not cut
      off with an ellipsis** — it wraps; the panel is only as wide as the longest row, capped at a
      sane fraction of the pane.
- [ ] **R5 — Row affordance.** Hovering a TOC row **changes its background** and the cursor is a
      **pointer**.
- [ ] **R6 — Trigger zone.** Hovering the empty edge band **below** the bars does **not** open the
      TOC (and does not block selecting text there); only hovering the **bars** opens it.
- [ ] **R7 — Selection drag.** While **selecting text** (mouse button held), drag the pointer onto
      the bars — the TOC still **opens**.
- [ ] **R8 — Heading indentation (regression). STATUS: could not reproduce — needs your live
      bisection.** With the plugin active, heading lines should keep their text **aligned with body
      text** (no progressive left shift by level), in every side (left/right) × mode (overlay/reserve)
      combo, existing and freshly typed, main and secondary windows. This was tested exhaustively on a
      real Joplin **3.7.6** with inline rendering ON in the worst-case **right + reserve** combo, both
      in a clean profile **and in a faithful copy of your environment** — your actual
      `userchrome.css` plus **Rich Markdown** and **Wrapped Line Indentation** loaded (see
      `e2e/heading-indent-faithful.spec.ts`). In every case all headings stayed flush (offset 0.0px).
      Ridgeline's reserve is a single **uniform** pad on `.cm-content`, so it cannot shift text per
      level, and Wrapped Line Indent only indents lines with **leading whitespace** (headings have
      none). So the shift you saw is **environment-specific** and not something Ridgeline injects.
      **If you still see it, bisect on your live desktop** (it is almost certainly another plugin's
      per-level heading decoration, not Ridgeline):
      1. Reproduce it first (right + reserve, a note with `#`…`######` headings).
      2. Tools → Options → Plugins: **disable Ridgeline only**, relaunch. If the shift *remains*, it is
         **not** Ridgeline — re-enable it and go to step 3. If it *disappears*, capture a screenshot and
         reopen this as a Ridgeline bug (it did not reproduce here, so we'd need your exact combo).
      3. With Ridgeline **on**, disable the other CM6 editor plugins **one at a time** (start with
         **Rich Markdown**, then **Wrapped Line Indentation**, **Markdown Alerts**, **codeblock
         autocomplete**, **MathMode**), relaunching between each, until the shift stops. The last one
         you disabled is the interacting plugin.
      4. As a userchrome cross-check, temporarily rename `~/.config/joplin-desktop/userchrome.css` and
         relaunch. If the shift stops, a local CSS rule is the cause.
      Report which step cleared it and we'll scope Ridgeline's reserve padding (or document the rule)
      against that specific interaction.

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
