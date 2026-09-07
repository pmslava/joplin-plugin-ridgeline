import { test, expect, Locator, Page, Frame } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance, PLUGIN_ID } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  hoverEditorBars,
  selectNoteByTitle,
  waitForEditorStrip,
  MIXED_HEADINGS,
  EDITOR_STRIP,
  VIEWER_IFRAME,
} from './helpers';

/**
 * OUTLINE TOOLBAR / PIN / WIDTH / MAKE-ROOM (GitHub issue #2).
 *
 * The outline (the expanded TOC panel `.ridgeline-panel` that opens over the compact minimap) gains an
 * optional FIRST ROW of controls — Width, Headings, Pin — behind the new `outlineToolbar` setting (OFF
 * by default). That setting adds ONLY the row: the width percent, the pin and make-room are independent
 * settings that work whether or not the toolbar is shown. Pinning keeps the outline open at the full
 * height of the pane; "make room" (`outlineMakeRoom`, ON by default) pushes the note text aside by the
 * outline's width so the pinned outline never covers a word. `Ctrl+Alt+P` / the Tools → Ridgeline
 * submenu flip `outlinePinned` and nothing else.
 *
 * WIDTH, the part that is easy to get wrong (contract "HOW IT IS APPLIED"):
 *   - BOTH the hover outline and the pinned one are content-fit — `width: max-content`, `min-width:
 *     140px` — and the width percentage is only their CAP (`max-width`). Short headings give a narrow
 *     panel either way; a pinned outline is additionally never narrower than its own toolbar row.
 *   - the room made for a pinned outline follows the MEASURED panel width, not the cap:
 *     `room = panelWidth + edgeGapPx (2) + outlineRoomGapPx (6)`.
 * So the percentage itself is asserted through the container's `data-outline-width` attribute and (where
 * there is a toolbar) the Width button's label; the rendered panel is asserted as "content-fit within
 * the cap" whether hovering or pinned.
 *
 * TWO Joplin launches only (each cold launch is ~75 s):
 *   Launch A — a profile seeded with only `outlineWidthPercent: 20`: the toolbar is OFF, so the outline
 *              must behave exactly as it does today, AND the width percent, the pin (Ctrl+Alt+P) and
 *              make-room must all work with no toolbar to drive them.
 *   Launch B — seeded `{ outlineToolbar: true, side: 'right' }`: the toolbar itself, the width control
 *              (presets + typed value + clamping), the headings control, the pin button, make-room and
 *              the pinned empty-note placeholder.
 *
 * Everything measured in pixels is asserted with a tolerance, never with equality.
 *
 * All selectors, data-testids and attribute values below come from the shared implementation contract
 * (outline toolbar / pin / width / make-room). The numeric constants mirror the contract's tokens rather
 * than importing `src/tokens.ts`, so this spec pins the CONTRACT and fails loudly if the implementation
 * quietly changes a number. (Note the vocabulary split: user-facing wording is "minimap", while the DOM
 * selectors keep their historical `strip` names.)
 */

// ── Selectors (contract) ─────────────────────────────────────────────────────────────────────────
const EDITOR_PANEL = `${EDITOR_STRIP} .ridgeline-panel`;
const EDITOR_ROWS = `${EDITOR_PANEL} .ridgeline-panel-row`;
const VIEWER_STRIP = '#ridgeline-viewer-strip';
const VIEWER_PANEL = `${VIEWER_STRIP} .ridgeline-panel`;
const VIEWER_ROWS = `${VIEWER_PANEL} .ridgeline-panel-row`;
const TOOLBAR = '.ridgeline-toolbar';
const WIDTH_POPOVER = '.ridgeline-tb-popover[data-for="width"]';
const HEADINGS_POPOVER = '.ridgeline-tb-popover[data-for="headings"]';
const WIDTH_INPUT = '.ridgeline-tb-width-input';

/** `data-testid` of a toolbar button on a given surface, e.g. tb('editor', 'pin'). */
function tb(surface: 'editor' | 'viewer', name: 'width' | 'headings' | 'pin'): string {
  return `[data-testid="ridgeline-${surface}-tb-${name}"]`;
}

// ── Contract constants ───────────────────────────────────────────────────────────────────────────
const OUTLINE_WIDTH_DEFAULT = 33;
/** Launch A seeds a non-default percent, to prove the width applies with the toolbar off. */
const LAUNCH_A_WIDTH_PERCENT = 30;
const OUTLINE_MIN_WIDTH_PX = 140; // tokens.outlineMinWidthPx
const OUTLINE_MAX_WIDTH_FRACTION = 0.9; // tokens.outlineMaxWidthFraction
const OUTLINE_MIN_TEXT_PX = 200; // tokens.outlineMinTextPx
// The heading-range labels are numbers only, joined by an EN DASH (U+2013), not a hyphen: `1–6`, `1–2`.
const EN_DASH = '–';
/** The published width is a rounded percentage of a pane whose px width depends on the layout. */
const WIDTH_TOL_PX = 10;
/** Content-fit bounds (cap, 140px floor, toolbar row) hold to within rounding and the 1px border. */
const PINNED_WIDTH_TOL_PX = 2;
/** The pinned panel spans the pane exactly; allow a few px for rounding/scrollbars. */
const HEIGHT_TOL_PX = 4;
/** The thin minimap margin is 46px with the shipped tokens (bar area 20 + 2×12 air + 2 edge gap); "no room
 * reserved" is anything well below that — Launch B runs in overlay mode, so the post-unpin padding is 0. */
const NO_ROOM_PX = 14;
/** A toolbar popover can be destroyed by a re-render racing the click that opened it — retry the click. */
const POPOVER_OPEN_ATTEMPTS = 3;
const POPOVER_OPEN_TIMEOUT_MS = 2000;
/** Room = the MEASURED panel width + edgeGapPx (2) + outlineRoomGapPx (6). */
const ROOM_GAP_PX = 8;
const ROOM_TOL_PX = 4;

/** The outline width (px) the contract's resolver must produce for a pane of `paneW` px at `pct` %. */
function expectedOutlineWidthPx(paneW: number, pct: number): number {
  if (paneW < OUTLINE_MIN_WIDTH_PX) return paneW;
  const raw = Math.round((paneW * pct) / 100);
  // Same order as src/tokens.ts outlineWidthPx: the 140px floor wins over the 90% ceiling on a pane of
  // 140–155px, where floor(pane × 0.9) < 140 — the contract's clamp(v, lo, hi), floor applied last.
  return Math.max(OUTLINE_MIN_WIDTH_PX, Math.min(raw, Math.floor(paneW * OUTLINE_MAX_WIDTH_FRACTION)));
}

// ── Measurement helpers ──────────────────────────────────────────────────────────────────────────

