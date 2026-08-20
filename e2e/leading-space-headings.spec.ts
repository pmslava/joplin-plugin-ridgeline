import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNoteWithExactBody,
  ensureViewerVisible,
  scrollEditorTo,
  editorScrollTop,
  measureHeadingGeometry,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * P1 — Ridgeline correctness with LEADING-SPACE ATX headings.
 *
 * CommonMark (§4.3) allows an ATX heading to carry up to three spaces of leading indent before the
 * `#` — " # Title", "  ## Title", "   ### Title" are all valid H1/H2/H3. Real users end up with these
 * because CodeMirror's auto-indent can carry a leading space onto a freshly-typed heading. Joplin's
 * RENDERED viewer strips that leading whitespace (correct). In the user's real desktop the Markdown
 * EDITOR draws the leading whitespace as visible indentation that grows with heading level — but that
 * mis-indentation is NOT Joplin core and NOT Ridgeline. A clean profile with inline rendering ON
 * renders leading-space headings flush (measured 0px at every level); the shift only appears with the
 * third-party Wrapped Line Indent plugin (com.bwat47.joplin-wrapped-line-indent) installed, which
 * hang-indents any leading-whitespace line (padding-left + equal negative text-indent) and, on a
 * heading line, lays that whitespace out at the level's larger font so the indent scales with level.
 * Editor geometry is pixel-identical with Ridgeline loaded or not (see the round-2 hand-off notes). So
 * this spec deliberately asserts only RIDGELINE'S behaviour, never the plugin's per-level geometry
 * (which would flip the moment that plugin is fixed or removed):
 *
 *   1. Ridgeline lists leading-space headings in BOTH surfaces (a bar per heading, editor↔viewer
 *      parity) — they must not be dropped just because of the leading space.
 *   2. The editor bar's anchor (our uslug) matches the id Joplin's renderer put on the rendered
 *      heading — slug parity for leading-space headings — so click-to-jump lands.
 *   3. Clicking a leading-space heading's bar jumps the editor to it.
 *   4. Ridgeline does not itself shift heading text: NORMAL (no-leading-space) headings stay flush
 *      with body text while Ridgeline is mounted (this is the only alignment claim we can make that
 *      stays true after core fixes the leading-space case).
 */

// Normal + leading-space headings interleaved, each followed by filler so the note scrolls. The final
// section is tall so a jump to it visibly moves the scroll position.
const HEADINGS = [
  { raw: '# Overview', text: 'Overview', slug: 'overview', level: 1, leading: false },
  { raw: ' # Spaced Alpha', text: 'Spaced Alpha', slug: 'spaced-alpha', level: 1, leading: true },
  { raw: '  ## Spaced Bravo', text: 'Spaced Bravo', slug: 'spaced-bravo', level: 2, leading: true },
  { raw: '### Charlie', text: 'Charlie', slug: 'charlie', level: 3, leading: false },
  { raw: '   ## Spaced Delta', text: 'Spaced Delta', slug: 'spaced-delta', level: 2, leading: true },
];

function buildBody(): string {
  const lines: string[] = [];
  HEADINGS.forEach((h, i) => {
    lines.push(h.raw);
    const filler = i === HEADINGS.length - 1 ? 80 : 8;
    for (let n = 0; n < filler; n++) lines.push(`Body ${i + 1} line ${n + 1}.`);
    lines.push('');
  });
  return lines.join('\n');
}

const TOL = 3;

test.describe('P1 leading-space ATX headings — Ridgeline correctness', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ seed: { side: 'left', editorMode: 'overlay' } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithExactBody(joplin.win, 'Leading Space Note', buildBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('editor lists every heading including the leading-space ones', async () => {
    const { win } = joplin;
    await expect
      .poll(() => win.locator(`${EDITOR_STRIP} .ridgeline-bar`).count(), { timeout: 10_000 })
      .toBe(HEADINGS.length);

    // Each heading — leading-space included — has a bar carrying its text and anchor.
    const anchors = await win.locator(`${EDITOR_STRIP} .ridgeline-bar`).evaluateAll((bars) =>
      bars.map((b) => ({ text: b.getAttribute('data-text'), anchor: b.getAttribute('data-anchor'), level: b.getAttribute('data-level') }))
    );
    expect(anchors.map((a) => a.text)).toEqual(HEADINGS.map((h) => h.text));
    expect(anchors.map((a) => a.anchor)).toEqual(HEADINGS.map((h) => h.slug));
    expect(anchors.map((a) => Number(a.level))).toEqual(HEADINGS.map((h) => h.level));
  });

  test('viewer lists the same headings (editor↔viewer parity) with matching anchors', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    await expect(frame.locator('#ridgeline-viewer-strip .ridgeline-bar')).toHaveCount(HEADINGS.length, {
      timeout: 15_000,
    });

    const viewerAnchors = await frame
      .locator('#ridgeline-viewer-strip .ridgeline-bar')
      .evaluateAll((bars) => bars.map((b) => b.getAttribute('data-anchor')));
    expect(viewerAnchors).toEqual(HEADINGS.map((h) => h.slug));

    // Slug parity with Joplin's OWN renderer: the anchor our editor parser generated for each
    // leading-space heading equals the id Joplin put on the rendered <h*>. (If uslug and Joplin's
    // renderer disagreed on how to slug a leading-space heading, the jump would miss.)
    for (const h of HEADINGS) {
      const renderedId = await frame.locator(`#${h.slug}`).first().getAttribute('id').catch(() => null);
      expect(renderedId, `rendered <h${h.level}> id for "${h.text}"`).toBe(h.slug);
    }
  });

  test('clicking a leading-space heading bar jumps the editor to it', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    expect(await editorScrollTop(win)).toBeLessThan(20);

    // "Spaced Delta" is the last heading, sitting far down the note — jumping to it must move scroll.
    const deltaIndex = HEADINGS.findIndex((h) => h.slug === 'spaced-delta');
    await win.locator(`${EDITOR_STRIP} .ridgeline-bar[data-index="${deltaIndex}"]`).dispatchEvent('click');
    await expect.poll(() => editorScrollTop(win), { timeout: 10_000 }).toBeGreaterThan(200);
  });

  test('Ridgeline does not shift heading text: normal headings stay flush with body', async () => {
    const { win } = joplin;
    await scrollEditorTo(win, 0);
    const g = await measureHeadingGeometry(win);
    expect(g.bodyLeft, 'a body line was measured').toBeGreaterThan(0);
    // Only assert on NORMAL headings — the leading-space core mis-indentation is a separate upstream
    // bug we must NOT lock into a spec. Ridgeline itself never shifts text, so normal headings are flush.
    const normalTexts = new Set(HEADINGS.filter((h) => !h.leading).map((h) => h.text));
    const normal = g.headings.filter((h) => normalTexts.has(h.text.trim()));
    expect(normal.length, 'normal headings measured').toBeGreaterThan(0);
    for (const h of normal) {
      expect(
        Math.abs(h.left - g.bodyLeft),
        `normal H${h.level} "${h.text}" left ${h.left.toFixed(1)} vs body ${g.bodyLeft.toFixed(1)}`
      ).toBeLessThanOrEqual(TOL);
    }
  });
});
