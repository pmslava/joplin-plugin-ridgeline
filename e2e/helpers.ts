import { Page, Frame, FrameLocator, expect } from '@playwright/test';

/** Generous settle delay: Joplin re-renders the editor/viewer on a timer of its own. */
export const SETTLE = 800;

export const EDITOR_STRIP = '.ridgeline-editor-strip';
export const EDITOR_BARS = '.ridgeline-editor-strip .ridgeline-bars';
export const VIEWER_IFRAME = 'iframe.noteTextViewer';

/**
 * Open the editor's hover TOC by moving the pointer over the COMPACT BAR STACK (the `.ridgeline-bars`
 * box), which is the real hover trigger zone. The strip container is full-height but no longer
 * captures hover (R6), so hovering its centre would not expand the panel — hover the bars.
 */
export async function hoverEditorBars(win: Page): Promise<void> {
  await win.locator(EDITOR_BARS).first().hover();
}

/** Distinct heading titles used by the test note, in document order. */
export const HEADINGS = [
  'Introduction',
  'Installation',
  'Configuration',
  'Usage',
  'Advanced Topics',
  'Troubleshooting',
];

/**
 * Build a Markdown body with the headings above, each followed by filler lines so the note is tall
 * enough that scrolling changes which heading sits at the top of the viewport.
 *
 * The FINAL section is made much taller than any plausible editor/viewer viewport (>= 80 lines) so
 * that scrolling to the very bottom deterministically places the last heading at the top of the
 * viewport — letting S2/S5 assert the exact bottom-of-scroll heading rather than merely "it changed".
 */
export function buildNoteBody(fillerPerSection = 12): string {
  const lines: string[] = [];
  const lastIndex = HEADINGS.length - 1;
  HEADINGS.forEach((h, i) => {
    lines.push(`# ${h}`);
    const filler = i === lastIndex ? Math.max(fillerPerSection, 80) : fillerPerSection;
    for (let n = 0; n < filler; n++) {
      lines.push(`Section ${i + 1} line ${n + 1}.`);
    }
  });
  return lines.join('\n');
}

/**
 * A note whose headings span levels H1..H6 (in that order), each followed by filler so the note is
 * scrollable. Used to exercise level-encoded bar widths, panel indentation, and maxDepth filtering.
 * Returns the ordered list of { level, text } so specs can assert against it.
 */
export const MIXED_HEADINGS: Array<{ level: number; text: string }> = [
  { level: 1, text: 'Alpha One' },
  { level: 2, text: 'Bravo Two' },
  { level: 3, text: 'Charlie Three' },
  { level: 4, text: 'Delta Four' },
  { level: 5, text: 'Echo Five' },
  { level: 6, text: 'Foxtrot Six' },
];

export function buildMixedNoteBody(fillerPerSection = 6): string {
  const lines: string[] = [];
  const lastIndex = MIXED_HEADINGS.length - 1;
  MIXED_HEADINGS.forEach((h, i) => {
    lines.push(`${'#'.repeat(h.level)} ${h.text}`);
    const filler = i === lastIndex ? Math.max(fillerPerSection, 80) : fillerPerSection;
    for (let n = 0; n < filler; n++) lines.push(`Body ${i + 1} line ${n + 1}.`);
  });
  return lines.join('\n');
}

/**
 * A note mixing setext headings (=== / ---), ATX headings, a fenced code block that CONTAINS a line
 * that looks like an ATX heading, AND an indented (4-space) code block whose line also looks like an
 * ATX heading. The editor parser and the rendered viewer must agree on the heading count: 4 real
 * headings, the fenced `# Not A Heading` and the indented `# Indented Not A Heading` both ignored
 * (CommonMark: 4+ leading spaces = indented code block, which Joplin renders as <code>, not <h*>).
 */
export const SETEXT_REAL_HEADING_COUNT = 4;
export function buildSetextNoteBody(): string {
  return [
    'Setext Title', // setext H1 (line 0)
    '============', // underline (line 1)
    '',
    'Body text for the first section so it is a bit taller.',
    '',
    'Setext Subtitle', // setext H2
    '---------------', // underline
    '',
    'More body text under the subtitle.',
    '',
    '# Real ATX Heading',
    '',
    'Text, then a fenced block whose contents must NOT be parsed as a heading:',
    '',
    // Tilde fence (not backticks) so typing it into CodeMirror cannot trigger backtick auto-close.
    '~~~',
    '# Not A Heading',
    '~~~',
    '',
    '## Another ATX Heading',
    '',
    ...Array.from({ length: 80 }, (_, n) => `Trailing line ${n + 1}.`),
    '',
    // Indented code block (4 spaces) whose line looks like an ATX heading but must NOT be parsed as
    // one. Placed LAST so CodeMirror's auto-indent (which carries the 4-space indent onto the next
    // typed line) cannot contaminate any real heading above it.
    'Finally, an indented code block whose line must NOT be parsed as a heading:',
    '',
    '    # Indented Not A Heading',
  ].join('\n');
}

