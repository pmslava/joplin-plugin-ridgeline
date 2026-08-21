import { test, expect, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  waitForEditorStrip,
  EDITOR_STRIP,
  EDITOR_BARS,
  VIEWER_IFRAME,
} from './helpers';

/**
 * Z3 — IFRAME TRANSIT + STUCK-OPEN. Once the pointer enters ANY iframe (his Cockpit panel, the note
 * viewer, another plugin panel), the host window's document stops receiving mousemove. So the two
 * adjacent bugs he hit:
 *   (a) a fast transit across the strip INTO an iframe still opened the TOC — the dwell timer matured
 *       on stale coordinates because the "pointer left the zone" mousemove never arrived; and
 *   (b) an OPEN TOC never closed when the pointer departed into the iframe — no mousemove ever told it
 *       the pointer had left.
 * The fix handles event BOUNDARIES: a mouseout whose relatedTarget is null or an IFRAME (plus window
 * blur / visibilitychange) cancels the dwell timer and starts the close grace, WITHOUT another mousemove
 * in our document.
 *
 * DETERMINISTIC REPRODUCTION. His Cockpit panel is a docked iframe adjacent to the editor. We reproduce
 * that faithfully and controllably by injecting a real <iframe> element into the editor window at a known
 * location clear of the strip, then driving realistic Playwright mouse.move sequences from the bars into
 * it. The key to ISOLATING the boundary fix: a single-step mouse.move whose endpoint is OVER the iframe
 * delivers its mousemove to the IFRAME, not to our document — so our ordinary mousemove handler never
 * runs, and only the new mouseout/boundary handler can cancel the dwell or close the panel. If the fix
 * were absent, (a) the dwell timer would mature into a popup and (b) the open panel would never close.
 * The mirrored viewer case (pointer leaving the note-viewer iframe back into the main window) is covered
 * against the real note viewer.
 */

const TEST_IFRAME_ID = 'ridgeline-z3-test-iframe';

interface Box { x: number; y: number; width: number; height: number }
async function boxOf(win: Page, selector: string): Promise<Box> {
  const b = await win.locator(selector).boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
}

// Inject a real iframe into the editor window at a fixed rect (main-window CSS px), on top of everything.
async function injectIframe(win: Page, rect: Box): Promise<void> {
  await win.evaluate(
    ({ id, r }) => {
      let f = document.getElementById(id) as HTMLIFrameElement | null;
      if (!f) {
        f = document.createElement('iframe');
        f.id = id;
        f.src = 'about:blank';
        document.body.appendChild(f);
      }
      const s = f.style;
      s.position = 'fixed';
      s.left = `${r.x}px`;
      s.top = `${r.y}px`;
      s.width = `${r.width}px`;
      s.height = `${r.height}px`;
      s.border = '0';
      s.margin = '0';
      s.zIndex = '999999';
      s.pointerEvents = 'auto';
    },
    { id: TEST_IFRAME_ID, r: rect },
  );
}

async function removeIframe(win: Page): Promise<void> {
  await win.evaluate((id) => {
    const f = document.getElementById(id);
    if (f && f.parentNode) f.parentNode.removeChild(f);
  }, TEST_IFRAME_ID);
}

