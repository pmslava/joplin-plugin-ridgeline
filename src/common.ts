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

// CodeMirror command self-registered by the editor content script; the coordinator invokes it via
// joplin.commands.execute('editor.execCommand', { name: EDITOR_SCROLL_COMMAND, args: [line] }).
export const EDITOR_SCROLL_COMMAND = 'ridgeline.scrollToLine';

// Setting keys (registered under the plugin namespace). Stored in File storage so they can be seeded
// in a profile's settings.json and survive restarts.
export const SETTING_SIDE = 'side';
export const SETTING_EDITOR_MODE = 'editorMode';
export const SETTING_VIEWER_MODE = 'viewerMode';

export type Side = 'left' | 'right';
export type PaneMode = 'overlay' | 'reserve';

export interface RidgelineSettings {
	side: Side;
	editorMode: PaneMode;
	viewerMode: PaneMode;
}

export const DEFAULT_SETTINGS: RidgelineSettings = {
	side: 'left',
	editorMode: 'overlay',
	viewerMode: 'overlay',
};

// Width of the strip in CSS pixels (matches viewer.css / editor theme). Kept modest for the smoke
// build; the real minimap will widen on hover.
export const STRIP_WIDTH_PX = 14;

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