export async function createNotebook(win: Page, name: string): Promise<void> {
  await win.click('.sidebar-header-button.-newfolder');
  await win.waitForTimeout(1200);
  await win.locator('input[type="text"]:visible').first().fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
}

/**
 * Create a new note, set its title, then type a Markdown body into the CodeMirror editor.
 *
 * The title and body are filled separately with focus verified before typing the body: on "New
 * note" Joplin focuses the title input, and typing the body without first moving focus into the
 * editor leaks the leading characters into the title (which then corrupts the first heading).
 * Leaves the note open in the editor.
 */
export async function createNoteWithBody(win: Page, title: string, body: string): Promise<void> {
  await win.locator('button:has-text("New note")').first().click();
  await win.waitForTimeout(SETTLE);

  // Set the title via the title input directly.
  const titleInput = win.locator('input.title-input');
  await titleInput.click();
  await titleInput.fill(title);
  await win.waitForTimeout(200);

  // Focus the editor body and CONFIRM the caret is inside the CodeMirror editor before typing.
  await win.locator('.cm-content').first().click();
  await win
    .waitForFunction(
      () => {
        const ae = document.activeElement as HTMLElement | null;
        return !!ae && !!ae.closest('.cm-editor');
      },
      undefined,
      { timeout: 5000 }
    )
    .catch(() => {});
  await win.keyboard.type(body);
  await win.waitForTimeout(SETTLE);
  // Return the viewport to the top so the first heading is the current one initially.
  await scrollEditorTo(win, 0);
}

/**
 * Like createNoteWithBody, but inserts the body with keyboard.insertText — a single input event
 * rather than per-key typing. CodeMirror's Enter keymap (and its auto-indent) never fires, so exact
 * leading whitespace on a line (e.g. a leading-space ATX heading " # Title") is preserved verbatim.
 * createNoteWithBody's keyboard.type would let auto-indent alter that whitespace.
 */
export async function createNoteWithExactBody(win: Page, title: string, body: string): Promise<void> {
  await win.locator('button:has-text("New note")').first().click();
  await win.waitForTimeout(SETTLE);
  const titleInput = win.locator('input.title-input');
  await titleInput.click();
  await titleInput.fill(title);
  await win.waitForTimeout(200);
  await win.locator('.cm-content').first().click();
  await win
    .waitForFunction(
      () => {
        const ae = document.activeElement as HTMLElement | null;
        return !!ae && !!ae.closest('.cm-editor');
      },
      undefined,
      { timeout: 5000 }
    )
    .catch(() => {});
  await win.keyboard.insertText(body);
  await win.waitForTimeout(SETTLE);
  await scrollEditorTo(win, 0);
}

/** The CodeMirror scroller element in the main window. */
export function editorScroller(win: Page) {
  return win.locator('.cm-scroller').first();
}

export async function scrollEditorTo(win: Page, top: number): Promise<void> {
  await win.evaluate((y) => {
    const el = document.querySelector('.cm-scroller') as HTMLElement | null;
    if (el) el.scrollTop = y;
  }, top);
  await win.waitForTimeout(300);
}

export async function editorScrollTop(win: Page): Promise<number> {
  return win.evaluate(() => {
    const el = document.querySelector('.cm-scroller') as HTMLElement | null;
    return el ? el.scrollTop : -1;
  });
}

// The current heading is now shown by the bold/white current BAR (no text label in the compact
// state). Its heading text is carried on the bar's data-text attribute for observability.
export async function editorCurrentHeading(win: Page): Promise<string> {
  return (
    (await win
      .locator(`${EDITOR_STRIP} .ridgeline-bar.is-current`)
      .first()
      .getAttribute('data-text')
      .catch(() => '')) ?? ''
  );
}

/**
 * Ensure the rendered Markdown viewer pane is visible. Joplin's "toggleVisiblePanes" (Ctrl+L) cycles
 * editor-only → split → viewer-only; press until the note-viewer iframe is present.
 */
export async function ensureViewerVisible(win: Page): Promise<Frame> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const frame = viewerFrameOrNull(win);
    if (frame) return frame;
    await win.locator('.cm-content, .note-editor, .editor').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await win.keyboard.press('Control+l');
    await win.waitForTimeout(SETTLE);
  }
  const frame = viewerFrameOrNull(win);
  if (!frame) throw new Error('Note-viewer iframe never appeared after toggling panes');
  return frame;
}

