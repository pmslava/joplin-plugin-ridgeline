import { test, expect, Frame, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchJoplin, closeJoplin, JoplinInstance, E2E_PATHS } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  waitForEditorStrip,
  viewerFrameOrNull,
  VIEWER_IFRAME,
} from './helpers';

/**
 * ISSUE #3 — the outline must not appear in an exported PDF, a printed note, or an exported HTML
 * file. The strip is navigation; those are documents.
 *
 * The bug's mechanism: Ridgeline ships `viewer.js`/`viewer.css` as MarkdownIt content-script ASSETS,
 * and Joplin copies those assets far beyond the live note viewer. Export → PDF and File → Print both
 * go through InteropServiceHelper.exportNoteTo_(): the note is rendered by
 * InteropService_Exporter_Html into a temp .html file, with the plugin assets copied to
 * `pluginAssets/<contentScriptId>/` and injected into <head> as <link>/<script> tags; that file is
 * then loaded into a hidden BrowserWindow and printToPDF()/print() is called on it. Export → HTML
 * writes the very same standalone page. viewer.js used to run there and build the strip into it.
 *
 * The fix is two independent layers, and this spec pins BOTH:
 *
 *   (a) CSS — `@media print { #ridgeline-viewer-strip { display: none !important } }` in viewer.css.
 *       Asserted in the LIVE viewer under Playwright's print-media emulation, then released again.
 *
 *   (b) JS — `hostAvailable()` in viewer.js: with no `webviewApi` host bridge the strip is never
 *       built at all. Asserted on a STANDALONE page of exactly the exporter's shape (no bridge,
 *       assets pulled in by <link>/<script src>), which is the layer that actually keeps the strip
 *       out of the PDF (the exported page is printed, but it is also just a file a user opens).
 *
 * WHY THE (b) PAGE IS BUILT THE WAY IT IS. The faithful way to test the exporter's output is a
 * separate top-level page loading a real file:// .html, so the primary path asks the existing CDP
 * connection for `browser.contexts()[0].newPage()` (Target.createTarget) and navigates it there.
 * Electron's CDP does not always implement target creation, so there is a fallback: build the same
 * page inside a same-origin about:blank IFRAME created in the live viewer document, with the asset
 * text injected inline instead of fetched. An iframe gets its own global scope, so the fallback is a
 * genuine no-bridge page too — note that the OBVIOUS fallback (setting `window.webviewApi =
 * undefined` in the live viewer) would NOT work: Joplin declares `webviewApi` as a top-level `const`
 * in the note viewer's own index.html, so it lives in that document's script scope and is not
 * reachable, or maskable, through `window`. The variant actually used is recorded as a test
 * annotation and logged.
 *
 * Either variant loads the page TWICE — once with no bridge and once with a stub bridge defined
 * ahead of the asset. The stub-bridge load is the NEGATIVE CONTROL that makes the assertion
 * meaningful: it proves the asset really did load and can still build a strip in this page shape, so
 * "no strip" on the no-bridge load can only be the guard, never a page that failed to run the
 * script. Remove `hostAvailable()` from viewer.js and the no-bridge half of this test fails.
 */

const STRIP_ID = 'ridgeline-viewer-strip';
// The exporter lays plugin assets out under `pluginAssets/<asset name>` next to the .html file, and
// a content script's asset name is prefixed with its content-script id. Mirror that layout so the
// page under test references the assets exactly as an exported note does.
const VIEWER_CONTENT_SCRIPT_ID = 'io.github.pmslava.ridgeline.viewerStrip';
const ASSET_REL_DIR = `pluginAssets/${VIEWER_CONTENT_SCRIPT_ID}`;

/** A rendered-note-like body: several <h1>–<h3> with the anchor ids Joplin's renderer emits. */
const RENDERED_NOTE_BODY = `
<div class="exported-note">
  <h1 id="export-alpha">Export Alpha</h1>
  <p>Body text under alpha.</p>
  <h2 id="export-bravo">Export Bravo</h2>
  <p>Body text under bravo.</p>
  <h3 id="export-charlie">Export Charlie</h3>
  <p>Body text under charlie.</p>
  <h2 id="export-delta">Export Delta</h2>
  <p>Body text under delta.</p>
</div>`;

// A minimal stand-in for Joplin's host bridge, defined BEFORE the asset script exactly as the note
// viewer's index.html defines the real one. It answers getSettings with null, so viewer.js keeps its
// fallback settings/tokens and builds — which is the point: it proves the asset runs here.
const BRIDGE_STUB = `<script>window.webviewApi = { postMessage: function () { return Promise.resolve(null); } };</script>`;

