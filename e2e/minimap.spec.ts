import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  buildSetextNoteBody,
  createNotebook,
  createNoteWithBody,
  editorCurrentHeading,
  editorScrollTop,
  ensureViewerVisible,
  MIXED_HEADINGS,
  scrollEditorTo,
  selectNoteByTitle,
  SETEXT_REAL_HEADING_COUNT,
  viewerCurrentHeading,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * Phase-2 minimap behaviour on a note whose headings span H1..H6. One default launch covers the
 * level-encoded bar widths, current-bar tracking, the hover-expand TOC (row count + indentation +
 * current-row highlight + click-to-jump + collapse), setext parity, and live settings.
 */
test.describe('Ridgeline compact minimap + hover TOC', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Mixed Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  async function editorBarWidths(): Promise<number[]> {
    const { win } = joplin;
    const bars = win.locator(`${EDITOR_STRIP} .ridgeline-bar`);
    const count = await bars.count();
    const widths: number[] = [];
    for (let i = 0; i < count; i++) {
      const box = await bars.nth(i).boundingBox();
      widths.push(box ? box.width : -1);
    }
    return widths;
  }

  // D1 — one bar per heading, lengths strictly diminishing by heading level (H1 longest → H6
  // shortest) per the shared design tokens (40,30,22,19,17,15).
  test('bar count matches headings and widths are strictly ordered by level', async () => {
    expect(await joplin.win.locator(`${EDITOR_STRIP} .ridgeline-bar`).count()).toBe(
      MIXED_HEADINGS.length
    );
    const widths = await editorBarWidths();
    expect(widths.length).toBe(MIXED_HEADINGS.length);
    for (let i = 1; i < widths.length; i++) {
      // Each deeper level's bar is strictly shorter than the one above it.
      expect(widths[i - 1]).toBeGreaterThan(widths[i]);
    }
    // Sanity-check the extremes against the tokens (H1 = 40, H6 = 15).
    expect(Math.round(widths[0])).toBe(40);
    expect(Math.round(widths[widths.length - 1])).toBe(15);
  });

  // D1 — the current bar (bold/tall + is-current) moves as the viewport top passes headings.
  test('current-bar highlight moves on scroll', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    await expect.poll(() => editorCurrentHeading(win), { timeout: 5_000 }).toBe(MIXED_HEADINGS[0].text);
    // Exactly one current bar.
    expect(await win.locator(`${EDITOR_STRIP} .ridgeline-bar.is-current`).count()).toBe(1);

    await win.evaluate(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => editorCurrentHeading(win), { timeout: 5_000 })
      .toBe(MIXED_HEADINGS[MIXED_HEADINGS.length - 1].text);
    expect(await win.locator(`${EDITOR_STRIP} .ridgeline-bar.is-current`).count()).toBe(1);
  });

  // D2 — hovering the strip expands the TOC panel: one row per heading, indentation increasing with
  // level, and the current heading's row highlighted (is-current + bold).
  test('hover expands the TOC panel with correct rows, indentation and current highlight', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0); // current heading = first
    const strip = win.locator(EDITOR_STRIP);
    await strip.hover();

    await expect.poll(() => strip.getAttribute('data-expanded'), { timeout: 5_000 }).toBe('true');
    const panel = win.locator(`${EDITOR_STRIP} .ridgeline-panel`);
    await expect(panel).toBeVisible();

    const rows = win.locator(`${EDITOR_STRIP} .ridgeline-panel-row`);
    expect(await rows.count()).toBe(MIXED_HEADINGS.length);

    // Indentation strictly increases with heading level.
    const pads: number[] = [];
    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      pads.push(
        await rows.nth(i).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft) || 0)
      );
    }
    for (let i = 1; i < pads.length; i++) {
      expect(pads[i]).toBeGreaterThan(pads[i - 1]);
    }

    // The first row is the current one at top-of-scroll.
    const current = win.locator(`${EDITOR_STRIP} .ridgeline-panel-row.is-current`);
    expect(await current.count()).toBe(1);
    expect(await current.first().getAttribute('data-index')).toBe('0');
    const weight = await current.first().evaluate((el) => getComputedStyle(el).fontWeight);
    expect(Number(weight)).toBeGreaterThanOrEqual(700);

    // Move the pointer off the strip.
    await win.mouse.move(600, 400);
  });

  // D2 — clicking a panel row jumps the editor to that heading.
  test('clicking a panel row jumps the editor', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    expect(await editorScrollTop(win)).toBeLessThan(20);

    const lastIndex = MIXED_HEADINGS.length - 1;
    await win.locator(EDITOR_STRIP).hover();
    await win.locator(`[data-testid="ridgeline-editor-row-${lastIndex}"]`).dispatchEvent('click');
    await expect.poll(() => editorScrollTop(win), { timeout: 10_000 }).toBeGreaterThan(200);
    await win.mouse.move(600, 400);
  });

  // D2 — the panel collapses after the pointer leaves (grace delay), and reopens on re-hover.
  test('panel collapses on mouseleave', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);
    await strip.hover();
    await expect.poll(() => strip.getAttribute('data-expanded'), { timeout: 5_000 }).toBe('true');

    // Move well away from the strip; after the ~200ms grace it must collapse.
    await win.mouse.move(700, 450);
    await expect.poll(() => strip.getAttribute('data-expanded'), { timeout: 5_000 }).toBe('false');
    await expect(win.locator(`${EDITOR_STRIP} .ridgeline-panel`)).toBeHidden();
  });

  // D4 — setext + ATX + fenced fake-heading: editor and viewer must agree on the heading count.
  test('setext parity: editor and viewer agree on heading count', async () => {
    const { win } = joplin;
    await createNoteWithBody(win, 'Ridgeline Setext Note', buildSetextNoteBody());
    await waitForEditorStrip(win);

    await expect
      .poll(() => win.locator(`${EDITOR_STRIP} .ridgeline-bar`).count(), { timeout: 10_000 })
      .toBe(SETEXT_REAL_HEADING_COUNT);

    const frame = await ensureViewerVisible(win);
    await expect(frame.locator('#ridgeline-viewer-strip .ridgeline-bar')).toHaveCount(
      SETEXT_REAL_HEADING_COUNT,
      { timeout: 15_000 }
    );
  });

  // D3 — changing a setting mid-session updates BOTH surfaces without a relaunch. The registered
  // "Ridgeline: Toggle strip side" command (accelerator Ctrl+Alt+R) flips the `side` setting, which
  // fires joplin.settings.onChange → the editor strip is pushed live and the viewer strip polls it up.
  test('live settings: toggling side updates editor and viewer without relaunch', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);
    await expect(strip).toHaveAttribute('data-side', 'left');
    const frame = await ensureViewerVisible(win);
    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveAttribute('data-side', 'left', {
      timeout: 15_000,
    });

    // Fire the toggle command via its accelerator (focus the editor first so the accelerator lands).
    await win.locator('.cm-content').first().click();
    await win.waitForTimeout(300);
    await win.keyboard.press('Control+Alt+r');

    // Editor is pushed live via editor.execCommand; the viewer polls (~700ms) and rebuilds.
    await expect(strip).toHaveAttribute('data-side', 'right', { timeout: 15_000 });
    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveAttribute('data-side', 'right', {
      timeout: 15_000,
    });
  });
});
