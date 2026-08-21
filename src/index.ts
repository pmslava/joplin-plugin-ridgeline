import joplin from 'api';
import {
	ContentScriptType,
	MenuItemLocation,
	SettingItemType,
	SettingStorage,
	ToolbarButtonLocation,
} from 'api/types';
import {
	EDITOR_APPLY_SETTINGS_COMMAND,
	EDITOR_CONTENT_SCRIPT_ID,
	EDITOR_SCROLL_COMMAND,
	HOVER_OPEN_DELAY_MAX,
	HOVER_OPEN_DELAY_MIN,
	PLUGIN_ID,
	SETTING_EDITOR_MODE,
	SETTING_HIDE_WHEN_EMPTY,
	SETTING_HOVER_OPEN_DELAY,
	SETTING_MAX_DEPTH,
	SETTING_SHOW_MINIMAP,
	SETTING_SIDE,
	SETTING_VIEWER_MODE,
	TOGGLE_HIDE_WHEN_EMPTY_COMMAND,
	TOGGLE_MINIMAP_COMMAND,
	TOGGLE_SIDE_COMMAND,
	VIEWER_CONTENT_SCRIPT_ID,
	type ContentScriptMessage,
	type PaneMode,
	type RidgelineSettings,
	type SettingsResponse,
	type Side,
} from './common';
import { parseHeadings } from './headings';
import { DESIGN_TOKENS } from './tokens';

const SETTINGS_SECTION = 'ridgeline.settings';

async function registerSettings(): Promise<void> {
	await joplin.settings.registerSection(SETTINGS_SECTION, {
		label: 'Ridgeline',
		iconName: 'fas fa-mountain',
		description: 'Ridgeline minimap outline (smoke build).',
	});

	await joplin.settings.registerSettings({
		[SETTING_SIDE]: {
			value: 'left',
			type: SettingItemType.String,
			isEnum: true,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Strip side',
			description: 'Which edge of the editor/viewer the strip sits on.',
			options: { left: 'Left', right: 'Right' },
			// File storage so the value persists AND can be seeded via a profile settings.json.
			storage: SettingStorage.File,
		},
		[SETTING_EDITOR_MODE]: {
			value: 'overlay',
			type: SettingItemType.String,
			isEnum: true,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Editor strip mode',
			description: 'overlay draws over the text; reserve adds a margin so text is not covered.',
			options: { overlay: 'Overlay', reserve: 'Reserve margin' },
			storage: SettingStorage.File,
		},
		[SETTING_VIEWER_MODE]: {
			value: 'overlay',
			type: SettingItemType.String,
			isEnum: true,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Viewer strip mode',
			description: 'overlay draws over the rendered note; reserve adds a margin so text is not covered.',
			options: { overlay: 'Overlay', reserve: 'Reserve margin' },
			storage: SettingStorage.File,
		},
		[SETTING_MAX_DEPTH]: {
			value: 6,
			type: SettingItemType.Int,
			isEnum: true,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Maximum heading depth',
			description: 'Deepest heading level shown in the minimap. Headings deeper than this are hidden.',
			options: { 1: 'H1 only', 2: 'H1–H2', 3: 'H1–H3', 4: 'H1–H4', 5: 'H1–H5', 6: 'H1–H6' },
			storage: SettingStorage.File,
		},
		[SETTING_SHOW_MINIMAP]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Show minimap',
			description:
				'Show the Ridgeline strip in the editor and viewer. Turn off to hide it everywhere without ' +
				'disabling the plugin (Tools → Ridgeline: Toggle minimap, or Ctrl+Alt+M). Applies live.',
			storage: SettingStorage.File,
		},
		[SETTING_HIDE_WHEN_EMPTY]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Hide minimap when the note has no headings',
			description:
				'On a note with no headings, hide the strip and drop its reserved margin entirely (in both ' +
				'the editor and viewer) so the text uses the full width. Turn off to keep the empty strip. ' +
				'Applies live.',
			storage: SettingStorage.File,
		},
		[SETTING_HOVER_OPEN_DELAY]: {
			value: DESIGN_TOKENS.hoverOpenDelayMs,
			type: SettingItemType.Int,
			minimum: HOVER_OPEN_DELAY_MIN,
			maximum: HOVER_OPEN_DELAY_MAX,
			step: 50,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Hover open delay (ms)',
			description:
				'How long the pointer must rest on the bars before the outline opens. Higher = a quick ' +
				'mouse trip across the strip never pops it open; lower = opens sooner. 100–1000ms.',
			storage: SettingStorage.File,
		},
	});
}

