import { test, expect, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, findSecondaryWindow, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  waitForEditorStrip,
  EDITOR_STRIP,
  VIEWER_IFRAME,
} from './helpers';

/**
 * Z2 — VISIBILITY CONTROL. A boolean "Show minimap" setting (default true) hides/shows the strip in
 * BOTH surfaces, in EVERY window, live (no relaunch). A "Ridgeline: Toggle minimap" command (Tools →
 * Ridgeline submenu, accelerator Ctrl+Alt+M) flips it. Hidden = fully unmounted (listeners torn down),
 * not merely invisible.
 *
 * This exercises the COMMAND path (which sets the setting, firing joplin.settings.onChange → editor
 * strip pushed live, viewer strip polled), asserting the editor strip DETACHES and the viewer strip is
 * removed when off and both return when on — with no relaunch. A secondary window is also checked.
 */
async function fireToggle(win: Page): Promise<void> {
  // Focus the editor so the accelerator lands, then flip the setting via the registered command.
  await win.locator('.cm-content').first().click();
  await win.waitForTimeout(200);
  await win.keyboard.press('Control+Alt+m');
}

// The note-toolbar button created for the toggle command. Its `title` attribute is the command label
// ("Ridgeline: Toggle minimap"); Joplin may append the keymap accelerator (e.g. " (Ctrl+Alt+M)"), so
// match by prefix rather than an exact string.
const TOOLBAR_BUTTON = 'button[title^="Ridgeline: Toggle minimap"]';

test.describe('Ridgeline visibility toggle (Show minimap)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Visibility Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
    // Make the viewer visible up front so both surfaces are live for the toggle checks.
    await ensureViewerVisible(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('toggling off hides the strip in editor AND viewer live; toggling on restores it', async () => {
    const { win } = joplin;
    const editorStrip = win.locator(EDITOR_STRIP);
    const viewerStrip = win.frameLocator(VIEWER_IFRAME).locator('#ridgeline-viewer-strip');

    // Baseline: both present.
    await expect(editorStrip).toBeAttached();
    await expect(viewerStrip).toBeAttached({ timeout: 15_000 });

    // Toggle OFF via the Tools command — no relaunch.
    await fireToggle(win);
    // Editor strip is fully unmounted (removed from the DOM), not just hidden.
    await expect(editorStrip).toHaveCount(0, { timeout: 15_000 });
    // Viewer strip is removed too (polled up within ~pollMs).
    await expect(viewerStrip).toHaveCount(0, { timeout: 15_000 });

    // Toggle ON again — both come back, still no relaunch.
    await fireToggle(win);
    await expect(editorStrip).toHaveCount(1, { timeout: 15_000 });
    await expect(viewerStrip).toHaveCount(1, { timeout: 15_000 });
  });

  // The note-toolbar button (fa-stream icon) flips the SAME "Show minimap" setting as the Tools
  // command / Ctrl+Alt+M, so clicking it must hide the strip in both surfaces and clicking again
  // restore it — live, no relaunch. Its hover title is the command label; Joplin may append the
  // keymap accelerator, so we match the title by prefix. The click is dispatched (not a real mouse
  // click) to match how the panel-row click and Cockpit's own toolbar-button test are fired: a
  // synthetic click still runs the React handler → the registered command → the setting flip, and it
  // sidesteps hit-testing flakiness under the virtual display.
  test('the note-toolbar button (fa-stream) toggles the strip live in both surfaces', async () => {
    const { win } = joplin;
    const button = win.locator(TOOLBAR_BUTTON);
    // Registered against the note toolbar; present because a note is open.
    await expect(button).toBeVisible({ timeout: 20_000 });
    // It renders the chosen fa-stream icon (not some fallback), proving the iconName took effect.
    await expect(button.locator('i.fa-stream')).toHaveCount(1);

    const editorStrip = win.locator(EDITOR_STRIP);
    const viewerStrip = win.frameLocator(VIEWER_IFRAME).locator('#ridgeline-viewer-strip');

    // Baseline: both surfaces show the strip.
    await expect(editorStrip).toHaveCount(1, { timeout: 15_000 });
    await expect(viewerStrip).toHaveCount(1, { timeout: 15_000 });

    // Click the toolbar button — the strip unmounts in editor AND viewer, no relaunch.
    await button.dispatchEvent('click');
    await expect(editorStrip).toHaveCount(0, { timeout: 15_000 });
    await expect(viewerStrip).toHaveCount(0, { timeout: 15_000 });

    // Click again — both come back.
    await button.dispatchEvent('click');
    await expect(editorStrip).toHaveCount(1, { timeout: 15_000 });
    await expect(viewerStrip).toHaveCount(1, { timeout: 15_000 });
  });

  test('the toggle also hides/shows the strip in a secondary window', async () => {
    const { win, browser } = joplin;

    // Open the note in a new window.
    await win.locator('.cm-content').first().click().catch(() => {});
    await win.waitForTimeout(200);
    await win.keyboard.press('Control+Alt+n');
    const secondary = await findSecondaryWindow(browser, win, 30_000);
    expect(secondary, 'a secondary window should open on Ctrl+Alt+N').not.toBeNull();
    if (!secondary) return;

    const secStrip = secondary.locator(EDITOR_STRIP);
    await expect(secStrip).toBeAttached({ timeout: 30_000 });

    // Toggle OFF (from the main window) — the secondary window's strip unmounts too.
    await fireToggle(win);
    await expect(secStrip).toHaveCount(0, { timeout: 15_000 });
    await expect(win.locator(EDITOR_STRIP)).toHaveCount(0, { timeout: 15_000 });

    // Toggle ON — it returns in the secondary window.
    await fireToggle(win);
    await expect(secStrip).toHaveCount(1, { timeout: 15_000 });
    await expect(win.locator(EDITOR_STRIP)).toHaveCount(1, { timeout: 15_000 });
  });
});
