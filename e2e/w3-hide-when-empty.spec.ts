import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  waitForEditorStrip,
  SETTLE,
  EDITOR_STRIP,
  VIEWER_IFRAME,
} from './helpers';

/**
 * W3 — HIDE WHEN THE NOTE HAS NO HEADINGS. A boolean "hideWhenEmpty" setting (default TRUE) fully
 * unmounts the strip AND drops its reserved margin, in BOTH surfaces / every window, on a note that
 * has 0 headings. It reacts LIVE: typing the first heading mounts the strip (+ margin), deleting the
 * last heading unmounts it. showMinimap=false always wins (hidden); hideWhenEmpty=false restores the
 * pre-W3 behaviour (an empty strip + reserved margin even with no headings).
 *
 * These tests run in RESERVE mode on both surfaces, so the reserved margin (not just the strip) is
 * observable: in the default (hide-when-empty) profile a heading-less note must have NO strip and NO
 * reserve padding at all.
 */

// A body with no ATX/setext headings at all.
const EMPTY_BODY = [
  'Just some plain paragraph text, deliberately without any headings.',
  '',
  'A second paragraph, still no headings anywhere in this note.',
  '',
  'One more line so the note is not trivially short.',
].join('\n');

// The same note, now carrying a single real heading.
const HEADED_BODY = [
  '# Hello World',
  '',
  'Body text under the one and only heading in this note.',
  '',
  'Another paragraph so there is something to render.',
].join('\n');

async function editorStripCount(win: Page): Promise<number> {
  return win.locator(EDITOR_STRIP).count();
}

// The reserve-mode left padding CodeMirror's content carries (0 when no margin is reserved).
async function editorReservePadding(win: Page): Promise<number> {
  return win.evaluate(() => {
    const el = document.querySelector('.cm-content') as HTMLElement | null;
    return el ? parseFloat(getComputedStyle(el).paddingLeft) || 0 : -1;
  });
}

async function viewerStripCount(frame: Frame): Promise<number> {
  return frame.locator('#ridgeline-viewer-strip').count();
}

// The reserve-mode left margin the viewer body carries (0 when no margin is reserved).
async function viewerBodyMargin(frame: Frame): Promise<number> {
  return frame.evaluate(() => parseFloat(getComputedStyle(document.body).marginLeft) || 0);
}

// Replace the whole editor body with `body` (select-all → delete → type), so the note deterministically
// gains or loses its only heading in a single doc change — exactly the live crossing W3 must react to.
async function setEditorBody(win: Page, body: string): Promise<void> {
  await win.locator('.cm-content').first().click();
  await win.waitForTimeout(200);
  await win.keyboard.press('Control+a');
  await win.keyboard.press('Delete');
  await win.waitForTimeout(150);
  await win.keyboard.type(body);
  await win.waitForTimeout(SETTLE);
}

test.describe('W3 hide-when-empty (default true) — reserve mode, both surfaces', () => {
  let joplin: JoplinInstance;
  let frame: Frame;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ seed: { editorMode: 'reserve', viewerMode: 'reserve' } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    // A heading-less note: with hideWhenEmpty defaulting true, NO strip should mount — so we must NOT
    // wait for one here (it never appears).
    await createNoteWithBody(joplin.win, 'W3 Heading-less Note', EMPTY_BODY);
    // Split view so the editor is editable AND the rendered viewer is observable at the same time.
    frame = await ensureViewerVisible(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('heading-less note: no strip and NO reserve padding on either surface', async () => {
    const { win } = joplin;
    // Editor: strip fully unmounted, and the reserve margin dropped (padding well under the ~18px it
    // would otherwise reserve).
    await expect(win.locator(EDITOR_STRIP)).toHaveCount(0, { timeout: 15_000 });
    expect(await editorReservePadding(win)).toBeLessThan(14);
    // Viewer: strip removed and the body margin dropped.
    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveCount(0, { timeout: 15_000 });
    expect(await viewerBodyMargin(frame)).toBeLessThan(14);
  });

  test('typing the first heading mounts the strip + reserve margin live (both surfaces)', async () => {
    const { win } = joplin;
    await setEditorBody(win, HEADED_BODY);

    // Editor: strip mounts, reserve padding reappears — no relaunch.
    await expect(win.locator(EDITOR_STRIP)).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => editorReservePadding(win), { timeout: 15_000 }).toBeGreaterThanOrEqual(14);
    await expect(win.locator(`${EDITOR_STRIP} .ridgeline-bar`)).toHaveCount(1, { timeout: 15_000 });

    // Viewer: strip mounts (polled/rebuilt up), body margin reappears.
    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => viewerBodyMargin(frame), { timeout: 15_000 }).toBeGreaterThanOrEqual(14);
  });

  test('deleting the last heading unmounts the strip + drops the margin live (both surfaces)', async () => {
    const { win } = joplin;
    await setEditorBody(win, EMPTY_BODY);

    await expect(win.locator(EDITOR_STRIP)).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => editorReservePadding(win), { timeout: 15_000 }).toBeLessThan(14);

    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => viewerBodyMargin(frame), { timeout: 15_000 }).toBeLessThan(14);
  });
});

test.describe('W3 hideWhenEmpty=false — the empty strip + margin are kept', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin({
      seed: { editorMode: 'reserve', viewerMode: 'reserve', hideWhenEmpty: false },
    });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'W3 Kept Empty Note', EMPTY_BODY);
    // With hideWhenEmpty off, the strip mounts even on a heading-less note, so waiting for it is valid.
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('heading-less note still shows the strip + reserve margin on both surfaces', async () => {
    const { win } = joplin;
    // Editor: strip present (with zero bars) and the reserve margin kept.
    await expect(win.locator(EDITOR_STRIP)).toHaveCount(1);
    expect(await win.locator(`${EDITOR_STRIP} .ridgeline-bar`).count()).toBe(0);
    expect(await editorReservePadding(win)).toBeGreaterThanOrEqual(14);

    // Viewer: strip present (zero bars) and the body margin kept.
    const frame = await ensureViewerVisible(win);
    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveCount(1, { timeout: 15_000 });
    expect(await frame.locator('#ridgeline-viewer-strip .ridgeline-bar').count()).toBe(0);
    await expect.poll(() => viewerBodyMargin(frame), { timeout: 15_000 }).toBeGreaterThanOrEqual(14);
  });
});
