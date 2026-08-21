import { test, expect, Frame, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance } from './launch';
import {
  createNotebook,
  createNoteWithBody,
  ensureViewerVisible,
  hoverEditorBars,
  waitForEditorStrip,
  EDITOR_STRIP,
} from './helpers';

/**
 * Q3 — FAITHFUL-ENVIRONMENT pointer-cursor lock.
 *
 * Twice before, a single-point cursor assertion passed while the pointer cursor still wasn't showing on
 * the user's real machine. The discrepancy was never observable through document.elementFromPoint (its
 * computed cursor was always 'pointer'); the real problem was that the editor panel lived INSIDE
 * .cm-editor, where CodeMirror's own cursor/stacking could win the on-screen cursor. Round 3 moves the
 * editor strip+panel to a FIXED element on the document body, fully outside CodeMirror.
 *
 * This spec reproduces the user's environment as faithfully as the harness allows — his real
 * userchrome.css, his 120% zoom, and the two heading-touching CM6 editor plugins (Rich Markdown +
 * Wrapped Line Indent) — then, on BOTH the editor and the viewer, opens the TOC and samples MULTIPLE
 * points across the panel, asserting for each that (a) elementFromPoint lands on the panel or a
 * descendant (nothing from the editor sits on top), (b) the computed cursor is pointer, and (c) nothing
 * between the hit and the panel disables pointer-events. It also proves the strip is no longer a child
 * of .cm-editor.
 *
 * Portability: the user's assets live under ~/.config and are absent in CI; when neither the userchrome
 * nor any named plugin is present the spec test.skip()s (the clean-profile cursor invariant is covered
 * by round1-fixes.spec.ts and minimap.spec.ts).
 */

const CFG = path.join(os.homedir(), '.config', 'joplin-desktop');
const USERCHROME = path.join(CFG, 'userchrome.css');
const JPL_DIR = path.join(CFG, 'plugins');
const EDITOR_PLUGINS = [
  'com.bwat47.joplin-wrapped-line-indent.jpl',
  'plugin.calebjohn.rich-markdown.jpl',
];

function availableAssets(): { userchrome: boolean; plugins: string[] } {
  const plugins = EDITOR_PLUGINS.filter((p) => fs.existsSync(path.join(JPL_DIR, p)));
  return { userchrome: fs.existsSync(USERCHROME), plugins };
}

function buildBody(): string {
  const lines: string[] = [];
  const push = (h: string, level: number, filler = 6) => {
    lines.push(`${'#'.repeat(level)} ${h}`);
    for (let n = 0; n < filler; n++) lines.push(`Body line ${n + 1}.`);
  };
  push('Alpha One', 1);
  push('A very long heading that overflows the panel width and so is ellipsized for sure', 2);
  push('Charlie Three', 3);
  push('Delta Four', 4);
  push('Echo Five', 5);
  push('Foxtrot Six', 6, 90);
  return lines.join('\n');
}

interface Sample {
  label: string;
  tag: string | null;
  cls: string;
  cursor: string | null;
  insidePanel: boolean;
  blockedBy: string | null;
}

// Runs inside the page/frame: open panel assumed. Samples row + panel points against the given strip id.
function sampleFn(stripSelector: string): Sample[] {
  const panel = document.querySelector(`${stripSelector} .ridgeline-panel`) as HTMLElement | null;
  const rows = Array.from(document.querySelectorAll(`${stripSelector} .ridgeline-panel-row`)) as HTMLElement[];
  const out: Sample[] = [];
  if (!panel || rows.length === 0) return out;
  const pr = panel.getBoundingClientRect();
  const probe = (label: string, x: number, y: number) => {
    const t = document.elementFromPoint(x, y) as HTMLElement | null;
    const insidePanel = !!t && (t === panel || panel.contains(t));
    let blockedBy: string | null = null;
    let el: HTMLElement | null = t;
    for (let i = 0; el && i < 12; i++, el = el.parentElement) {
      if (getComputedStyle(el).pointerEvents === 'none') blockedBy = `${el.tagName}.${el.className}`;
      if (el === panel) break;
    }
    out.push({ label, tag: t?.tagName ?? null, cls: (t?.className || '').toString(), cursor: t ? getComputedStyle(t).cursor : null, insidePanel, blockedBy });
  };
  const row = rows[2] || rows[0];
  const rr = row.getBoundingClientRect();
  probe('row-textcenter', rr.left + rr.width / 2, rr.top + rr.height / 2);
  probe('row-leftpad', rr.left + 2, rr.top + rr.height / 2);
  probe('panel-padding', pr.left + 3, pr.top + 3);
  probe('panel-innermid', pr.left + pr.width / 2, pr.top + pr.height / 2);
  return out;
}

