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

// Z2: plugin command (Tools menu + accelerator Ctrl+Alt+M + a fa-stream note-toolbar button) that
// flips the "Show minimap" setting, so the user can hide/show Ridgeline live in every window without
// disabling the plugin.
export const TOGGLE_MINIMAP_COMMAND = 'ridgeline.toggleMinimap';

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
// Q2: hover-intent dwell (ms) before the TOC opens. Stored as a setting so the user can tune it; the
// coordinator folds the resolved value into the tokens it ships to both content scripts.
export const SETTING_HOVER_OPEN_DELAY = 'hoverOpenDelayMs';
export const HOVER_OPEN_DELAY_MIN = 100;
export const HOVER_OPEN_DELAY_MAX = 1000;

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
}

export const DEFAULT_SETTINGS: RidgelineSettings = {
	side: 'left',
	editorMode: 'overlay',
	viewerMode: 'overlay',
	maxDepth: 6,
	showMinimap: true,
	hideWhenEmpty: true,
};

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

export type ContentScriptMessage = GetSettingsMessage | JumpMessage;
