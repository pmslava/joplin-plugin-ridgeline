import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance, PLUGIN_ID } from './launch';
import {
  buildNoteBody,
  createNotebook,
  createNoteWithBody,
  editorCurrentHeading,
  editorScrollTop,
  ensureViewerVisible,
  HEADINGS,
  scrollEditorTo,
  scrollViewerTo,
  selectNoteByTitle,
  viewerCurrentHeading,
  viewerFrameOrNull,
  viewerScrollTop,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * Default settings (side=left, overlay). One Joplin launch covers the editor-side and viewer-side
 * primitives: S1 (editor strip), S2 (editor current heading tracks scroll), S4 (viewer strip rebuilt
 * idempotently), S5 (viewer current heading tracks scroll), S6 (click-to-jump in both panes).
 */
test.describe('Ridgeline editor + viewer strip (default settings)', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Test Note', buildNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('plugin background page is running (CDP)', async () => {
    await expect
      .poll(
        () => {
          const urls: string[] = [];
          for (const ctx of joplin.browser.contexts()) {
            for (const p of ctx.pages()) urls.push(p.url());
          }
          return urls.some((u) => u.includes(`pluginId=${PLUGIN_ID}`));
        },
        { timeout: 30_000 }
      )
      .toBe(true);
  });

  // S1 — a strip is mounted at the left edge of the editor pane.
  test('S1: editor strip is mounted at the left edge of the editor', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);
    await expect(strip).toBeAttached();

    const box = await strip.boundingBox();
    const editorBox = await win.locator('.cm-editor').first().boundingBox();
    expect(box).not.toBeNull();
    expect(editorBox).not.toBeNull();
    if (box && editorBox) {
      // Narrow vertical strip...
      expect(box.width).toBeGreaterThan(6);
      expect(box.width).toBeLessThan(40);
      expect(box.height).toBeGreaterThan(100);
      // ...pinned to the editor's left edge.
      expect(Math.abs(box.x - editorBox.x)).toBeLessThan(6);
      expect(await win.locator(EDITOR_STRIP).getAttribute('data-side')).toBe('left');
    }
  });

  // S3 (negative control) — in overlay mode (the default) the strip draws OVER the text, so the
  // content must NOT carry the reserve padding that reserve mode adds. Complements the positive
  // reserve-padding assertion in reserve-and-side.spec.ts.
  test('S3 (negative): overlay mode does not reserve content padding', async () => {
    const { win } = joplin;
    const paddingLeft = await win.evaluate(() => {
      const el = document.querySelector('.cm-content') as HTMLElement | null;
      if (!el) return -1;
      return parseFloat(getComputedStyle(el).paddingLeft) || 0;
    });
    expect(paddingLeft).toBeGreaterThanOrEqual(0);
    // Reserve mode would add STRIP_WIDTH_PX (14) + gap (4) = 18px; overlay must stay well below that.
    expect(paddingLeft).toBeLessThan(14);
  });

  // S2 — current heading is the top-most heading in the viewport, updating live on scroll.
  test('S2: editor current heading tracks the viewport top on scroll', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    const atTop = await editorCurrentHeading(win);
    expect(atTop).toBe(HEADINGS[0]); // Introduction

    // Scroll to the bottom. The final section is built taller than the viewport, so the last heading
    // must sit at the top — assert that EXACT heading (poll: the label update is rAF-debounced).
    await win.evaluate(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => editorCurrentHeading(win), { timeout: 5_000 })
      .toBe(HEADINGS[HEADINGS.length - 1]); // Troubleshooting
  });

  // S6 (editor) — clicking a strip tick jumps the editor to that heading (full message round-trip).
  test('S6: clicking an editor tick scrolls the editor to that heading', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    expect(await editorScrollTop(win)).toBeLessThan(20);

    // Click the tick for the last heading; the editor should scroll well down.
    const lastIndex = HEADINGS.length - 1;
    await win.locator(`[data-testid="ridgeline-editor-tick-${lastIndex}"]`).dispatchEvent('click');
    await expect.poll(() => editorScrollTop(win), { timeout: 10_000 }).toBeGreaterThan(200);

    // And the current-heading label should settle onto a late heading (poll: the label update is
    // rAF-debounced, so it lands a frame after the scroll position does).
    await expect
      .poll(async () => HEADINGS.slice(3).includes(await editorCurrentHeading(win)), { timeout: 5_000 })
      .toBe(true);
  });

  // S4 — the viewer strip exists inside the rendered note iframe and is rebuilt (not duplicated) when
  // the note is edited OR when switching notes.
  test('S4: viewer strip survives an edit and a note switch without duplicating', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);

    const strip = frame.locator('#ridgeline-viewer-strip');
    await expect(strip).toBeAttached({ timeout: 15_000 });
    expect(await frame.locator('#ridgeline-viewer-strip .ridgeline-tick').count()).toBe(
      HEADINGS.length
    );

    // The strip is pinned to the viewport with position: fixed.
    expect(
      await frame.evaluate(() => {
        const el = document.getElementById('ridgeline-viewer-strip');
        return el ? getComputedStyle(el).position : '';
      })
    ).toBe('fixed');

    // Edit the note: type a character into the editor, which forces a viewer re-render.
    await win.locator('.cm-content').first().click();
    await win.keyboard.press('End');
    await win.keyboard.type(' edit');
    await win.waitForTimeout(1500);

    // Exactly one strip must exist after the re-render (idempotent rebuild).
    let freshFrame = viewerFrameOrNull(win)!;
    await expect(freshFrame.locator('#ridgeline-viewer-strip')).toHaveCount(1);
    expect(await freshFrame.locator('#ridgeline-viewer-strip .ridgeline-tick').count()).toBe(
      HEADINGS.length
    );

    // Switch to a DIFFERENT note (with a different heading count) and back. Each switch re-renders the
    // viewer; the strip must stay a single instance with the correct per-note tick count — not pile up
    // duplicates from the previous note's build.
    await createNoteWithBody(
      win,
      'Ridgeline Other Note',
      ['# Alpha', 'text', '# Beta', 'text', '# Gamma', 'text'].join('\n')
    );
    await selectNoteByTitle(win, 'Ridgeline Test Note');

    freshFrame = await ensureViewerVisible(win);
    await expect(freshFrame.locator('#ridgeline-viewer-strip')).toHaveCount(1);
    await expect(freshFrame.locator('#ridgeline-viewer-strip .ridgeline-tick')).toHaveCount(
      HEADINGS.length
    );
  });

  // S5 — viewer current heading tracks the viewport top on scroll.
  test('S5: viewer current heading tracks the viewport top on scroll', async () => {
    const { win } = joplin;
    await ensureViewerVisible(win);
    await scrollViewerTo(win, 0);
    const atTop = await viewerCurrentHeading(win);
    expect(atTop).toBe(HEADINGS[0]);

    // Scroll to the bottom. The tall final section forces the last heading to the top — assert that
    // EXACT heading (poll: the label update is rAF-debounced).
    await scrollViewerTo(win, 100000); // scroll to bottom
    await expect
      .poll(() => viewerCurrentHeading(win), { timeout: 5_000 })
      .toBe(HEADINGS[HEADINGS.length - 1]); // Troubleshooting
  });

  // S6 (viewer) — clicking a viewer tick jumps the viewer to that heading.
  test('S6: clicking a viewer tick scrolls the viewer to that heading', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    await scrollViewerTo(win, 0);
    expect(await viewerScrollTop(win)).toBeLessThan(20);

    const lastIndex = HEADINGS.length - 1;
    await frame.locator(`[data-testid="ridgeline-viewer-tick-${lastIndex}"]`).dispatchEvent('click');
    await expect.poll(() => viewerScrollTop(win), { timeout: 10_000 }).toBeGreaterThan(200);
  });
});
