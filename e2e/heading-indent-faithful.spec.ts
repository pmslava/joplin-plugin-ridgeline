import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance } from './launch';
import {
  buildMixedNoteBody,
  createNotebook,
  createNoteWithBody,
  waitForEditorStrip,
  measureHeadingGeometry,
} from './helpers';

/**
 * R8 — FAITHFUL-ENVIRONMENT reproduction.
 *
 * The base heading-indent.spec.ts locks the heading↔body alignment invariant in a clean profile. The
 * legitimate objection to that alone (raised in the round-1 verification) is that the user's reported
 * per-level left-shift might come from his REAL environment — his userchrome.css and/or another
 * CM6 editor plugin — interacting with Ridgeline's reserve padding, none of which a clean profile
 * exercises. This spec closes that gap: when the user's real assets are present on the machine, it
 * layers them into the throwaway profile and re-asserts the SAME invariant under the actual
 * interacting conditions:
 *   - his real ~/.config/joplin-desktop/userchrome.css (has .cm-editor / .cm-ext-checkbox-toggle
 *     rules), copied into the profile so Joplin injects it exactly as on his desktop;
 *   - Rich Markdown (plugin.calebjohn.rich-markdown) — the source of his .cm-rm-* userchrome rules,
 *     a CM6 plugin that renders headings; and
 *   - Wrapped Line Indentation (com.bwat47.joplin-wrapped-line-indent) — a CM6 plugin that adds a
 *     per-line hanging indent (the most plausible per-level-shift suspect),
 *   installed into the profile alongside Ridgeline, in the WORST-CASE side=right + reserve combo,
 *   with inline rendering ON.
 *
 * Result (recorded here for provenance): across pre-existing and freshly-typed H1..H6, every heading
 * line's visible text starts at the body text-left (offset 0.0px) — i.e. R8 did NOT reproduce even in
 * this faithful environment. WLI indents from leading whitespace, which headings do not have, so it
 * cannot shift them; Rich Markdown (verified loaded) leaves headings flush; and Ridgeline's reserve
 * padding is a single uniform pad on .cm-content that shifts every line equally. R8 is therefore
 * closed as environment-specific (see SMOKE.md for the live bisection recipe), not a shipped fix —
 * and this spec stands as a lock that Ridgeline's reserve padding never breaks heading alignment even
 * with those two heading-touching plugins present.
 *
 * Portability: the user's assets live under ~/.config and are absent in CI. When neither the
 * userchrome nor any of the named plugins is found, the spec test.skip()s (the clean-profile
 * invariant is already covered by heading-indent.spec.ts). When at least one asset is present it
 * runs, layering whatever is available.
 */

const CFG = path.join(os.homedir(), '.config', 'joplin-desktop');
const USERCHROME = path.join(CFG, 'userchrome.css');
const JPL_DIR = path.join(CFG, 'plugins');
// CM6 editor plugins that could plausibly touch heading-line horizontal geometry.
const EDITOR_PLUGINS = [
  'com.bwat47.joplin-wrapped-line-indent.jpl',
  'plugin.calebjohn.rich-markdown.jpl',
];

const TOL = 3;

function availableAssets(): { userchrome: boolean; plugins: string[] } {
  const plugins = EDITOR_PLUGINS.filter((p) => fs.existsSync(path.join(JPL_DIR, p)));
  return { userchrome: fs.existsSync(USERCHROME), plugins };
}

async function assertAligned(win: import('playwright').Page, label: string): Promise<void> {
  const g = await measureHeadingGeometry(win);
  const rel = g.headings.map((h) => `H${h.level}:${(h.left - g.bodyLeft).toFixed(1)}`).join(' ');
  // eslint-disable-next-line no-console
  console.log(`[faithful ${label}] bodyLeft=${g.bodyLeft.toFixed(1)} contentLeft=${g.contentLeft.toFixed(1)} | ${rel}`);
  test.expect(g.headings.length, `${label}: headings measured`).toBeGreaterThan(0);
  test.expect(g.bodyLeft, `${label}: a body line measured`).toBeGreaterThan(0);
  for (const h of g.headings) {
    test
      .expect(Math.abs(h.left - g.bodyLeft), `${label}: H${h.level} "${h.text}" left ${h.left.toFixed(1)} vs body ${g.bodyLeft.toFixed(1)}`)
      .toBeLessThanOrEqual(TOL);
    test
      .expect(h.left, `${label}: H${h.level} left ${h.left.toFixed(1)} < contentLeft ${g.contentLeft.toFixed(1)}`)
      .toBeGreaterThanOrEqual(g.contentLeft - TOL);
  }
}

test.describe("R8 faithful environment (user's userchrome + real editor plugins, right+reserve)", () => {
  let joplin: JoplinInstance | null = null;
  const assets = availableAssets();

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // side=right + reserve is the worst case the user reported ("text exits the pane").
    const profileDir = createProfile(true, { side: 'right', editorMode: 'reserve' });
    if (assets.userchrome) fs.copyFileSync(USERCHROME, path.join(profileDir, 'userchrome.css'));
    if (assets.plugins.length) {
      const pdir = path.join(profileDir, 'plugins');
      fs.mkdirSync(pdir, { recursive: true });
      for (const p of assets.plugins) fs.copyFileSync(path.join(JPL_DIR, p), path.join(pdir, p));
    }
    // eslint-disable-next-line no-console
    console.log(`[faithful] userchrome=${assets.userchrome} plugins=${JSON.stringify(assets.plugins)}`);
    joplin = await launchJoplin({ profileDir });
    await createNotebook(joplin.win, 'Ridgeline NB');
    await createNoteWithBody(joplin.win, 'R8 faithful', buildMixedNoteBody());
    await waitForEditorStrip(joplin.win);
    await joplin.win.waitForTimeout(1500);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
    joplin = null;
  });

  test('pre-existing H1..H6 stay flush with body under the real interacting environment', async () => {
    test.skip(!assets.userchrome && assets.plugins.length === 0,
      'no user assets on this machine (CI); clean-profile invariant is covered by heading-indent.spec.ts');
    await assertAligned(joplin!.win, 'pre-existing');
  });

  test('freshly typed H1..H6 stay flush with body under the real interacting environment', async () => {
    test.skip(!assets.userchrome && assets.plugins.length === 0,
      'no user assets on this machine (CI); clean-profile invariant is covered by heading-indent.spec.ts');
    const { win } = joplin!;
    await win.locator('.cm-content').first().click();
    await win.keyboard.press('Control+End');
    await win.keyboard.type('\n\n# Fresh One\nx\n## Fresh Two\nx\n### Fresh Three\nx\n#### Fresh Four\nx\n##### Fresh Five\nx\n###### Fresh Six\nx');
    await win.waitForTimeout(700);
    await win.evaluate(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await win.waitForTimeout(600);
    await assertAligned(win, 'fresh');
  });
});
