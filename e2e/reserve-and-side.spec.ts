import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  buildNoteBody,
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * Seeded settings: side=right, editorMode=reserve, viewerMode=reserve. One launch covers S3 (editor
 * reserve margin) and S7 (side=right applied to both panes, with the editor strip offset by the
 * scrollbar width).
 */
test.describe('Ridgeline reserve mode + right side (seeded settings)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ seed: { side: 'right', editorMode: 'reserve', viewerMode: 'reserve' } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Reserve Note', buildNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  // S7 (editor) — strip sits on the right edge, offset inward by the editor's scrollbar width.
  test('S7: editor strip is on the right edge', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);
    await expect(strip).toBeAttached();
    expect(await strip.getAttribute('data-side')).toBe('right');

    const box = await strip.boundingBox();
    const editorBox = await win.locator('.cm-editor').first().boundingBox();
    expect(box).not.toBeNull();
    expect(editorBox).not.toBeNull();
    if (box && editorBox) {
      const stripRight = box.x + box.width;
      const editorRight = editorBox.x + editorBox.width;
      // Right-aligned (allowing for the scrollbar-width offset).
      expect(editorRight - stripRight).toBeLessThan(24);
      expect(editorRight - stripRight).toBeGreaterThanOrEqual(0);
      // Clearly on the right half of the editor, not the left.
      expect(box.x).toBeGreaterThan(editorBox.x + editorBox.width / 2);
    }
  });

  // S3 — reserve mode adds a right-side margin on the editor content so text is not covered.
  test('S3: editor reserve mode pads the content so text is not under the strip', async () => {
    const { win } = joplin;
    const paddingRight = await win.evaluate(() => {
      const el = document.querySelector('.cm-content') as HTMLElement | null;
      if (!el) return 0;
      return parseFloat(getComputedStyle(el).paddingRight) || 0;
    });
    // We reserve STRIP_WIDTH_PX (14) + gap (4) = 18px.
    expect(paddingRight).toBeGreaterThanOrEqual(14);
  });

  // S7 (viewer) — the viewer strip is also on the right, and reserve adds a right body margin.
  test('S7: viewer strip is on the right and reserve pads the body', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    const strip = frame.locator('#ridgeline-viewer-strip');
    await expect(strip).toBeAttached({ timeout: 15_000 });
    expect(await strip.getAttribute('data-side')).toBe('right');

    const marginRight = await frame.evaluate(() => {
      return parseFloat(getComputedStyle(document.body).marginRight) || 0;
    });
    expect(marginRight).toBeGreaterThanOrEqual(14);
  });
});
