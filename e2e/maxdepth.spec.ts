import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * D1/D3 — maxDepth filtering. Seeded with maxDepth=3 on a note whose headings span H1..H6, so both
 * the editor and viewer minimaps must show exactly the 3 headings at levels 1-3 and hide H4-H6.
 */
test.describe('Ridgeline maxDepth (seeded = 3)', () => {
  let joplin: JoplinInstance;
  const MAX_DEPTH = 3;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ seed: { maxDepth: MAX_DEPTH } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Depth Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('editor minimap shows only headings up to maxDepth', async () => {
    const { win } = joplin;
    await expect
      .poll(() => win.locator(`${EDITOR_STRIP} .ridgeline-bar`).count(), { timeout: 10_000 })
      .toBe(MAX_DEPTH);
    // Every shown bar is at a level <= maxDepth.
    const levels = await win
      .locator(`${EDITOR_STRIP} .ridgeline-bar`)
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-level'))));
    expect(levels).toEqual([1, 2, 3]);
  });

  test('viewer minimap shows only headings up to maxDepth', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    await expect(frame.locator('#ridgeline-viewer-strip .ridgeline-bar')).toHaveCount(MAX_DEPTH, {
      timeout: 15_000,
    });
    const levels = await frame
      .locator('#ridgeline-viewer-strip .ridgeline-bar')
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-level'))));
    expect(levels).toEqual([1, 2, 3]);
  });
});