/** The editor pane width the resolver uses: CodeMirror's scroller clientWidth (no scrollbar). */
async function editorPaneWidth(win: Page): Promise<number> {
  return win.evaluate(() => {
    const el = document.querySelector('.cm-scroller') as HTMLElement | null;
    return el ? el.clientWidth : -1;
  });
}

/** The editor pane height the pinned outline must span (the scroller's rendered height). */
async function editorPaneHeight(win: Page): Promise<number> {
  const box = await win.locator('.cm-scroller').first().boundingBox();
  return box ? box.height : -1;
}

async function editorPanelWidth(win: Page): Promise<number> {
  const box = await win.locator(EDITOR_PANEL).boundingBox();
  return box ? box.width : -1;
}

async function editorPanelHeight(win: Page): Promise<number> {
  const box = await win.locator(EDITOR_PANEL).boundingBox();
  return box ? box.height : -1;
}

/** The viewer pane width the resolver uses: `document.scrollingElement.clientWidth`. */
async function viewerPaneWidth(frame: Frame): Promise<number> {
  return frame.evaluate(
    () => (document.scrollingElement || document.documentElement).clientWidth
  ) as Promise<number>;
}

async function viewerPanelWidth(frame: Frame): Promise<number> {
  const box = await frame.locator(VIEWER_PANEL).boundingBox();
  return box ? box.width : -1;
}

/** `data-outline-width` (px) as published by a minimap container; NaN when absent. */
async function outlineWidthAttr(strip: Locator): Promise<number> {
  const raw = await strip.getAttribute('data-outline-width').catch(() => null);
  return raw === null ? NaN : Number(raw);
}

/** The room (or thin minimap margin) the editor reserves on the minimap's side (left in A, right in B). */
async function editorContentPadding(win: Page, side: 'left' | 'right'): Promise<number> {
  return win.evaluate((which) => {
    const el = document.querySelector('.cm-content') as HTMLElement | null;
    if (!el) return -1;
    const cs = getComputedStyle(el);
    return parseFloat(which === 'right' ? cs.paddingRight : cs.paddingLeft) || 0;
  }, side);
}

/** The room (or thin minimap margin) the rendered viewer reserves on the minimap's side. */
async function viewerBodyMargin(frame: Frame, side: 'left' | 'right'): Promise<number> {
  return frame.evaluate((which) => {
    const cs = getComputedStyle(document.body);
    return parseFloat(which === 'right' ? cs.marginRight : cs.marginLeft) || 0;
  }, side) as Promise<number>;
}

/** The intrinsic width of a surface's toolbar row, or 0 when that surface has no toolbar. */
async function toolbarRowWidth(toolbar: Locator): Promise<number> {
  if ((await toolbar.count()) === 0) return 0;
  return toolbar.first().evaluate((el) => (el as HTMLElement).scrollWidth);
}

// ── Pointer helpers ──────────────────────────────────────────────────────────────────────────────

/**
 * Move the pointer FAR from either minimap — over the note list, on the opposite side of the window from
 * a right-hand outline and still clear of a left-hand one. Used both to collapse a hover outline and to
 * prove a PINNED one does not collapse.
 */
async function movePointerToNoteList(win: Page): Promise<void> {
  const box = await win.locator('.note-list-item').first().boundingBox().catch(() => null);
  if (box) await win.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  else await win.mouse.move(200, 500);
  await win.waitForTimeout(100);
}

/**
 * Close the viewer's hover outline the only way the viewer can actually observe.
 *
 * HARNESS LIMIT (measured on the real app with an instrumented probe): when the pointer moves from
 * inside the note iframe straight out to the main window, the viewer document receives NO departure
 * event at all — mouseout with a null relatedTarget: 0, mouseleave: 0, blur: 0. It happens for the
 * plain hover outline too (the listener set is unchanged from main), and z3-iframe-transit only ever
 * exercised departure INTO a nested iframe, so nothing caught it before. A `movePointerToNoteList`
 * therefore leaves the viewer outline open forever — and an open panel covers the bars, so the NEXT
 * viewer hover in the file blocks on actionability until it times out.
 *
 * Departing WITHIN the iframe — a mousemove over the rendered note, well clear of the bars and panel —
 * is the observable path and runs exactly the same depart/collapse rule. 30% across / 60% down of the
 * iframe is inside the note body and clear of the outline on either side (it hugs one edge, and the
 * hover outline is content-fit narrow for these short headings). The pointer is then parked over the
 * note list as usual, so the editor surface sees a departure too.
 */
async function leaveViewerOutline(win: Page, frame: Frame): Promise<void> {
  const box = await win.locator(VIEWER_IFRAME).boundingBox().catch(() => null);
  if (box && (await frame.locator(VIEWER_STRIP).count()) > 0) {
    await win.mouse.move(Math.round(box.x + box.width * 0.3), Math.round(box.y + box.height * 0.6));
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-expanded', 'false', {
      timeout: 5_000,
    });
  }
  await movePointerToNoteList(win);
}

/**
 * Park the pointer INSIDE the open editor panel (near its top, so a panel that gets shorter or narrower
 * does not leave the pointer outside). The hover hit-test treats the open panel as part of the hover
 * zone, so this holds the outline open while its toolbar is driven.
 */
async function parkPointerInEditorPanel(win: Page): Promise<void> {
  const box = await win.locator(EDITOR_PANEL).boundingBox().catch(() => null);
  if (!box || box.width <= 0) return;
  await win.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + Math.min(12, box.height / 2)));
}

/** Open the editor's hover outline (dwell on the bars) and leave the pointer inside the panel. */
async function openEditorOutline(win: Page): Promise<void> {
  const strip = win.locator(EDITOR_STRIP);
  if ((await strip.getAttribute('data-expanded')) !== 'true') {
    await hoverEditorBars(win);
    await expect(strip).toHaveAttribute('data-expanded', 'true', { timeout: 10_000 });
  }
  await expect(win.locator(EDITOR_PANEL)).toBeVisible({ timeout: 10_000 });
  await parkPointerInEditorPanel(win);
}

/**
 * Focus the Markdown editor so a menu accelerator lands, clicking a point in the editor pane that is
 * guaranteed NOT to be under an open (possibly pinned) outline panel — a plain `.cm-content` click at
 * its centre or top-left would be intercepted by the panel and fail actionability.
 */
async function focusEditor(win: Page): Promise<void> {
  const scroller = await win.locator('.cm-scroller').first().boundingBox();
  if (!scroller) {
    await win.locator('.cm-content').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await win.waitForTimeout(200);
    return;
  }
  const panel = await win.locator(EDITOR_PANEL).boundingBox().catch(() => null);
  const inset = Math.min(40, Math.max(8, scroller.width / 5));
  let x = scroller.x + scroller.width / 2;
  if (panel && panel.width > 0) {
    const panelOnRight = panel.x + panel.width / 2 > scroller.x + scroller.width / 2;
    x = panelOnRight ? scroller.x + inset : scroller.x + scroller.width - inset;
  }
  const y = scroller.y + Math.min(60, scroller.height / 2);
  await win.mouse.click(Math.round(x), Math.round(y));
  await win.waitForTimeout(200);
}