function exportPageHtml(withBridge: boolean): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>Ridgeline export probe</title>
    <link rel="stylesheet" href="${ASSET_REL_DIR}/viewer.css">
    ${withBridge ? BRIDGE_STUB : ''}
    <script src="${ASSET_REL_DIR}/viewer.js"></script>
  </head>
  <body>${RENDERED_NOTE_BODY}</body>
</html>`;
}

/**
 * Lay out an exported-note directory (page + pluginAssets/) in a throwaway temp dir, the same shape
 * InteropService_Exporter_Html writes. Kept out of the Joplin profile so the running app never sees
 * it. Returns the two page paths plus the root to remove afterwards.
 */
function writeExportFixture(): { dir: string; noBridge: string; withBridge: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ridgeline-export-'));
  const assetDir = path.join(dir, ASSET_REL_DIR);
  fs.mkdirSync(assetDir, { recursive: true });
  for (const name of ['viewer.js', 'viewer.css']) {
    fs.copyFileSync(path.join(E2E_PATHS.PLUGIN_DIST, 'contentScripts', name), path.join(assetDir, name));
  }
  const noBridge = path.join(dir, 'no-bridge.html');
  const withBridge = path.join(dir, 'with-bridge.html');
  fs.writeFileSync(noBridge, exportPageHtml(false), 'utf8');
  fs.writeFileSync(withBridge, exportPageHtml(true), 'utf8');
  return { dir, noBridge, withBridge };
}

/**
 * Count the strips a standalone page builds, giving viewer.js every chance to build one: its own
 * 50 ms build debounce, its ~700 ms settings poll, and a joplin-noteDidUpdate for good measure.
 */
const PROBE_SCRIPT = `(function () {
  return new Promise(function (resolve) {
    setTimeout(function () {
      document.dispatchEvent(new Event('joplin-noteDidUpdate'));
      setTimeout(function () {
        resolve({
          strips: document.querySelectorAll('#${STRIP_ID}, .ridgeline-viewer-strip').length,
          bodyMarginLeft: document.body.style.marginLeft,
          bodyMarginRight: document.body.style.marginRight,
          headings: document.querySelectorAll('h1[id], h2[id], h3[id]').length,
        });
      }, 1500);
    }, 1500);
  });
})()`;

interface ProbeResult {
  strips: number;
  bodyMarginLeft: string;
  bodyMarginRight: string;
  headings: number;
}

/** Variant B1: a real top-level page on a real file:// URL. Null if this Electron cannot create one. */
async function probeViaNewPage(
  joplin: JoplinInstance,
  files: { noBridge: string; withBridge: string }
): Promise<{ noBridge: ProbeResult; withBridge: ProbeResult } | null> {
  let page: Page | null = null;
  try {
    // Electron's CDP may not implement Target.createTarget at all — and may hang rather than
    // reject — so cap the attempt and fall back instead of burning the test's budget.
    page = await Promise.race([
      joplin.browser.contexts()[0].newPage(),
      new Promise<Page>((_, reject) =>
        setTimeout(() => reject(new Error('newPage() did not resolve within 20s')), 20_000)
      ),
    ]);
    const run = async (file: string): Promise<ProbeResult> => {
      await page!.goto(`file://${file}`);
      return (await page!.evaluate(PROBE_SCRIPT)) as ProbeResult;
    };
    const noBridge = await run(files.noBridge);
    const withBridge = await run(files.withBridge);
    return { noBridge, withBridge };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[issue #3] newPage() unavailable in this Electron, falling back to an iframe:', (error as Error).message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Variant B2: the same page inside a same-origin about:blank iframe of the live viewer document,
 * with the assets injected as text (an about:blank document has no base URL to resolve the
 * exporter's relative asset paths against, and its origin need not be able to fetch file:// URLs).
 * Only the transport of the two asset files differs from the exporter's page; the guard under test
 * sees an identical world — its own global scope, with no `webviewApi` in it.
 */
async function probeViaIframe(
  frame: Frame,
  withBridge: boolean
): Promise<ProbeResult> {
  const js = fs.readFileSync(path.join(E2E_PATHS.PLUGIN_DIST, 'contentScripts', 'viewer.js'), 'utf8');
  const css = fs.readFileSync(path.join(E2E_PATHS.PLUGIN_DIST, 'contentScripts', 'viewer.css'), 'utf8');
  return (await frame.evaluate(
    async ({ jsText, cssText, bridge, body, probe }) => {
      const old = document.getElementById('ridgeline-export-probe');
      if (old && old.parentNode) old.parentNode.removeChild(old);

      const iframe = document.createElement('iframe');
      iframe.id = 'ridgeline-export-probe';
      iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:700px;';
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument as Document;
      const win = iframe.contentWindow as Window & { webviewApi?: unknown; eval: (s: string) => unknown };
      doc.open();
      doc.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${body}</body></html>`);
      doc.close();

      const style = doc.createElement('style');
      style.textContent = cssText;
      doc.head.appendChild(style);
      if (bridge) {
        (win as { webviewApi?: unknown }).webviewApi = {
          postMessage: () => Promise.resolve(null),
        };
      }
      const script = doc.createElement('script');
      script.textContent = jsText;
      doc.head.appendChild(script);

      const result = await (win.eval(probe) as Promise<unknown>);
      iframe.remove();
      return result;
    },
    { jsText: js, cssText: css, bridge: withBridge, body: RENDERED_NOTE_BODY, probe: PROBE_SCRIPT }
  )) as ProbeResult;
}

test.describe('Issue #3 — the strip stays out of exported PDFs, printed notes and exported HTML', () => {
  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    joplin = await launchJoplin();
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Ridgeline Export Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
    await ensureViewerVisible(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  // LAYER (a). Belt-and-braces for any host that keeps a bridge alive in a print window (and for a
  // plain Ctrl+P inside the live viewer): under print media the strip computes to display:none, and
  // it comes straight back when screen media is restored.
  test('CSS layer: print media hides the live viewer strip, and releasing it brings the strip back', async () => {
    const { win } = joplin;
    const strip = win.frameLocator(VIEWER_IFRAME).locator(`#${STRIP_ID}`);
    await expect(strip).toBeVisible({ timeout: 30_000 });

    const displayOfStrip = async (): Promise<string> => {
      const frame = viewerFrameOrNull(win);
      expect(frame, 'the note-viewer frame is attached').not.toBeNull();
      return frame!.evaluate((id) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).display : 'MISSING';
      }, STRIP_ID);
    };

    // Sanity: on screen it is a laid-out flex container, not hidden.
    expect(await displayOfStrip()).toBe('flex');

    await win.emulateMedia({ media: 'print' });
    try {
      await expect
        .poll(displayOfStrip, { timeout: 10_000, message: 'strip is display:none under print media' })
        .toBe('none');
      await expect(strip).toBeHidden();
    } finally {
      await win.emulateMedia({ media: null });
    }

    // Released again: the strip is visible exactly as before, so the print rule costs nothing on
    // screen.
    await expect
      .poll(displayOfStrip, { timeout: 10_000, message: 'strip is visible again on screen media' })
      .toBe('flex');
    await expect(strip).toBeVisible();
  });

  // LAYER (b). The real export shape: a standalone page carrying the same assets and NO host bridge.
  // This is the layer that keeps the strip out of Export → PDF / File → Print / Export → HTML.
  test('JS layer: a standalone exported-note page with no host bridge builds no strip', async () => {
    const files = writeExportFixture();

    let variant = 'newPage (file:// top-level page, assets via <link>/<script src>)';
    let results: { noBridge: ProbeResult; withBridge: ProbeResult } | null = null;
    try {
      results = await probeViaNewPage(joplin, files);
      if (!results) {
        variant = 'iframe (same-origin about:blank in the live viewer, assets injected as text)';
        const frame = viewerFrameOrNull(joplin.win);
        expect(frame, 'the note-viewer frame is attached').not.toBeNull();
        results = {
          noBridge: await probeViaIframe(frame!, false),
          withBridge: await probeViaIframe(frame!, true),
        };
      }
    } finally {
      fs.rmSync(files.dir, { recursive: true, force: true });
    }
    test.info().annotations.push({ type: 'issue-3-variant', description: variant });
    // eslint-disable-next-line no-console
    console.log(`[issue #3] standalone-page variant used: ${variant}`);

    const { noBridge, withBridge } = results!;

    // NEGATIVE CONTROL first: with a bridge in place the very same page DOES build a strip. Without
    // this, "no strip" below could just mean the asset never ran.
    expect(withBridge.headings, 'control page rendered its headings').toBe(4);
    expect(
      withBridge.strips,
      'control: with a host bridge the exported page shape DOES build the strip — so the asset loads and runs here'
    ).toBe(1);

    // THE ASSERTION: no bridge, no strip. This is the exported/printed page.
    expect(noBridge.headings, 'exported page rendered its headings').toBe(4);
    expect(
      noBridge.strips,
      'issue #3: an exported/printed page has no webviewApi bridge, so viewer.js must build NO strip'
    ).toBe(0);
    // And it leaves the document alone: no reserve margin pushed onto the exported body.
    expect(noBridge.bodyMarginLeft, 'exported page body keeps its own left margin').toBe('');
    expect(noBridge.bodyMarginRight, 'exported page body keeps its own right margin').toBe('');
  });
});
