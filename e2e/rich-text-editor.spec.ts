import { test, expect, Frame, Page } from '@playwright/test';
import { launchJoplin, closeJoplin, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  waitForEditorStrip,
  EDITOR_STRIP,
  MIXED_HEADINGS,
  VIEWER_IFRAME,
} from './helpers';

/**
 * THE RICH TEXT (TinyMCE) EDITOR IS NOT A TARGET — the strip must never be built into it.
 *
 * THE MECHANISM. Ridgeline ships `viewer.js`/`viewer.css` as MarkdownIt content-script ASSETS, and
 * Joplin's Rich Text editor loads those assets into its OWN document: TinyMCE's
 * `loadDocumentAssets()` (packages/app-desktop/gui/NoteEditor/NoteBody/TinyMCE) appends a <link> for
 * every css asset and a `<script class="jop-tinymce-js">` for every js asset into the editor iframe's
 * head, after rendering the note with markupToHtml() and setting it as the editor's content. Its
 * `useWebViewApi()` hook then defines `webviewApi.postMessage` on that iframe's window. So every
 * precondition viewer.js builds on is satisfied there — a host bridge, and rendered headings that
 * still carry the renderer's anchor ids.
 *
 * WHY THAT IS A BUG, NOT A FEATURE. The TinyMCE document is CONTENTEDITABLE: whatever sits in its
 * body is note content, and Joplin converts it back to Markdown on save. Probed against Joplin 3.7.x
 * on 2026-09-06 (this exact setup, before the guard): `strips: 1`, mounted inside the contentEditable
 * body, rect 44×671 at (0,0); `tinymce.activeEditor.getContent()` matched /ridgeline/i; and after ONE
 * typed word, toggling back to the Markdown editor showed the first heading title TWICE in the
 * CodeMirror text — the panel's row labels had been saved into the note body. So this is not merely
 * an unwanted overlay: editing in Rich Text rewrote the user's note.
 *
 * THE GUARD (src/contentScripts/viewer.js). `insideEditorDocument()` is true when the document is
 * editable (`document.body.isContentEditable`, or `designMode === 'on'`) OR the body carries
 * TinyMCE's root marker class `mce-content-body` — clause (b) covers TinyMCE's read-only mode, where
 * Joplin calls `editor.mode.set('readonly')` and the body is not editable but the document is still
 * the Rich Text editor with our assets in it. `stripAllowedHere()` = a host bridge AND not an editor
 * document, and it is consulted on all three build paths (build / scheduleBuild / startPolling), so
 * a later poll tick or `joplin-noteDidUpdate` cannot sneak a strip in either.
 *
 * WHY THE CONTROLS MAKE THE ASSERTION MEANINGFUL. "No strip" is only interesting if a strip COULD
 * have been built here, so test A first proves, with messages, that the Rich Text document is the
 * loaded, bridged, heading-bearing document the probe found: our <script>/<link> tags are in its
 * head, `typeof webviewApi === 'object'` with a callable postMessage, all six headings carry ids,
 * and the body is `mce-content-body` + contentEditable. Remove the guard and this test fails exactly
 * as the probe measured it. Test B is the no-over-reach half: the two REAL targets — the rendered
 * viewer's strip and the Markdown editor's strip — must come straight back.
 */

const TINYMCE_IFRAME = 'iframe.tox-edit-area__iframe';

interface RichTextEvidence {
  scriptInjected: boolean;
  cssInjected: boolean;
  webviewApiType: string;
  postMessageIsFunction: boolean;
  headingsWithId: number;
  bodyIsMceContentBody: boolean;
  bodyIsContentEditable: boolean;
  strips: number;
  bodyMarginLeft: string;
  bodyMarginRight: string;
}

/**
 * Evaluated as a STRING on purpose: `typeof webviewApi` must be read LEXICALLY. TinyMCE defines the
 * bridge as a window property, but the note viewer declares it as a top-level `const` that is not
 * reachable through `window`, so the honest check is the same one viewer.js makes — and TypeScript
 * cannot even name an undeclared identifier inside a callback.
 */
