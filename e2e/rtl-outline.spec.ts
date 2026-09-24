import { test, expect, Page, Frame } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNoteWithExactBody,
  ensureViewerVisible,
  hoverEditorBars,
  scrollEditorTo,
  scrollViewerTo,
  waitForEditorStrip,
  EDITOR_STRIP,
  VIEWER_IFRAME,
} from './helpers';
import { DESIGN_TOKENS } from '../src/tokens';

/**
 * RIGHT-TO-LEFT HEADINGS (GitHub issue #4).
 *
 * An Arabic, Persian or Hebrew heading must read right-to-left in the outline — aligned to the right,
 * indented from the right, trimmed with its ellipsis at the END of the text (its left) — and LTR and RTL
 * headings may be MIXED in one note, so the direction is decided PER HEADING, from its display text, by
 * the first-strong-letter rule (`textDirection` in src/inlineText.ts, twinned in viewer.js). The compact
 * bars mirror with their rows: an LTR bar is flush right with its ragged LEFT edge stepping inward by
 * level, exactly like an LTR row's indentation; an RTL bar is flush LEFT, ragged right.
 *
 * The attribute checks (a) are the cheap half. The proof is GEOMETRY (b, c): where the text and the bar
 * actually land, measured against the tokens — a row that says `dir="rtl"` but is still indented from the
 * left fails here. The long RTL heading is the one that overflows the outline's width cap, so it proves
 * the text is anchored on the correct end (its right edge still sits exactly at the indent while its
 * content overflows to the left, where the ellipsis is).
 *
 * ONE launch (default seed: side=left). The side flip (e) runs last, because it changes the layout.
 */

const LONG_RTL =
  'هذا عنوان عربي طويل جدا يتجاوز عرض المخطط بكثير لكي يقطع النص عند نهايته الصحيحة بعلامة الحذف ولا يلتف أبدا إلى سطر ثان مهما كانت النافذة عريضة';

/** The seeded headings in document order, with the direction each MUST resolve to, and why. */
const RTL_HEADINGS: Array<{ level: number; text: string; dir: 'ltr' | 'rtl' }> = [
  { level: 1, text: 'مقدمه', dir: 'rtl' }, // Persian
  { level: 2, text: 'نصب', dir: 'rtl' },
  { level: 3, text: 'تست', dir: 'rtl' },
  { level: 1, text: 'Introduction', dir: 'ltr' },
  { level: 2, text: 'Setup', dir: 'ltr' },
  { level: 3, text: '1. פרק', dir: 'rtl' }, // Hebrew: the leading digit and dot are neutral
  { level: 2, text: 'Alpha عربي', dir: 'ltr' }, // the FIRST strong letter is Latin
  { level: 2, text: LONG_RTL, dir: 'rtl' }, // overflows the outline's cap: the ellipsis case
];

/**
 * Each heading followed by a few LTR filler lines; the LAST section is >= 80 lines (as in
 * buildMixedNoteBody) so the note scrolls. Inserted with createNoteWithExactBody (keyboard.insertText,
 * one input event), which is the safe way to put non-Latin text into CodeMirror.
 */
function buildRtlNoteBody(fillerPerSection = 4): string {
  const lines: string[] = [];
  const lastIndex = RTL_HEADINGS.length - 1;
  RTL_HEADINGS.forEach((h, i) => {
    lines.push(`${'#'.repeat(h.level)} ${h.text}`);
    const filler = i === lastIndex ? Math.max(fillerPerSection, 80) : fillerPerSection;
    for (let n = 0; n < filler; n++) lines.push(`Body ${i + 1} line ${n + 1}.`);
  });
  return lines.join('\n');
}

const EDITOR_ROWS = `${EDITOR_STRIP} .ridgeline-panel-row`;
const VIEWER_STRIP = '#ridgeline-viewer-strip';
const VIEWER_ROWS = `${VIEWER_STRIP} .ridgeline-panel-row`;

const ROW_TOL_PX = 1.5;
const BAR_TOL_PX = 1;

/** The row indent for a level, on the row's START side: the panel padding plus one step per level. */
function indentFor(level: number): number {
  return DESIGN_TOKENS.panelPaddingPx + (level - 1) * DESIGN_TOKENS.panelIndentPx;
}

// ── Measurement (runs in the page or in the note iframe; must not close over anything) ───────────

interface RowSample {
  testid: string | null;
  level: number;
  text: string;
  dir: string | null;
  dataDir: string | null;
  computedDir: string;
  rowLeft: number;
  rowRight: number;
  textLeft: number;
  textRight: number;
  scrollWidth: number;
  clientWidth: number;
}

