import joplin from 'api';
import { ContentScriptType, SettingItemType, SettingStorage } from 'api/types';
import {
	EDITOR_CONTENT_SCRIPT_ID,
	EDITOR_SCROLL_COMMAND,
	PLUGIN_ID,
	SETTING_EDITOR_MODE,
	SETTING_SIDE,
	SETTING_VIEWER_MODE,
	VIEWER_CONTENT_SCRIPT_ID,
	type ContentScriptMessage,
	type PaneMode,
	type RidgelineSettings,
	type Side,
} from './common';
import { parseHeadings } from './headings';

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
	});
}

async function readSettings(): Promise<RidgelineSettings> {
	const values = await joplin.settings.values([
		SETTING_SIDE,
		SETTING_EDITOR_MODE,
		SETTING_VIEWER_MODE,
	]);
	// Coerce defensively — a seeded/edited settings.json could carry an unexpected value.
	const side: Side = values[SETTING_SIDE] === 'right' ? 'right' : 'left';
	const editorMode: PaneMode = values[SETTING_EDITOR_MODE] === 'reserve' ? 'reserve' : 'overlay';
	const viewerMode: PaneMode = values[SETTING_VIEWER_MODE] === 'reserve' ? 'reserve' : 'overlay';
	return { side, editorMode, viewerMode };
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
			return readSettings();
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

		console.info(`[ridgeline] ${PLUGIN_ID} started`);
	},
});
