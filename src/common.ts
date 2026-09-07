// Shared constants and message types used by the main-process coordinator (index.ts) and the
// CodeMirror editor content script. The viewer asset JS (viewer.js) is plain JavaScript that runs
// in the note iframe and cannot import this module, so it re-declares the few string constants it
// needs — keep the literal values here and there in sync.

export const PLUGIN_ID = 'io.github.pmslava.ridgeline';

// Content-script ids. These are the ids passed to joplin.contentScripts.register and to
// joplin.contentScripts.onMessage, and are also what the content scripts pass to
// context.postMessage / webviewApi.postMessage.
export const EDITOR_CONTENT_SCRIPT_ID = 'io.github.pmslava.ridgeline.editorStrip';
export const VIEWER_CONTENT_SCRIPT_ID = 'io.github.pmslava.ridgeline.viewerStrip';

// CodeMirror commands self-registered by the editor content script; the coordinator invokes them via
// joplin.commands.execute('editor.execCommand', { name, args }).
//  - EDITOR_SCROLL_COMMAND scrolls the raw editor to a line (jump target).
//  - EDITOR_APPLY_SETTINGS_COMMAND pushes new settings live (no relaunch) into the mounted strip.
export const EDITOR_SCROLL_COMMAND = 'ridgeline.scrollToLine';
export const EDITOR_APPLY_SETTINGS_COMMAND = 'ridgeline.applySettings';

// Plugin command (with menu item + accelerator) that flips the strip side; used to demonstrate and
// test live settings, and handy for the user.
export const TOGGLE_SIDE_COMMAND = 'ridgeline.toggleSide';

// Z2: plugin command (Tools → Ridgeline submenu + accelerator Ctrl+Alt+M + a fa-stream note-toolbar
// button) that flips the "Show minimap" setting, so the user can hide/show Ridgeline live in every
// window without disabling the plugin.
export const TOGGLE_MINIMAP_COMMAND = 'ridgeline.toggleMinimap';

// W3: plugin command (Tools → Ridgeline submenu + accelerator Ctrl+Alt+H) that flips the
// "hideWhenEmpty" setting, so the user can turn the hide-on-heading-less-note behaviour on/off live in
// every window. Flipping it fires the same settings.onChange path (editor pushed, viewer polled) that
// mounts/unmounts the strip.
export const TOGGLE_HIDE_WHEN_EMPTY_COMMAND = 'ridgeline.toggleHideWhenEmpty';

// Outline toolbar: plugin command (Tools → Ridgeline submenu + accelerator Ctrl+Alt+P) that flips the
// "Pin the outline open" setting, and nothing else. The pin does not need the toolbar — a pinned
// outline with no toolbar simply shows its rows, and the same accelerator unpins it again.
export const TOGGLE_PIN_COMMAND = 'ridgeline.togglePin';

// Outline toolbar: plugin command (Tools → Ridgeline submenu + accelerator Ctrl+Alt+O) that flips
// "Make room for the pinned outline", so the pinned outline can be switched between pushing the note
// text aside and overlaying it without a trip to the Settings screen. Ctrl+Alt+O is free in Joplin
// 3.7.6's default keymap (its only Ctrl+Alt+* bindings are -, T, S, 1, 2, 3 and N).
export const TOGGLE_MAKE_ROOM_COMMAND = 'ridgeline.toggleMakeRoom';

