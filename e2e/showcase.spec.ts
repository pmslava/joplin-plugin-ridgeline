import { test, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchJoplin, closeJoplin, createProfile, JoplinInstance } from './launch';
import {
  EDITOR_STRIP,
  EDITOR_BARS,
  createNotebook,
  createNoteWithExactBody,
  waitForEditorStrip,
  hoverEditorBars,
  ensureViewerVisible,
  scrollEditorTo,
  editorScroller,
} from './helpers';

/**
 * Not an assertion suite: this populates a realistic demo note and captures the Ridgeline strip so
 * the README/manifest screenshots can be regenerated. It asserts nothing and is skipped unless asked
 * for (mirrors joplin-plugin-cockpit/e2e/showcase.spec.ts):
 *
 *     SHOWCASE=1 xvfb-run -a --server-args="-screen 0 1920x1080x24" npx playwright test e2e/showcase.spec.ts
 *
 * It runs against a throwaway profile forced to Joplin's built-in DARK theme (theme=2) with inline
 * rendering ON — never the user's real profile. All content is fictional ("Acme Rocket Skates"), so
 * no real user data is captured.
 */

const OUT_DIR = path.join(__dirname, '..', 'docs', 'images');

// A generic, realistic product-spec note: H1..H4, paragraphs, a bullet list, and a fenced code block.
// Tall enough that scrolling changes which heading is current, so the compact strip shows a live
// current bar mid-scroll. Fictional throughout — no real user data.
const ACME_BODY = [
  '# Acme Rocket Skates — Product Specification',
  '',
  'Rocket-assisted personal mobility for the discerning field agent. This document covers the',
  'hardware, firmware, and safety envelope of the RS-7 platform, revision D.',
  '',
  '## Overview',
  '',
  'The RS-7 pairs two miniature booster pods with an active gyroscopic balance loop, so a standing',
  'operator can accelerate to cruising speed without losing footing. Everything below assumes the',
  'stock chassis and the factory firmware image.',
  '',
  '### Design goals',
  '',
  '- Sustained ground speed of 240 km/h on level, paved terrain',
  '- Sub-second throttle response from a standing start',
  '- Automatic cut-off before any detected cliff edge',
  '- A full charge-to-charge range of at least 40 kilometres',
  '',
  '### Non-goals',
  '',
  'Off-road, aquatic, and sub-zero operation are explicitly out of scope for the RS-7 and are',
  'deferred to the ruggedised RS-9 line.',
  '',
  '## Hardware',
  '',
  'The chassis is a single milled aluminium spine with a booster pod bolted to each heel and the',
  'control board seated between the ankles.',
  '',
  '### Booster assembly',
  '',
  'Each pod holds a replaceable solid-fuel cartridge, an igniter, and a thrust-vectoring nozzle on a',
  'two-axis gimbal. The nozzles counter-steer to hold a heading through a crosswind.',
  '',
  '### Balance loop',
  '',
  'A 1 kHz control loop reads the inertial unit and trims each nozzle to keep the operator upright.',
  'The loop degrades gracefully: a single failed sensor drops it to a slower, more conservative mode.',
  '',
  '#### Sensor fusion',
  '',
  'Accelerometer, gyroscope, and barometric altitude are fused with a complementary filter tuned for',
  'low latency over absolute accuracy — the loop cares more about *now* than about drift over minutes.',
  '',
  '## Firmware',
  '',
  'The controller runs a hard real-time loop. The throttle law is deliberately boring so that its',
  'behaviour is easy to certify:',
  '',
  '```python',
  'throttle = clamp(pid(target_speed - measured_speed), 0, MAX_THRUST)',
  'if edge_detected():',
  '    throttle = 0            # cliff ahead: cut thrust immediately',
  '```',
  '',
  '### Telemetry',
  '',
  'Every loop iteration emits speed, heading, thrust, and battery state over a short-range radio link',
  'for the ground station to record.',
  '',
  '## Safety',
  '',
  'The RS-7 is a powered vehicle. Treat every one of the failure modes below as a design constraint,',
  'not an afterthought.',
  '',
  '### Failure modes',
  '',
  'A stuck nozzle, a depleted cartridge, and a lost radio link each have a defined, tested response',
  'that always errs toward cutting thrust and coasting to a stop.',
  '',
  '#### Emergency stop',
  '',
  'A single firm heel-tap arms the emergency stop; a second within one second cuts both boosters and',
  'deploys the friction brake. There is no way to override it in firmware.',
  '',
  '## Ordering',
  '',
  'Units ship in pairs with two spare cartridges, a charging cradle, and the ground-station dongle.',
  'Volume pricing and the service contract are covered in the sales appendix.',
  '',
  ...Array.from({ length: 30 }, (_, n) => `Appendix line ${n + 1}: reserved for the sales and service terms.`),
].join('\n');

/** Clip a page screenshot to a rectangle, guarding against off-screen / zero-size boxes. */
async function shotClip(
  win: Page,
  file: string,
  clip: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const x = Math.max(0, Math.round(clip.x));
  const y = Math.max(0, Math.round(clip.y));
  const width = Math.max(1, Math.round(clip.width));
  const height = Math.max(1, Math.round(clip.height));
  await win.screenshot({ path: path.join(OUT_DIR, file), clip: { x, y, width, height } });
}

