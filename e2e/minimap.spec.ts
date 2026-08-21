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
  scrollViewerTo,
  viewerCurrentHeading,
  SETEXT_REAL_HEADING_COUNT,
  waitForEditorStrip,
  EDITOR_STRIP,
  VIEWER_IFRAME,
  readEditorBars,
  readViewerBars,
  assertCurrentBarCentered,
  assertNeighboursUnmoved,
  assertToggledBarCentered,
} from './helpers';
import { DESIGN_TOKENS } from '../src/tokens';

// W2 centring assertions (assertCurrentBarCentered / assertNeighboursUnmoved / assertToggledBarCentered)
// and the bar-geometry sampler now live in helpers.ts, shared with the 120%-zoom Z1 spec so W2 centring
// is proven at BOTH the default and the user's real 120% zoom.

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

  // W1: the current-section bar keeps EXACTLY its level's length — its prominence is thickness + a
  // brighter colour only, NO length boost (an H3 must never read as an H2). So the rendered width IS
  // the per-level length for every bar, current or not. (Round-4 subtracted a currentBarLengthBoostPx
  // here; that token was removed this round, so there is nothing to normalise out.)
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

  // D1/R9 — one bar per heading, base lengths diminishing near-LINEARLY by heading level (H1 longest →
  // H6 shortest) per the shared design tokens (Q1: 20/17/14/11/8/6, a ~3px step per level).
  test('bar count matches headings and widths are linearly ordered by level', async () => {
    await scrollEditorTo(joplin.win, 0);
    expect(await joplin.win.locator(`${EDITOR_STRIP} .ridgeline-bar`).count()).toBe(
      MIXED_HEADINGS.length
    );
    const widths = await editorBarWidths();
    expect(widths.length).toBe(MIXED_HEADINGS.length);
    for (let i = 1; i < widths.length; i++) {
      // Each deeper level's bar is strictly shorter than the one above it.
      expect(widths[i - 1]).toBeGreaterThan(widths[i]);
    }
    // Sanity-check the extremes against the tokens (H1 = longest, H6 = shortest). widths[0] is the
    // CURRENT bar at top-of-scroll (H1); W1: it equals its level length exactly — NOT boosted longer.
    expect(Math.round(widths[0])).toBe(DESIGN_TOKENS.levelLengths[1]);
    expect(Math.round(widths[widths.length - 1])).toBe(DESIGN_TOKENS.levelLengths[6]);
    // R9: the decrements are near-EQUAL (linear), so every adjacent pair is equally distinguishable.
    // Each step is ~3px; assert they match within 1px of each other.
    const steps = widths.slice(1).map((w, i) => widths[i] - w);
    const minStep = Math.min(...steps);
    const maxStep = Math.max(...steps);
    expect(maxStep - minStep).toBeLessThanOrEqual(1);
  });

  // Q1 — visibly more air between the bars and the strip's text-side edge (barSideAirPx raised 7→12).
  // For every bar, the gap from its (flush) right edge to the strip's right edge equals that air.
  test('Q1: the bar stack floats with clearly more side air than before (>8px)', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    const strip = await win.locator(EDITOR_STRIP).boundingBox();
    const bars = win.locator(`${EDITOR_STRIP} .ridgeline-bar`);
    const count = await bars.count();
    expect(strip).not.toBeNull();
    const stripRight = strip!.x + strip!.width;
    for (let i = 0; i < count; i++) {
      const b = await bars.nth(i).boundingBox();
      if (!b) continue;
      const air = stripRight - (b.x + b.width);
      // More than the previous 7px on the text side; comfortably under the strip width.
      expect(air, `bar ${i} side air`).toBeGreaterThan(8);
    }
  });

  // Q4 — inactive bars must render at an IDENTICAL height and land on INTEGER y positions (they used to
  // land on half-pixels at the user's zoom and look unevenly bold). The current bar is exempt (bolder).
  async function assertUniformIntegerBars(scope: 'editor' | 'viewer'): Promise<void> {
    const { win } = joplin;
    let bars;
    if (scope === 'editor') {
      bars = win.locator(`${EDITOR_STRIP} .ridgeline-bar`);
    } else {
      await ensureViewerVisible(win);
      bars = win.frameLocator(VIEWER_IFRAME).locator('#ridgeline-viewer-strip .ridgeline-bar');
    }
    const data = await bars.evaluateAll((els) =>
      els.map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { current: el.classList.contains('is-current'), height: Math.round(r.height * 100) / 100, top: r.top };
      })
    );
    expect(data.length).toBeGreaterThan(2);
    const inactive = data.filter((d) => !d.current);
    expect(inactive.length).toBeGreaterThan(1);
    // All inactive bars render at an IDENTICAL height (the Q4 "some look bolder" fix).
    const heights = inactive.map((d) => d.height);
    expect(Math.max(...heights) - Math.min(...heights), `${scope}: inactive bar heights identical`).toBe(0);
    // Every bar (current included) sits on an INTEGER y pixel.
    for (const d of data) {
      expect(Math.abs(d.top - Math.round(d.top)), `${scope}: bar top ${d.top} is integer`).toBeLessThan(0.02);
    }
    // W2: the current bar is now CENTRED in its slot — its top is shifted UP by half the thickness delta,
    // so its raw top is deliberately off the inactive grid. Reconstruct each bar's SLOT top (undo that
    // shift for the current bar) and assert THOSE sit on a single constant INTEGER pitch — i.e. the
    // inactive neighbours are on an even grid and the current bar occupies its slot centred, not nudged
    // off it. (Round-4 asserted ALL raw tops were on one pitch because the current bar grew downward
    // from the slot top; W2 changed that by design.)
    const centerPad = (DESIGN_TOKENS.currentBarHeight - DESIGN_TOKENS.barHeight) / 2;
    const slotTops = data.map((d) => Math.round(d.current ? d.top + centerPad : d.top)).sort((a, b) => a - b);
    const gaps = slotTops.slice(1).map((t, i) => t - slotTops[i]);
    if (gaps.length > 1) {
      expect(Math.max(...gaps) - Math.min(...gaps), `${scope}: uniform integer pitch (slot tops)`).toBe(0);
    }
  }

  test('Q4: editor inactive bars are uniform height on integer y positions', async () => {
    await scrollEditorTo(joplin.win, 0);
    await assertUniformIntegerBars('editor');
  });

  // Z1 — vertical condensing ~2×. The bar PITCH (top-to-top distance) is roughly HALF the v0.2.3 pitch
  // of 15px, so a note's stack is about twice as compact, WITHOUT changing bar thickness. Measured from
  // the actual rendered bar tops at default zoom (dpr=1, so device-snapping is a no-op and the pitch is
  // exactly barHeight+barGap = 7).
  test('Z1: the bar stack is ~half as tall as v0.2.3 for the same headings', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    const tops = await win
      .locator(`${EDITOR_STRIP} .ridgeline-bar`)
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).getBoundingClientRect().top).sort((a, b) => a - b));
    expect(tops.length).toBe(MIXED_HEADINGS.length);

    // Uniform pitch, and it is the halved token pitch (~7px), clearly below the old 15px.
    const pitches = tops.slice(1).map((t, i) => t - tops[i]);
    const pitch = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    const EXPECTED_PITCH = DESIGN_TOKENS.barHeight + DESIGN_TOKENS.barGap; // 3 + 4 = 7
    expect(pitch).toBeGreaterThan(EXPECTED_PITCH - 1);
    expect(pitch).toBeLessThan(EXPECTED_PITCH + 1);

    // Stack total (last top − first top + current bar) is roughly half the v0.2.3 equivalent.
    const OLD_PITCH = 15; // v0.2.3 barHeight(3)+barGap(12)
    const n = MIXED_HEADINGS.length;
    const newStack = tops[n - 1] - tops[0] + DESIGN_TOKENS.currentBarHeight;
    const oldStack = (n - 1) * OLD_PITCH + DESIGN_TOKENS.currentBarHeight;
    const ratio = newStack / oldStack;
    expect(ratio, `stack height ratio vs v0.2.3 (${newStack}/${oldStack})`).toBeLessThan(0.65);
    expect(ratio).toBeGreaterThan(0.4);
  });

  test('Q4: viewer inactive bars are uniform height on integer y positions', async () => {
    await assertUniformIntegerBars('viewer');
  });

  // W2 (editor) — the current bar is CENTRED in its pitch slot: its vertical centre equals the centre an
  // inactive bar would have in the same slot, and its neighbours do not move when a DIFFERENT bar becomes
  // current. Proven by toggling which bar is current (scroll top vs bottom) and comparing geometry. At
  // this default zoom dpr=1, so a correctly-centred bar's centre is INVARIANT across the toggle (delta
  // exactly 0) while the pre-W2 downward-grown bar would shift its centre by 1 device px — so the
  // assertToggledBarCentered guard is set BELOW 1 device px (0.5) here to discriminate the two, whereas
  // the straddling assertCurrentBarCentered line fit cannot (its ≤1-px tolerance equals the miscentring).
  test('W2: editor current bar is centred in its slot; neighbours unmoved when it changes', async () => {
    const { win } = joplin;

    // Snapshot A: scrolled to top → first heading is current.
    await scrollEditorTo(win, 0);
    await expect.poll(() => editorCurrentHeading(win), { timeout: 5_000 }).toBe(MIXED_HEADINGS[0].text);
    const a = await readEditorBars(win);
    expect(a.bars[0].current, 'first bar current at top-of-scroll').toBe(true);
    assertCurrentBarCentered(a.bars, a.dpr, 'editor@top');

    // Snapshot B: scrolled to the bottom → the LAST heading is current (a different bar).
    await win.evaluate(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => editorCurrentHeading(win), { timeout: 5_000 })
      .toBe(MIXED_HEADINGS[MIXED_HEADINGS.length - 1].text);
    const b = await readEditorBars(win);
    expect(b.bars[b.bars.length - 1].current, 'last bar current at bottom-of-scroll').toBe(true);
    assertCurrentBarCentered(b.bars, b.dpr, 'editor@bottom');

    // The DISCRIMINATING check: the bars that toggled current between the two snapshots kept their
    // centre put (< 0.5 device px at dpr=1) — a downward-grown, un-centred bar would drop it ~1 device
    // px. Plus neighbours (inactive in both) did not move.
    assertToggledBarCentered(a.bars, b.bars, a.dpr, 'editor', 0.5);
    assertNeighboursUnmoved(a.bars, b.bars, a.dpr, 'editor');

    await scrollEditorTo(win, 0);
  });

  // W2 (viewer) — same centring + neighbours-unmoved guarantee on the rendered-note strip.
  test('W2: viewer current bar is centred in its slot; neighbours unmoved when it changes', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    await expect(frame.locator('#ridgeline-viewer-strip .ridgeline-bar').first()).toBeVisible({
      timeout: 15_000,
    });

    // Snapshot A: viewer scrolled to top → first heading current.
    await scrollViewerTo(win, 0);
    await expect.poll(() => viewerCurrentHeading(win), { timeout: 10_000 }).toBe(MIXED_HEADINGS[0].text);
    const a = await readViewerBars(frame);
    expect(a.bars[0].current, 'first viewer bar current at top-of-scroll').toBe(true);
    assertCurrentBarCentered(a.bars, a.dpr, 'viewer@top');

    // Snapshot B: viewer scrolled to the bottom → the LAST heading current.
    await scrollViewerTo(win, 10_000_000);
    await expect
      .poll(() => viewerCurrentHeading(win), { timeout: 10_000 })
      .toBe(MIXED_HEADINGS[MIXED_HEADINGS.length - 1].text);
    const b = await readViewerBars(frame);
    expect(b.bars[b.bars.length - 1].current, 'last viewer bar current at bottom-of-scroll').toBe(true);
    assertCurrentBarCentered(b.bars, b.dpr, 'viewer@bottom');

    assertToggledBarCentered(a.bars, b.bars, a.dpr, 'viewer', 0.5);
    assertNeighboursUnmoved(a.bars, b.bars, a.dpr, 'viewer');

    await scrollViewerTo(win, 0);
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

  // Q3 (viewer) — the viewer TOC rows must show a pointer cursor too, sampled at MULTIPLE points and
  // asserted on the element document.elementFromPoint actually returns (the displayed-cursor source).
  // The viewer strip already lives in the note iframe body (outside any editor), so this locks that it
  // stays a clean pointer surface.
  test('Q3: every sampled viewer panel point resolves to a pointer cursor', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    // Side may be 'right' from the previous test; hover the viewer bar stack to expand the panel (after
    // the Q2 dwell).
    const bars = frame.locator('#ridgeline-viewer-strip .ridgeline-bars');
    await expect(bars).toBeVisible({ timeout: 15_000 });
    await bars.hover();
    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveAttribute('data-expanded', 'true', {
      timeout: 5_000,
    });
    const samples = await frame.evaluate(() => {
      const panel = document.querySelector('#ridgeline-viewer-strip .ridgeline-panel') as HTMLElement | null;
      const rows = Array.from(document.querySelectorAll('#ridgeline-viewer-strip .ridgeline-panel-row')) as HTMLElement[];
      const out: { label: string; tag: string | null; cls: string; cursor: string | null; insidePanel: boolean; blockedBy: string | null }[] = [];
      if (!panel) return out;
      const pr = panel.getBoundingClientRect();
      const probe = (label: string, x: number, y: number) => {
        const t = document.elementFromPoint(x, y) as HTMLElement | null;
        const insidePanel = !!t && (t === panel || panel.contains(t));
        let blockedBy: string | null = null;
        let el: HTMLElement | null = t;
        for (let i = 0; el && i < 12; i++, el = el.parentElement) {
          if (getComputedStyle(el).pointerEvents === 'none') blockedBy = `${el.tagName}.${el.className}`;
          if (el === panel) break;
        }
        out.push({ label, tag: t?.tagName ?? null, cls: (t?.className || '').toString(), cursor: t ? getComputedStyle(t).cursor : null, insidePanel, blockedBy });
      };
      const row = rows[2] || rows[0];
      const rr = row.getBoundingClientRect();
      probe('row-textcenter', rr.left + rr.width / 2, rr.top + rr.height / 2);
      probe('row-leftpad', rr.left + 2, rr.top + rr.height / 2);
      probe('panel-padding', pr.left + 3, pr.top + 3);
      probe('panel-innermid', pr.left + pr.width / 2, pr.top + pr.height / 2);
      return out;
    });
    expect(samples.length).toBeGreaterThanOrEqual(4);
    for (const s of samples) {
      expect(s.insidePanel, `${s.label}: hit <${s.tag} class="${s.cls}"> is the panel/descendant`).toBe(true);
      expect(s.cursor, `${s.label}: viewer hit <${s.tag} class="${s.cls}"> cursor`).toBe('pointer');
      expect(s.blockedBy, `${s.label}: pointer-events:none between hit and panel`).toBeNull();
    }
  });
});