// Setting keys (registered under the plugin namespace). Stored in File storage so they can be seeded
// in a profile's settings.json and survive restarts.
export const SETTING_SIDE = 'side';
export const SETTING_EDITOR_MODE = 'editorMode';
export const SETTING_VIEWER_MODE = 'viewerMode';
export const SETTING_MAX_DEPTH = 'maxDepth';
// Z2: master visibility toggle. When false the strip is fully unmounted (listeners torn down) in both
// surfaces and every window; when true it is (re)mounted. Live via the same push/poll path.
export const SETTING_SHOW_MINIMAP = 'showMinimap';
// W3: hide the strip (and drop the reserve margin) on a note that has NO headings. Default true — the
// user prefers a clean, unreserved surface on heading-less notes. showMinimap=false always wins;
// hideWhenEmpty=false keeps the empty strip + margin as before. Live via the same push/poll path.
export const SETTING_HIDE_WHEN_EMPTY = 'hideWhenEmpty';
// v0.2.8: gate the fa-stream note-toolbar toggle button behind a setting. Default true (button shown).
// This is the ONE Ridgeline setting that is NOT live: JoplinViewsToolbarButtons exposes create() only
// — no remove/hide/destroy — so a toolbar button created at startup cannot be torn down at runtime.
// The value is therefore read once at startup to decide whether to create the button, and a change to
// it only takes effect after Joplin is restarted. The Tools → Ridgeline submenu entry and Ctrl+Alt+M
// are unaffected.
export const SETTING_SHOW_TOOLBAR_BUTTON = 'showToolbarButton';
// Q2: hover-intent dwell (ms) before the TOC opens. Stored as a setting so the user can tune it; the
// coordinator folds the resolved value into the tokens it ships to both content scripts.
export const SETTING_HOVER_OPEN_DELAY = 'hoverOpenDelayMs';
export const HOVER_OPEN_DELAY_MIN = 100;
export const HOVER_OPEN_DELAY_MAX = 1000;

// ── OUTLINE TOOLBAR (issue #2) ───────────────────────────────────────────
//
// Vocabulary, used consistently in code, labels and docs. Everything the USER reads (setting labels,
// descriptions, README, tooltips) says "minimap" for the compact bars, never "strip"; the code keeps
// its older `strip` identifiers, CSS classes and data-testids, which must not be renamed:
//   minimap (code: strip) = the compact stack of thin bars at the pane edge.
//   outline               = the expanded table-of-contents panel (.ridgeline-panel) over it.
//   minimap margin        = the EXISTING thin margin (editorMode/viewerMode = 'reserve') that keeps
//                           the text clear of the BARS only.
//   outline room          = the NEW wide margin that keeps the text clear of a PINNED outline.
//
// The toolbar is the outline's first row (Width / Headings / Pin). It is OFF by default; the three
// settings below it work with or without it, from the Settings screen, the toolbar or Ctrl+Alt+P.
export const SETTING_OUTLINE_TOOLBAR = 'outlineToolbar';
// The outline's MAXIMUM width as a share of the pane, in percent. The outline is content-fit within
// it, hovered or pinned.
export const SETTING_OUTLINE_WIDTH_PERCENT = 'outlineWidthPercent';
// Keep the outline open at full pane height until unpinned (persisted, so a pin survives a restart).
export const SETTING_OUTLINE_PINNED = 'outlinePinned';
// While pinned, push the note text aside by the outline's width instead of overlaying it. Flipped from
// the Settings screen or by TOGGLE_MAKE_ROOM_COMMAND (Ctrl+Alt+O).
export const SETTING_OUTLINE_MAKE_ROOM = 'outlineMakeRoom';

// The width percent's bounds/default and the toolbar's three presets. Mirrored in viewer.js (which
// cannot import this module) — keep the literal values in sync.
export const OUTLINE_WIDTH_MIN = 10;
export const OUTLINE_WIDTH_MAX = 90;
export const OUTLINE_WIDTH_DEFAULT = 33;
export const OUTLINE_WIDTH_PRESETS = [25, 33, 50];

export type Side = 'left' | 'right';
export type PaneMode = 'overlay' | 'reserve';