export function viewerFrameOrNull(win: Page): Frame | null {
  for (const frame of win.frames()) {
    if (frame.url().includes('note-viewer/index.html')) return frame;
  }
  return null;
}

export function viewerFrame(win: Page): FrameLocator {
  return win.frameLocator(VIEWER_IFRAME);
}

export async function viewerCurrentHeading(win: Page): Promise<string> {
  const frame = viewerFrameOrNull(win);
  if (!frame) return '';
  return (
    (await frame
      .locator('#ridgeline-viewer-strip .ridgeline-bar.is-current')
      .first()
      .getAttribute('data-text')
      .catch(() => '')) ?? ''
  );
}

// Joplin's note viewer scrolls an inner container, not document.scrollingElement, so both reading
// and setting the scroll position must target whichever element actually overflows. Pick the element
// (including documentElement/body) with the largest scrollable delta.
const FIND_SCROLLER = `
  (function () {
    var best = document.scrollingElement || document.documentElement;
    var bestDelta = (best ? best.scrollHeight - best.clientHeight : 0);
    var els = document.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var delta = el.scrollHeight - el.clientHeight;
      if (delta > bestDelta) { bestDelta = delta; best = el; }
    }
    return best;
  })()`;

export async function viewerScrollTop(win: Page): Promise<number> {
  const frame = viewerFrameOrNull(win);
  if (!frame) return -1;
  return frame.evaluate(`(function(){ var s = ${FIND_SCROLLER}; return s ? s.scrollTop : 0; })()`) as Promise<number>;
}

export async function scrollViewerTo(win: Page, top: number): Promise<void> {
  const frame = viewerFrameOrNull(win);
  if (!frame) return;
  await frame.evaluate(`(function(){ var s = ${FIND_SCROLLER}; if (s) s.scrollTop = ${Math.floor(top)}; })()`);
  await win.waitForTimeout(400);
}

/** Wait for the editor strip to be attached to the DOM. */
export async function waitForEditorStrip(win: Page): Promise<void> {
  await expect(win.locator(EDITOR_STRIP)).toBeAttached({ timeout: 30_000 });
}

/**
 * Geometry of the Markdown editor's heading lines, measured in a given window (main or secondary).
 *
 * With Joplin's inline rendering ON, heading lines hide their leading `#` marks on lines that don't
 * hold the cursor, and the editor is supposed to keep the visible heading text flush with ordinary
 * body text (same content-left edge). R8 is the regression where heading text is instead pushed
 * progressively LEFT by level, past the content edge.
 *
 * We measure the visual left edge of each line's rendered text with a DOM Range over the line's
 * contents (a Range collapses hidden/zero-width replaced decorations, so it reports where visible
 * glyphs actually start). We report, per heading line: its level and text-left; plus the text-left
 * of a representative body line and the content box's inner-left, all in the same viewport pixels.
 */
export interface HeadingGeometry {
  contentLeft: number; // .cm-content inner left edge (border-box left + left padding)
  bodyLeft: number; // text-left of a representative non-heading body line
  headings: Array<{ level: number; left: number; text: string }>;
}

export async function measureHeadingGeometry(win: Page): Promise<HeadingGeometry> {
  return win.evaluate(() => {
    const editor = document.querySelector('.cm-editor');
    const content = editor?.querySelector('.cm-content') as HTMLElement | null;
    if (!editor || !content) return { contentLeft: -1, bodyLeft: -1, headings: [] };

    const cs = getComputedStyle(content);
    const cRect = content.getBoundingClientRect();
    const contentLeft = cRect.left + (parseFloat(cs.paddingLeft) || 0);

    const textLeft = (el: Element): number => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      // An empty line yields a zero rect; fall back to the element's own left.
      if (r.width === 0 && r.left === 0) return el.getBoundingClientRect().left;
      return r.left;
    };

    const lines = Array.from(editor.querySelectorAll('.cm-line')) as HTMLElement[];
    const headings: Array<{ level: number; left: number; text: string }> = [];
    let bodyLeft = -1;
    for (const line of lines) {
      let level = 0;
      for (let n = 1; n <= 6; n++) if (line.classList.contains(`cm-h${n}`)) level = n;
      if (level > 0) {
        headings.push({ level, left: textLeft(line), text: (line.textContent || '').trim() });
      } else if (bodyLeft < 0 && (line.textContent || '').trim().length > 0) {
        bodyLeft = textLeft(line);
      }
    }
    return { contentLeft, bodyLeft, headings };
  });
}

/** Select the note with the given title in the note list (used to exercise note switching). */
export async function selectNoteByTitle(win: Page, title: string): Promise<void> {
  await win.locator('.note-list-item .title span', { hasText: title }).first().click();
  await win.waitForTimeout(SETTLE);
}
