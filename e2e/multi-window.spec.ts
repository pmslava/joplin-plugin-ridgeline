import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, findSecondaryWindow, JoplinInstance } from './launch';
import {
  buildNoteBody,
  createNotebook,
  createNoteWithBody,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * S8 — multi-window. Joplin can open a note in a secondary window (command openNoteInNewWindow,
 * default accelerator Ctrl+Alt+N). Secondary windows are created with window.open('about:blank') and
 * the editor is rendered into them via a React portal, so they surface as a separate CDP page whose
 * DOM hosts its own CodeMirror editor. Because content scripts are instantiated per EditorView, the
 * Ridgeline strip must appear in that window too.
 *
 * This is automated: we fire the accelerator, find the new CDP page, and assert the strip mounts in
 * it. If the accelerator does not open a window under the virtual display, the test fails loudly
 * rather than silently passing — see SMOKE.md for the manual fallback.
 */
test.describe('Ridgeline multi-window', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline MW Note', buildNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('S8: the strip appears in a secondary window', async () => {
    const { win, browser } = joplin;

    // Make sure the note is selected/focused, then open it in a new window.
    await win.locator('.note-list-item .title span', { hasText: 'Ridgeline MW Note' })
      .first()
      .click()
      .catch(() => {});
    await win.waitForTimeout(500);
    await win.locator('.cm-content').first().click().catch(() => {});
    await win.waitForTimeout(300);
    await win.keyboard.press('Control+Alt+n');

    const secondary = await findSecondaryWindow(browser, win, 30_000);
    expect(secondary, 'a secondary window should open on Ctrl+Alt+N').not.toBeNull();

    if (secondary) {
      // The editor strip must mount in the secondary window's editor DOM.
      await expect(secondary.locator(EDITOR_STRIP)).toBeAttached({ timeout: 30_000 });
      const count = await secondary.locator(EDITOR_STRIP).count();
      expect(count).toBe(1);
    }
  });
});
