import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, findSecondaryWindow, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  measureHeadingGeometry,
  waitForEditorStrip,
  EDITOR_STRIP,
  type HeadingGeometry,
} from './helpers';

/**
 * R8 — the critical regression the user reported: with Joplin's inline rendering ON (the user's real
 * environment, seeded in the E2E profile as editor.inlineRendering=true), heading LINES in the
 * Markdown editor must keep their visible text FLUSH with body text. The report was that heading text
 * shifted progressively LEFT by level — pushing text out of the content area, worst with the strip on
 * the right in reserve mode — and only in the MAIN window.
 *
 * Root cause (see SMOKE.md / the round-1 report): Joplin hides the leading `#` marks with a plain
 * Decoration.replace (the characters are removed from layout; there is no per-level text-indent
 * compensation), and Ridgeline's editor CSS is a single uniform reserve padding on `.cm-content`
 * (reconfigured, never stacked) plus an absolutely-positioned overlay strip that is out of the text
 * flow. Neither can shift heading text per level. These specs LOCK that invariant: for every heading
 * line the visible text-left equals the body text-left (within tolerance) and never sits left of the
 * content edge — in all four side/mode combos, for existing AND freshly typed headings, and in both
 * the main and a secondary window.
 *
 * The measurement tool (measureHeadingGeometry) is proven sensitive by the self-validation test
 * below: when an artificial per-level shift is injected it is detected; with only Ridgeline active the
 * offsets are zero.
 */

// Text-left parity tolerance (px). Sub-pixel layout + the 1px line padding are fine; a per-level
// shift of whole characters (many px, growing with level) is the regression this guards against.
const TOL = 3;

function summarize(label: string, g: HeadingGeometry): string {
  const rel = g.headings.map((h) => `H${h.level}:${(h.left - g.bodyLeft).toFixed(1)}`).join(' ');
  return `[${label}] contentLeft=${g.contentLeft.toFixed(1)} bodyLeft=${g.bodyLeft.toFixed(
    1
  )} | heading(left-body): ${rel}`;
}

function assertHeadingsAligned(label: string, g: HeadingGeometry): void {
  // eslint-disable-next-line no-console
  console.log(summarize(label, g));
  expect(g.headings.length, `${label}: headings measured`).toBeGreaterThan(0);
  expect(g.bodyLeft, `${label}: a body line was measured`).toBeGreaterThan(0);
  for (const h of g.headings) {
    // Parity with body text: heading text starts at the same content-left as ordinary text.
    expect(
      Math.abs(h.left - g.bodyLeft),
      `${label}: H${h.level} "${h.text}" text-left ${h.left.toFixed(1)} vs body ${g.bodyLeft.toFixed(
        1
      )}`
    ).toBeLessThanOrEqual(TOL);
    // And never left of the content edge (text must not exit the content area).
    expect(
      h.left,
      `${label}: H${h.level} "${h.text}" text-left ${h.left.toFixed(1)} < contentLeft ${g.contentLeft.toFixed(
        1
      )}`
    ).toBeGreaterThanOrEqual(g.contentLeft - TOL);
  }
}