test.describe('Ridgeline showcase (dark theme)', () => {
  test.skip(!process.env.SHOWCASE, 'Set SHOWCASE=1 to capture the README/manifest screenshots');

  let joplin: JoplinInstance;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // Throwaway profile, forced to Joplin's built-in DARK theme (Setting.THEME_DARK = 2, verified in
    // the bundled app.asar), inline rendering ON (createProfile default), plugin loaded from ./dist.
    const profileDir = createProfile(true, { side: 'left', maxDepth: 6, editorMode: 'reserve', viewerMode: 'reserve' });
    const settingsPath = path.join(profileDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // theme is a File-storage setting, but it is only honoured when themeAutoDetect is OFF — otherwise
    // Joplin follows the OS colour scheme (light under Xvfb) and ignores `theme`. Set both.
    settings['themeAutoDetect'] = false;
    settings['theme'] = 2; // Setting.THEME_DARK (verified in the bundled app.asar)
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    joplin = await launchJoplin({ profileDir });
    await createNotebook(joplin.win, 'Acme');
    await createNoteWithExactBody(joplin.win, 'Acme Rocket Skates — RS-7 spec', ACME_BODY);
    await waitForEditorStrip(joplin.win);
    await joplin.win.waitForTimeout(1500);
  });

  test.afterAll(async () => {
    if (joplin) await closeJoplin(joplin);
  });

  test('capture the Ridgeline strip', async () => {
    const { win } = joplin;

    // Confirm the profile actually launched dark: the editor surface background must be a dark colour.
    // This is a sanity check on the theme seed, not a strict assertion — logged for provenance.
    const bg = await win.evaluate(() => {
      const el = document.querySelector('.cm-scroller') || document.querySelector('.cm-editor') || document.body;
      let node: HTMLElement | null = el as HTMLElement;
      for (let i = 0; node && i < 12; i++, node = node.parentElement) {
        const c = getComputedStyle(node).backgroundColor;
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (m) {
          const [r, g, b] = m[1].split(',').map((p) => parseFloat(p));
          if (!(r === 0 && g === 0 && b === 0 && /,\s*0\s*\)/.test(c))) {
            const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            return { color: c, lum };
          }
        }
      }
      return { color: '(none)', lum: 1 };
    });
    // eslint-disable-next-line no-console
    console.log(`[showcase] editor surface bg=${bg.color} luminance=${bg.lum.toFixed(3)} (dark => < 0.5)`);
    test.expect(bg.lum, 'editor surface is a dark theme').toBeLessThan(0.5);

    const editorBox = async () => (await editorScroller(win).boundingBox())!;
    const stripBox = async () => (await win.locator(EDITOR_STRIP).first().boundingBox())!;

    // ── Shot 1: compact minimap in the editor, current bar visible mid-scroll ──────────────────────
    // Scroll to roughly the Firmware section so a mid-document bar is the current one.
    const scroller = await editorBox();
    await scrollEditorTo(win, Math.round(scroller.height * 3.2));
    await win.waitForTimeout(900);
    {
      const ed = await editorBox();
      const st = await stripBox();
      // A tight vertical slice: the strip plus ~330px of the text it tracks, over the visible viewport.
      const left = Math.max(0, st.x - 6);
      await shotClip(win, 'minimap-editor.png', {
        x: left,
        y: ed.y,
        width: st.x + st.width + 330 - left,
        height: Math.min(ed.height, 620),
      });
    }

    // ── Shot 2: hover TOC expanded, indented rows + current heading highlighted ────────────────────
    await hoverEditorBars(win);
    await win.waitForSelector(`${EDITOR_STRIP} .ridgeline-panel`, { state: 'visible', timeout: 5000 }).catch(() => {});
    await win.waitForTimeout(700);
    {
      const ed = await editorBox();
      const panel = await win.locator(`${EDITOR_STRIP} .ridgeline-panel`).first().boundingBox();
      const st = await stripBox();
      const box = panel ?? st;
      // Frame the open panel with a little air on each side and top.
      const left = Math.max(0, box.x - 10);
      await shotClip(win, 'hover-toc-editor.png', {
        x: left,
        y: Math.max(ed.y, box.y - 12),
        width: box.width + 28,
        height: Math.min(box.height + 24, ed.height),
      });
    }
    // Move the pointer off the strip so the panel collapses before the next shot.
    await win.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2);
    await win.waitForTimeout(500);

    // ── Shot 3: split view with COMPACT strips in BOTH the editor and the rendered viewer ──────────
    await ensureViewerVisible(win);
    await win.waitForTimeout(1200);
    // Scroll both panes a little so each shows a live current bar.
    await scrollEditorTo(win, Math.round((await editorBox()).height * 1.4));
    await win.waitForTimeout(1000);
    // Park the pointer well away from either strip and wait out the hover grace so the TOC panel is
    // collapsed — this shot must show the two COMPACT strips, not an open outline.
    await win.mouse.move(360, 60);
    await win.waitForTimeout(1200);
    // Full window so both edge strips (editor-left + viewer-left) are in frame.
    await win.screenshot({ path: path.join(OUT_DIR, 'split-view.png') });

    // (The plugin's settings page is deliberately not auto-captured: Joplin's Options screen is opened
    // from a NATIVE application menu that Playwright's DOM driver cannot reach, and driving it hangs
    // the run. The README documents the settings in a table instead; regenerate that shot by hand if
    // ever needed.)

    // eslint-disable-next-line no-console
    console.log(`[showcase] wrote screenshots to ${OUT_DIR}`);
  });
});