const EVIDENCE_SCRIPT = `(function () {
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var api = (typeof webviewApi !== 'undefined') ? webviewApi : null;
  var body = document.body;
  return {
    scriptInjected: all('script[src]').some(function (el) { return /(contentScripts|ridgeline)\\S*\\/viewer\\.js/i.test(el.getAttribute('src') || ''); }),
    cssInjected: all('link[rel="stylesheet"]').some(function (el) { return /(contentScripts|ridgeline)\\S*\\/viewer\\.css/i.test(el.getAttribute('href') || ''); }),
    webviewApiType: typeof webviewApi,
    postMessageIsFunction: !!api && typeof api.postMessage === 'function',
    headingsWithId: all('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]').length,
    bodyIsMceContentBody: !!body && body.classList.contains('mce-content-body'),
    bodyIsContentEditable: !!body && body.isContentEditable,
    strips: all('#ridgeline-viewer-strip, .ridgeline-viewer-strip, .ridgeline-strip').length,
    bodyMarginLeft: body ? body.style.marginLeft : 'NO BODY',
    bodyMarginRight: body ? body.style.marginRight : 'NO BODY'
  };
})()`;

/**
 * The TinyMCE editing document. Primary path: the iframe element's own contentFrame(). Fallback: any
 * frame whose body carries TinyMCE's root marker (a frame can be mid-swap, and evaluating a detached
 * one throws).
 */
async function tinymceFrame(win: Page): Promise<Frame | null> {
  const handle = await win.$(TINYMCE_IFRAME);
  if (handle) {
    const frame = await handle.contentFrame();
    if (frame) return frame;
  }
  for (const frame of win.frames()) {
    try {
      const isTiny = await frame.evaluate(
        () => !!document.body && document.body.classList.contains('mce-content-body')
      );
      if (isTiny) return frame;
    } catch {
      /* detached or navigating; keep looking */
    }
  }
  return null;
}

/** The serialised note body TinyMCE would save, or null if the editor is not reachable. */
async function tinymceContent(win: Page): Promise<string | null> {
  return win.evaluate(() => {
    const editor = (window as unknown as { tinymce?: { activeEditor?: { getContent?: () => string } } })
      .tinymce?.activeEditor;
    if (!editor || typeof editor.getContent !== 'function') return null;
    try {
      return String(editor.getContent());
    } catch {
      return null;
    }
  });
}

/** Click Joplin's editor toggle (command `toggleEditors`), returning the selector that worked. */
async function clickToggleEditors(win: Page): Promise<string> {
  const byRole = win.getByRole('button', { name: 'Toggle editors' }).first();
  try {
    await byRole.waitFor({ state: 'visible', timeout: 20_000 });
    await byRole.click({ timeout: 15_000 });
    return 'getByRole(button, "Toggle editors")';
  } catch {
    /* fall through to attribute-based selectors */
  }
  for (const selector of ['[title*="Toggle editors"]', '[aria-label*="Toggle editors"]']) {
    try {
      const locator = win.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 5_000 });
      await locator.click({ timeout: 10_000 });
      return selector;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No "Toggle editors" control could be found or clicked');
}

