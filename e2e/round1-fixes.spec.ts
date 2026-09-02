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
 * Round-1 UX fixes (R1–R6) plus the round-2 reversals P3 (single-line + ellipsis rows), P4 (pointer
 * cursor on the real hit element) and P5 (a selection drag does NOT open the TOC), verified against
 * observable geometry/DOM.
 *
 * One default launch (side=left, overlay). The note mixes heading levels and includes one very long
 * heading so the hover panel's single-line + ellipsis (P3) behaviour can be checked.
 */
const LONG_HEADING =
  'A very long heading that is wider than the panel and so is trimmed to a single line with a CSS ellipsis rather than wrapping';

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

  // P3 — the hover panel OVERLAPS the strip (anchored at the pane edge). Rows are SINGLE-LINE; a row
  // too long for the (widened) panel is trimmed with a CSS ellipsis, never wrapped. (This reverses the
  // round-1 R4 behaviour — wrapping — per the user's new decision.)
  test('P3: panel overlaps the strip; rows are single-line and overflowing rows ellipsize', async () => {
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

    const rows = await win.locator(`${EDITOR_STRIP} .ridgeline-panel-row`).evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el as HTMLElement);
        return {
          height: (el as HTMLElement).getBoundingClientRect().height,
          lineHeight: parseFloat(cs.lineHeight) || 0,
          padTop: parseFloat(cs.paddingTop) || 0,
          padBottom: parseFloat(cs.paddingBottom) || 0,
          whiteSpace: cs.whiteSpace,
          textOverflow: cs.textOverflow,
          scrollWidth: (el as HTMLElement).scrollWidth,
          clientWidth: (el as HTMLElement).clientWidth,
          text: (el.textContent || '').slice(0, 24),
        };
      })
    );
    for (const r of rows) {
      // Single line: the row is no taller than one line + its vertical padding (a wrapped row would be
      // ~2× taller). And it is set up to ellipsize rather than wrap.
      expect(r.height, `row "${r.text}" single-line height`).toBeLessThanOrEqual(
        r.lineHeight + r.padTop + r.padBottom + 3
      );
      expect(r.whiteSpace, `row "${r.text}" white-space`).toBe('nowrap');
      expect(r.textOverflow, `row "${r.text}" text-overflow`).toBe('ellipsis');
    }
    // The long heading really overflows its row, so the ellipsis is actually engaged (clipped content).
    // NB this needs a row that genuinely overflows the panel. LONG_HEADING is 124 characters of pure
    // prose, which the display-text resolution (issue #1) passes through byte-identical. A future
    // fixture whose length came from link URLs would render SHORT and silently stop overflowing, so
    // this assertion would pass vacuously — keep the long row plain.
    const longRow = rows.find((r) => r.text.startsWith('A very long heading'));
    expect(longRow, 'long heading row present').toBeTruthy();
    expect(longRow!.scrollWidth - longRow!.clientWidth, 'long row content is clipped').toBeGreaterThan(1);
    await collapsePanel(win);
  });

  // R5/Q3 — a row changes background on hover, and the cursor is a pointer. Two prior "fixes" passed a
  // single-point cursor assertion while the real on-screen cursor still wasn't a pointer, because the
  // panel lived inside .cm-editor where a CM layer/cursor could win. The panel is now a FIXED element on
  // <body>, fully outside CodeMirror. This test SAMPLES MULTIPLE points across the open panel (row text,
  // row left padding, panel padding, container/panel edge) and for EACH asserts (a) the element
  // document.elementFromPoint returns is the panel or a descendant of it — i.e. nothing from the editor
  // sits on top — (b) its computed cursor is pointer, and (c) no element in the chain from the hit up to
  // the panel disables pointer-events. (The strip CONTAINER above the panel intentionally has
  // pointer-events:none, with the panel re-enabling it; that is above the resolved hit and irrelevant.)
  function samplePanelCursors(): { label: string; tag: string | null; cls: string; cursor: string | null; insidePanel: boolean; blockedBy: string | null }[] {
    const panel = document.querySelector('.ridgeline-editor-strip .ridgeline-panel') as HTMLElement | null;
    const rows = Array.from(document.querySelectorAll('.ridgeline-editor-strip .ridgeline-panel-row')) as HTMLElement[];
    const out: { label: string; tag: string | null; cls: string; cursor: string | null; insidePanel: boolean; blockedBy: string | null }[] = [];
    if (!panel) return out;
    const pr = panel.getBoundingClientRect();
    const probe = (label: string, x: number, y: number) => {
      const t = document.elementFromPoint(x, y) as HTMLElement | null;
      const insidePanel = !!t && (t === panel || panel.contains(t));
      // Walk from the hit up to (and including) the panel; flag any pointer-events:none in that span.
      let blockedBy: string | null = null;
      let el: HTMLElement | null = t;
      for (let i = 0; el && i < 12; i++, el = el.parentElement) {
        if (getComputedStyle(el).pointerEvents === 'none') blockedBy = `${el.tagName}.${el.className}`;
        if (el === panel) break;
      }
      out.push({ label, tag: t?.tagName ?? null, cls: (t?.className || '').toString(), cursor: t ? getComputedStyle(t).cursor : null, insidePanel, blockedBy });
    };
    // A non-current row (index 2) so current-row styling never confounds.
    const row = rows[2] || rows[0];
    const rr = row.getBoundingClientRect();
    probe('row-textcenter', rr.left + rr.width / 2, rr.top + rr.height / 2);
    probe('row-leftpad', rr.left + 2, rr.top + rr.height / 2);
    probe('panel-padding', pr.left + 3, pr.top + 3);
    probe('panel-innermid', pr.left + pr.width / 2, pr.top + pr.height / 2);
    return out;
  }

  test('R5/Q3: rows highlight on hover and EVERY sampled panel point resolves to a pointer cursor', async () => {
    const { win } = joplin;
    await collapsePanel(win);
    await hoverEditorBars(win);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 });

    // Hover highlight on a non-current row.
    const row = win.locator(`[data-testid="ridgeline-editor-row-2"]`);
    const before = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    await row.hover();
    await win.waitForTimeout(150);
    const after = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(after).not.toBe(before);
    expect(after).not.toBe('rgba(0, 0, 0, 0)');

    const samples = await win.evaluate(samplePanelCursors);
    expect(samples.length).toBeGreaterThanOrEqual(4);
    for (const s of samples) {
      expect(s.insidePanel, `${s.label}: hit <${s.tag} class="${s.cls}"> is the panel/descendant`).toBe(true);
      expect(s.cursor, `${s.label}: hit <${s.tag} class="${s.cls}"> cursor`).toBe('pointer');
      expect(s.blockedBy, `${s.label}: pointer-events:none between hit and panel`).toBeNull();
    }
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

  // P5 — a text-selection drag (button held) across the bars must NOT open the TOC; a plain hover
  // (no button) still opens it. (This reverses the round-1 R7 behaviour per the user's new decision.)
  test('P5: dragging a selection across the bars does NOT open the TOC; a button-free hover does', async () => {
    const { win } = joplin;
    await collapsePanel(win);
    const editor = await boxOf(win, '.cm-editor');
    const bars = await boxOf(win, EDITOR_BARS);
    const barsCx = bars.x + bars.width / 2;
    const barsCy = bars.y + bars.height / 2;

    // Start a selection over the note text, hold the button, and drag across the bar stack.
    const startX = editor.x + editor.width / 2;
    const startY = editor.y + editor.height / 2;
    await win.mouse.move(startX, startY);
    await win.mouse.down();
    await win.mouse.move((startX + barsCx) / 2, (startY + barsCy) / 2, { steps: 4 });
    await win.mouse.move(barsCx, barsCy, { steps: 4 });
    await win.waitForTimeout(250);
    const expandedWhileDragging = await win.locator(EDITOR_STRIP).getAttribute('data-expanded');
    expect(expandedWhileDragging).not.toBe('true');
    // The drag also did not eat the selection: releasing over the bars leaves a real selection.
    await win.mouse.up();
    const hasSelection = await win.evaluate(() => (window.getSelection()?.toString().length ?? 0) > 0);
    expect(hasSelection, 'text selection survived the drag across the minimap').toBe(true);

    // A button-free hover over the same bars DOES open the panel (after the dwell — see Q2 below).
    await collapsePanel(win);
    await win.mouse.move(barsCx, barsCy);
    await win.waitForTimeout(50);
    await win.mouse.move(barsCx + 1, barsCy);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 });
    await collapsePanel(win);
  });

  // Q2 (NEW this round; REPLACES the round-2 instant-open-on-hover behaviour) — hover-intent. A pointer
  // merely CROSSING the strip (transit, tens of ms) must NOT open the TOC; the pointer must DWELL on the
  // bars for hoverOpenDelayMs (~300ms) before it opens.
  test('Q2: a quick transit across the bars does NOT open the TOC', async () => {
    const { win } = joplin;
    await collapsePanel(win);
    const bars = await boxOf(win, EDITOR_BARS);
    const cy = bars.y + bars.height / 2;
    // Sweep the pointer FROM outside the strip, ACROSS the bars, and OUT the other side (onto the note
    // text) in one fast motion — exactly a mouse trip to the note list. It enters and leaves the bar
    // hit-zone well within the dwell window, so the panel must stay closed.
    await win.mouse.move(bars.x - 40, cy);
    await win.mouse.move(bars.x + bars.width + 120, cy, { steps: 6 });
    await win.waitForTimeout(500); // > dwell; if intent were mis-fired it would be open by now
    expect(await win.locator(EDITOR_STRIP).getAttribute('data-expanded')).not.toBe('true');
  });

  test('Q2: dwelling on the bars opens the TOC after the delay', async () => {
    const { win } = joplin;
    await collapsePanel(win);
    const bars = await boxOf(win, EDITOR_BARS);
    const cx = bars.x + bars.width / 2;
    const cy = bars.y + bars.height / 2;
    // Arrive and REST on the bars. It must not be open immediately (dwell not yet elapsed)...
    await win.mouse.move(cx, cy);
    await win.waitForTimeout(120);
    expect(await win.locator(EDITOR_STRIP).getAttribute('data-expanded')).not.toBe('true');
    // ...and it must open once the dwell elapses.
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 });
    await collapsePanel(win);
  });
});
