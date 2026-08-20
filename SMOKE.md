# Ridgeline — manual smoke checklist

This is the early **smoke build** of Ridgeline. It does not draw the real minimap yet — just an
ugly coloured strip that proves the risky primitives work end-to-end in a real Joplin desktop.

## Install

1. Build (or use the committed artifact): `npm install && npm run dist` → produces
   `publish/io.github.pmslava.ridgeline.jpl`.
2. In Joplin desktop (3.7.6): **Settings → Plugins → Install from file**, pick
   `publish/io.github.pmslava.ridgeline.jpl`.
3. **Fully quit and relaunch Joplin.** Do **not** use Ctrl+R — it reloads the renderer without
   re-running plugin startup cleanly.

## What you should see

A ~14px vertical blue→purple strip at one edge of the editor and (in split/viewer mode) the same
strip at the edge of the rendered note. The strip carries a small dark label showing the current
heading, plus light "tick" marks — one per heading. The tick for the current section turns yellow.

Use a note with several `#` headings and enough text to scroll.

## Checklist

- [ ] **Editor strip (S1).** Open a note with headings in the Markdown editor. A coloured strip sits
      at the **left** edge of the editor pane.
- [ ] **Editor current heading (S2).** The strip's label shows the top-most heading in view. Scroll
      the editor down — the label updates live to the heading you have scrolled to (it tracks the
      viewport top, not the cursor).
- [ ] **Viewer strip surviving edits (S4).** Switch to split or viewer mode (Ctrl+L). The same strip
      appears in the rendered note. Type into the note and switch to another note and back — there is
      still **exactly one** strip (it must not pile up duplicates).
- [ ] **Viewer current heading (S5).** Scroll the rendered note — its strip label updates live too.
- [ ] **Click to jump (S6).** Click a tick on the editor strip — the editor jumps to that heading.
      Click a tick on the viewer strip — the rendered note jumps to that heading. In split view both
      panes should follow.
- [ ] **Side = right (S7).** Settings → Ridgeline → *Strip side* → **Right**. Quit + relaunch. Both
      strips now sit on the **right** edge (the editor one tucked just inside the scrollbar).
- [ ] **Reserve mode (S7/S3).** Settings → Ridgeline → set *Editor strip mode* and *Viewer strip
      mode* to **Reserve margin**. Quit + relaunch. The text is now pushed away from the strip so it
      is no longer drawn over (in *Overlay* mode the strip sits on top of the text). Open a **split**
      view and scroll — editor↔viewer scroll-sync should still behave normally.
- [ ] **Multi-window (S8).** With the note selected, press **Ctrl+Alt+N** (Note → *Open note in new
      window*, or right-click the note → *Edit in new window*). The strip must appear in the **new
      window** too, and keep tracking its own scroll independently of the main window.

## Notes

- Reload the plugin only via a **full quit + relaunch**, never Ctrl+R.
- Settings are stored in file storage, so they persist across restarts and can be pre-seeded in a
  profile's `settings.json` under `plugin-io.github.pmslava.ridgeline.<key>` (this is how the E2E
  suite exercises side/reserve without clicking through the UI).