test.describe('The Rich Text (TinyMCE) editor builds no strip and stays uncontaminated', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    // hideWhenEmpty:false on purpose. With the default (true) a document that simply rendered no
    // headings would also produce "no strip", and a missing guard could hide behind it. With it off,
    // the only thing that can keep a strip out of the Rich Text editor is the guard itself.
    joplin = await launchJoplin({ seed: { hideWhenEmpty: false } });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Rich Text Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
    await ensureViewerVisible(joplin.win);

    // The Rich Text editor only mounts if the editor pane is actually on screen; Ctrl+L cycles panes,
    // and ensureViewerVisible above may have left a viewer-only layout.
    const { win } = joplin;
    for (let i = 0; i < 4; i++) {
      if (await win.locator('.cm-editor').first().isVisible().catch(() => false)) break;
      await win.keyboard.press('Control+l');
      await win.waitForTimeout(800);
    }
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('no strip is built into the TinyMCE document, and editing there cannot pick one up', async () => {
    const { win } = joplin;
    const headingTitles = MIXED_HEADINGS.map((h) => h.text);

    const toggleSelector = await clickToggleEditors(win);
    test.info().annotations.push({ type: 'toggle-selector', description: toggleSelector });

    await expect(win.locator(TINYMCE_IFRAME)).toBeAttached({ timeout: 60_000 });
    // Not just "an iframe exists": wait until the NOTE is rendered inside it, so everything below is
    // measured on the real Rich Text document rather than an empty one.
    await expect
      .poll(
        async () => {
          const frame = await tinymceFrame(win);
          if (!frame) return -1;
          try {
            return await frame.evaluate(
              (titles: string[]) =>
                Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(
                  (el) => titles.indexOf((el.textContent || '').trim()) >= 0
                ).length,
              headingTitles
            );
          } catch {
            return -1;
          }
        },
        { timeout: 60_000, message: 'the note headings are rendered inside the TinyMCE document' }
      )
      .toBeGreaterThan(0);

    // Give viewer.js every chance to build: its 50 ms debounce, its ~700 ms settings poll, and an
    // explicit joplin-noteDidUpdate — the same rebuild paths the guard has to cover.
    await win.waitForTimeout(3_000);
    const beforeEvent = await tinymceFrame(win);
    await beforeEvent
      ?.evaluate(() => document.dispatchEvent(new Event('joplin-noteDidUpdate')))
      .catch(() => {});
    await win.waitForTimeout(3_000);

    const frame = await tinymceFrame(win);
    expect(frame, 'the TinyMCE editing frame is attached').not.toBeNull();
    const evidence = (await frame!.evaluate(EVIDENCE_SCRIPT)) as RichTextEvidence;

    // CONTROLS — this document really could have built a strip. Without these, "0 strips" would be
    // satisfied by an editor that never loaded our asset at all.
    expect(evidence.scriptInjected, 'control: TinyMCE injected our viewer.js as a document asset').toBe(true);
    expect(evidence.cssInjected, 'control: TinyMCE injected our viewer.css as a document asset').toBe(true);
    expect(evidence.webviewApiType, 'control: TinyMCE defines a webviewApi host bridge in its iframe').toBe('object');
    expect(evidence.postMessageIsFunction, 'control: that bridge has a callable postMessage — hostAvailable() is TRUE here').toBe(true);
    expect(evidence.headingsWithId, 'control: the rendered content keeps the renderer anchor ids the strip is built from').toBe(
      MIXED_HEADINGS.length
    );
    expect(evidence.bodyIsMceContentBody, 'control: the body carries TinyMCE root marker mce-content-body').toBe(true);
    expect(evidence.bodyIsContentEditable, 'control: the body is contentEditable — anything in it is note content').toBe(true);

    // THE ASSERTION: nothing of ours in the editor document, and no reserve margin pushed onto it.
    expect(evidence.strips, 'the guard keeps every strip out of the Rich Text editor document').toBe(0);
    expect(evidence.bodyMarginLeft, 'the Rich Text body keeps its own left margin').toBe('');
    expect(evidence.bodyMarginRight, 'the Rich Text body keeps its own right margin').toBe('');

    // And what TinyMCE would SAVE carries none of it — the half that actually protects the note.
    const content = await tinymceContent(win);
    expect(content, 'tinymce.activeEditor.getContent() is readable from the main window').not.toBeNull();
    expect(
      /ridgeline/i.test(content ?? ''),
      'the serialised Rich Text content contains nothing of ours'
    ).toBe(false);

    // The probe's pollution path: one typed word is all it took to write the outline into the note.
    await win.frameLocator(TINYMCE_IFRAME).locator('body').click({ timeout: 15_000 });
    await win.keyboard.press('Control+End');
    await win.keyboard.type(' probe');
    await win.waitForTimeout(2_000);
    const afterEdit = await tinymceContent(win);
    expect(
      /ridgeline/i.test(afterEdit ?? ''),
      'after editing in Rich Text, the serialised content STILL contains nothing of ours'
    ).toBe(false);
  });

  test('the guard does not over-reach: the viewer and Markdown editor strips are unaffected', async () => {
    const { win } = joplin;

    // Test A left us in the Rich Text editor; toggle back only if we are not already in Markdown.
    if (!(await win.locator('.cm-editor').first().isVisible().catch(() => false))) {
      await clickToggleEditors(win);
    }
    await expect(win.locator('.cm-editor')).toBeAttached({ timeout: 60_000 });
    await win.waitForTimeout(2_000);

    // The two REAL targets still work.
    await expect(
      win.frameLocator(VIEWER_IFRAME).locator('#ridgeline-viewer-strip'),
      'the rendered viewer strip is back'
    ).toBeVisible({ timeout: 60_000 });
    await expect(win.locator(EDITOR_STRIP), 'the Markdown editor strip is back').toBeAttached({
      timeout: 60_000,
    });

    // And the note itself was not rewritten by the Rich Text round trip. CodeMirror virtualises long
    // documents, so only the rendered viewport is readable here: "at most once" is the honest bound —
    // the pre-guard probe saw this title TWICE in exactly this measurement.
    const markdown = await win.evaluate(() => {
      const el = document.querySelector('.cm-content') as HTMLElement | null;
      return el ? el.innerText : '';
    });
    const firstTitle = MIXED_HEADINGS[0].text;
    expect(
      markdown.split(firstTitle).length - 1,
      `"${firstTitle}" was not duplicated into the note body by the Rich Text round trip`
    ).toBeLessThanOrEqual(1);
    expect(/ridgeline/i.test(markdown), 'no strip markup leaked into the Markdown source').toBe(false);
  });
});