/** Fire the `Ridgeline: Toggle outline pin` command via its accelerator. */
async function firePinToggle(win: Page): Promise<void> {
  await focusEditor(win);
  await win.keyboard.press('Control+Alt+p');
}

/** `data-pinned` on the editor minimap, or null when the minimap is not mounted at all. */
async function editorPinnedAttr(win: Page): Promise<string | null> {
  const strip = win.locator(EDITOR_STRIP);
  if ((await strip.count()) === 0) return null;
  return strip.getAttribute('data-pinned').catch(() => null);
}

/**
 * Establish the pin PRECONDITION explicitly, on both surfaces, before a test flips it.
 *
 * Playwright retries re-run a single test from the PREVIOUS attempt's mutated state, so a test that
 * merely fires the toggle and then waits for the state it expects can invert itself on the retry (the
 * first run of this spec did exactly that: A3's retry re-PINNED and then waited forever for a collapse).
 * Reading the current value and only toggling when it is wrong makes each flip test idempotent.
 *
 * Requires a note WITH headings to be open when `wanted` is false — a heading-less, unpinned note has
 * no minimap to carry the attribute (hideWhenEmpty).
 */
async function ensurePinned(win: Page, frame: Frame, wanted: boolean): Promise<void> {
  const want = wanted ? 'true' : 'false';
  if ((await editorPinnedAttr(win)) !== want) await firePinToggle(win);
  // Wait for the EXACT expected value on both surfaces: `not.toBe('true')` would be satisfied
  // instantly by a stale pre-push value and let the test run against the wrong state.
  await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-pinned', want, { timeout: 15_000 });
  await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-pinned', want, { timeout: 20_000 });
}

// ── Toolbar helpers ──────────────────────────────────────────────────────────────────────────────

/**
 * Open (or reuse) one of the toolbar's popovers inside the editor's outline, keeping the outline open.
 *
 * RETRIED, because a click can race a re-render: the panel is rebuilt whenever settings arrive (the
 * local apply, the settings push that follows it, the other surface's ~700ms poll) or the document
 * changes, and a rebuild landing a few ms after the click throws the just-opened popover away. Each
 * attempt re-parks the pointer inside the panel first — a rebuild can also resize the panel out from
 * under the pointer, and losing the hover would close the whole outline — then clicks and waits a short
 * while for the popover. Only after POPOVER_OPEN_ATTEMPTS tries does it fall through to the ordinary
 * assertion, so a genuine failure still reports as "popover never became visible".
 */
async function openToolbarPopover(win: Page, which: 'width' | 'headings'): Promise<Locator> {
  const popover = win.locator(
    `${EDITOR_PANEL} ${which === 'width' ? WIDTH_POPOVER : HEADINGS_POPOVER}`
  );
  const button = win.locator(`${EDITOR_PANEL} ${tb('editor', which)}`);
  for (let attempt = 1; attempt <= POPOVER_OPEN_ATTEMPTS; attempt++) {
    // Already open (or reopened by a rebuild): clicking again would TOGGLE it shut.
    if (await popover.first().isVisible().catch(() => false)) break;
    try {
      await parkPointerInEditorPanel(win);
      await button.click({ timeout: POPOVER_OPEN_TIMEOUT_MS });
      await expect(popover).toBeVisible({ timeout: POPOVER_OPEN_TIMEOUT_MS });
      break;
    } catch {
      // Swallowed: the click found a detached button, or the popover was re-rendered away. Try again;
      // the assertion below reports the failure if every attempt loses the race.
    }
  }
  await expect(popover).toBeVisible({ timeout: 10_000 });
  return popover;
}

/** Open (or reuse) the Width popover inside the editor's outline, keeping the outline open. */
async function openWidthPopover(win: Page): Promise<Locator> {
  return openToolbarPopover(win, 'width');
}

/** Open (or reuse) the Headings popover inside the editor's outline, keeping the outline open. */
async function openHeadingsPopover(win: Page): Promise<Locator> {
  return openToolbarPopover(win, 'headings');
}

/**
 * The width SETTING as the editor surface publishes it: the Width button's label and the container's
 * `data-outline-width`, which must equal the contract's clamp of `pct` % of the editor pane. Polled,
 * because the change round-trips through the coordinator (`setSettings` → fresh `SettingsResponse`).
 */
async function expectEditorOutlineWidth(win: Page, pct: number): Promise<void> {
  const paneW = await editorPaneWidth(win);
  expect(paneW, 'editor pane width measured').toBeGreaterThan(0);
  const expected = expectedOutlineWidthPx(paneW, pct);
  await expect
    .poll(async () => Math.abs((await outlineWidthAttr(win.locator(EDITOR_STRIP))) - expected), {
      timeout: 10_000,
      message: `editor data-outline-width ≈ ${expected}px (${pct}% of a ${paneW}px pane)`,
    })
    .toBeLessThanOrEqual(WIDTH_TOL_PX);
  // Never below the token floor, whatever the percentage asks for.
  expect(
    await outlineWidthAttr(win.locator(EDITOR_STRIP)),
    'published outline width respects the 140px floor'
  ).toBeGreaterThanOrEqual(Math.min(OUTLINE_MIN_WIDTH_PX, paneW));
}

