import joplin from 'api';
import { ContentScriptType, MenuItemLocation, SettingItemType, SettingStorage } from 'api/types';
import {
	EDITOR_APPLY_SETTINGS_COMMAND,
	EDITOR_CONTENT_SCRIPT_ID,
	EDITOR_SCROLL_COMMAND,
	PLUGIN_ID,
	SETTING_EDITOR_MODE,
	SETTING_MAX_DEPTH,
	SETTING_SIDE,
	SETTING_VIEWER_MODE,
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
	});
}

async function readSettings(): Promise<RidgelineSettings> {
	const values = await joplin.settings.values([
		SETTING_SIDE,
		SETTING_EDITOR_MODE,
		SETTING_VIEWER_MODE,
		SETTING_MAX_DEPTH,
	]);
	// Coerce defensively — a seeded/edited settings.json could carry an unexpected value.
	const side: Side = values[SETTING_SIDE] === 'right' ? 'right' : 'left';
	const editorMode: PaneMode = values[SETTING_EDITOR_MODE] === 'reserve' ? 'reserve' : 'overlay';
	const viewerMode: PaneMode = values[SETTING_VIEWER_MODE] === 'reserve' ? 'reserve' : 'overlay';
	let maxDepth = Number(values[SETTING_MAX_DEPTH]);
	if (!Number.isFinite(maxDepth)) maxDepth = 6;
	maxDepth = Math.min(6, Math.max(1, Math.round(maxDepth)));
	return { side, editorMode, viewerMode, maxDepth };
}

// The getSettings answer both content scripts read: resolved settings + the shared design tokens.
// The viewer strip (a plain-JS iframe asset that cannot import tokens.ts) gets its tokens from here.
async function readSettingsResponse(): Promise<SettingsResponse> {
	const settings = await readSettings();
	return { ...settings, tokens: DESIGN_TOKENS };
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

		console.info(`[ridgeline] ${PLUGIN_ID} started`);
	},
});