function sampleRows(selector: string): RowSample[] {
  return Array.from(document.querySelectorAll(selector)).map((el) => {
    const row = el as HTMLElement;
    const rr = row.getBoundingClientRect();
    // A Range over the row's contents reports where the GLYPHS lie, independent of the row's padding.
    const range = document.createRange();
    range.selectNodeContents(row);
    const tr = range.getBoundingClientRect();
    return {
      testid: row.getAttribute('data-testid'),
      level: Number(row.getAttribute('data-level')),
      text: row.textContent || '',
      dir: row.getAttribute('dir'),
      dataDir: row.getAttribute('data-dir'),
      computedDir: getComputedStyle(row).direction,
      rowLeft: rr.left,
      rowRight: rr.right,
      textLeft: tr.left,
      textRight: tr.right,
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
    };
  });
}

interface BarSample {
  level: number;
  dataDir: string | null;
  fromLeft: number; // bar.left − wrap.left
  fromRight: number; // wrap.right − bar.right
  width: number;
}

function sampleBars(strip: string): BarSample[] {
  const wrap = document.querySelector(`${strip} .ridgeline-bars`);
  if (!wrap) return [];
  const w = wrap.getBoundingClientRect();
  return Array.from(document.querySelectorAll(`${strip} .ridgeline-bar`)).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      level: Number(el.getAttribute('data-level')),
      dataDir: el.getAttribute('data-dir'),
      fromLeft: r.left - w.left,
      fromRight: w.right - r.right,
      width: r.width,
    };
  });
}

// ── Assertions shared by the two surfaces ─────────────────────────────────────────────────────────

/** (a) Every row carries the expected direction — as an attribute, as data-dir, and as computed style. */
function expectRowDirections(rows: RowSample[], surface: 'editor' | 'viewer'): void {
  expect(rows.length, `${surface}: one row per heading`).toBe(RTL_HEADINGS.length);
  rows.forEach((r, i) => {
    const want = RTL_HEADINGS[i];
    const where = `${surface} row ${i} "${want.text.slice(0, 20)}"`;
    expect(r.testid, `${where}: testid`).toBe(`ridgeline-${surface}-row-${i}`);
    expect(r.text, `${where}: display text`).toBe(want.text);
    expect(r.dir, `${where}: dir`).toBe(want.dir);
    expect(r.dataDir, `${where}: data-dir`).toBe(want.dir);
    expect(r.computedDir, `${where}: computed direction`).toBe(want.dir);
  });
}

/**
 * (b) The real proof: the text starts exactly one indent in from the row's START edge — the right edge
 * of an RTL row, the left edge of an LTR one. The long RTL row must genuinely overflow (so the ellipsis
 * is engaged) while its right edge still sits at the indent: anchored, and trimmed, on the correct end.
 */
function expectRowGeometry(rows: RowSample[], surface: 'editor' | 'viewer'): void {
  expect(rows.length, `${surface}: one row per heading`).toBe(RTL_HEADINGS.length);
  rows.forEach((r, i) => {
    const want = RTL_HEADINGS[i];
    const indent = indentFor(want.level);
    const where = `${surface} row ${i} (H${want.level} ${want.dir})`;
    expect(r.level, `${where}: level`).toBe(want.level);
    if (want.dir === 'rtl') {
      expect(Math.abs(r.rowRight - r.textRight - indent), `${where}: indent from the RIGHT = ${indent}px`).toBeLessThanOrEqual(ROW_TOL_PX);
    } else {
      expect(Math.abs(r.textLeft - r.rowLeft - indent), `${where}: indent from the LEFT = ${indent}px`).toBeLessThanOrEqual(ROW_TOL_PX);
    }
  });
  const longIndex = RTL_HEADINGS.findIndex((h) => h.text === LONG_RTL);
  const long = rows[longIndex];
  // It genuinely overflows (so the ellipsis is engaged), and the loop above already proved its RIGHT edge
  // sits exactly at the indent: the overflow, and the trim, are on its left — the end of an RTL line.
  expect(long.scrollWidth - long.clientWidth, `${surface}: the long RTL row overflows its row (ellipsis engaged)`).toBeGreaterThan(1);
}

/** (c) Each bar is flush on its own side at barSideAirPx — right for LTR, LEFT for RTL — at its level's length. */
function expectBarGeometry(bars: BarSample[], surface: 'editor' | 'viewer', label = surface): void {
  expect(bars.length, `${label}: one bar per heading`).toBe(RTL_HEADINGS.length);
  const air = DESIGN_TOKENS.barSideAirPx;
  bars.forEach((b, i) => {
    const want = RTL_HEADINGS[i];
    const where = `${label} bar ${i} (H${want.level} ${want.dir})`;
    expect(b.level, `${where}: level`).toBe(want.level);
    expect(b.dataDir, `${where}: data-dir`).toBe(want.dir);
    if (want.dir === 'rtl') {
      expect(Math.abs(b.fromLeft - air), `${where}: flush LEFT at ${air}px (was ${b.fromLeft.toFixed(2)})`).toBeLessThanOrEqual(BAR_TOL_PX);
    } else {
      expect(Math.abs(b.fromRight - air), `${where}: flush right at ${air}px (was ${b.fromRight.toFixed(2)})`).toBeLessThanOrEqual(BAR_TOL_PX);
    }
    expect(Math.round(b.width), `${where}: width is the level length`).toBe(DESIGN_TOKENS.levelLengths[want.level]);
  });
}