async function readSettings(): Promise<RidgelineSettings> {
	const values = await joplin.settings.values([
		SETTING_SIDE,
		SETTING_EDITOR_MODE,
		SETTING_VIEWER_MODE,
		SETTING_MAX_DEPTH,
		SETTING_SHOW_MINIMAP,
		SETTING_HIDE_WHEN_EMPTY,
	]);
	// Coerce defensively — a seeded/edited settings.json could carry an unexpected value.
	const side: Side = values[SETTING_SIDE] === 'right' ? 'right' : 'left';
	const editorMode: PaneMode = values[SETTING_EDITOR_MODE] === 'reserve' ? 'reserve' : 'overlay';
	const viewerMode: PaneMode = values[SETTING_VIEWER_MODE] === 'reserve' ? 'reserve' : 'overlay';
	let maxDepth = Number(values[SETTING_MAX_DEPTH]);
	if (!Number.isFinite(maxDepth)) maxDepth = 6;
	maxDepth = Math.min(6, Math.max(1, Math.round(maxDepth)));
	// Default true: only an explicit stored `false` hides the strip.
	const showMinimap = values[SETTING_SHOW_MINIMAP] !== false;
	// W3: default true; only an explicit stored `false` keeps the strip on a heading-less note.
	const hideWhenEmpty = values[SETTING_HIDE_WHEN_EMPTY] !== false;
	return { side, editorMode, viewerMode, maxDepth, showMinimap, hideWhenEmpty };
}

// The getSettings answer both content scripts read: resolved settings + the shared design tokens.
// The viewer strip (a plain-JS iframe asset that cannot import tokens.ts) gets its tokens from here.
// The user-tunable hover-open delay (Q2) is folded into the tokens so both surfaces read it from the
// same one place, alongside the compile-time design tokens.
async function readSettingsResponse(): Promise<SettingsResponse> {
	const settings = await readSettings();
	let delay = Number(await joplin.settings.value(SETTING_HOVER_OPEN_DELAY));
	if (!Number.isFinite(delay)) delay = DESIGN_TOKENS.hoverOpenDelayMs;
	delay = Math.min(HOVER_OPEN_DELAY_MAX, Math.max(HOVER_OPEN_DELAY_MIN, Math.round(delay)));
	return { ...settings, tokens: { ...DESIGN_TOKENS, hoverOpenDelayMs: delay } };
}

// Dual-fire the jump exactly like cqroot/joplin-outline: scrollToHash moves the rendered viewer to
// the heading's anchor; editor.execCommand → the CM content script's self-registered scroll command
// moves the raw Markdown editor to the heading's line. Both are fired so a split editor+viewer stays
// in agreement regardless of which pane the click came from.
async function resolveLineFromAnchor(anchor: string): Promise<number | null> {
	try {
		const note = await joplin.workspace.selectedNote();
		if (!note || typeof note.body !== 'string') return null;
		const match = parseHeadings(note.body).find((h) => h.slug === anchor);
		return match ? match.line : null;
	} catch (error) {
		console.warn('[ridgeline] could not resolve line from anchor', error);
		return null;
	}
}

async function handleJump(anchor: string, line: number | null): Promise<void> {
	if (typeof anchor === 'string' && anchor.length > 0) {
		try {
			await joplin.commands.execute('scrollToHash', anchor);
		} catch (error) {
			console.warn('[ridgeline] scrollToHash failed', error);
		}
	}

	// The viewer sends line=null; resolve it from the current note body by matching the anchor.
	let targetLine = line;
	if ((targetLine === null || !Number.isFinite(targetLine) || targetLine < 0) && anchor) {
		targetLine = await resolveLineFromAnchor(anchor);
	}

	if (targetLine !== null && Number.isFinite(targetLine) && targetLine >= 0) {
		try {
			await joplin.commands.execute('editor.execCommand', {
				name: EDITOR_SCROLL_COMMAND,
				args: [targetLine],
			});
		} catch (error) {
			console.warn('[ridgeline] editor scrollToLine failed', error);
		}
	}
}

async function onContentScriptMessage(rawMessage: ContentScriptMessage): Promise<unknown> {
	if (!rawMessage || typeof rawMessage !== 'object') return null;

	switch (rawMessage.type) {
		case 'getSettings':
			return readSettingsResponse();
		case 'jump':
			await handleJump(rawMessage.anchor, rawMessage.line);
			return { ok: true };
		default:
			return null;
	}
}

