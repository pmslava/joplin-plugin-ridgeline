import { test, expect, Page, Frame } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  scrollEditorTo,
  scrollViewerTo,
  editorCurrentHeading,
  viewerCurrentHeading,
  readEditorBars,
  readViewerBars,
  assertToggledBarCentered,
  assertNeighboursUnmoved,
  MIXED_HEADINGS,
  waitForEditorStrip,
  EDITOR_STRIP,
  VIEWER_IFRAME,
} from './helpers';

/**
 * Z1 — DEVICE-PIXEL PHASE ALIGNMENT at the user's real 120% zoom.
 *
 * The bars are placed with top_i = Math.round(i * pitch * dpr) / dpr, so every bar's top lands on an
 * exact integer DEVICE pixel. That means all bars share the SAME sub-device-pixel phase (identical
 * fractional device offset), which is what makes them antialias identically ("no bar looks bolder" —
 * the old Q4 bug, now zoom-proof). The old fix relied on a pitch that happened to be a whole number of
 * device px at 120% (15 CSS px = 18 device px); the halved pitch (7) is NOT (7×1.2 = 8.4 device px), so
 * without device-snapping the phase would drift bar to bar. This spec launches at windowContentZoomFactor
 * 120 and asserts, on BOTH surfaces, that (a) the zoom really raised devicePixelRatio, (b) inactive bars
 * render at an identical height, and (c) each bar's top is an integer number of device pixels away from
 * the first bar's top (uniform phase).
 */

// Assert phase alignment over a list of {top,height,current} bar rects measured at devicePixelRatio dpr.
function assertPhaseAligned(
  bars: Array<{ top: number; height: number; current: boolean }>,
  dpr: number,
  where: string,
): void {
  expect(bars.length, `${where}: bar count`).toBeGreaterThan(2);
  const inactive = bars.filter((b) => !b.current);
  expect(inactive.length, `${where}: inactive bars`).toBeGreaterThan(1);

  // (b) inactive bars all render at the SAME height (the boldness proxy).
  const heights = inactive.map((b) => Math.round(b.height * 100) / 100);
  expect(Math.max(...heights) - Math.min(...heights), `${where}: identical inactive heights`).toBe(0);

  // (c) every bar's top is an integer number of DEVICE pixels from the first — uniform phase. The
  // relative offset i*pitch is device-snapped, so (top_i − top_0) × dpr must be (near) integer.
  const tops = bars.map((b) => b.top);
  const top0 = Math.min(...tops);
  for (const t of tops) {
    const deviceOffset = (t - top0) * dpr;
    const frac = Math.abs(deviceOffset - Math.round(deviceOffset));
    expect(frac, `${where}: bar top ${t} is ${deviceOffset.toFixed(3)} device px from first (integer)`).toBeLessThan(0.1);
  }
}