// ── Pointer choreography (the established pattern from outline-toolbar.spec.ts) ─────────────────

async function movePointerToNoteList(win: Page): Promise<void> {
  const box = await win.locator('.note-list-item').first().boundingBox().catch(() => null);
  if (box) await win.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  else await win.mouse.move(200, 500);
  await win.waitForTimeout(100);
}

async function openEditorOutline(win: Page): Promise<void> {
  await hoverEditorBars(win);
  await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 10_000 });
}

async function closeEditorOutline(win: Page): Promise<void> {
  await movePointerToNoteList(win);
  await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'false', { timeout: 5_000 });
}

/**
 * Close the viewer's hover outline from INSIDE the note iframe: a pointer leaving the iframe for the main
 * window delivers no departure event to the viewer document (measured — see leaveViewerOutline in
 * outline-toolbar.spec.ts), so an outline left open there stays open. The in-document point differs from
 * that spec's 30% across: this note's long heading widens the outline to its cap (33% of the pane, on the
 * LEFT here), so 75% across is the side guaranteed clear of it.
 */
async function leaveViewerOutline(win: Page, frame: Frame): Promise<void> {
  const box = await win.locator(VIEWER_IFRAME).boundingBox().catch(() => null);
  if (box && (await frame.locator(VIEWER_STRIP).count()) > 0) {
    await win.mouse.move(Math.round(box.x + box.width * 0.75), Math.round(box.y + box.height * 0.6));
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-expanded', 'false', { timeout: 5_000 });
  }
  await movePointerToNoteList(win);
}

test.describe('Right-to-left headings in the outline and the minimap (issue #4)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    joplin = await launchJoplin();
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithExactBody(joplin.win, 'Ridgeline RTL Note', buildRtlNoteBody());
    await waitForEditorStrip(joplin.win);
    await expect(joplin.win.locator(`${EDITOR_STRIP} .ridgeline-bar`)).toHaveCount(RTL_HEADINGS.length, {
      timeout: 15_000,
    });
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('a: editor rows carry their own heading direction', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    await openEditorOutline(win);
    expectRowDirections(await win.evaluate(sampleRows, EDITOR_ROWS), 'editor');
    await closeEditorOutline(win);
  });

  test('b: editor rows are indented from their START edge; the long RTL row is trimmed at its end', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    await openEditorOutline(win);
    expectRowGeometry(await win.evaluate(sampleRows, EDITOR_ROWS), 'editor');
    await closeEditorOutline(win);
  });

  test('c: editor bars mirror with their rows (RTL flush left, LTR flush right)', async () => {
    const { win } = joplin;
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-side', 'left');
    expectBarGeometry(await win.evaluate(sampleBars, EDITOR_STRIP), 'editor');
  });

  test('d: the viewer matches — rows, geometry, bars — and agrees with the editor', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    await expect(frame.locator(`${VIEWER_STRIP} .ridgeline-bar`)).toHaveCount(RTL_HEADINGS.length, {
      timeout: 20_000,
    });
    await scrollViewerTo(win, 0);

    // (c) in the viewer: the compact bars, before any hover.
    expectBarGeometry(await frame.evaluate(sampleBars, VIEWER_STRIP), 'viewer');

    // Editor↔viewer parity: the two surfaces resolve every heading to the same direction.
    const editorDirs = await win
      .locator(`${EDITOR_STRIP} .ridgeline-bar`)
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-dir')));
    const viewerDirs = await frame
      .locator(`${VIEWER_STRIP} .ridgeline-bar`)
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-dir')));
    expect(viewerDirs, 'viewer data-dir sequence equals the editor one').toEqual(editorDirs);
    expect(editorDirs).toEqual(RTL_HEADINGS.map((h) => h.dir));

    // (a) and (b) in the viewer: hover its bars, then close the outline from inside the note.
    const viewerBars = frame.locator(`${VIEWER_STRIP} .ridgeline-bars`);
    await expect(viewerBars).toBeVisible({ timeout: 20_000 });
    await viewerBars.hover();
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 10_000 });
    const rows = await frame.evaluate(sampleRows, VIEWER_ROWS);
    expectRowDirections(rows, 'viewer');
    expectRowGeometry(rows, 'viewer');
    await leaveViewerOutline(win, frame);
  });

  test('e: flipping the minimap to the right keeps every bar mirrored by direction', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);
    await expect(strip).toHaveAttribute('data-side', 'left');
    // Fire the toggle via its accelerator with the editor focused (the heading-indent.spec.ts pattern).
    await win.locator('.cm-content').first().click();
    await win.waitForTimeout(300);
    await win.keyboard.press('Control+Alt+r');
    await expect(strip).toHaveAttribute('data-side', 'right', { timeout: 15_000 });
    await win.waitForTimeout(500);
    // The side moves the strip, never the reading direction: the RTL mirror is unchanged.
    expectBarGeometry(await win.evaluate(sampleBars, EDITOR_STRIP), 'editor', 'editor (side=right)');
  });
});
