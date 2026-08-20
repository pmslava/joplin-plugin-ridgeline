# Ridgeline — manual checklist (Phase 2, v0.2.2)

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

## Round-2 re-check (v0.2.2)

Re-verify each on Joplin 3.7.x with the Markdown editor's **inline rendering ON** (Settings → Editor
→ *Render markup in editor*), dark theme, on a note with a mix of `#`…`######` headings and at least
one **very long** heading.

- [ ] **P1 — Leading-space headings (root cause found).** Ridgeline lists a bar for headings that
      carry a leading space before the hash (` # Title`, `  ## Title` — valid CommonMark), in **both**
      editor and viewer, and clicking one **jumps** to it. *Separately:* if you type ` # Title` with a
      leading space you may notice the **editor** draws the heading text slightly **indented** (more so
      at higher levels), while the **rendered viewer** shows it flush. That indentation is a **Joplin
      core** editor bug, **not** Ridgeline — it reproduces in a clean profile with **no plugins at all**
      (the editor renders the leading whitespace at the heading's larger font; the viewer strips it per
      CommonMark). Removing the leading space fixes the line. Toggling Ridgeline on/off does not change
      it in the slightest. A ready-to-file upstream report is in the round-2 hand-off notes.
- [ ] **P2 — Narrower, airier bars.** The bars are **thinner/shorter** than before (H1 ≈ 28px down to
      H6 ≈ 8px) and the stack has **more air**: visible gaps on **both sides** of the bars inside the
      strip, and a **larger vertical gap** between bars. It should read as a thin, airy stack.
- [ ] **P3 — Single-line TOC rows.** Hovering opens the TOC. Every row is **one line tall**. A heading
      too long for the panel is trimmed with a CSS **ellipsis** (`…`) — it must **not** wrap onto a
      second line. The panel may be a bit **wider** than before, up to a moderate cap.
- [ ] **P4 — Pointer cursor on rows.** Moving the pointer over a TOC row shows a **pointer (hand)**
      cursor — in **both** the editor and the rendered viewer. (Check the real on-screen cursor, not
      just the hover highlight.)
- [ ] **P5 — Selection drag does NOT open the TOC.** While **selecting text** (mouse button held),
      drag the pointer across the bars — the TOC must **stay closed** and the **selection must not be
      interrupted**. A plain **hover with no button pressed** over the bars still opens it. (This is the
      reverse of the round-1 R7 behaviour.)

Round-1 fixes R1–R6 (top anchor, right-aligned bars, current-bar prominence, panel overlay, row hover
highlight, trigger-zone) remain in force — spot-check them too.

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
