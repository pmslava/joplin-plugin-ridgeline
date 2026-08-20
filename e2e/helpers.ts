import { Page, Frame, FrameLocator, expect } from '@playwright/test';

/** Generous settle delay: Joplin re-renders the editor/viewer on a timer of its own. */
export const SETTLE = 800;

export const EDITOR_STRIP = '.ridgeline-editor-strip';
export const VIEWER_IFRAME = 'iframe.noteTextViewer';

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
 */
export function buildNoteBody(fillerPerSection = 12): string {
  const lines: string[] = [];
  HEADINGS.forEach((h, i) => {
    lines.push(`# ${h}`);
    for (let n = 0; n < fillerPerSection; n++) {
      lines.push(`Section ${i + 1} paragraph line ${n + 1} for scrolling.`);
    }
  });
  return lines.join('\n');
}

export async function createNotebook(win: Page, name: string): Promise<void> {
  await win.click('.sidebar-header-button.-newfolder');
  await win.waitForTimeout(1200);
  await win.locator('input[type="text"]:visible').first().fill(name);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
}

/**
 * Create a new note, type its title, then type a Markdown body into the CodeMirror editor.
 * Leaves the note open in the editor.
 */
export async function createNoteWithBody(win: Page, title: string, body: string): Promise<void> {
  await win.locator('button:has-text("New note")').first().click();
  await win.waitForTimeout(SETTLE);
  await win.keyboard.type(title);
  await win.waitForTimeout(SETTLE);

  // Move into the Markdown editor body and type the content.
  const content = win.locator('.cm-content').first();
  await content.click();
  await win.waitForTimeout(200);
  await win.keyboard.type(body);
  await win.waitForTimeout(SETTLE);
  // Return the caret to the top so the first heading is the current one initially.
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

export async function editorCurrentHeading(win: Page): Promise<string> {
  return (await win.locator(`${EDITOR_STRIP} .ridgeline-current`).textContent()) ?? '';
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
  return (await frame.locator('#ridgeline-viewer-strip .ridgeline-current').textContent().catch(() => '')) ?? '';
}

export async function viewerScrollTop(win: Page): Promise<number> {
  const frame = viewerFrameOrNull(win);
  if (!frame) return -1;
  return frame.evaluate(() => {
    return (
      window.pageYOffset ||
      (document.documentElement && document.documentElement.scrollTop) ||
      (document.body && document.body.scrollTop) ||
      0
    );
  });
}

export async function scrollViewerTo(win: Page, top: number): Promise<void> {
  const frame = viewerFrameOrNull(win);
  if (!frame) return;
  await frame.evaluate((y) => {
    const el = (document.scrollingElement || document.documentElement) as HTMLElement;
    el.scrollTop = y;
    window.scrollTo(0, y);
  }, top);
  await win.waitForTimeout(400);
}

/** Wait for the editor strip to be attached to the DOM. */
export async function waitForEditorStrip(win: Page): Promise<void> {
  await expect(win.locator(EDITOR_STRIP)).toBeAttached({ timeout: 30_000 });
}
