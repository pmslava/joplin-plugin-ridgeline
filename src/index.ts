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
	OUTLINE_WIDTH_DEFAULT,
	OUTLINE_WIDTH_MAX,
	OUTLINE_WIDTH_MIN,
	PLUGIN_ID,
	SETTING_EDITOR_MODE,
	SETTING_HIDE_WHEN_EMPTY,
	SETTING_HOVER_OPEN_DELAY,
	SETTING_MAX_DEPTH,
	SETTING_OUTLINE_MAKE_ROOM,
	SETTING_OUTLINE_PINNED,
	SETTING_OUTLINE_TOOLBAR,
	SETTING_OUTLINE_WIDTH_PERCENT,
	SETTING_SHOW_MINIMAP,
	SETTING_SHOW_TOOLBAR_BUTTON,
	SETTING_SIDE,
	SETTING_VIEWER_MODE,
	TOGGLE_HIDE_WHEN_EMPTY_COMMAND,
	TOGGLE_MINIMAP_COMMAND,
	TOGGLE_PIN_COMMAND,
	TOGGLE_SIDE_COMMAND,
	VIEWER_CONTENT_SCRIPT_ID,
	type ContentScriptMessage,
	type PaneMode,
	type RidgelineSettings,
	type SetSettingsMessage,
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
		description: 'A hover-expanding minimap outline for the editor and viewer.',
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
		// The two MINIMAP margins. Relabelled (keys, values and option values unchanged) so they can no
		// longer be confused with the pinned outline's own, much wider margin — "Make room for the
		// pinned outline" below. This one only ever clears the compact bars. User-facing wording says
		// "minimap" throughout; the code keeps its older `strip` identifiers.
		[SETTING_EDITOR_MODE]: {
			value: 'overlay',
			type: SettingItemType.String,
			isEnum: true,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Editor minimap margin',
			description:
				'The thin margin for the minimap\'s bars in the Markdown editor. It applies to the bars ' +
				'only, never to the outline; a pinned outline gets its own, wider margin from "Make room ' +
				'for the pinned outline" below.',
			options: {
				overlay: 'None — the bars overlay the text',
				reserve: 'Thin margin — keep the text clear of the bars',
			},
			storage: SettingStorage.File,
		},
		[SETTING_VIEWER_MODE]: {
			value: 'overlay',
			type: SettingItemType.String,
			isEnum: true,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Viewer minimap margin',
			description:
				'The thin margin for the minimap\'s bars in the rendered viewer. It applies to the bars ' +
				'only, never to the outline; a pinned outline gets its own, wider margin from "Make room ' +
				'for the pinned outline" below.',
			options: {
				overlay: 'None — the bars overlay the text',
				reserve: 'Thin margin — keep the text clear of the bars',
			},
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
				'disabling the plugin (Tools → Ridgeline → Ridgeline: Toggle minimap, or Ctrl+Alt+M). ' +
				'Applies live.',
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
		[SETTING_SHOW_TOOLBAR_BUTTON]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Show the toolbar toggle button',
			// This is the ONE Ridgeline setting that is NOT live: it takes effect only after Joplin is
			// restarted, because the plugin API cannot remove a toolbar button at runtime (see the
			// conditional create in onStart). Say so plainly here so the user is not left waiting for a
			// change that will not appear until a relaunch.
			description:
				'Show the note-toolbar button (the fa-stream icon) that toggles the minimap. Takes effect ' +
				'only after restarting Joplin — unlike every other Ridgeline setting, this one is not live, ' +
				'because the plugin API cannot remove a toolbar button once it has been created. The ' +
				'Tools → Ridgeline menu entry and Ctrl+Alt+M keep working regardless.',
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
		// ── OUTLINE TOOLBAR (issue #2) ───────────────────────────────────
		//
		// Four settings, registered LAST so they read as one group under the older ones. Joplin's
		// settings API cannot gray a setting out while another is off, so each description says plainly
		// what it depends on — that sentence is the only "disabled" state the user gets.
		[SETTING_OUTLINE_TOOLBAR]: {
			value: false,
			type: SettingItemType.Bool,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Show the outline toolbar',
			description:
				'Adds a row of controls to the top of the outline (the table of contents that opens over ' +
				'the minimap): Width, Headings and Pin. Off by default, and then the outline behaves ' +
				'exactly as before. The three settings below depend on it and do nothing while it is off. ' +
				'Applies live.',
			storage: SettingStorage.File,
		},
		[SETTING_OUTLINE_WIDTH_PERCENT]: {
			value: OUTLINE_WIDTH_DEFAULT,
			type: SettingItemType.Int,
			minimum: OUTLINE_WIDTH_MIN,
			maximum: OUTLINE_WIDTH_MAX,
			step: 1,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Outline width (% of the pane)',
			description:
				'The outline\'s width as a share of the editor or viewer pane. A pinned outline is exactly ' +
				'this wide; the outline that opens on hover stays as narrow as its headings allow and uses ' +
				'this only as its limit, as it does today. The toolbar\'s Width control offers 25, 33 and ' +
				'50 and a field for any value from 10 to 90; this setting is the same value. The outline ' +
				'is never narrower than 140 px and never wider than nine tenths of the pane. Needs the ' +
				'outline toolbar. Applies live.',
			storage: SettingStorage.File,
		},
		[SETTING_OUTLINE_PINNED]: {
			value: false,
			type: SettingItemType.Bool,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Pin the outline open',
			description:
				'Keep the outline open at the full height of the pane instead of opening it on hover — in ' +
				'the editor and the viewer, in every window — until it is unpinned. The Pin button in the ' +
				'outline toolbar and Ctrl+Alt+P flip this same setting, so a pin survives a restart. Needs ' +
				'the outline toolbar. Applies live.',
			storage: SettingStorage.File,
		},
		[SETTING_OUTLINE_MAKE_ROOM]: {
			value: true,
			type: SettingItemType.Bool,
			public: true,
			section: SETTINGS_SECTION,
			label: 'Make room for the pinned outline',
			description:
				'While the outline is pinned, push the note text aside by the outline\'s width so the ' +
				'outline never covers a word. The outline keeps its border, so where the note ends and the ' +
				'outline begins stays visible. This is the outline\'s own, wide margin — separate from the ' +
				'thin minimap margins above, which only clear the bars. Off: the pinned outline overlays ' +
				'the text, as it does on hover. On a pane too narrow to leave at least 200 px of text ' +
				'beside the outline, no room is made and the outline overlays instead. Needs the outline ' +
				'toolbar and a pinned outline. Applies live.',
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
		SETTING_OUTLINE_TOOLBAR,
		SETTING_OUTLINE_WIDTH_PERCENT,
		SETTING_OUTLINE_PINNED,
		SETTING_OUTLINE_MAKE_ROOM,
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
	// Issue #2 — the outline toolbar group. The two booleans that default to FALSE are read as "only an
	// explicit stored `true` turns them on", the mirror of the two above that default to true; a seeded
	// settings.json carrying a string or a number therefore never silently enables the toolbar.
	const outlineToolbar = values[SETTING_OUTLINE_TOOLBAR] === true;
	const outlinePinned = values[SETTING_OUTLINE_PINNED] === true;
	const outlineMakeRoom = values[SETTING_OUTLINE_MAKE_ROOM] !== false;
	let outlineWidthPercent = Number(values[SETTING_OUTLINE_WIDTH_PERCENT]);
	if (!Number.isFinite(outlineWidthPercent)) outlineWidthPercent = OUTLINE_WIDTH_DEFAULT;
	outlineWidthPercent = Math.min(
		OUTLINE_WIDTH_MAX,
		Math.max(OUTLINE_WIDTH_MIN, Math.round(outlineWidthPercent)),
	);
	return {
		side,
		editorMode,
		viewerMode,
		maxDepth,
		showMinimap,
		hideWhenEmpty,
		outlineToolbar,
		outlineWidthPercent,
		outlinePinned,
		outlineMakeRoom,
	};
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
		// An image-only heading legitimately slugs to '' (Joplin renders <h1 id="">), so this find() can
		// look for an empty anchor — but it never does: handleJump below gates BOTH scrollToHash and
		// this resolution on a truthy anchor, so an empty anchor is simply un-jumpable and can never
		// mis-resolve onto the first empty-slug heading.
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

// A settings change made FROM a surface — the outline toolbar's Width / Headings / Pin controls.
//
// The ALLOWLIST is these three literal `in` checks and nothing else: a content script can only ever
// write outlinePinned, outlineWidthPercent and maxDepth, whatever else it puts in the payload, because
// no key from the message is ever used to address a setting. Each value is coerced here exactly as
// readSettings coerces the stored one, so a bad payload cannot store a value the surfaces would then
// have to defend against.
//
// The answer is a fresh SettingsResponse: the surface that sent the message applies it immediately, so
// the click feels instant, while every OTHER surface and window picks the change up through the
// existing onChange push / 700ms poll (setValue below fires onChange).
async function handleSetSettings(values: SetSettingsMessage['values']): Promise<SettingsResponse> {
	if (values && typeof values === 'object') {
		if ('outlinePinned' in values) {
			await joplin.settings.setValue(SETTING_OUTLINE_PINNED, values.outlinePinned === true);
		}
		if ('outlineWidthPercent' in values) {
			let percent = Number(values.outlineWidthPercent);
			if (!Number.isFinite(percent)) percent = OUTLINE_WIDTH_DEFAULT;
			percent = Math.min(OUTLINE_WIDTH_MAX, Math.max(OUTLINE_WIDTH_MIN, Math.round(percent)));
			await joplin.settings.setValue(SETTING_OUTLINE_WIDTH_PERCENT, percent);
		}
		if ('maxDepth' in values) {
			let depth = Number(values.maxDepth);
			if (!Number.isFinite(depth)) depth = 6;
			depth = Math.min(6, Math.max(1, Math.round(depth)));
			await joplin.settings.setValue(SETTING_MAX_DEPTH, depth);
		}
	}
	return readSettingsResponse();
}

async function onContentScriptMessage(rawMessage: ContentScriptMessage): Promise<unknown> {
	if (!rawMessage || typeof rawMessage !== 'object') return null;

	switch (rawMessage.type) {
		case 'getSettings':
			return readSettingsResponse();
		case 'jump':
			await handleJump(rawMessage.anchor, rawMessage.line);
			return { ok: true };
		case 'setSettings':
			return handleSetSettings(rawMessage.values);
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

		// A convenience command (Tools → Ridgeline submenu + accelerator) that flips the strip side.
		// Handy for the user and exercised by the live-settings E2E, since changing the setting triggers
		// onChange above and both surfaces update without a relaunch.
		await joplin.commands.register({
			name: TOGGLE_SIDE_COMMAND,
			label: 'Ridgeline: Toggle strip side (left/right)',
			execute: async () => {
				const current = await joplin.settings.value(SETTING_SIDE);
				await joplin.settings.setValue(SETTING_SIDE, current === 'right' ? 'left' : 'right');
			},
		});

		// Z2: master visibility toggle. Flips the boolean setting, which fires joplin.settings.onChange
		// above → both surfaces mount/unmount the strip live (editor pushed, viewer polled), in every
		// window. Reachable three ways, all flipping the same setting: the Tools → Ridgeline submenu,
		// Ctrl+Alt+M, and a note-toolbar button (fa-stream, a stack of staggered lines that reads as the
		// minimap).
		await joplin.commands.register({
			name: TOGGLE_MINIMAP_COMMAND,
			label: 'Ridgeline: Toggle minimap',
			iconName: 'fas fa-stream',
			execute: async () => {
				const current = await joplin.settings.value(SETTING_SHOW_MINIMAP);
				await joplin.settings.setValue(SETTING_SHOW_MINIMAP, current === false);
			},
		});
		// The same command as a note-toolbar button so the toggle is a single click away, not buried in
		// the Tools → Ridgeline submenu. Note toolbar = desktop-only, present whenever a note is open. The
		// button's hover title is the command label ("Ridgeline: Toggle minimap"); the E2E locates it by
		// that, so this label must not be shortened.
		//
		// Gated behind SETTING_SHOW_TOOLBAR_BUTTON, read once here at startup. This is the ONE Ridgeline
		// setting that is NOT live: JoplinViewsToolbarButtons exposes create() only (no remove/hide/
		// destroy — confirmed in api/JoplinViewsToolbarButtons.d.ts), so a button created here cannot be
		// torn down at runtime. A change to the setting therefore only takes effect on the next Joplin
		// restart. The Tools → Ridgeline submenu entry and Ctrl+Alt+M are registered unconditionally and
		// are unaffected either way.
		const showToolbarButton = (await joplin.settings.value(SETTING_SHOW_TOOLBAR_BUTTON)) !== false;
		if (showToolbarButton) {
			await joplin.views.toolbarButtons.create(
				'ridgeline.toggleMinimap.toolbar',
				TOGGLE_MINIMAP_COMMAND,
				ToolbarButtonLocation.NoteToolbar,
			);
		}

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
		// Issue #2: flip the outline pin live, from the keyboard (Ctrl+Alt+P) or the Tools → Ridgeline
		// submenu — the same setting the toolbar's Pin button writes, so a pin made either way survives a
		// restart and shows in every window.
		//
		// Pinning while the toolbar is OFF also turns the toolbar on: the pin lives IN the toolbar row, so
		// a pinned outline without one would be un-unpinnable by mouse (only this command could undo it).
		// Unpinning never touches the toolbar setting — the user may well want to keep the toolbar.
		await joplin.commands.register({
			name: TOGGLE_PIN_COMMAND,
			label: 'Ridgeline: Toggle outline pin',
			execute: async () => {
				const pinned = (await joplin.settings.value(SETTING_OUTLINE_PINNED)) === true;
				if (pinned) {
					await joplin.settings.setValue(SETTING_OUTLINE_PINNED, false);
					return;
				}
				await joplin.settings.setValue(SETTING_OUTLINE_PINNED, true);
				const toolbar = (await joplin.settings.value(SETTING_OUTLINE_TOOLBAR)) === true;
				if (!toolbar) await joplin.settings.setValue(SETTING_OUTLINE_TOOLBAR, true);
			},
		});

		// One "Ridgeline" submenu under Tools holding all four toggles, instead of four top-level Tools
		// items. Created here, after the last commands.register, because the leaves are resolved through
		// CommandService when the menu bar builds, so all four commands are registered first.
		//
		// The entries render with their FULL command labels ("Ridgeline: Toggle minimap", …), so the menu
		// reads Tools → Ridgeline → Ridgeline: Toggle minimap. A per-item `label` cannot shorten them,
		// despite what MenuItem.label in api/types.ts suggests ("if not specified, the command label will
		// be used instead"): that doc holds for MenuItem as other APIs consume it, not for the leaves of
		// views.menus.create. In Joplin 3.7.6 (the build the e2e pins) MenuBar's createPluginMenuTree
		// reads menuItem.label ONLY on items that themselves carry a `submenu`, and sends every leaf
		// through MenuUtils.commandToMenuItem(commandName, onClick), which hard-codes
		// `label: this.service.label(commandName)` — the registered command label. A `label` here would be
		// silently discarded, so none is passed.
		//
		// `accelerator` IS honoured: JoplinViewsMenus.create walks these items and feeds each one to
		// KeymapService.registerCommandAccelerator(commandName, accelerator), which commandToMenuItem then
		// reads back. The shortcuts below are live, and the grouping under one parent is the real win.
		await joplin.views.menus.create(
			'ridgeline.menu',
			'Ridgeline',
			[
				{ commandName: TOGGLE_SIDE_COMMAND, accelerator: 'Ctrl+Alt+R' },
				{ commandName: TOGGLE_MINIMAP_COMMAND, accelerator: 'Ctrl+Alt+M' },
				{ commandName: TOGGLE_HIDE_WHEN_EMPTY_COMMAND, accelerator: 'Ctrl+Alt+H' },
				{ commandName: TOGGLE_PIN_COMMAND, accelerator: 'Ctrl+Alt+P' },
			],
			MenuItemLocation.Tools,
		);

		console.info(`[ridgeline] ${PLUGIN_ID} started`);
	},
});
