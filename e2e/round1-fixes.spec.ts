import { test, expect, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNoteWithBody,
  hoverEditorBars,
  scrollEditorTo,
  waitForEditorStrip,
  EDITOR_STRIP,
  EDITOR_BARS,
} from './helpers';

/**
 * Round-1 UX fixes (R1–R7) verified against observable geometry/DOM.
 *
 * One default launch (side=left, overlay). The note mixes heading levels and includes one very long
 * heading so the hover panel's no-truncation (R4) behaviour can be checked.
 */
const LONG_HEADING =
  'A very long heading that must not be truncated with an ellipsis but should wrap across lines inside the panel';

function buildBody(): string {
  const lines: string[] = [];
  const push = (h: string, level: number, fillerLast = false) => {
    lines.push(`${'#'.repeat(level)} ${h}`);
    const filler = fillerLast ? 90 : 6;
    for (let n = 0; n < filler; n++) lines.push(`Body line ${n + 1}.`);
  };
  push('Alpha One', 1);
  push(LONG_HEADING, 2);
  push('Charlie Three', 3);
  push('Delta Four', 4);
  push('Echo Five', 5);
  push('Foxtrot Six', 6, true);
  return lines.join('\n');
}

interface Box { x: number; y: number; width: number; height: number }
async function boxOf(win: Page, selector: string, nth = 0): Promise<Box> {
  const b = await win.locator(selector).nth(nth).boundingBox();
  if (!b) throw new Error(`no box for ${selector} [${nth}]`);
  return b;
}

async function collapsePanel(win: Page): Promise<void> {
  await win.mouse.move(950, 450);
  await win.waitForTimeout(400);
}