test.describe('Z3 iframe transit + stuck-open TOC', () => {
  let joplin: JoplinInstance;
  // A docked "panel" iframe on the right half of the editor window — clear of the left-edge strip and
  // its (left-anchored) hover panel.
  const PANEL_IFRAME: Box = { x: 900, y: 80, width: 600, height: 760 };

  test.beforeAll(async () => {
    joplin = await launchJoplin({ seed: { side: 'left' } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Z3 Transit Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  async function park(win: Page): Promise<void> {
    // Park the pointer in the editor text, away from the strip, and let any grace elapse.
    await win.mouse.move(650, 500);
    await win.waitForTimeout(400);
  }

  async function editorExpanded(win: Page): Promise<string | null> {
    return win.locator(EDITOR_STRIP).getAttribute('data-expanded');
  }

  // (a) A fast swipe from the note area, ACROSS the strip, and INTO the adjacent iframe must NOT open
  // the TOC — the real trip toward his Cockpit panel. Realistic continuous motion (mouse.move steps):
  // the pointer grazes the bars (arming the dwell) then keeps going and ends inside the iframe, so the
  // dwell never matures into a popup.
  test('a fast transit across the strip into an iframe does NOT open the TOC', async () => {
    const { win } = joplin;
    await injectIframe(win, PANEL_IFRAME);
    await park(win);
    const bars = await boxOf(win, EDITOR_BARS);
    const y = bars.y + bars.height / 2;
    // Start just left of the strip, sweep right across the bars and the editor text, and end inside the
    // iframe — one continuous fast motion.
    await win.mouse.move(bars.x - 40, y);
    await win.mouse.move(PANEL_IFRAME.x + PANEL_IFRAME.width / 2, y, { steps: 12 });
    // Well past the dwell: a mis-fire would have popped it open by now.
    await win.waitForTimeout(700);
    expect(await editorExpanded(win)).not.toBe('true');
    await removeIframe(win);
  });

  // (b) An OPEN TOC must auto-close within the grace when the pointer departs into an iframe, with NO
  // further mousemove in the editor document.
  test('an open TOC auto-closes when the pointer departs into an iframe', async () => {
    const { win } = joplin;
    await injectIframe(win, PANEL_IFRAME);
    await park(win);
    const bars = await boxOf(win, EDITOR_BARS);
    const cx = bars.x + bars.width / 2;
    const cy = bars.y + bars.height / 2;

    // Rest on the bars to open (dwell ~300ms).
    await win.mouse.move(cx, cy);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 8_000 });

    // Single-step into the iframe: the editor document sees only the mouseout(→IFRAME); its own mousemove
    // handler never runs (the endpoint move belongs to the iframe). Only the boundary fix can close it.
    await win.mouse.move(PANEL_IFRAME.x + PANEL_IFRAME.width / 2, PANEL_IFRAME.y + PANEL_IFRAME.height / 2, { steps: 1 });

    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'false', { timeout: 5_000 });
    await expect(win.locator(`${EDITOR_STRIP} .ridgeline-panel`)).toBeHidden();
    await removeIframe(win);
  });

  // Mirrored case, against the REAL note viewer: the viewer strip has the same stuck-open exposure — the
  // pointer departing the viewer surface into an adjacent iframe (another plugin panel rendered over the
  // note, or the pointer crossing into a docked iframe) stops the viewer document's mousemove stream.
  // We reproduce it deterministically by injecting a real iframe INTO the viewer document, clear of its
  // bars, and moving the OS pointer from the viewer bars into it: the viewer document then sees only the
  // mouseout(→IFRAME), so only the viewer's boundary fix can close the open panel.
  test('an open viewer TOC auto-closes when the pointer departs into an iframe', async () => {
    const { win } = joplin;
    await park(win);
    const frame = await ensureViewerVisible(win);
    const viewerStrip = win.frameLocator(VIEWER_IFRAME).locator('#ridgeline-viewer-strip');
    const viewerBars = win.frameLocator(VIEWER_IFRAME).locator('#ridgeline-viewer-strip .ridgeline-bars');
    await expect(viewerBars).toBeVisible({ timeout: 15_000 });

    // Inject a docked "panel" iframe into the viewer document, on its right side (clear of the
    // left-edge bars and the left-anchored hover panel).
    await frame.evaluate(() => {
      const f = document.createElement('iframe');
      f.id = 'ridgeline-z3-viewer-iframe';
      f.src = 'about:blank';
      Object.assign(f.style, {
        position: 'fixed', right: '0px', top: '15%', width: '160px', height: '300px',
        border: '0', margin: '0', zIndex: '2147483646', pointerEvents: 'auto',
      });
      document.body.appendChild(f);
    });

    // Open the viewer panel by resting on its bars (Playwright puts the real OS pointer over them).
    await viewerBars.hover();
    await expect(viewerStrip).toHaveAttribute('data-expanded', 'true', { timeout: 8_000 });

    // Compute the nested iframe's centre in main-window coordinates and single-step the OS pointer there.
    const viewerBox = await win.locator(VIEWER_IFRAME).boundingBox();
    const nested = await frame.evaluate(() => {
      const r = (document.getElementById('ridgeline-z3-viewer-iframe') as HTMLElement).getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (!viewerBox) throw new Error('no viewer iframe box');
    await win.mouse.move(viewerBox.x + nested.x + nested.w / 2, viewerBox.y + nested.y + nested.h / 2, { steps: 1 });

    await expect(viewerStrip).toHaveAttribute('data-expanded', 'false', { timeout: 5_000 });
    await frame.evaluate(() => {
      const f = document.getElementById('ridgeline-z3-viewer-iframe');
      if (f && f.parentNode) f.parentNode.removeChild(f);
    });
  });

  // Keep-open invariants still hold: resting on the bars opens, Esc closes.
  test('regression: dwell still opens and Esc still closes', async () => {
    const { win } = joplin;
    await park(win);
    const bars = await boxOf(win, EDITOR_BARS);
    await win.mouse.move(bars.x + bars.width / 2, bars.y + bars.height / 2);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 8_000 });
    await win.keyboard.press('Escape');
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'false', { timeout: 5_000 });
  });
});
