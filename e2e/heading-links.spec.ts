import { test, expect } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  createNotebook,
  createNoteWithExactBody,
  ensureViewerVisible,
  hoverEditorBars,
  scrollEditorTo,
  scrollViewerTo,
  editorScrollTop,
  viewerScrollTop,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * GitHub issue #1 — "Headings with links".
 *
 * `## See [Alpha Note](:/0123…) for details` used to show its RAW MARKDOWN in the editor strip's bar
 * tooltip and hover-outline row. Both surfaces must now show what a reader sees — `See Alpha Note for
 * details` — and, as a direct consequence of resolving the inline markup properly, our jump anchors
 * must equal the ids Joplin actually renders.
 *
 * What this spec is really defending is the SILENT half of the bug. A wrong anchor throws nothing and
 * logs nothing: `src/index.ts`'s `find()` returns undefined, `resolveLineFromAnchor` returns null, and
 * `handleJump` skips the editor scroll. The only way to see it is end-to-end, against the real app, so
 * T6 below is the sharpest assertion in the file.
 *
 * ON MAIN, deliberately, NOT every assertion flips — a spec where everything failed could not tell
 * "fixed the display" from "rewrote the slug rules":
 *   FAILS on main — T1 (rows 1,2,3,5,6 carry raw Markdown; rows 5 and 6 carry the old anchors
 *   `a-~~strike~~-word` and `use-text-here`), T2 (same raw strings in the TOC), T3's row-array
 *   equality (the VIEWER already read correctly, so main is asserted to be internally inconsistent
 *   between its own two surfaces), T5 and T6 (both jumps to row 6 land nowhere).
 *   PASSES on main — T4, because its locator is built from the EXPECTED slug, which is Joplin's own
 *   rendered id; T3's `data-anchor` array, because viewer.js sets it from `h.id`; and T1 rows 0 and 4,
 *   the plain-text control and the false-positive guard.
 *
 * `npm run dist` is MANDATORY before running this: `assertE2EReady` only checks that dist/manifest.json
 * exists, so a stale build silently tests the old parser — and `headings.ts` is bundled TWICE (into
 * dist/index.js and into dist/contentScripts/editorContentScript.js), so a hand-run of one webpack pass
 * can ship two copies that disagree.
 *
 * maxDepth / hideWhenEmpty are deliberately NOT covered here: they are level-only
 * (editorContentScript.ts, viewer.js) and count-only respectively, so heading TEXT is orthogonal to
 * both. A second seeded launch would double a heavyweight real-Electron run for zero coverage.
 */

// Any well-formed `:/<32 hex>` takes Joplin's note-link rendering branch; the note need not exist.
const NOTE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * If you add a row: give it a NON-EMPTY, CSS-identifier-safe slug, or exclude it from T4. An
 * image-only heading legitimately slugs to the empty string, and `'#'` alone is an invalid CSS
 * selector that throws rather than failing cleanly.
 */
const HEADINGS = [
  // Control: plain prose, green on main. Proves the fixture and the strip work at all.
  { raw: '# Overview', text: 'Overview', slug: 'overview', level: 1 },
  // THE reported case.
  {
    raw: `## See [Alpha Note](:/${NOTE_ID}) for details`,
    text: 'See Alpha Note for details',
    slug: 'see-alpha-note-for-details',
    level: 2,
  },
  { raw: '## [Docs](https://example.com/a?b=1)', text: 'Docs', slug: 'docs', level: 2 },
  { raw: `## [**Bold** note](:/${NOTE_ID})`, text: 'Bold note', slug: 'bold-note', level: 2 },
  // False-positive guard: parentheses that are not a link must survive untouched.
  { raw: '## Notes (see below)', text: 'Notes (see below)', slug: 'notes-see-below', level: 2 },
  // Slug fix: uslug KEEPS '~', so the unstripped ~~ used to leak into the id as `a-~~strike~~-word`.
  { raw: '## A ~~strike~~ word', text: 'A strike word', slug: 'a-strike-word', level: 2 },
  // Slug fix AND the jump target for T5/T6: a code span is opaque, so the link inside it stays
  // literal. Main un-linked inside the code span and produced `use-text-here`, which matches no
  // rendered element — the jump died silently.
  { raw: '## Use `[text](url)` here', text: 'Use [text](url) here', slug: 'use-texturl-here', level: 2 },
];

const JUMP_INDEX = HEADINGS.length - 1;

function buildBody(): string {
  const lines: string[] = [];
  HEADINGS.forEach((h, i) => {
    lines.push(h.raw);
    // The final section is far taller than any plausible viewport so a jump to it visibly moves both
    // scrollers rather than merely changing which heading is current.
    const filler = i === JUMP_INDEX ? 90 : 8;
    for (let n = 0; n < filler; n++) lines.push(`Body ${i + 1} line ${n + 1}.`);
    lines.push('');
  });
  return lines.join('\n');
}