function assertSamples(samples: Sample[], where: string): void {
  expect(samples.length, `${where}: sampled points`).toBeGreaterThanOrEqual(4);
  for (const s of samples) {
    expect(s.insidePanel, `${where} ${s.label}: hit <${s.tag} class="${s.cls}"> is the panel/descendant`).toBe(true);
    expect(s.cursor, `${where} ${s.label}: hit <${s.tag} class="${s.cls}"> cursor`).toBe('pointer');
    expect(s.blockedBy, `${where} ${s.label}: pointer-events:none between hit and panel`).toBeNull();
  }
}

test.describe("Q3 faithful pointer cursor (user's userchrome + 120% zoom + real editor plugins)", () => {
  let joplin: JoplinInstance | null = null;
  const assets = availableAssets();

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const profileDir = createProfile(true, { side: 'left', editorMode: 'overlay' });
    const sf = path.join(profileDir, 'settings.json');
    const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
    s['windowContentZoomFactor'] = 120; // the user's real zoom
    fs.writeFileSync(sf, JSON.stringify(s, null, 2), 'utf8');
    if (assets.userchrome) fs.copyFileSync(USERCHROME, path.join(profileDir, 'userchrome.css'));
    if (assets.plugins.length) {
      const pdir = path.join(profileDir, 'plugins');
      fs.mkdirSync(pdir, { recursive: true });
      for (const p of assets.plugins) fs.copyFileSync(path.join(JPL_DIR, p), path.join(pdir, p));
    }
    // eslint-disable-next-line no-console
    console.log(`[q3faithful] userchrome=${assets.userchrome} zoom=120 plugins=${JSON.stringify(assets.plugins)}`);
    joplin = await launchJoplin({ profileDir });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'Q3 faithful cursor', buildBody());
    await waitForEditorStrip(joplin.win);
    await joplin.win.waitForTimeout(1200);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
    joplin = null;
  });

  test('the editor strip is a FIXED element on <body>, not a child of .cm-editor', async () => {
    test.skip(!assets.userchrome && assets.plugins.length === 0, 'no user assets on this machine (CI)');
    const info = await joplin!.win.evaluate(() => {
      const strip = document.querySelector('.ridgeline-editor-strip') as HTMLElement | null;
      return {
        position: strip ? getComputedStyle(strip).position : null,
        parentIsBody: strip ? strip.parentElement === document.body : false,
        insideCmEditor: strip ? !!strip.closest('.cm-editor') : true,
      };
    });
    expect(info.position).toBe('fixed');
    expect(info.parentIsBody).toBe(true);
    expect(info.insideCmEditor).toBe(false);
  });

  test('editor: every sampled panel point resolves to a pointer cursor', async () => {
    test.skip(!assets.userchrome && assets.plugins.length === 0, 'no user assets on this machine (CI)');
    const win = joplin!.win as Page;
    await hoverEditorBars(win);
    await expect(win.locator(EDITOR_STRIP)).toHaveAttribute('data-expanded', 'true', { timeout: 8_000 });
    await win.waitForTimeout(200);
    const samples = await win.evaluate(sampleFn, '.ridgeline-editor-strip');
    assertSamples(samples, 'editor');
  });

  test('viewer: every sampled panel point resolves to a pointer cursor', async () => {
    test.skip(!assets.userchrome && assets.plugins.length === 0, 'no user assets on this machine (CI)');
    const win = joplin!.win as Page;
    const frame: Frame = await ensureViewerVisible(win);
    const bars = frame.locator('#ridgeline-viewer-strip .ridgeline-bars');
    await expect(bars).toBeVisible({ timeout: 15_000 });
    await bars.hover();
    await expect(frame.locator('#ridgeline-viewer-strip')).toHaveAttribute('data-expanded', 'true', { timeout: 8_000 });
    await win.waitForTimeout(200);
    const samples = await frame.evaluate(sampleFn, '#ridgeline-viewer-strip');
    assertSamples(samples, 'viewer');
  });
});