export interface RidgelineSettings {
	side: Side;
	editorMode: PaneMode;
	viewerMode: PaneMode;
	// Deepest heading level shown in the minimap (1-6). Headings deeper than this are omitted.
	maxDepth: number;
	// Z2: master visibility. false = strip fully unmounted in both surfaces / every window.
	showMinimap: boolean;
	// W3: when true (default), a note with 0 headings hides the strip AND drops the reserve margin in
	// both surfaces / every window. false = the empty strip + margin are kept (pre-W3 behaviour).
	hideWhenEmpty: boolean;
	// Issue #2: show the outline's first row (Width / Headings / Pin). OFF by default. The three fields
	// below are independent of it — the toolbar only offers a second way to change them.
	outlineToolbar: boolean;
	// The outline's MAXIMUM width as a percent of the pane (OUTLINE_WIDTH_MIN..MAX); it is content-fit
	// within that cap.
	outlineWidthPercent: number;
	// Keep the outline open at the full pane height until unpinned.
	outlinePinned: boolean;
	// While pinned, reserve the outline room (the wide margin) so the outline covers no text.
	outlineMakeRoom: boolean;
}

export const DEFAULT_SETTINGS: RidgelineSettings = {
	side: 'left',
	editorMode: 'overlay',
	viewerMode: 'overlay',
	maxDepth: 6,
	showMinimap: true,
	hideWhenEmpty: true,
	outlineToolbar: false,
	outlineWidthPercent: OUTLINE_WIDTH_DEFAULT,
	outlinePinned: false,
	outlineMakeRoom: true,
};

// ── THE ONE RESOLVER (both surfaces must agree) ──────────────────────────
//
// Mirrored verbatim in viewer.js (plain JS, no imports). Exactly one place decides "is the toolbar row
// drawn / is the outline pinned / is room being made":
//   toolbarOn = showMinimap && outlineToolbar
//   pinned    = showMinimap && outlinePinned
//   makeRoom  = pinned      && outlineMakeRoom
//
// The three OUTLINE settings are INDEPENDENT of the toolbar: the toolbar is only a convenient place to
// change them, never a precondition for them. Pin, width and make-room all work from the Settings
// screen (and Ctrl+Alt+P) with the toolbar off — a pinned outline with no toolbar simply shows its
// rows. Only the master showMinimap switch still gates everything, pinned or not.
export function outlineToolbarOn(settings: RidgelineSettings): boolean {
	return settings.showMinimap && settings.outlineToolbar;
}

export function outlinePinnedOn(settings: RidgelineSettings): boolean {
	return settings.showMinimap && settings.outlinePinned;
}

export function outlineMakeRoomOn(settings: RidgelineSettings): boolean {
	return outlinePinnedOn(settings) && settings.outlineMakeRoom;
}

// The coordinator's answer to a getSettings request: the resolved settings plus the design tokens.
// The viewer strip (plain-JS iframe asset that cannot import tokens.ts) reads its tokens from here.
import type { RidgelineTokens } from './tokens';
export interface SettingsResponse extends RidgelineSettings {
	tokens: RidgelineTokens;
}

// Messages content scripts send to the coordinator (answered by joplin.contentScripts.onMessage).
export interface GetSettingsMessage {
	type: 'getSettings';
}

export interface JumpMessage {
	type: 'jump';
	// uslug anchor of the target heading (matches Joplin's rendered anchor id) — scrolls the viewer.
	anchor: string;
	// 0-based line number of the heading — scrolls the raw Markdown editor. The editor strip knows
	// this from its own parse; the viewer strip sends null and the coordinator resolves it from the
	// note body by matching the anchor.
	line: number | null;
}

// A settings change made FROM a surface (the outline toolbar's Width / Headings / Pin controls). The
// coordinator applies an ALLOWLIST of exactly these three keys — a content script can never write any
// other setting — coerces each, and answers with a fresh SettingsResponse so the clicking surface can
// apply it immediately instead of waiting for the onChange push / the 700ms poll.
export interface SetSettingsMessage {
	type: 'setSettings';
	values: Partial<{ outlinePinned: boolean; outlineWidthPercent: number; maxDepth: number }>;
}

export type ContentScriptMessage = GetSettingsMessage | JumpMessage | SetSettingsMessage;
