import { test, expect, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * showToolbarButton — the fa-stream note-toolbar toggle button can be hidden by a setting (default
 * true). Because JoplinViewsToolbarButtons exposes create() only (no remove/hide/destroy), the plugin
 * gates the button at startup: it is created only when the setting is true, and a change to the setting
 * takes effect on the next relaunch — so a seeded profile is exactly how a real user's choice reaches
 * startup. This spec seeds each state and asserts presence/absence of the button, and that hiding the
 * button leaves the Ctrl+Alt+M toggle fully working (the button is only one of three ways to toggle).
 *
 * The button's `title` attribute is the command label ("Ridgeline: Toggle minimap"); Joplin may append
 * the keymap accelerator (e.g. " (Ctrl+Alt+M)"), so match by prefix — the same TOOLBAR_BUTTON selector
 * z2-visibility.spec.ts uses.
 */
const TOOLBAR_BUTTON = 'button[title^="Ridgeline: Toggle minimap"]';

async function fireToggle(win: Page): Promise<void> {
  // Focus the editor so the accelerator lands, then flip the setting via the registered command.
  await win.locator('.cm-content').first().click();
  await win.waitForTimeout(200);
  await win.keyboard.press('Control+Alt+m');
}

test.describe('Ridgeline toolbar button setting: default (showToolbarButton unset → true)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    // No seed for showToolbarButton — it defaults to true, so the button must be created.
    joplin = await launchJoplin();
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Toolbar Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('the fa-stream toolbar button exists in the note toolbar by default', async () => {
    const { win } = joplin;
    const button = win.locator(TOOLBAR_BUTTON);
    await expect(button).toBeVisible({ timeout: 20_000 });
    // It renders the chosen fa-stream icon (not a fallback), proving the iconName took effect.
    await expect(button.locator('i.fa-stream')).toHaveCount(1);
  });
});

test.describe('Ridgeline toolbar button setting: seeded showToolbarButton=false', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ seed: { showToolbarButton: false } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Toolbar Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('the toolbar button is absent when the setting is seeded false', async () => {
    const { win } = joplin;
    // A note is open (the editor strip is up), so the note toolbar is present — the button would be
    // there if it had been created. It must not be: startup skipped toolbarButtons.create.
    await expect(win.locator(EDITOR_STRIP)).toBeAttached();
    await expect(win.locator(TOOLBAR_BUTTON)).toHaveCount(0);
    await expect(win.locator(TOOLBAR_BUTTON)).toHaveCount(0, { timeout: 5_000 });
  });

  test('Ctrl+Alt+M still toggles the strip when the toolbar button is hidden', async () => {
    const { win } = joplin;
    const editorStrip = win.locator(EDITOR_STRIP);

    // Baseline: strip present (the setting hides only the button, never the strip itself).
    await expect(editorStrip).toHaveCount(1, { timeout: 15_000 });

    // Toggle OFF via the accelerator — the strip unmounts, no relaunch, no toolbar button needed.
    await fireToggle(win);
    await expect(editorStrip).toHaveCount(0, { timeout: 15_000 });

    // Toggle ON — it comes back.
    await fireToggle(win);
    await expect(editorStrip).toHaveCount(1, { timeout: 15_000 });
  });
});