for (const editorMode of ['overlay', 'reserve'] as const) {
  test.describe(`R8 heading indentation — editorMode=${editorMode}`, () => {
    let joplin: JoplinInstance;

    test.beforeAll(async () => {
      joplin = await launchJoplin({ seed: { side: 'left', editorMode } });
      await createNotebook(joplin.win, 'Ridgeline NB');
      await createNoteWithBody(joplin.win, `R8 ${editorMode} Note`, buildMixedNoteBody());
      await waitForEditorStrip(joplin.win);
    });

    test.afterAll(async () => {
      if (joplin) await closeJoplin(joplin);
    });

    test(`side=left/${editorMode}: heading text aligns with body`, async () => {
      const { win } = joplin;
      await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-side', 'left');
      assertHeadingsAligned(`left/${editorMode}`, await measureHeadingGeometry(win));
    });

    test(`side=right/${editorMode}: heading text aligns with body (live toggle)`, async () => {
      const { win } = joplin;
      // Flip the side live (Ctrl+Alt+R fires the toggle command → settings.onChange → strip re-sided
      // and the reserve theme reconfigured to the other edge).
      await win.locator('.cm-content').first().click();
      await win.waitForTimeout(300);
      await win.keyboard.press('Control+Alt+r');
      await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-side', 'right', { timeout: 15_000 });
      await win.waitForTimeout(500);
      assertHeadingsAligned(`right/${editorMode}`, await measureHeadingGeometry(win));
    });

    test(`newly typed headings align with body (${editorMode})`, async () => {
      const { win } = joplin;
      // Type a fresh multi-level heading block at the end, then move the caret off those lines so
      // their `#` marks hide (inline rendering). The freshly rendered headings must also align.
      await win.locator('.cm-content').first().click();
      await win.keyboard.press('Control+End');
      await win.keyboard.type('\n\n# Fresh One\nx\n## Fresh Two\nx\n### Fresh Three\nx\n#### Fresh Four\nx');
      await win.waitForTimeout(500);
      await win.keyboard.press('Control+Home');
      await win.waitForTimeout(400);
      // Scroll the new headings into view.
      await win.evaluate(() => {
        const el = document.querySelector('.cm-scroller') as HTMLElement | null;
        if (el) el.scrollTop = el.scrollHeight;
      });
      await win.waitForTimeout(400);
      const g = await measureHeadingGeometry(win);
      const fresh = g.headings.filter((h) => h.text.startsWith('Fresh'));
      expect(fresh.length, 'fresh headings measured').toBeGreaterThan(0);
      assertHeadingsAligned(`fresh/${editorMode}`, g);
    });

    if (editorMode === 'overlay') {
      // Self-validation: prove measureHeadingGeometry can DETECT a per-level shift, so the zero-offset
      // results above are a real "no shift" and not a blind spot. Inject an artificial per-level left
      // margin on heading lines, confirm it is detected, then remove it and confirm alignment returns.
      test('measurement tool detects (and clears) an injected per-level shift', async () => {
        const { win } = joplin;
        await win.evaluate(() => {
          const style = document.createElement('style');
          style.id = 'ridgeline-r8-sim';
          style.textContent = [1, 2, 3, 4, 5, 6]
            .map((n) => `.cm-editor .cm-line.cm-h${n}{margin-left:${-6 * n}px;}`)
            .join('');
          document.head.appendChild(style);
        });
        await win.waitForTimeout(300);
        const shifted = await measureHeadingGeometry(win);
        const offsets = shifted.headings.map((h) => h.left - shifted.bodyLeft);
        // eslint-disable-next-line no-console
        console.log('injected offsets:', offsets.map((o) => o.toFixed(1)).join(' '));
        expect(offsets[0]).toBeLessThan(-3);
        for (let i = 1; i < offsets.length; i++) {
          expect(offsets[i]).toBeLessThan(offsets[i - 1] + 1); // progressively more negative
        }
        // Remove the injected shift; alignment must return.
        await win.evaluate(() => document.getElementById('ridgeline-r8-sim')?.remove());
        await win.waitForTimeout(300);
        assertHeadingsAligned('overlay/after-clear', await measureHeadingGeometry(win));
      });
    }
  });
}

/**
 * The user's key diagnostic: he saw the shift only in the MAIN window; a secondary window rendered
 * headings correctly. This test measures BOTH and asserts both keep headings aligned — encoding the
 * discriminator as a permanent guard.
 */
test.describe('R8 main vs secondary window', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ seed: { side: 'right', editorMode: 'reserve' } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'R8 MW Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('both main and secondary window headings align with body', async () => {
    const { win, browser } = joplin;

    assertHeadingsAligned('MAIN', await measureHeadingGeometry(win));

    // Open the note in a secondary window.
    await win.locator('.note-list-item .title span', { hasText: 'R8 MW Note' })
      .first()
      .click()
      .catch(() => {});
    await win.waitForTimeout(500);
    await win.locator('.cm-content').first().click().catch(() => {});
    await win.waitForTimeout(300);
    await win.keyboard.press('Control+Alt+n');

    const secondary = await findSecondaryWindow(browser, win, 30_000);
    expect(secondary, 'a secondary window should open on Ctrl+Alt+N').not.toBeNull();
    await expect(secondary!.locator(EDITOR_STRIP)).toBeAttached({ timeout: 30_000 });
    // Wait until the secondary editor has actually rendered its heading lines before measuring.
    await expect(secondary!.locator('.cm-editor .cm-line.cm-h1').first()).toBeAttached({ timeout: 30_000 });
    await secondary!.evaluate(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement | null;
      if (el) el.scrollTop = 0;
    });
    await secondary!.waitForTimeout(600);
    assertHeadingsAligned('SECONDARY', await measureHeadingGeometry(secondary!));
  });
});