test.describe('Issue #1 — headings containing links read as a reader sees them', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin({ seed: { side: 'left', editorMode: 'overlay' } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    // createNoteWithExactBody (keyboard.insertText), NOT createNoteWithBody: typing this body per key
    // would let CodeMirror's bracket/backtick auto-close corrupt `[Docs](…)` and `` `[text](url)` ``.
    await createNoteWithExactBody(joplin.win, 'Heading Links Note', buildBody());
    await waitForEditorStrip(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  // T1 — the strip's own data. data-text is the string the bar's native tooltip shows.
  test('editor bars carry display text and Joplin-matching anchors', async () => {
    const { win } = joplin;
    await expect
      .poll(() => win.locator(`${EDITOR_STRIP} .ridgeline-bar`).count(), { timeout: 10_000 })
      .toBe(HEADINGS.length);

    const bars = await win.locator(`${EDITOR_STRIP} .ridgeline-bar`).evaluateAll((els) =>
      els.map((b) => ({
        text: b.getAttribute('data-text'),
        anchor: b.getAttribute('data-anchor'),
        level: Number(b.getAttribute('data-level')),
      }))
    );
    expect(bars.map((b) => b.text)).toEqual(HEADINGS.map((h) => h.text));
    expect(bars.map((b) => b.anchor)).toEqual(HEADINGS.map((h) => h.slug));
    expect(bars.map((b) => b.level)).toEqual(HEADINGS.map((h) => h.level));
  });

  // T2 — literally the pixels the reporter photographed: the hover outline's rows.
  test('editor hover TOC rows show the rendered heading text, not raw Markdown', async () => {
    const { win } = joplin;
    await hoverEditorBars(win);
    await expect
      .poll(() => win.locator(EDITOR_STRIP).getAttribute('data-expanded'), { timeout: 5_000 })
      .toBe('true');

    const rows = await win
      .locator(`${EDITOR_STRIP} .ridgeline-panel-row`)
      .evaluateAll((els) => els.map((r) => r.textContent));
    expect(rows).toEqual(HEADINGS.map((h) => h.text));

    // Collapse again so the panel cannot sit over the viewer toggle in the tests below.
    await win.mouse.move(950, 450);
    await expect
      .poll(() => win.locator(EDITOR_STRIP).getAttribute('data-expanded'), { timeout: 5_000 })
      .toBe('false');
  });

  // T3 — the load-bearing one. The two surfaces derive their text by completely opposite means (a
  // Markdown scanner vs a rendered-DOM walker) and must land on the same string. On main the VIEWER is
  // already right, so this asserts main is inconsistent with itself — a viewer-only check would pass on
  // main and prove nothing.
  test('viewer rows match the editor rows exactly (editor↔viewer parity)', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    await expect(frame.locator('#ridgeline-viewer-strip .ridgeline-bar')).toHaveCount(HEADINGS.length, {
      timeout: 15_000,
    });

    // data-anchor on the viewer side is Joplin's OWN id (viewer.js sets it from h.id), so this is a
    // direct comparison of the expected slugs against the renderer.
    const viewerAnchors = await frame
      .locator('#ridgeline-viewer-strip .ridgeline-bar')
      .evaluateAll((els) => els.map((b) => b.getAttribute('data-anchor')));
    expect(viewerAnchors).toEqual(HEADINGS.map((h) => h.slug));

    const viewerRows = await frame
      .locator('#ridgeline-viewer-strip .ridgeline-panel-row')
      .evaluateAll((els) => els.map((r) => r.textContent));
    expect(viewerRows).toEqual(HEADINGS.map((h) => h.text));

    // And byte-identical to the editor's own rows, which is the property that keeps the current-heading
    // readouts (helpers.ts editorCurrentHeading / viewerCurrentHeading) comparable.
    await hoverEditorBars(win);
    await expect
      .poll(() => win.locator(EDITOR_STRIP).getAttribute('data-expanded'), { timeout: 5_000 })
      .toBe('true');
    const editorRows = await win
      .locator(`${EDITOR_STRIP} .ridgeline-panel-row`)
      .evaluateAll((els) => els.map((r) => r.textContent));
    expect(viewerRows).toEqual(editorRows);
    await win.mouse.move(950, 450);
  });

  // T4 — slug parity against Joplin's renderer itself. Passes on main by design: the locator is built
  // from the EXPECTED slug, which IS the rendered id.
  test('every expected slug is a real rendered heading id', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    for (const h of HEADINGS) {
      // Empty slugs are legal in general (an image-only heading) but '#' alone is an invalid selector;
      // this fixture has none, and the rule is stated in the header for whoever adds a row.
      expect(h.slug, 'fixture slugs must be non-empty for this loop').not.toBe('');
      const renderedId = await frame
        .locator(`#${h.slug}`)
        .first()
        .getAttribute('id')
        .catch(() => null);
      expect(renderedId, `rendered <h${h.level}> id for "${h.text}"`).toBe(h.slug);
    }
  });

  // T5 — editor bar → viewer scroll. On main scrollToHash('use-text-here') finds no such element.
  test('clicking the code-span heading bar scrolls the viewer to it', async () => {
    const { win } = joplin;
    await ensureViewerVisible(win);
    await scrollViewerTo(win, 0);
    // dispatchEvent, never .click(): the bars are 3-5px tall and a real pointer move would open (then
    // collapse) the hover panel over the click target.
    await win.locator(`[data-testid="ridgeline-editor-tick-${JUMP_INDEX}"]`).dispatchEvent('click');
    await expect.poll(() => viewerScrollTop(win), { timeout: 15_000 }).toBeGreaterThan(200);
  });

  // T6 — viewer bar → editor scroll: the silent-failure case. The viewer sends Joplin's real id
  // `use-texturl-here`; main's parser computes `use-text-here`, so resolveLineFromAnchor returns null
  // and handleJump skips the editor scroll with NO exception and NO console warning. The poll simply
  // times out. That is exactly why this assertion belongs in the suite.
  test('clicking the code-span heading bar in the viewer scrolls the editor to it', async () => {
    const { win } = joplin;
    const frame = await ensureViewerVisible(win);
    await scrollEditorTo(win, 0);
    await frame.locator(`[data-testid="ridgeline-viewer-tick-${JUMP_INDEX}"]`).dispatchEvent('click');
    await expect.poll(() => editorScrollTop(win), { timeout: 10_000 }).toBeGreaterThan(200);
  });
});