test.describe('Ridgeline round-1 fixes (R1–R7)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Round1 Note', buildBody());
    await waitForEditorStrip(joplin.win);
    await scrollEditorTo(joplin.win, 0);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  // R1 — the bar stack anchors to the TOP of the pane (small offset), not vertically centred.
  test('R1: bar stack anchors near the top of the pane', async () => {
    const { win } = joplin;
    const editor = await boxOf(win, '.cm-editor');
    const bars = await boxOf(win, EDITOR_BARS);
    const offsetFromTop = bars.y - editor.y;
    // Anchored near the top: within a small band, and FAR above the vertical centre it used to sit at.
    expect(offsetFromTop).toBeGreaterThanOrEqual(0);
    expect(offsetFromTop).toBeLessThan(40);
    expect(offsetFromTop).toBeLessThan(editor.height / 4);
  });

  // R2 — bars are RIGHT-aligned within the strip (flush right edge, ragged left) on BOTH sides.
  async function assertBarsRightAligned(win: Page): Promise<void> {
    const bars = win.locator(`${EDITOR_STRIP} .ridgeline-bar`);
    const count = await bars.count();
    expect(count).toBeGreaterThan(1);
    const rights: number[] = [];
    const lefts: number[] = [];
    for (let i = 0; i < count; i++) {
      const b = await bars.nth(i).boundingBox();
      if (b) {
        rights.push(b.x + b.width);
        lefts.push(b.x);
      }
    }
    // Right edges align (flush right)...
    expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(1.5);
    // ...and left edges are ragged (different lengths => different left starts).
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeGreaterThan(3);
  }

  test('R2: bars are right-aligned on the left side', async () => {
    await assertBarsRightAligned(joplin.win);
  });

  test('R2: bars are right-aligned on the right side too', async () => {
    const { win } = joplin;
    await win.locator('.cm-content').first().click();
    await win.waitForTimeout(200);
    await win.keyboard.press('Control+Alt+r');
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-side', 'right', { timeout: 15_000 });
    await win.waitForTimeout(400);
    await assertBarsRightAligned(win);
    // Restore left side for later tests.
    await win.locator('.cm-content').first().click();
    await win.waitForTimeout(200);
    await win.keyboard.press('Control+Alt+r');
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-side', 'left', { timeout: 15_000 });
  });

  // R3 — the current-section bar is measurably bolder (thicker) than a normal bar.
  test('R3: current bar is thicker than normal bars', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0); // first heading is current
    await expect(win.locator(`${EDITOR_STRIP} .ridgeline-bar.is-current`)).toHaveCount(1);
    const current = await boxOf(win, `${EDITOR_STRIP} .ridgeline-bar.is-current`);
    const normal = await boxOf(win, `${EDITOR_STRIP} .ridgeline-bar:not(.is-current)`);
    expect(current.height).toBeGreaterThanOrEqual(normal.height + 1);
  });

  // R4 — the hover panel OVERLAPS the strip (anchored at the pane edge) and does not ellipsize rows.
  test('R4: panel overlaps the strip and long rows wrap instead of truncating', async () => {
    const { win } = joplin;
    await collapsePanel(win);
    await hoverEditorBars(win);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 });

    const strip = await boxOf(win, EDITOR_STRIP);
    const panel = await boxOf(win, `${EDITOR_STRIP} .ridgeline-panel`);
    // Anchored at the same pane edge and overlapping the strip's box (not beside it).
    expect(Math.abs(panel.x - strip.x)).toBeLessThan(6);
    const overlapX = Math.min(panel.x + panel.width, strip.x + strip.width) - Math.max(panel.x, strip.x);
    expect(overlapX).toBeGreaterThan(0);
    // The panel extends out over the note (wider than the compact strip).
    expect(panel.width).toBeGreaterThan(strip.width + 20);

    // No row is horizontally clipped/ellipsized (content fits within the row box => it wrapped).
    const overflow = await win.locator(`${EDITOR_STRIP} .ridgeline-panel-row`).evaluateAll((rows) =>
      rows.map((r) => (r as HTMLElement).scrollWidth - (r as HTMLElement).clientWidth)
    );
    for (const o of overflow) expect(o).toBeLessThanOrEqual(1);
    // The long heading really is present and forced the wrap (its row is taller than one line).
    const longRow = win.locator(`${EDITOR_STRIP} .ridgeline-panel-row`, { hasText: 'A very long heading' });
    const lh = await longRow.first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { h: el.getBoundingClientRect().height, line: parseFloat(cs.lineHeight) || 0 };
    });
    expect(lh.h).toBeGreaterThan(lh.line + 2); // wrapped onto 2+ lines
    await collapsePanel(win);
  });

  // R5 — a row changes background on hover and the cursor is a pointer.
  test('R5: rows have a hover highlight and pointer cursor', async () => {
    const { win } = joplin;
    await collapsePanel(win);
    await hoverEditorBars(win);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 });

    // A non-current row (index 2) so the current-row styling does not confound the hover background.
    const row = win.locator(`[data-testid="ridgeline-editor-row-2"]`);
    const before = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    const cursor = await row.evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toBe('pointer');
    await row.hover();
    await win.waitForTimeout(150);
    const after = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(after).not.toBe(before);
    // The hover background is a real (non-transparent) colour.
    expect(after).not.toBe('rgba(0, 0, 0, 0)');
    await collapsePanel(win);
  });

  // R6 — only the compact bar stack (plus the open panel) triggers the TOC; the full-height edge band
  // below the bars does NOT.
  test('R6: hovering the edge band below the bars does not open the TOC; hovering the bars does', async () => {
    const { win } = joplin;
    await collapsePanel(win);
    const strip = await boxOf(win, EDITOR_STRIP);
    const bars = await boxOf(win, EDITOR_BARS);

    // A point on the strip's column but well BELOW the bar stack.
    const belowX = strip.x + strip.width / 2;
    const belowY = bars.y + bars.height + 150;
    await win.mouse.move(belowX, belowY);
    await win.waitForTimeout(500);
    expect(await win.locator(EDITOR_STRIP).getAttribute('data-expanded')).not.toBe('true');

    // Hovering the bars themselves opens it.
    await hoverEditorBars(win);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 });
    await collapsePanel(win);
  });

  // R7 — a selection drag (button held) onto the bars opens the TOC.
  test('R7: dragging a selection onto the bars opens the TOC', async () => {
    const { win } = joplin;
    await collapsePanel(win);
    const editor = await boxOf(win, '.cm-editor');
    const bars = await boxOf(win, EDITOR_BARS);

    // Start a selection over the note text, hold the button, and drag onto the bar stack.
    const startX = editor.x + editor.width / 2;
    const startY = editor.y + editor.height / 2;
    await win.mouse.move(startX, startY);
    await win.mouse.down();
    // Move in a couple of steps to emulate a real drag, ending over the bars.
    await win.mouse.move((startX + bars.x) / 2, (startY + bars.y) / 2, { steps: 4 });
    await win.mouse.move(bars.x + bars.width / 2, bars.y + bars.height / 2, { steps: 4 });
    await win.waitForTimeout(200);
    const expandedWhileDragging = await win.locator(EDITOR_STRIP).getAttribute('data-expanded');
    await win.mouse.up();
    expect(expandedWhileDragging).toBe('true');
    await collapsePanel(win);
  });
});