test.describe('Z1 device-pixel phase alignment at 120% zoom', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const profileDir = createProfile(true, { side: 'left' });
    const sf = path.join(profileDir, 'settings.json');
    const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
    s['windowContentZoomFactor'] = 120; // the user's real zoom
    fs.writeFileSync(sf, JSON.stringify(s, null, 2), 'utf8');
    joplin = await launchJoplin({ profileDir });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Z1 Zoom Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('the 120% zoom raised devicePixelRatio above 1', async () => {
    const dpr = await joplin.win.evaluate(() => window.devicePixelRatio);
    // eslint-disable-next-line no-console
    console.log(`[z1zoom] editor devicePixelRatio=${dpr}`);
    expect(dpr, 'zoom 120 should push dpr to ~1.2').toBeGreaterThan(1.05);
  });

  test('editor: inactive bars are uniform height and phase-aligned in device pixels', async () => {
    const win = joplin.win as Page;
    await scrollEditorTo(win, 0);
    const { dpr, bars } = await win.evaluate((sel) => {
      const els = Array.from(document.querySelectorAll(`${sel} .ridgeline-bar`)) as HTMLElement[];
      return {
        dpr: window.devicePixelRatio,
        bars: els.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, height: r.height, current: el.classList.contains('is-current') };
        }),
      };
    }, EDITOR_STRIP);
    assertPhaseAligned(bars, dpr, 'editor@120');
  });

  test('viewer: inactive bars are uniform height and phase-aligned in device pixels', async () => {
    const win = joplin.win as Page;
    const frame: Frame = await ensureViewerVisible(win);
    await expect(win.frameLocator(VIEWER_IFRAME).locator('#ridgeline-viewer-strip .ridgeline-bar').first()).toBeVisible({
      timeout: 15_000,
    });
    const { dpr, bars } = await frame.evaluate(() => {
      const els = Array.from(document.querySelectorAll('#ridgeline-viewer-strip .ridgeline-bar')) as HTMLElement[];
      return {
        dpr: window.devicePixelRatio,
        bars: els.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, height: r.height, current: el.classList.contains('is-current') };
        }),
      };
    });
    // eslint-disable-next-line no-console
    console.log(`[z1zoom] viewer devicePixelRatio=${dpr}`);
    assertPhaseAligned(bars, dpr, 'viewer@120');
  });

  // W2 at 120% zoom — the current bar is CENTRED in its pitch slot at the user's real fractional dpr, not
  // just at dpr=1. Phase alignment (above) holds for a centred AND a downward-grown current bar, so it
  // cannot see miscentring; this test can. It toggles which bar is current (scroll top vs bottom) and
  // asserts the toggled bar keeps its vertical CENTRE put across the change — the invariant that holds
  // iff the current bar is centred in its slot (a downward-grown bar would drop its centre ~1 device px).
  // Neighbours (inactive in both snapshots) must not move. This is the W2 centring proof at 120%.
  test('editor: W2 current bar stays centred in its slot at 120% zoom', async () => {
    const win = joplin.win as Page;

    // Snapshot A: scrolled to top → first heading current.
    await scrollEditorTo(win, 0);
    await expect.poll(() => editorCurrentHeading(win), { timeout: 5_000 }).toBe(MIXED_HEADINGS[0].text);
    const a = await readEditorBars(win);
    expect(a.dpr, 'the 120% zoom must have raised dpr for this to be a real 120% assertion').toBeGreaterThan(1.05);
    expect(a.bars[0].current, 'first bar current at top-of-scroll').toBe(true);

    // Snapshot B: scrolled to the bottom → the LAST heading current (a different bar).
    await win.evaluate(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => editorCurrentHeading(win), { timeout: 5_000 })
      .toBe(MIXED_HEADINGS[MIXED_HEADINGS.length - 1].text);
    const b = await readEditorBars(win);
    expect(b.bars[b.bars.length - 1].current, 'last bar current at bottom-of-scroll').toBe(true);

    assertToggledBarCentered(a.bars, b.bars, a.dpr, 'editor@120', 1);
    assertNeighboursUnmoved(a.bars, b.bars, a.dpr, 'editor@120');
    await scrollEditorTo(win, 0);
  });

  test('viewer: W2 current bar stays centred in its slot at 120% zoom', async () => {
    const win = joplin.win as Page;
    const frame: Frame = await ensureViewerVisible(win);
    await expect(win.frameLocator(VIEWER_IFRAME).locator('#ridgeline-viewer-strip .ridgeline-bar').first()).toBeVisible({
      timeout: 15_000,
    });

    // Snapshot A: viewer scrolled to top → first heading current.
    await scrollViewerTo(win, 0);
    await expect.poll(() => viewerCurrentHeading(win), { timeout: 10_000 }).toBe(MIXED_HEADINGS[0].text);
    const a = await readViewerBars(frame);
    expect(a.dpr, 'viewer 120% zoom must have raised dpr').toBeGreaterThan(1.05);
    expect(a.bars[0].current, 'first viewer bar current at top-of-scroll').toBe(true);

    // Snapshot B: viewer scrolled to the bottom → the LAST heading current.
    await scrollViewerTo(win, 10_000_000);
    await expect
      .poll(() => viewerCurrentHeading(win), { timeout: 10_000 })
      .toBe(MIXED_HEADINGS[MIXED_HEADINGS.length - 1].text);
    const b = await readViewerBars(frame);
    expect(b.bars[b.bars.length - 1].current, 'last viewer bar current at bottom-of-scroll').toBe(true);

    assertToggledBarCentered(a.bars, b.bars, a.dpr, 'viewer@120', 1);
    assertNeighboursUnmoved(a.bars, b.bars, a.dpr, 'viewer@120');
    await scrollViewerTo(win, 0);
  });
});
