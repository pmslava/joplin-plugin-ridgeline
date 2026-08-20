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
  hoverEditorBars,
  MIXED_HEADINGS,
  scrollEditorTo,
  SETEXT_REAL_HEADING_COUNT,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';
import { DESIGN_TOKENS } from '../src/tokens';

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

  // The current-section bar carries a small length boost (R3, currentBarLengthBoostPx in tokens), so
  // its rendered width is longer than its pure level width. Normalise that out to validate the
  // per-level (base) length encoding.
  const CURRENT_BAR_LENGTH_BOOST = DESIGN_TOKENS.currentBarLengthBoostPx;

  // Returns the BASE bar length per bar (rendered width minus the current-bar boost, if current).
  async function editorBaseBarWidths(): Promise<number[]> {
    const { win } = joplin;
    const bars = win.locator(`${EDITOR_STRIP} .ridgeline-bar`);
    const count = await bars.count();
    const widths: number[] = [];
    for (let i = 0; i < count; i++) {
      const box = await bars.nth(i).boundingBox();
      const isCurrent = (await bars.nth(i).getAttribute('class'))?.includes('is-current') ?? false;
      widths.push(box ? box.width - (isCurrent ? CURRENT_BAR_LENGTH_BOOST : 0) : -1);
    }
    return widths;
  }

  // D1/R9 — one bar per heading, base lengths diminishing LINEARLY by heading level (H1 longest → H6
  // shortest) per the shared design tokens (28/24/20/16/12/8 — an equal 4px step per level; P2).
  test('bar count matches headings and widths are linearly ordered by level', async () => {
    await scrollEditorTo(joplin.win, 0);
    expect(await joplin.win.locator(`${EDITOR_STRIP} .ridgeline-bar`).count()).toBe(
      MIXED_HEADINGS.length
    );
    const widths = await editorBaseBarWidths();
    expect(widths.length).toBe(MIXED_HEADINGS.length);
    for (let i = 1; i < widths.length; i++) {
      // Each deeper level's base bar is strictly shorter than the one above it.
      expect(widths[i - 1]).toBeGreaterThan(widths[i]);
    }
    // Sanity-check the extremes against the tokens (H1 = longest, H6 = shortest).
    expect(Math.round(widths[0])).toBe(DESIGN_TOKENS.levelLengths[1]);
    expect(Math.round(widths[widths.length - 1])).toBe(DESIGN_TOKENS.levelLengths[6]);
    // R9: the decrements are EQUAL (linear), so every adjacent pair is equally distinguishable. Each
    // step is ~5px; assert they match within 1px of each other.
    const steps = widths.slice(1).map((w, i) => widths[i] - w);
    const minStep = Math.min(...steps);
    const maxStep = Math.max(...steps);
    expect(maxStep - minStep).toBeLessThanOrEqual(1);
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
    await hoverEditorBars(win);

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
    await hoverEditorBars(win);
    await win.locator(`[data-testid="ridgeline-editor-row-${lastIndex}"]`).dispatchEvent('click');
    await expect.poll(() => editorScrollTop(win), { timeout: 10_000 }).toBeGreaterThan(200);
    await win.mouse.move(600, 400);
  });

  // D2 — the panel collapses after the pointer leaves (grace delay), and reopens on re-hover.
  test('panel collapses on mouseleave', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);
    await hoverEditorBars(win);
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

  // P4 — the viewer TOC rows must show a pointer cursor too, asserted on the element
  // document.elementFromPoint actually returns at the row centre (the displayed-cursor source).
  test('P4: viewer TOC rows show a pointer cursor on the hit element', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    // Side may be 'right' from the previous test; hover the viewer bar stack to expand the panel.
    const bars = frame.locator('#ridgeline-viewer-strip .ridgeline-bars');
    await expect(bars).toBeVisible({ timeout: 15_000 });
    await bars.hover();
    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveAttribute('data-expanded', 'true', {
      timeout: 5_000,
    });
    const row = frame.locator('#ridgeline-viewer-strip .ridgeline-panel-row').nth(2);
    await row.hover();
    const hit = await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { tag: target?.tagName ?? null, cls: target?.className ?? null, cursor: target ? getComputedStyle(target).cursor : null };
    });
    expect(hit.cursor, `viewer elementFromPoint hit <${hit.tag} class="${hit.cls}"> cursor`).toBe('pointer');
  });
});