/** The same, plus the toolbar's Width button label — for surfaces that HAVE a toolbar. */
async function expectEditorWidthSetting(win: Page, pct: number): Promise<void> {
  await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'width')}`)).toContainText(`${pct}%`, {
    timeout: 10_000,
  });
  await expectEditorOutlineWidth(win, pct);
}

/** The same width setting as the VIEWER publishes it, against the viewer's own pane. */
async function expectViewerWidthSetting(frame: Frame, pct: number): Promise<void> {
  const paneW = await viewerPaneWidth(frame);
  expect(paneW, 'viewer pane width measured').toBeGreaterThan(0);
  const expected = expectedOutlineWidthPx(paneW, pct);
  await expect
    .poll(async () => Math.abs((await outlineWidthAttr(frame.locator(VIEWER_STRIP))) - expected), {
      // The viewer picks settings up on its ~700ms poll; be generous on a busy machine.
      timeout: 20_000,
      message: `viewer data-outline-width ≈ ${expected}px (${pct}% of a ${paneW}px pane)`,
    })
    .toBeLessThanOrEqual(WIDTH_TOL_PX);
}

/**
 * The content-fit rule, identical for the hover outline and the pinned one: never wider than the width
 * percentage (its `max-width` cap, published as `data-outline-width`) unless its own toolbar row is
 * wider, never narrower than the 140px floor, and never narrower than that toolbar row (when the
 * surface has one — the row must not wrap or be clipped). It may legitimately be much narrower than
 * the cap: these headings are short.
 */
function expectContentFit(
  width: number,
  cap: number,
  paneW: number,
  toolbarW: number,
  where: string
): void {
  expect(width, `${where}: rendered`).toBeGreaterThan(0);
  expect(Number.isFinite(cap), `${where}: the minimap publishes data-outline-width`).toBe(true);
  // The toolbar row is a FLOOR that wins over the cap: at a small percentage on a narrow pane (10% of a
  // ~700px pane is the 140px floor) the three buttons still get their one row (~150px), so the outline
  // may exceed the cap by exactly that much and no more.
  expect(width, `${where}: content-fit, capped at ${cap}px (or its ${toolbarW}px toolbar row)`).toBeLessThanOrEqual(
    Math.max(cap, toolbarW) + PINNED_WIDTH_TOL_PX
  );
  expect(width, `${where}: never narrower than the ${OUTLINE_MIN_WIDTH_PX}px floor`).toBeGreaterThanOrEqual(
    Math.min(OUTLINE_MIN_WIDTH_PX, paneW) - PINNED_WIDTH_TOL_PX
  );
  if (toolbarW > 0) {
    expect(width, `${where}: never narrower than its toolbar row (${toolbarW}px)`).toBeGreaterThanOrEqual(
      toolbarW - PINNED_WIDTH_TOL_PX
    );
  }
}

/** The content-fit rule applied to the editor's outline, hovered or pinned. */
async function expectEditorPanelContentFit(win: Page, where: string): Promise<void> {
  await expect(win.locator(EDITOR_PANEL)).toBeVisible();
  expectContentFit(
    await editorPanelWidth(win),
    await outlineWidthAttr(win.locator(EDITOR_STRIP)),
    await editorPaneWidth(win),
    await toolbarRowWidth(win.locator(`${EDITOR_PANEL} ${TOOLBAR}`)),
    where
  );
}

/** Kept under its old name: every call site asserts exactly this rule on the open hover outline. */
async function expectHoverPanelWithinCap(win: Page): Promise<void> {
  await expectEditorPanelContentFit(win, 'hover outline');
}

async function expectPinnedPanelContentFit(win: Page): Promise<void> {
  await expectEditorPanelContentFit(win, 'pinned editor outline');
}

/** The same rule in the viewer, whose panel is rebuilt when the pin arrives on its settings poll. */
async function expectPinnedViewerPanelContentFit(frame: Frame): Promise<void> {
  await expect(frame.locator(VIEWER_PANEL)).toBeVisible({ timeout: 20_000 });
  expectContentFit(
    await viewerPanelWidth(frame),
    await outlineWidthAttr(frame.locator(VIEWER_STRIP)),
    await viewerPaneWidth(frame),
    await toolbarRowWidth(frame.locator(`${VIEWER_PANEL} ${TOOLBAR}`)),
    'pinned viewer outline'
  );
}

/**
 * Make-room follows the MEASURED panel width, not the cap: the note text is pushed aside by exactly
 * `panelWidth + edgeGapPx + outlineRoomGapPx` on the minimap's side.
 */
async function expectEditorRoom(win: Page, side: 'left' | 'right'): Promise<void> {
  const panelW = await editorPanelWidth(win);
  expect(panelW, 'pinned editor outline width').toBeGreaterThan(0);
  const expected = panelW + ROOM_GAP_PX;
  await expect
    .poll(async () => Math.abs((await editorContentPadding(win, side)) - expected), {
      timeout: 15_000,
      message: `.cm-content padding-${side} = outline width + ${ROOM_GAP_PX}px (${expected}px)`,
    })
    .toBeLessThanOrEqual(ROOM_TOL_PX);
}

async function expectViewerRoom(frame: Frame, side: 'left' | 'right'): Promise<void> {
  const panelW = await viewerPanelWidth(frame);
  expect(panelW, 'pinned viewer outline width').toBeGreaterThan(0);
  const expected = panelW + ROOM_GAP_PX;
  await expect
    .poll(async () => Math.abs((await viewerBodyMargin(frame, side)) - expected), {
      timeout: 20_000,
      message: `viewer body margin-${side} = outline width + ${ROOM_GAP_PX}px (${expected}px)`,
    })
    .toBeLessThanOrEqual(ROOM_TOL_PX);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// LAUNCH A — default profile: the toolbar is OFF, and Ctrl+Alt+P switches the feature on.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Outline toolbar OFF: width, pin and make-room still work', () => {
  let joplin: JoplinInstance;
  let frame: Frame;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // Everything but the toolbar is left at its default; `outlineWidthPercent` is seeded to a
    // non-default 20 so A1 can prove the width percent applies with the toolbar OFF. Patched into
    // settings.json directly (the z1-zoom-phase pattern), like Launch B seeds the toolbar itself.
    const profileDir = createProfile(true, {});
    const settingsFile = path.join(profileDir, 'settings.json');
    const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    seeded[`plugin-${PLUGIN_ID}.outlineWidthPercent`] = LAUNCH_A_WIDTH_PERCENT;
    fs.writeFileSync(settingsFile, JSON.stringify(seeded, null, 2), 'utf8');

    joplin = await launchJoplin({ profileDir });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Outline Default Note', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
    // Split view, so the editor and the rendered viewer are both live for every check below.
    frame = await ensureViewerVisible(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  // Contract A(1) — with `outlineToolbar` off the outline is exactly what it is today: hover opens it,
  // it lists every heading, and it carries NO toolbar row on either surface. The width percent is a
  // separate setting, so the seeded 30% must shape this toolbar-less outline all the same.
  test('A1: with the setting off, the hover outline has no toolbar but honours the width (editor and viewer)', async () => {
    const { win } = joplin;

    await openEditorOutline(win);
    await expect(win.locator(EDITOR_ROWS)).toHaveCount(MIXED_HEADINGS.length);
    await expect(win.locator(`${EDITOR_PANEL} ${TOOLBAR}`)).toHaveCount(0);
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'pin')}`)).toHaveCount(0);
    // Nothing claims to be pinned either.
    expect(await win.locator(EDITOR_STRIP).getAttribute('data-pinned')).not.toBe('true');

    // The seeded 30% is published (and floored at 140px) and caps this toolbar-less hover outline.
    await expectEditorOutlineWidth(win, LAUNCH_A_WIDTH_PERCENT);
    await expectHoverPanelWithinCap(win);

    // The viewer's outline: same story inside the note iframe.
    await movePointerToNoteList(win);
    const viewerBars = frame.locator(`${VIEWER_STRIP} .ridgeline-bars`);
    await expect(viewerBars).toBeVisible({ timeout: 20_000 });
    await viewerBars.hover();
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-expanded', 'true', {
      timeout: 10_000,
    });
    await expect(frame.locator(`${VIEWER_PANEL} ${TOOLBAR}`)).toHaveCount(0);
    // Close it from INSIDE the iframe (see leaveViewerOutline) so no test leaves the viewer outline open.
    await leaveViewerOutline(win, frame);
  });

  // Contract A(2) — the pin is independent of the toolbar: Ctrl+Alt+P pins on a profile with no toolbar
  // and adds no toolbar. The pinned outline spans the pane, does not close when the pointer walks away,
  // and make-room (default ON) pushes the note text aside on the minimap's side — here the LEFT, since
  // Launch A runs at the default `side: left`.
  test('A2: Ctrl+Alt+P pins and makes room with no toolbar, in both surfaces', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);

    // Precondition, stated rather than assumed: NOT pinned (a retry starts from the previous attempt's
    // state, where the toggle below would unpin instead of pin).
    await ensurePinned(win, frame, false);

    await firePinToggle(win);

    // The editor is pushed the new settings immediately (no poll). The pin adds NO toolbar row.
    await expect(strip).toHaveAttribute('data-pinned', 'true', { timeout: 15_000 });
    await expect(strip).toHaveAttribute('data-expanded', 'true', { timeout: 15_000 });
    await expect(win.locator(EDITOR_PANEL)).toBeVisible({ timeout: 15_000 });
    await expect(win.locator(`${EDITOR_PANEL} ${TOOLBAR}`)).toHaveCount(0);

    // Walk the pointer far away and wait out any hover grace: a pinned outline stays open.
    await movePointerToNoteList(win);
    await win.waitForTimeout(2000);
    await expect(win.locator(EDITOR_PANEL)).toBeVisible();
    await expect(strip).toHaveAttribute('data-pinned', 'true');
    await expect(strip).toHaveAttribute('data-expanded', 'true');

    // Pinned = the full height of the pane, and still content-fit within the seeded 30% cap.
    const paneH = await editorPaneHeight(win);
    expect(paneH, 'editor pane height measured').toBeGreaterThan(0);
    await expect
      .poll(async () => Math.abs((await editorPanelHeight(win)) - paneH), {
        timeout: 10_000,
        message: `pinned outline height ≈ editor pane height (${paneH}px)`,
      })
      .toBeLessThanOrEqual(HEIGHT_TOL_PX);
    await expectPinnedPanelContentFit(win);

    // Make-room, with no toolbar anywhere: the note text is pushed aside on the LEFT by the outline's
    // measured width plus the two small gaps.
    await expectEditorRoom(win, 'left');

    // The viewer follows through its ~700ms settings poll — pinned, no toolbar, and its own room.
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-pinned', 'true', {
      timeout: 20_000,
    });
    await expect(frame.locator(VIEWER_PANEL)).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator(`${VIEWER_PANEL} ${TOOLBAR}`)).toHaveCount(0);
    await expectPinnedViewerPanelContentFit(frame);
    await expectViewerRoom(frame, 'left');
  });

  // Contract A(3) — a second Ctrl+Alt+P unpins both surfaces and hands the outline back to hover: with
  // the pointer away it collapses after the grace, and hovering the bars opens it again.
  test('A3: Ctrl+Alt+P again unpins both surfaces and hover behaviour returns', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);

    // Precondition: pinned on BOTH surfaces. Established explicitly so a retry (which starts from this
    // test's own mutated end state) cannot fire the toggle in the wrong direction.
    await ensurePinned(win, frame, true);

    await firePinToggle(win);

    // Poll for the EXACT post-flip value on both surfaces. `not.toBe('true')` would be satisfied by a
    // stale value the moment it is read, before the unpin has reached the surface.
    await expect(strip).toHaveAttribute('data-pinned', 'false', { timeout: 15_000 });
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-pinned', 'false', {
      timeout: 20_000,
    });

    // Pointer away → the outline collapses after the hover grace on both surfaces.
    await movePointerToNoteList(win);
    await expect(strip).toHaveAttribute('data-expanded', 'false', { timeout: 10_000 });
    await expect(win.locator(EDITOR_PANEL)).toBeHidden();
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-expanded', 'false', {
      timeout: 20_000,
    });

    // ...and hover opens it again — still with no toolbar, since the pin command never adds one.
    await openEditorOutline(win);
    await expect(win.locator(`${EDITOR_PANEL} ${TOOLBAR}`)).toHaveCount(0);
    await movePointerToNoteList(win);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// LAUNCH B — seeded `{ outlineToolbar: true, side: 'right' }`: the toolbar itself.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('Outline toolbar ON (seeded), minimap on the right', () => {
  let joplin: JoplinInstance;
  let frame: Frame;
  const MIXED_NOTE = 'Outline Toolbar Note';
  const EMPTY_NOTE = 'Outline Empty Note';
  // A note with no ATX/setext heading anywhere — used for the pinned "No headings" placeholder.
  const EMPTY_BODY = [
    'Plain paragraph text with no headings at all.',
    '',
    'A second paragraph, still heading-less.',
  ].join('\n');

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // `outlineToolbar` is a File-storage plugin setting like the ones SeedSettings already covers; seed
    // it by patching the profile's settings.json directly (the z1-zoom-phase pattern), so this spec does
    // not depend on `SeedSettings` having grown the new key.
    const profileDir = createProfile(true, { side: 'right' });
    const settingsFile = path.join(profileDir, 'settings.json');
    const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    seeded[`plugin-${PLUGIN_ID}.outlineToolbar`] = true;
    fs.writeFileSync(settingsFile, JSON.stringify(seeded, null, 2), 'utf8');

    joplin = await launchJoplin({ profileDir });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, MIXED_NOTE, buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
    frame = await ensureViewerVisible(joplin.win);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  // Contract B(1) — the toolbar is the outline's first row on both surfaces and it reflects the CURRENT
  // settings (33%, H1–H6, unpinned). The hover outline itself stays content-fit, with the percentage as
  // its cap.
  test('B1: the hover outline opens with a Width/Headings/Pin toolbar at the default 33%', async () => {
    const { win } = joplin;
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-side', 'right');

    await openEditorOutline(win);

    // The toolbar is the FIRST child of the panel, with exactly the three contract buttons.
    const toolbar = win.locator(`${EDITOR_PANEL} ${TOOLBAR}`);
    await expect(toolbar).toHaveCount(1);
    await expect(toolbar).toBeVisible();
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'width')}`)).toBeVisible();
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'headings')}`)).toBeVisible();
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'pin')}`)).toBeVisible();
    expect(
      await win.locator(EDITOR_PANEL).evaluate((el) => el.firstElementChild?.className ?? ''),
      "the toolbar is the panel's first child"
    ).toContain('ridgeline-toolbar');

    // Labels/state mirror the settings: 33%, the full 1–6 heading range (numbers only), not pinned.
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'headings')}`)).toContainText(
      `1${EN_DASH}6`
    );
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'pin')}`)).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    // The three buttons sit on ONE row: same top, same height, and the icon-only Pin button is square.
    const widthBox = await win.locator(`${EDITOR_PANEL} ${tb('editor', 'width')}`).boundingBox();
    const headingsBox = await win.locator(`${EDITOR_PANEL} ${tb('editor', 'headings')}`).boundingBox();
    const pinBox = await win.locator(`${EDITOR_PANEL} ${tb('editor', 'pin')}`).boundingBox();
    expect(widthBox && headingsBox && pinBox, 'all three toolbar buttons are laid out').toBeTruthy();
    if (widthBox && headingsBox && pinBox) {
      const tops = [widthBox.y, headingsBox.y, pinBox.y];
      expect(
        Math.max(...tops) - Math.min(...tops),
        'the three toolbar buttons sit on one row'
      ).toBeLessThanOrEqual(1);
      const heights = [widthBox.height, headingsBox.height, pinBox.height];
      expect(
        Math.max(...heights) - Math.min(...heights),
        'the three toolbar buttons are the same height'
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(pinBox.width - pinBox.height),
        'the icon-only Pin button is square'
      ).toBeLessThanOrEqual(1);
    }

    // 33% is published on the container (and shown on the button); the hover panel is content-fit
    // within that cap and never below the 140px floor.
    await expectEditorWidthSetting(win, OUTLINE_WIDTH_DEFAULT);
    await expectHoverPanelWithinCap(win);
    // The heading rows survive alongside the toolbar.
    await expect(win.locator(EDITOR_ROWS)).toHaveCount(MIXED_HEADINGS.length);

    // The viewer's outline carries the same toolbar and the same published width.
    await movePointerToNoteList(win);
    const viewerBars = frame.locator(`${VIEWER_STRIP} .ridgeline-bars`);
    await expect(viewerBars).toBeVisible({ timeout: 20_000 });
    await viewerBars.hover();
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-expanded', 'true', {
      timeout: 10_000,
    });
    await expect(frame.locator(`${VIEWER_PANEL} ${TOOLBAR}`)).toHaveCount(1);
    await expect(frame.locator(`${VIEWER_PANEL} ${tb('viewer', 'width')}`)).toContainText('33%');
    await expect(frame.locator(`${VIEWER_PANEL} ${tb('viewer', 'headings')}`)).toContainText(
      `1${EN_DASH}6`
    );
    await expect(frame.locator(`${VIEWER_PANEL} ${tb('viewer', 'pin')}`)).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expectViewerWidthSetting(frame, OUTLINE_WIDTH_DEFAULT);
    await leaveViewerOutline(win, frame);
  });

  // Contract B(2) — the Width control: the three presets, a typed value, and the 10–90 clamp. Each change
  // is written through the coordinator's `setSettings` allowlist, so the OTHER surface must follow too.
  // While hovering, only the published width and the button label carry the percentage; the panel itself
  // is asserted as "within the cap".
  test('B2: the Width control applies presets, a typed value, and clamps to 10–90', async () => {
    const { win } = joplin;
    await openEditorOutline(win);

    // Preset 50% — both surfaces publish it.
    let popover = await openWidthPopover(win);
    await popover.locator('button.ridgeline-tb-preset[data-preset="50"]').click();
    await parkPointerInEditorPanel(win);
    await expectEditorWidthSetting(win, 50);
    await expectHoverPanelWithinCap(win);
    await expectViewerWidthSetting(frame, 50);

    // A typed value: 70 + Enter.
    popover = await openWidthPopover(win);
    await popover.locator(WIDTH_INPUT).fill('70');
    await popover.locator(WIDTH_INPUT).press('Enter');
    await parkPointerInEditorPanel(win);
    await expectEditorWidthSetting(win, 70);
    await expectHoverPanelWithinCap(win);

    // Out of range HIGH: 200 clamps to the 90 maximum.
    popover = await openWidthPopover(win);
    await popover.locator(WIDTH_INPUT).fill('200');
    await popover.locator(WIDTH_INPUT).press('Enter');
    await parkPointerInEditorPanel(win);
    await expectEditorWidthSetting(win, 90);
    await expectHoverPanelWithinCap(win);

    // Out of range LOW: 3 clamps to the 10 minimum (and the published px still respects the 140px floor,
    // which expectedOutlineWidthPx applies).
    popover = await openWidthPopover(win);
    await popover.locator(WIDTH_INPUT).fill('3');
    await popover.locator(WIDTH_INPUT).press('Enter');
    await parkPointerInEditorPanel(win);
    await expectEditorWidthSetting(win, 10);
    await expectHoverPanelWithinCap(win);
    await expectViewerWidthSetting(frame, 10);

    // Back to the 33% preset, so the pin/make-room tests below measure a realistic outline.
    popover = await openWidthPopover(win);
    await popover.locator('button.ridgeline-tb-preset[data-preset="33"]').click();
    await parkPointerInEditorPanel(win);
    await expectEditorWidthSetting(win, OUTLINE_WIDTH_DEFAULT);
    await expectViewerWidthSetting(frame, OUTLINE_WIDTH_DEFAULT);
    await movePointerToNoteList(win);
  });

  // Contract B(3) — the Headings control writes `maxDepth`, which filters BOTH outlines (and the button
  // label follows the setting).
  test('B3: the Headings control filters the outline to H1–H2 and back to H1–H6', async () => {
    const { win } = joplin;
    await openEditorOutline(win);

    let popover = await openHeadingsPopover(win);
    await popover.locator('button.ridgeline-tb-depth[data-depth="2"]').click();
    await parkPointerInEditorPanel(win);

    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'headings')}`)).toContainText(
      `1${EN_DASH}2`,
      { timeout: 10_000 }
    );
    await expect(win.locator(EDITOR_ROWS)).toHaveCount(2, { timeout: 10_000 });
    // The viewer re-renders its own outline on the settings poll.
    await expect(frame.locator(VIEWER_ROWS)).toHaveCount(2, { timeout: 20_000 });
    await expect(frame.locator(`${VIEWER_PANEL} ${tb('viewer', 'headings')}`)).toContainText(
      `1${EN_DASH}2`,
      { timeout: 20_000 }
    );

    // Back to the full range.
    popover = await openHeadingsPopover(win);
    await popover.locator('button.ridgeline-tb-depth[data-depth="6"]').click();
    await parkPointerInEditorPanel(win);
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'headings')}`)).toContainText(
      `1${EN_DASH}6`,
      { timeout: 10_000 }
    );
    await expect(win.locator(EDITOR_ROWS)).toHaveCount(MIXED_HEADINGS.length, { timeout: 10_000 });
    await expect(frame.locator(VIEWER_ROWS)).toHaveCount(MIXED_HEADINGS.length, { timeout: 20_000 });
    await movePointerToNoteList(win);
  });

  // Contract (review fix 15c498c) — an open popover must NOT strand the hover outline. A merely-open
  // popover holds nothing: when the pointer leaves the bars/panel the popover closes and the ordinary
  // collapse grace runs. Only a FOCUSED width field holds the outline (B7b). Pinned is exempt, so both
  // of these run with the outline explicitly UNPINNED.
  test('B7a: an open popover does not hold the hover outline once the pointer leaves', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);
    await ensurePinned(win, frame, false);

    await openEditorOutline(win);
    // Open the Width popover and go no further — the input is deliberately NOT focused (clicking the
    // toolbar button focuses the BUTTON, which must not hold the outline either).
    const popover = await openWidthPopover(win);
    await expect(popover).toBeVisible();

    // The pointer leaves for the note list. No click, so nothing but the departure itself closes this.
    await movePointerToNoteList(win);
    await expect(strip).toHaveAttribute('data-expanded', 'false', { timeout: 5_000 });
    await expect(popover).toBeHidden();
    await expect(win.locator(EDITOR_PANEL)).toBeHidden();

    // The same rule in the viewer. helpers.ts has no viewer-hover helper (only hoverEditorBars), so the
    // viewer bars are hovered through the frame locator, as A1/B1 already do in this file.
    //
    // The DEPARTURE here is made INSIDE the iframe rather than by walking out to the note list: the
    // viewer document never receives a departure event when the pointer leaves the iframe for the main
    // window (harness limit — see leaveViewerOutline), so the in-document move is the only way to
    // trigger it. It is the same departHold rule and the same code path; only the event differs.
    if ((await frame.locator(VIEWER_STRIP).getAttribute('data-expanded')) === 'true') {
      // Something upstream left the viewer outline open, and an open panel covers the bars to hover.
      await leaveViewerOutline(win, frame);
    }
    const viewerBars = frame.locator(`${VIEWER_STRIP} .ridgeline-bars`);
    await expect(viewerBars).toBeVisible({ timeout: 20_000 });
    await viewerBars.hover();
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-expanded', 'true', {
      timeout: 10_000,
    });
    await frame.locator(`${VIEWER_PANEL} ${tb('viewer', 'width')}`).click();
    const viewerPopover = frame.locator(`${VIEWER_PANEL} ${WIDTH_POPOVER}`);
    await expect(viewerPopover).toBeVisible({ timeout: 10_000 });

    // Depart over the note body: the open popover must close WITH the outline, not hold it open.
    // (leaveViewerOutline already waits for data-expanded='false'; assert it here for the record.)
    await leaveViewerOutline(win, frame);
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-expanded', 'false');
    await expect(viewerPopover).toBeHidden();
  });

  // Contract (review fix 15c498c) — the ONE thing that does hold the hover outline open is a focused
  // width field (typing a value must not be interrupted by the pointer wandering off). Finishing the
  // field — here with Enter — closes the popover and releases the hold, so the ordinary grace collapse
  // runs because the pointer is no longer over the bars/panel.
  test('B7b: a focused width field holds the outline; finishing it releases', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);
    await ensurePinned(win, frame, false);

    await openEditorOutline(win);
    const popover = await openWidthPopover(win);
    const input = popover.locator(WIDTH_INPUT);
    // Focus the field WITHOUT typing: the value must stay at its current 33 throughout.
    await input.click();
    await expect(input).toBeFocused();

    // Pointer away (a move, never a click, so focus stays in the field). Well past the ~200ms grace the
    // outline must still be open — held by the focused input alone.
    await movePointerToNoteList(win);
    await win.waitForTimeout(1500);
    expect(
      await strip.getAttribute('data-expanded'),
      'a focused width field holds the hover outline open'
    ).toBe('true');
    await expect(win.locator(EDITOR_PANEL)).toBeVisible();
    await expect(popover).toBeVisible();

    // Finish the field. The value is unchanged, so the width stays where it was; the popover closes and
    // the hold is released, so the outline collapses on the grace.
    await win.keyboard.press('Enter');
    await expect(strip).toHaveAttribute('data-expanded', 'false', { timeout: 5_000 });
    await expect(popover).toBeHidden();
    await expect(win.locator(EDITOR_PANEL)).toBeHidden();

    // Left exactly as found: still the default 33%.
    await expectEditorWidthSetting(win, OUTLINE_WIDTH_DEFAULT);
  });

  // Contract B(4a) — the Pin button: the outline takes the full height of the pane, stays content-fit
  // within its width cap, never closes, keeps its rounded border (so the seam between note and outline
  // stays visible), and the viewer pins too.
  test('B4: the Pin button holds the outline open at the full pane height on both surfaces', async () => {
    const { win } = joplin;
    const strip = win.locator(EDITOR_STRIP);

    // Precondition: NOT pinned — otherwise a retry would click the pin button to UNpin.
    await ensurePinned(win, frame, false);

    await openEditorOutline(win);
    await win.locator(`${EDITOR_PANEL} ${tb('editor', 'pin')}`).click();

    await expect(strip).toHaveAttribute('data-pinned', 'true', { timeout: 15_000 });
    await expect(strip).toHaveAttribute('data-expanded', 'true', { timeout: 15_000 });
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'pin')}`)).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 15_000 }
    );

    // Pointer far away, well past the hover grace: it stays open.
    await movePointerToNoteList(win);
    await win.waitForTimeout(2000);
    await expect(win.locator(EDITOR_PANEL)).toBeVisible();
    await expect(strip).toHaveAttribute('data-pinned', 'true');

    // Pinned is content-fit exactly like the hover outline: within the published cap, above the 140px
    // floor, and never narrower than the toolbar row it must show.
    await expectPinnedPanelContentFit(win);

    // Full pane height (the minimap container spans the pane; the pinned panel spans the container).
    const paneH = await editorPaneHeight(win);
    expect(paneH, 'editor pane height measured').toBeGreaterThan(0);
    await expect
      .poll(async () => Math.abs((await editorPanelHeight(win)) - paneH), {
        timeout: 10_000,
        message: `pinned outline height ≈ editor pane height (${paneH}px)`,
      })
      .toBeLessThanOrEqual(HEIGHT_TOL_PX);

    // The border is kept, so it is still obvious where the note ends and the outline begins.
    const frameStyle = await win.locator(EDITOR_PANEL).evaluate((el) => {
      const cs = getComputedStyle(el as HTMLElement);
      return {
        border: parseFloat(cs.borderRightWidth) || 0,
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
      };
    });
    expect(frameStyle.border, 'pinned outline keeps its 1px border').toBeGreaterThanOrEqual(0.5);
    expect(frameStyle.border).toBeLessThanOrEqual(2);
    expect(frameStyle.radius, 'pinned outline keeps its 4px radius').toBeGreaterThanOrEqual(3);
    expect(frameStyle.radius).toBeLessThanOrEqual(6);

    // The viewer is pinned too, with its own toolbar, its pin button pressed, and its own exact width.
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-pinned', 'true', {
      timeout: 20_000,
    });
    await expect(frame.locator(VIEWER_PANEL)).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator(`${VIEWER_PANEL} ${tb('viewer', 'pin')}`)).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 20_000 }
    );
    await expectPinnedViewerPanelContentFit(frame);
  });

  // Contract B(4b) — "Make room for the pinned outline" (ON by default): the note text is pushed aside by
  // the outline's width plus the two small gaps, on BOTH surfaces. Side is `right`, so it is the editor's
  // `.cm-content` padding-right and the viewer body's margin-right.
  test('B4: make-room pushes the note text aside by the pinned outline width (both surfaces)', async () => {
    const { win } = joplin;
    await ensurePinned(win, frame, true);

    // The room is the MEASURED panel width + the two gaps — not the width cap, which the content-fit
    // panel may well be narrower than.
    await expectEditorRoom(win, 'right');
    await expectViewerRoom(frame, 'right');

    // Room is made only while there is still a real text column beside the outline (contract:
    // outlineMinTextPx = 200). This pane is wide, so that condition holds here.
    const paneW = await editorPaneWidth(win);
    expect(
      paneW - (await editorContentPadding(win, 'right')),
      'text column left beside the outline'
    ).toBeGreaterThanOrEqual(OUTLINE_MIN_TEXT_PX);
  });

  // Contract B(4c) — the pin is a SETTING, so it survives leaving the note and coming back. This also
  // creates the heading-less note the placeholder test below needs.
  test('B4: the pin survives switching notes', async () => {
    const { win } = joplin;
    await ensurePinned(win, frame, true);

    // Idempotent on a retry: a second run must not create a duplicate note with the same title.
    const alreadyThere = await win
      .locator('.note-list-item .title span', { hasText: EMPTY_NOTE })
      .count();
    if (alreadyThere === 0) await createNoteWithBody(win, EMPTY_NOTE, EMPTY_BODY);
    await selectNoteByTitle(win, MIXED_NOTE);

    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-pinned', 'true', {
      timeout: 20_000,
    });
    await expect(win.locator(EDITOR_PANEL)).toBeVisible({ timeout: 20_000 });
    await expect(win.locator(EDITOR_ROWS)).toHaveCount(MIXED_HEADINGS.length, { timeout: 20_000 });
  });

  // Contract B(6) — a pinned outline on a note with NO headings keeps the toolbar plus a single
  // `No headings` placeholder, so the outline can still be unpinned in place. (Unpinned, `hideWhenEmpty`
  // would unmount the whole minimap — that behaviour is unchanged and covered by w3-hide-when-empty.)
  test('B6: a pinned outline on a heading-less note keeps the toolbar and says "No headings"', async () => {
    const { win } = joplin;
    // Pin while the note WITH headings is still open (a heading-less unpinned note has no minimap to
    // toggle from), then move to the heading-less one.
    await ensurePinned(win, frame, true);
    await selectNoteByTitle(win, EMPTY_NOTE);

    await expect(win.locator(EDITOR_STRIP)).toHaveCount(1, { timeout: 20_000 });
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-pinned', 'true', {
      timeout: 20_000,
    });
    await expect(win.locator(EDITOR_PANEL)).toBeVisible({ timeout: 20_000 });
    await expect(win.locator(`${EDITOR_PANEL} ${TOOLBAR}`)).toHaveCount(1);
    await expect(win.locator(`${EDITOR_PANEL} ${tb('editor', 'pin')}`)).toBeVisible();

    const placeholder = win.locator(`${EDITOR_PANEL} .ridgeline-panel-empty`);
    await expect(placeholder).toHaveCount(1, { timeout: 20_000 });
    await expect(placeholder).toHaveText('No headings');
    await expect(win.locator(EDITOR_ROWS)).toHaveCount(0);
  });

  // Contract B(5) — unpinning gives the room straight back: with `outlineMakeRoom` unreachable from the
  // toolbar, the OFF state is proven by unpinning, which must restore the legacy minimap margin (here
  // `overlay` on both surfaces, i.e. none) immediately.
  test('B5: unpinning restores the legacy minimap margin (no room) on both surfaces', async () => {
    const { win } = joplin;
    // Back on the note with headings, pinned (established, not assumed) and still making room.
    await selectNoteByTitle(win, MIXED_NOTE);
    await ensurePinned(win, frame, true);
    await expect
      .poll(() => editorContentPadding(win, 'right'), { timeout: 20_000 })
      .toBeGreaterThan(NO_ROOM_PX);

    await firePinToggle(win);

    // Exact post-flip value, for the same staleness reason as A3.
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-pinned', 'false', {
      timeout: 15_000,
    });
    await expect(frame.locator(VIEWER_STRIP)).toHaveAttribute('data-pinned', 'false', {
      timeout: 20_000,
    });
    // Overlay mode reserves nothing at all — the note text reclaims the full pane.
    await expect
      .poll(() => editorContentPadding(win, 'right'), {
        timeout: 15_000,
        message: 'editor room released on unpin (overlay mode → no margin)',
      })
      .toBeLessThan(NO_ROOM_PX);
    await expect
      .poll(() => viewerBodyMargin(frame, 'right'), {
        timeout: 20_000,
        message: 'viewer room released on unpin (overlay mode → no margin)',
      })
      .toBeLessThan(NO_ROOM_PX);

    // And the outline is a hover outline again.
    await movePointerToNoteList(win);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'false', {
      timeout: 10_000,
    });
  });

  /**
   * Contract "narrow pane": on a pane too narrow to leave `outlineMinTextPx` (200px) of text beside the
   * outline, no room is made and the outline overlays instead; below `outlineMinWidthPx` (140px) of pane
   * the outline is the whole pane.
   *
   * SKIPPED: there is no reliable way in this harness to shrink the editor pane below ~400px. The
   * existing helpers/specs never resize a pane — `ensureViewerVisible` only cycles Joplin's pane layout
   * (which at 1920x1080 still leaves ~700px per pane), the sidebar/note-list toggles make the editor
   * WIDER, no spec drags a split divider, and Playwright cannot resize a CDP-attached Electron window
   * (`setViewportSize` is unsupported on a persistent context). The only lever that does shrink the pane
   * in CSS px is `windowContentZoomFactor`, which is a PROFILE seed (see z1-zoom-phase.spec.ts) and would
   * therefore cost a third Joplin launch — the one thing this file is explicitly budgeted against.
   * The width invariants that CAN be checked without a narrow pane (the 140px floor, the ≤90%-of-pane
   * cap, and the ≥200px text column while room is made) are asserted in B1/B2/B4 above.
   */
  test.skip('narrow pane: the outline never exceeds the pane and room falls back to the minimap margin', async () => {
    // Intentionally empty — see the comment above. Needs a third launch seeded with a large
    // windowContentZoomFactor (or a driven split-divider drag) to make the editor pane < 400px.
  });
});