joplin.plugins.register({
	onStart: async () => {
		await registerSettings();

		// Editor front-end: a CodeMirror 6 plugin that mounts the strip into the editor DOM and
		// self-registers the scroll command the coordinator calls back into.
		await joplin.contentScripts.register(
			ContentScriptType.CodeMirrorPlugin,
			EDITOR_CONTENT_SCRIPT_ID,
			'./contentScripts/editorContentScript.js',
		);
		await joplin.contentScripts.onMessage(EDITOR_CONTENT_SCRIPT_ID, onContentScriptMessage);

		// Viewer front-end: a MarkdownIt plugin whose asset JS builds the strip inside the rendered
		// note iframe.
		await joplin.contentScripts.register(
			ContentScriptType.MarkdownItPlugin,
			VIEWER_CONTENT_SCRIPT_ID,
			'./contentScripts/viewerContentScript.js',
		);
		await joplin.contentScripts.onMessage(VIEWER_CONTENT_SCRIPT_ID, onContentScriptMessage);

		// Live settings (no relaunch). On any setting change, push the new values into the editor strip
		// via its self-registered command. The viewer strip has no main→iframe push channel, so it
		// polls getSettings itself and picks the change up on its own (see viewer.js).
		await joplin.settings.onChange(async () => {
			try {
				const response = await readSettingsResponse();
				await joplin.commands.execute('editor.execCommand', {
					name: EDITOR_APPLY_SETTINGS_COMMAND,
					args: [response],
				});
			} catch (error) {
				// editor.execCommand throws when no Markdown editor is focused; the strip re-reads
				// settings on its next mount anyway, so this is non-fatal.
				console.warn('[ridgeline] live settings push to editor failed', error);
			}
		});

		// A convenience command (menu item + accelerator) that flips the strip side. Handy for the
		// user and exercised by the live-settings E2E, since changing the setting triggers onChange
		// above and both surfaces update without a relaunch.
		await joplin.commands.register({
			name: TOGGLE_SIDE_COMMAND,
			label: 'Ridgeline: Toggle strip side (left/right)',
			execute: async () => {
				const current = await joplin.settings.value(SETTING_SIDE);
				await joplin.settings.setValue(SETTING_SIDE, current === 'right' ? 'left' : 'right');
			},
		});
		await joplin.views.menuItems.create(
			'ridgeline.toggleSide.menu',
			TOGGLE_SIDE_COMMAND,
			MenuItemLocation.Tools,
			{ accelerator: 'Ctrl+Alt+R' },
		);

		// Z2: master visibility toggle. Flips the boolean setting, which fires joplin.settings.onChange
		// above → both surfaces mount/unmount the strip live (editor pushed, viewer polled), in every
		// window. Reachable three ways, all flipping the same setting: Tools menu, Ctrl+Alt+M, and a
		// note-toolbar button (fa-stream, a stack of staggered lines that reads as the minimap).
		await joplin.commands.register({
			name: TOGGLE_MINIMAP_COMMAND,
			label: 'Ridgeline: Toggle minimap',
			iconName: 'fas fa-stream',
			execute: async () => {
				const current = await joplin.settings.value(SETTING_SHOW_MINIMAP);
				await joplin.settings.setValue(SETTING_SHOW_MINIMAP, current === false);
			},
		});
		await joplin.views.menuItems.create(
			'ridgeline.toggleMinimap.menu',
			TOGGLE_MINIMAP_COMMAND,
			MenuItemLocation.Tools,
			{ accelerator: 'Ctrl+Alt+M' },
		);
		// The same command as a note-toolbar button so the toggle is a single click away, not buried in
		// the Tools menu. Note toolbar = desktop-only, present whenever a note is open. The button's
		// hover title is the command label ("Ridgeline: Toggle minimap"); the E2E locates it by that.
		await joplin.views.toolbarButtons.create(
			'ridgeline.toggleMinimap.toolbar',
			TOGGLE_MINIMAP_COMMAND,
			ToolbarButtonLocation.NoteToolbar,
		);

		// W3: toggle the "hide when the note has no headings" setting live. Flipping it fires
		// joplin.settings.onChange above → the strip + reserve margin mount/unmount to match on a
		// heading-less note (editor pushed, viewer polled), in every window, with no relaunch.
		await joplin.commands.register({
			name: TOGGLE_HIDE_WHEN_EMPTY_COMMAND,
			label: 'Ridgeline: Toggle hide-when-empty',
			execute: async () => {
				const current = await joplin.settings.value(SETTING_HIDE_WHEN_EMPTY);
				await joplin.settings.setValue(SETTING_HIDE_WHEN_EMPTY, current === false);
			},
		});
		await joplin.views.menuItems.create(
			'ridgeline.toggleHideWhenEmpty.menu',
			TOGGLE_HIDE_WHEN_EMPTY_COMMAND,
			MenuItemLocation.Tools,
			{ accelerator: 'Ctrl+Alt+H' },
		);

		console.info(`[ridgeline] ${PLUGIN_ID} started`);
	},
});
