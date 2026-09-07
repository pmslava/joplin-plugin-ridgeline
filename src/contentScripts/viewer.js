// Ridgeline viewer strip — asset JS, runs inside the rendered note iframe with full DOM access.
//
// Draws the same compact minimap as the editor: one thin horizontal bar per heading (length encodes
// heading level), the current section's bar bold + white/foreground, expanding into a full hover
// TOC. Jumps on click through the coordinator round-trip.
//
// Plain JavaScript (no build step for this file): it is copied verbatim into the plugin and cannot
// import the TypeScript shared modules, so the content-script id and message shapes are inlined.
// Crucially the DESIGN TOKENS are NOT duplicated here — they are shipped by the coordinator inside
// the getSettings response (settings.tokens), so tuning stays a one-file change in src/tokens.ts.
// The FALLBACK_TOKENS below are only used if that round-trip fails.
//
// Exactly ONE rule is duplicated from the TypeScript side: the whitespace normaliser
// `.replace(/\s+/g, ' ').trim()` (see headingDisplayText below), which must stay byte-identical to
// `collapse()` in src/inlineText.ts or the two strips would label the same heading differently. It is
// pinned by `npm run test:headings` (VIEWER DRIFT GUARD), which reads this file as text, and
// behaviourally by e2e/heading-links.spec.ts's editor↔viewer row-array equality.
//
// The strip is a NAVIGATION tool: it belongs in the live rendered viewer, and nowhere else. Joplin
// ships this asset well beyond that one document — Export → PDF, File → Print and Export → HTML each
// render the note into a STANDALONE page carrying these same asset tags, and the Rich Text (TinyMCE)
// editor injects them into its own EDITABLE iframe, where a strip would be serialised back into the
// user's note. So the file guards itself on every build path: see stripAllowedHere() below, which
// combines hostAvailable() (issue #3) with insideEditorDocument(), plus the `@media print` rule in
// viewer.css.

(function () {
	'use strict';

	var VIEWER_CONTENT_SCRIPT_ID = 'io.github.pmslava.ridgeline.viewerStrip';
	var STRIP_ID = 'ridgeline-viewer-strip';
	var TOP_EDGE_TOLERANCE_PX = 4;

	// Fallback only — the real tokens arrive from the coordinator (settings.tokens). Kept in sync with
	// src/tokens.ts so a failed round-trip still looks right.
	var FALLBACK_TOKENS = {
		levelLengths: { 1: 20, 2: 17, 3: 14, 4: 11, 5: 8, 6: 6 },
		barHeight: 3,
		currentBarHeight: 5,
		barGap: 4,
		minBarGap: 1,
		normalOpacity: 0.45,
		barSideAirPx: 12,
		edgeGapPx: 2,
		stripTopOffsetPx: 6,
		panelFontPx: 12.5,
		panelIndentPx: 12,
		panelPaddingPx: 8,
		panelRowPaddingPx: 3,
		panelGapPx: 0,
		hoverGraceMs: 200,
		hoverOpenDelayMs: 300,
		pollMs: 700,
		outlineMinWidthPx: 140,
		outlineMaxWidthFraction: 0.9,
		outlineMinTextPx: 200,
		outlineRoomGapPx: 6,
	};

	// Issue #2 (outline toolbar): the width percent's bounds/default and the toolbar's presets, mirrored
	// from src/common.ts — keep the literals in sync.
	var OUTLINE_WIDTH_MIN = 10;
	var OUTLINE_WIDTH_MAX = 90;
	var OUTLINE_WIDTH_DEFAULT = 33;
	var OUTLINE_WIDTH_PRESETS = [25, 33, 50];

	var settings = {
		side: 'left',
		viewerMode: 'overlay',
		maxDepth: 6,
		showMinimap: true,
		hideWhenEmpty: true,
		// Issue #2 — the outline toolbar group. Off by default; with outlineToolbar false every path
		// below behaves exactly as it did before the toolbar existed (the regression contract).
		outlineToolbar: false,
		outlineWidthPercent: OUTLINE_WIDTH_DEFAULT,
		outlinePinned: false,
		outlineMakeRoom: true,
	};
	var tokens = FALLBACK_TOKENS;
	var currentSig = null;
	var buildTimer = null;
	var pollTimer = null;
	var strip = null; // { el, scrollHandler, enter, leave, keydown }
	// The last pointer position seen inside this iframe, and null once the pointer has left it (see
	// departZone). Module-level ON PURPOSE: this strip is rebuilt from scratch on every settings change
	// and every note render, and both readers of this value have to see across such a rebuild — the
	// carry-open decision below, and releaseHold() deciding whether the outline is still under the
	// pointer once a width field is finished with.
	var lastPointer = null;
	// Set by sendSettings immediately before the rebuild its own answer triggers, and consumed by the
	// very next build(). It is what tells "this rebuild is the answer to a click on THIS viewer's
	// toolbar" apart from every other rebuild (a poll tick, a note render), which is the only case the
	// carry-open below may act on — see pointerHoldsOutlineOpen.
	var carryOpenOnNextBuild = false;
	// The toolbar row's last measured single-line width — the outline's floor whenever a toolbar is
	// drawn. Everything measures 0 while the panel is display:none, so the last good value is kept, and
	// module-level because the strip is rebuilt from scratch on every settings change.
	var toolbarRowWidth = 0;

	function tokenLength(level) {
		var lengths = tokens.levelLengths || FALLBACK_TOKENS.levelLengths;
		if (lengths[level] != null) return lengths[level];
		var deepest = 1;
		for (var k in lengths) if (lengths.hasOwnProperty(k)) deepest = Math.max(deepest, Number(k));
		return lengths[deepest];
	}

	function stripWidth() {
		var lengths = tokens.levelLengths || FALLBACK_TOKENS.levelLengths;
		var max = 0;
		for (var k in lengths) if (lengths.hasOwnProperty(k)) max = Math.max(max, lengths[k]);
		return max;
	}

	// Total strip width = longest bar + horizontal air on each side (P2). Used for the container width
	// and the reserve margin so the bars float with air on both sides.
	function barSideAir() {
		var v = tokens.barSideAirPx;
		return typeof v === 'number' ? v : FALLBACK_TOKENS.barSideAirPx;
	}
	function stripTotalWidth() {
		return stripWidth() + 2 * barSideAir();
	}

	function parseColor(value) {
		var m = String(value).match(/rgba?\(([^)]+)\)/);
		if (!m) return null;
		var parts = m[1].split(',').map(function (p) { return parseFloat(p); });
		if (parts.length < 3) return null;
		if (parts.length >= 4 && parts[3] === 0) return null;
		return { r: parts[0], g: parts[1], b: parts[2] };
	}

	function luminance(c) {
		return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
	}

	function rgba(c, a) {
		return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + a + ')';
	}

	function rgb(c) {
		return 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')';
	}

	function resolveBackground() {
		var el = document.body;
		for (var hops = 0; el && hops < 12; hops++, el = el.parentElement) {
			var parsed = parseColor(getComputedStyle(el).backgroundColor);
			if (parsed) return parsed;
		}
		return { r: 255, g: 255, b: 255 };
	}

	function computeColors() {
		var fg = parseColor(getComputedStyle(document.body).color) || { r: 120, g: 120, b: 120 };
		var bg = resolveBackground();
		var isDark = luminance(bg) < 0.5;
		return {
			isDark: isDark,
			normalBar: rgba(fg, tokens.normalOpacity),
			currentBar: isDark ? '#ffffff' : rgb(fg),
			panelBg: rgb(bg),
			panelFg: rgba(fg, 0.75),
			panelBorder: rgba(fg, 0.18),
			rowHover: rgba(fg, isDark ? 0.16 : 0.1),
		};
	}

	// A token that a stale/failed round-trip may not carry, with the fallback value.
	function token(name) {
		var v = tokens[name];
		return typeof v === 'number' ? v : FALLBACK_TOKENS[name];
	}

	function paneWidth() {
		var el = document.scrollingElement || document.documentElement;
		return el ? (el.clientWidth || 0) : 0;
	}

	// ── Issue #2: THE ONE RESOLVER, mirrored from src/common.ts + src/tokens.ts ──
	//
	// toolbarOn = showMinimap && outlineToolbar; pinned = showMinimap && outlinePinned;
	// makeRoom  = pinned && outlineMakeRoom. The three OUTLINE settings are INDEPENDENT of the toolbar,
	// which is only a convenient place to change them: pin, width and make-room all work from the
	// Settings screen (and Ctrl+Alt+P) with the toolbar off, and a pinned outline with no toolbar simply
	// shows its rows. Only the master showMinimap switch still hides everything, pinned or not.
	function toolbarOn() {
		return settings.showMinimap && settings.outlineToolbar;
	}

	function isPinned() {
		return settings.showMinimap && settings.outlinePinned;
	}

	function makeRoomOn() {
		return isPinned() && settings.outlineMakeRoom;
	}

	// The outline's MAXIMUM width in px for the current pane: a percent of it, floored at
	// outlineMinWidthPx and capped at nine tenths of the pane — except on a pane narrower than the floor,
	// which cannot honour it and simply gets the whole pane (a very narrow pane must not look
	// surprising). The outline itself is content-fit within this; this is the ceiling, not the width.
	function outlineCapPx() {
		var pane = Math.round(paneWidth());
		var min = token('outlineMinWidthPx');
		if (!isFinite(pane) || pane <= 0) return min;
		if (pane < min) return pane;
		var wanted = Math.round((pane * settings.outlineWidthPercent) / 100);
		var cap = Math.floor(pane * token('outlineMaxWidthFraction'));
		return Math.max(min, Math.min(wanted, cap));
	}

	// The outline as it ACTUALLY renders, in px — what the room is reserved from (never the cap, or a
	// narrow outline would sit in a wide empty gutter). 0 while nothing is laid out.
	function measuredOutlineWidthPx() {
		var stripEl = document.getElementById(STRIP_ID);
		var panelEl = stripEl ? stripEl.querySelector('.ridgeline-panel') : null;
		if (!panelEl) return 0;
		var rect = panelEl.getBoundingClientRect();
		return rect && rect.width > 0 ? Math.ceil(rect.width) : 0;
	}

	// The outline ROOM: the width the outline actually renders at, plus the strip's edge inset and a
	// little air, so the text stops short of the outline's border. 0 = no room — the pane is too narrow
	// to leave a usable text column beside the outline, so the legacy minimap margin governs and the
	// outline overlays instead.
	function outlineRoomPx() {
		var pane = Math.round(paneWidth());
		var width = measuredOutlineWidthPx();
		if (!isFinite(pane) || pane <= 0 || width <= 0) return 0;
		var room = width + token('edgeGapPx') + token('outlineRoomGapPx');
		if (pane - room < token('outlineMinTextPx')) return 0;
		return room;
	}

	// Issue #2: the heading-depth label the toolbar shows (mirrored from editorContentScript.ts).
	// NUMBERS ONLY — the button's icon already draws an H. The full wording is in its tooltip.
	function depthRangeLabel(depth) {
		return depth <= 1 ? '1' : '1–' + depth;
	}

	function depthTitle(depth) {
		return depth <= 1 ? 'Headings shown: H1' : 'Headings shown: H1–H' + depth;
	}

	// Issue #2 — the toolbar's fixed geometry, mirrored from editorContentScript.ts: one button height
	// for all three (the Pin a square of it), a row that never wraps, and the two numbers the row's
	// single-line width is summed from.
	var TOOLBAR_BUTTON_PX = 22;
	var TOOLBAR_PADDING_X_PX = 6;
	var TOOLBAR_GAP_PX = 6;

	// Issue #2 — the toolbar's icons, from Lucide (https://lucide.dev, ISC licence): `move-horizontal`
	// for Width, `heading` for Headings, `pin` for Pin. Path data copied verbatim and drawn on Lucide's
	// own canvas (24×24 viewBox, no fill, currentColor stroke, width 2, round caps and joins) at a 14px
	// box. The same three strings are in editorContentScript.ts — keep them in sync.
	var ICON_WIDTH = ['m18 8 4 4-4 4', 'M2 12h20', 'm6 8-4 4 4 4'];
	var ICON_HEADINGS = ['M6 12h12', 'M6 20V4', 'M18 20V4'];
	var ICON_PIN = [
		'M12 17v5',
		'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
	];

	// An inline SVG icon at an exact 14×14 box. NOT Font Awesome: Joplin's icon font is chrome and is
	// not guaranteed inside this iframe, so the toolbar draws its own. `filled` is the PRESSED pin.
	function svgIcon(paths, filled) {
		var NS = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('fill', filled ? 'currentColor' : 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		svg.setAttribute('aria-hidden', 'true');
		svg.style.flex = '0 0 auto';
		svg.style.width = '14px';
		svg.style.height = '14px';
		svg.style.verticalAlign = 'middle';
		for (var i = 0; i < paths.length; i++) {
			var path = document.createElementNS(NS, 'path');
			path.setAttribute('d', paths[i]);
			svg.appendChild(path);
		}
		return svg;
	}

	// A toolbar/popover button: a real <button> (tabbable), transparent, 1px panelBorder, 3px radius,
	// panelFg, pointer cursor, rowHover on hover; `pressed` also colours it with the current-bar colour.
	function toolbarButton(colors, className, testId, title, pressed) {
		var button = document.createElement('button');
		button.type = 'button';
		button.className = className;
		button.setAttribute('data-testid', testId);
		button.title = title;
		if (pressed !== undefined) button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
		var b = button.style;
		// One explicit height for every button, borders included, so Width, Headings and Pin line up
		// exactly; the Pin (icon only) is a square of that height, set by its caller.
		b.boxSizing = 'border-box';
		b.height = TOOLBAR_BUTTON_PX + 'px';
		b.display = 'inline-flex';
		b.alignItems = 'center';
		b.justifyContent = 'center';
		b.gap = '4px';
		b.padding = '0 6px';
		b.fontFamily = 'inherit';
		b.fontSize = tokens.panelFontPx + 'px';
		b.lineHeight = '1';
		b.background = pressed ? colors.rowHover : 'transparent';
		b.border = '1px solid ' + colors.panelBorder;
		b.borderRadius = '3px';
		b.color = pressed ? colors.currentBar : colors.panelFg;
		b.cursor = 'pointer';
		b.whiteSpace = 'nowrap';
		button.addEventListener('mouseenter', function () { button.style.background = colors.rowHover; });
		button.addEventListener('mouseleave', function () {
			button.style.background = pressed ? colors.rowHover : 'transparent';
		});
		return button;
	}

	function verticalScrollbarWidth() {
		var el = document.scrollingElement || document.documentElement;
		if (!el) return 0;
		var w = (el.offsetWidth || 0) - (el.clientWidth || 0);
		return w > 0 ? w : 0;
	}

	/**
	 * The text this heading's bar and TOC row should show — what a READER sees.
	 *
	 * DO NOT PORT THE EDITOR'S MARKDOWN SCANNER (src/inlineText.ts) INTO THIS FILE. The next
	 * contributor will be tempted to "unify" the two surfaces; it would be actively wrong. This side's
	 * input is POST-render text, where the syntax has already been consumed, so a Markdown stripper
	 * would eat literal characters the renderer deliberately shows. Two measured counter-examples:
	 * `` # Use `[x](y)` now `` renders as the literal text "Use [x](y) now", and `# [ ] Not a task`
	 * as "[ ] Not a task". The two surfaces agree because they resolve the SAME source by opposite
	 * means, not because they share code.
	 *
	 * Three rules, each of which exists to match the editor exactly:
	 *   V1 — normalise whitespace. Joplin's textContent preserves link-label padding and a heading's
	 *        inner double spaces (`##  Spaced  heading  ##` → "Spaced  heading"); the editor collapses,
	 *        so without this the current-heading comparison differs on real notes.
	 *   V2 — walk with a skip-list instead of reading textContent wholesale. On `.joplin-editable`
	 *        take only the hidden `.joplin-source` text and skip the rendered `.katex` subtree; skip
	 *        `sup.footnote-ref` entirely. These are the only two constructs where raw textContent is
	 *        genuinely wrong — measured: "Solve x^2x2x^2x2 now" and "Claim[1] here". They mirror the
	 *        editor's math and footnote rules.
	 *   V3 — fall back to an `<img>` alt when the walk yields "", then to "". There is deliberately NO
	 *        `|| h.id` fallback any more: for a second image-only heading Joplin's id is the literal
	 *        "-2", so that fallback drew a bar labelled "-2".
	 *
	 * Never throws: a bad DOM degrades to the plain textContent rather than killing the build pass.
	 */
	function headingDisplayText(h) {
		try {
			var out = '';
			(function walk(node) {
				for (var i = 0; i < node.childNodes.length; i++) {
					var child = node.childNodes[i];
					if (child.nodeType === 3) { out += child.nodeValue; continue; }
					if (child.nodeType !== 1) continue;
					var cls = child.classList;
					// KaTeX: the hidden source, the MathML <annotation> and the visual .katex-html all
					// concatenate into textContent. Take the source once, skip the rendering.
					if (cls && cls.contains('joplin-editable')) {
						var src = child.querySelector('.joplin-source');
						if (src) { out += src.textContent || ''; continue; }
					}
					if (cls && cls.contains('katex')) continue;
					if (cls && cls.contains('footnote-ref')) continue;
					walk(child);
				}
			})(h);
			out = out.replace(/\s+/g, ' ').trim();
			if (out) return out;
			var img = h.querySelector('img');
			var alt = img ? (img.getAttribute('alt') || '') : '';
			return alt.replace(/\s+/g, ' ').trim();
		} catch (e) {
			return (h.textContent || '').replace(/\s+/g, ' ').trim();
		}
	}

	function headingElements() {
		var nodes = document.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
		var out = [];
		for (var i = 0; i < nodes.length; i++) {
			var level = Number(nodes[i].tagName.substring(1));
			if (level <= settings.maxDepth) out.push(nodes[i]);
		}
		return out;
	}

	// ── EXPORT / PRINT GUARD (issue #3) ──────────────────────────────────────
	//
	// DO NOT REMOVE. Ridgeline is a MarkdownIt content script, and Joplin copies a content script's
	// assets into far more pages than the live note viewer:
	//
	//   • Export → PDF and File → Print both go through InteropServiceHelper.exportNoteTo_(): the note
	//     is exported with InteropService_Exporter_Html to a temp .html file, with every plugin asset
	//     copied to pluginAssets/<contentScriptId>/ and injected as <link>/<script> tags. That file is
	//     loaded into a hidden BrowserWindow and printToPDF()/print() is called on it.
	//   • Export → HTML (file or directory) writes exactly the same standalone page, openable in any
	//     browser — where this script would otherwise run and draw a strip over the document.
	//
	// So this script does run there, and without a guard it builds the strip into the printed page:
	// issue #3, "Outline shows up in exported PDF of note". An outline is navigation; a PDF is a
	// document.
	//
	// The discriminator for THIS guard is the HOST BRIDGE. `webviewApi` is declared by the note
	// viewer's own index.html, as a top-level `const` in an inline <script> that runs before any
	// plugin asset is added (so it is always there when we boot — there is no race to wait out). The
	// exporter's standalone page has no such script, so no bridge means: this page is a DOCUMENT, not
	// a live surface. Build nothing, mount nothing, poll nothing.
	//
	// A bridge is NOT by itself proof that we are in the live viewer, though — Joplin's Rich Text
	// editor defines one too (see the RICH TEXT EDITOR GUARD below), so the two documents that carry
	// a bridge are told apart by a second, independent predicate. Nor is HOW the bridge is defined a
	// usable discriminator: the viewer's is a scope-local `const` and TinyMCE's is a window property,
	// but a plain `window.webviewApi` must keep building a strip (e2e/export-print.spec.ts's positive
	// control defines exactly that, on purpose).
	//
	// Both predicates are deliberately FUNCTIONS consulted on the build path
	// (build/scheduleBuild/startPolling) rather than one check at load time, so every later rebuild —
	// a poll tick, a joplin-noteDidUpdate — honours them too. viewer.css carries an independent
	// `@media print` rule as belt-and-braces.
	function hostAvailable() {
		return typeof webviewApi !== 'undefined' && !!webviewApi && typeof webviewApi.postMessage === 'function';
	}

	// ── RICH TEXT EDITOR GUARD (TinyMCE) ─────────────────────────────────────
	//
	// DO NOT REMOVE. Joplin's Rich Text editor runs this very file. TinyMCE's loadDocumentAssets()
	// appends every MarkdownIt content-script asset into the EDITOR IFRAME's head — <link> for our
	// css, <script class="jop-tinymce-js"> for this script — after rendering the note and setting it
	// as the editor's content, and its useWebViewApi() hook defines `webviewApi.postMessage` on that
	// iframe's window. So hostAvailable() is TRUE there, the content keeps the renderer's heading ids,
	// and every precondition this script builds on is satisfied.
	//
	// But that document is EDITABLE, and anything in it is note content. Probed against Joplin 3.7.x
	// on 2026-09-06: the strip WAS built into the contentEditable body (44×671 at 0,0),
	// `tinymce.activeEditor.getContent()` carried its markup, and after a single typed word Joplin's
	// HTML→Markdown save had written the outline's own row titles into the note — the first heading
	// then appeared TWICE in the Markdown editor. Ridgeline targets the Markdown editor (its
	// CodeMirror content script) and the rendered viewer; the Rich Text editor has never been a
	// target and must be left untouched.
	//
	// Two reasons, either sufficient:
	//   (a) the document is EDITABLE — the generic, future-proof one. A navigation strip must never
	//       live inside content the host serialises back into the user's note, whatever built it.
	//   (b) the body carries TinyMCE's root marker class `mce-content-body`, which TinyMCE sets in
	//       every version. This is what covers TinyMCE's READ-ONLY mode (Joplin calls
	//       editor.mode.set('readonly') for read-only notes): the body is then NOT contentEditable,
	//       yet the document is still the Rich Text editor and Joplin still injects our assets into it.
	// Joplin's own `jop-tinymce` body class and `jop-tinymce-js` script class corroborate the
	// diagnosis but are NOT the check — they are Joplin's private naming, not TinyMCE's contract.
	// `window.frameElement` is not used either: reading it can throw across origins.
	function insideEditorDocument() {
		var body = document.body;
		if (!body) return false;
		if (body.isContentEditable) return true;
		if (document.designMode === 'on') return true;
		return !!(body.classList && body.classList.contains('mce-content-body'));
	}

	// The one question every build path asks: may a strip exist in THIS document at all?
	function stripAllowedHere() {
		return hostAvailable() && !insideEditorDocument();
	}

	// Fold a coordinator answer (getSettings OR setSettings — both return the same SettingsResponse)
	// into the local settings + tokens, defensively, exactly as the editor's coerceSettings does.
	function applySettingsResult(result) {
		if (!result || typeof result !== 'object') return;
		settings.side = result.side === 'right' ? 'right' : 'left';
		settings.viewerMode = result.viewerMode === 'reserve' ? 'reserve' : 'overlay';
		var d = Number(result.maxDepth);
		settings.maxDepth = isFinite(d) ? Math.min(6, Math.max(1, Math.round(d))) : 6;
		// Z2: default true; only an explicit `false` hides the strip.
		settings.showMinimap = result.showMinimap !== false;
		// W3: default true; only an explicit `false` keeps the strip on a heading-less note.
		settings.hideWhenEmpty = result.hideWhenEmpty !== false;
		// Issue #2: the two booleans that default to FALSE take only an explicit `true` — the mirror of
		// the two above — so a malformed answer never switches the toolbar on behind the user's back.
		settings.outlineToolbar = result.outlineToolbar === true;
		settings.outlinePinned = result.outlinePinned === true;
		settings.outlineMakeRoom = result.outlineMakeRoom !== false;
		var w = Number(result.outlineWidthPercent);
		settings.outlineWidthPercent = isFinite(w)
			? Math.min(OUTLINE_WIDTH_MAX, Math.max(OUTLINE_WIDTH_MIN, Math.round(w)))
			: OUTLINE_WIDTH_DEFAULT;
		if (result.tokens) tokens = result.tokens;
	}

	function fetchSettings() {
		if (!hostAvailable()) {
			return Promise.resolve();
		}
		return webviewApi.postMessage(VIEWER_CONTENT_SCRIPT_ID, { type: 'getSettings' })
			.then(function (result) { applySettingsResult(result); })
			.catch(function () { /* keep current settings */ });
	}

	// Issue #2: a toolbar control writing its value back through the coordinator, which allowlists and
	// clamps it, stores it (firing the onChange push to the editor) and answers with the fresh settings.
	// Applying that answer and rebuilding at once makes the click feel instant, instead of waiting up to
	// a poll interval for our own change to come back around.
	function sendSettings(values) {
		if (!hostAvailable()) return;
		webviewApi.postMessage(VIEWER_CONTENT_SCRIPT_ID, { type: 'setSettings', values: values })
			.then(function (result) {
				if (!result || typeof result !== 'object') return;
				applySettingsResult(result);
				// This rebuild is OUR click's own consequence: the pointer is on the toolbar we are about to
				// throw away, so the outline may be carried open across it (and only across it).
				carryOpenOnNextBuild = true;
				rebuild();
			})
			.catch(function () { /* the poll will pick the change up */ });
	}

	function settingsSignature() {
		return JSON.stringify({
			s: settings.side,
			m: settings.viewerMode,
			d: settings.maxDepth,
			v: settings.showMinimap,
			e: settings.hideWhenEmpty,
			b: settings.outlineToolbar,
			w: settings.outlineWidthPercent,
			p: settings.outlinePinned,
			r: settings.outlineMakeRoom,
			t: tokens,
		});
	}

	// The viewer's body margin: the OUTLINE ROOM when one is being made, else the legacy thin minimap
	// margin, else nothing. The room supersedes the thin margin rather than adding to it — the pinned
	// outline covers the bars anyway, so reserving for both would double-count. outlineRoomPx() already
	// returns 0 on a pane too narrow to leave a usable text column, and then the outline overlays, which
	// is exactly what it does on hover today.
	// The one place a body margin of ours is written or withdrawn. `px` of 0 clears it.
	//
	// It also STAMPS the body with data-ridgeline-margin while we own that margin, and removes the
	// attribute when we give it back. That stamp is what viewer.css's @media print rule keys on: the
	// print rule hides the strip, but the gutter reserved for it would otherwise print as a blank band
	// down the page — 46px for the thin minimap margin, and up to nine tenths of the pane for a pinned
	// outline's room. Keyed on the attribute, the rule can only ever undo a margin WE set, never a
	// margin the note's own stylesheet or the user's userstyle put there.
	function setBodyMargin(side, px) {
		document.body.style.marginLeft = '';
		document.body.style.marginRight = '';
		if (!px) {
			document.body.removeAttribute('data-ridgeline-margin');
			return;
		}
		if (side === 'right') {
			document.body.style.marginRight = px + 'px';
			document.body.setAttribute('data-ridgeline-margin', 'right');
		} else {
			document.body.style.marginLeft = px + 'px';
			document.body.setAttribute('data-ridgeline-margin', 'left');
		}
	}

	function applyReserveMargin() {
		var room = makeRoomOn() ? outlineRoomPx() : 0;
		if (room > 0) {
			setBodyMargin(settings.side, room);
			return;
		}
		if (settings.viewerMode !== 'reserve') {
			setBodyMargin(settings.side, 0);
			return;
		}
		setBodyMargin(settings.side, stripTotalWidth() + tokens.edgeGapPx);
	}

	function pointInRect(x, y, rect, pad) {
		if (pad == null) pad = 2;
		return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
	}

	function computeActiveIndex(headings) {
		if (!headings.length) return -1;
		var active = 0;
		for (var i = 0; i < headings.length; i++) {
			var top = headings[i].getBoundingClientRect().top;
			if (top <= TOP_EDGE_TOLERANCE_PX) active = i;
			else break;
		}
		return active;
	}

	function currentGap(count) {
		if (count <= 1) return tokens.barGap;
		var avail = (document.scrollingElement || document.documentElement).clientHeight || 0;
		if (avail <= 0) return tokens.barGap;
		var barsHeight = count * tokens.currentBarHeight;
		var fitGap = Math.floor((avail - barsHeight) / (count - 1));
		return Math.max(tokens.minBarGap, Math.min(tokens.barGap, fitGap));
	}

	function teardown() {
		if (!strip) return;
		if (strip.scrollHandler) window.removeEventListener('scroll', strip.scrollHandler, true);
		// Issue #2: the outline's width is a percent of the pane, so it listens for pane resizes.
		if (strip.resize) window.removeEventListener('resize', strip.resize);
		if (strip.pointermove) document.removeEventListener('mousemove', strip.pointermove);
		if (strip.docleave) document.removeEventListener('mouseleave', strip.docleave);
		if (strip.pointerout) document.removeEventListener('mouseout', strip.pointerout);
		if (strip.winblur) window.removeEventListener('blur', strip.winblur);
		if (strip.visibility) document.removeEventListener('visibilitychange', strip.visibility);
		if (strip.keydown) window.removeEventListener('keydown', strip.keydown);
		if (strip.collapseTimer) clearTimeout(strip.collapseTimer);
		if (strip.openTimer) clearTimeout(strip.openTimer);
		if (strip.el && strip.el.parentNode) strip.el.parentNode.removeChild(strip.el);
		strip = null;
	}

	// Was the outline the PREVIOUS strip showed open, with the pointer resting on it? Read off the DOM
	// (rather than bookkept) so it needs nothing from the closure that is about to be thrown away, and
	// necessarily BEFORE build() removes that element.
	//
	// This gives the viewer the editor's behaviour: there, the container is re-styled in place, so an
	// outline the pointer is holding open survives a settings change — clicking the toolbar's own Pin
	// button (or any other control) never yanks the panel out from under the pointer. Here the whole
	// strip is rebuilt, so without this the outline would simply vanish mid-interaction, and with the
	// minimap on the right the Pin button sits far from the bars, so nothing would reopen it. Pinned is
	// excluded: `pinned` decides that case on its own.
	//
	// It is deliberately narrow: the caller ALSO requires `carryOpenOnNextBuild`, so only a rebuild this
	// viewer's own setSettings answer triggered may carry the outline open. `lastPointer` cannot be
	// trusted otherwise. Measured against this Electron build: when the pointer moves from inside the
	// note iframe straight into the main window, this document receives NO departure event at all — no
	// mouseout with a null relatedTarget, no mouseleave, no blur (pre-existing, and the reason departZone
	// cannot cover it). `lastPointer` therefore sits stale at its last in-iframe position, and a rebuild
	// driven by a change made ELSEWHERE (the editor's toolbar, the settings screen, Ctrl+Alt+P) would
	// carry the outline open with the pointer long gone — and, hover being the only thing that could then
	// close it, keep it open until the next mousemove inside the viewer.
	function pointerHoldsOutlineOpen() {
		if (!lastPointer) return false;
		var existing = document.getElementById(STRIP_ID);
		if (!existing) return false;
		if (existing.getAttribute('data-expanded') !== 'true') return false;
		if (existing.getAttribute('data-pinned') === 'true') return false;
		var previousPanel = existing.querySelector('.ridgeline-panel');
		if (!previousPanel) return false;
		return pointInRect(lastPointer.x, lastPointer.y, previousPanel.getBoundingClientRect());
	}

	function build() {
		// Read AND clear, whatever this build then decides, so a flag set for a rebuild that never came
		// (a failed round-trip) can never leak into a later, unrelated one.
		var ownChange = carryOpenOnNextBuild;
		carryOpenOnNextBuild = false;
		// Must be measured while the OUTGOING strip is still in the document (see above).
		var carryOpen = ownChange && pointerHoldsOutlineOpen();

		// Idempotent: remove any strip we (or a previous build) left behind.
		var existing = document.getElementById(STRIP_ID);
		if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
		teardown();

		// The guards (see stripAllowedHere): no bridge = this page is an exported or printed DOCUMENT;
		// an editable/TinyMCE body = this is the Rich Text editor. Either way, return before anything
		// is created, appended or measured, so the document stays exactly what its host wrote. Body
		// margins are left untouched on purpose — applyReserveMargin() below is only ever reached in
		// the live viewer, so there is never a reserve margin of ours to undo here. Note the ordering:
		// the teardown above still runs, so a rebuild that newly lands in a guarded document REMOVES
		// any strip instead of leaving it behind.
		if (!stripAllowedHere()) return;

		var colors = computeColors();
		var headings = headingElements();
		var count = headings.length;
		var side = settings.side;
		// Issue #2: resolved once per build — the strip is rebuilt whenever any of these changes, so the
		// handlers below can close over the value instead of re-resolving it.
		var pinned = isPinned();
		// Open from the first frame: because it is pinned, or because the pointer was holding the previous
		// outline open when this rebuild happened. In the second case the normal hover rules take over at
		// once — the grace collapses it as soon as the pointer leaves.
		var openAtBuild = pinned || (carryOpen && count > 0);

		// Z2/W3: not shown — leave nothing mounted (all listeners torn down by teardown) and drop any
		// reserve margin so the note text reclaims the space. Hidden when the master toggle is off, or
		// (W3) when the note has no headings and hideWhenEmpty is on — but a PINNED outline stays even on
		// a heading-less note (it shows its toolbar and a "No headings" placeholder), so it can always be
		// unpinned in place. showMinimap=false still wins over everything.
		if (!settings.showMinimap || (!pinned && settings.hideWhenEmpty && count === 0)) {
			setBodyMargin(settings.side, 0);
			return;
		}

		var el = document.createElement('div');
		el.id = STRIP_ID;
		el.className = 'ridgeline-strip ridgeline-viewer-strip';
		el.setAttribute('data-side', side);
		el.setAttribute('data-mode', settings.viewerMode);
		// Issue #2: the pinned state and the resolved outline width, published for the other half of the
		// feature to read (and for the E2E to assert on) in every state, pinned or not.
		el.setAttribute('data-pinned', pinned ? 'true' : 'false');
		// This whole strip is REBUILT on every settings change (unlike the editor's, which is re-styled in
		// place), so the expanded state must be written at build time too — a rebuilt-but-untouched strip
		// would otherwise carry no data-expanded at all until the first expand()/collapse(), and a reader
		// could not tell "closed" from "not yet touched". Pinned — or carried open under the pointer — it
		// is open from the moment it is built.
		el.setAttribute('data-expanded', openAtBuild ? 'true' : 'false');
		var s = el.style;
		s.position = 'fixed';
		// R1: anchor the stack to the TOP of the pane (small offset), not vertically centred.
		s.top = '0';
		s.bottom = '0';
		s.paddingTop = tokens.stripTopOffsetPx + 'px';
		s.width = stripTotalWidth() + 'px';
		s.zIndex = '2147483000';
		s.display = 'flex';
		s.flexDirection = 'column';
		s.justifyContent = 'flex-start';
		// R2: bars flush to the right edge on BOTH sides.
		s.alignItems = 'flex-end';
		s.background = 'transparent';
		// R6: the full-height container must NOT capture pointer events; only the bars + panel do.
		s.pointerEvents = 'none';
		if (side === 'right') { s.right = verticalScrollbarWidth() + 'px'; s.left = ''; }
		else { s.left = '0'; s.right = ''; }

		// Z1: the bars are absolutely positioned on a PITCH (barHeight + gap, ~halved from before) with
		// DEVICE-PIXEL-AWARE rounding — top = round(i * pitch * dpr) / dpr — so every inactive bar lands on
		// an exact integer DEVICE pixel (phase 0) at any zoom and renders at the same height; the current
		// bar (taller) grows downward without reflowing the bars below it.
		var pitch = tokens.barHeight + currentGap(count);
		var dpr = window.devicePixelRatio || 1;
		var deviceSnap = function (px) { return Math.round(px * dpr) / dpr; };
		// W2: the current bar is centred in its slot (top shifted up by half the thickness delta). The
		// whole grid is offset down by that same `pad` so the centred current bar never clips the top:
		// an inactive bar's slot top is i*pitch+pad, and the current bar sits at i*pitch. Both are
		// device-snapped, so every bar's top still lands on an exact integer device pixel at any zoom.
		var centerPad = (tokens.currentBarHeight - tokens.barHeight) / 2;
		var barsWrap = document.createElement('div');
		barsWrap.className = 'ridgeline-bars';
		var bw = barsWrap.style;
		bw.position = 'relative';
		bw.overflow = 'hidden';
		bw.maxHeight = '100%';
		bw.width = '100%';
		bw.boxSizing = 'border-box';
		bw.height = (count > 0 ? deviceSnap((count - 1) * pitch + centerPad) + tokens.currentBarHeight : 0) + 'px';
		// R6: the bar stack is the hover trigger zone and is interactive.
		bw.pointerEvents = 'auto';
		bw.cursor = 'pointer';
		el.appendChild(barsWrap);

		var panel = document.createElement('div');
		panel.className = 'ridgeline-panel';
		var p = panel.style;
		// Issue #2: PINNED, the outline is simply always open, docked at the full height of the pane (the
		// container already spans it) with the rows scrolling inside. Carried open, it is an ordinary
		// hover outline that simply starts out visible.
		p.display = openAtBuild ? 'block' : 'none';
		p.position = 'absolute';
		p.top = '0';
		p.maxHeight = '100%';
		if (pinned) p.height = '100%';
		p.overflowY = 'auto';
		p.overflowX = 'hidden';
		p.boxSizing = 'border-box';
		p.padding = tokens.panelPaddingPx + 'px';
		// Issue #2: the toolbar is a sticky, full-bleed first row, so the panel gives up its top padding
		// while one is shown — otherwise the row would stick 8px below the panel's own top edge.
		if (toolbarOn()) p.paddingTop = '0';
		p.background = colors.panelBg;
		p.color = colors.panelFg;
		p.border = '1px solid ' + colors.panelBorder;
		p.borderRadius = '4px';
		p.boxShadow = '0 2px 10px rgba(0,0,0,0.25)';
		p.zIndex = '6';
		// R6: the open panel is interactive.
		p.pointerEvents = 'auto';
		// P4: pointer cursor on the PANEL itself (not only rows), so whichever descendant
		// document.elementFromPoint reports under the pointer still shows a pointer.
		p.cursor = 'pointer';
		// R4: anchor the panel at the PANE EDGE so it draws OVER the compact strip (and the note),
		// rather than beside the strip leaving it visible.
		if (side === 'right') { p.right = '0'; p.left = ''; }
		else { p.left = '0'; p.right = ''; }
		el.appendChild(panel);

		// The width the toolbar row needs to keep its three buttons on ONE line — it must never wrap, so
		// this is the outline's floor whenever a toolbar is drawn. Summed from the buttons' own intrinsic
		// widths plus the row's gaps and padding, NOT read off the row's scrollWidth: the row is
		// full-bleed, so its scrollWidth is the panel's own width whenever the panel is the wider of the
		// two, and using it would ratchet the floor up and never let it back down.
		function toolbarRowWidthPx() {
			if (!toolbarEl) return 0;
			var kids = toolbarEl.children;
			var sum = 2 * TOOLBAR_PADDING_X_PX;
			for (var i = 0; i < kids.length; i++) sum += kids[i].offsetWidth;
			if (kids.length > 1) sum += (kids.length - 1) * TOOLBAR_GAP_PX;
			// > padding alone means the buttons actually measured (the panel is laid out).
			if (sum > 2 * TOOLBAR_PADDING_X_PX) toolbarRowWidth = Math.ceil(sum);
			return toolbarRowWidth;
		}

		// Issue #2 — size the outline and reserve its room, for the pane AS IT IS NOW. Called once the
		// strip is in the document, again whenever the outline opens, and again on every window resize,
		// because the cap is a PERCENT of a pane that moves.
		//
		// ONE sizing rule, pinned or hovered, toolbar or not: content-fit (`max-content`) between a floor
		// and the cap. "It is a MAX width — don't make empty space": a pinned outline over three short
		// headings docks narrow instead of reserving a wide empty gutter. The floor is 140px, or the
		// toolbar's own single-row width when that is wider, so the three buttons never wrap; it is itself
		// held to the pane width, since a floor wider than the pane would beat the cap (min-width wins
		// over max-width) and overflow it. P3 still holds: a row too long for the width stays a single
		// line and is trimmed with an ellipsis, never wrapped.
		function applyOutlineGeometry() {
			var cap = outlineCapPx();
			var pane = paneWidth();
			var min = token('outlineMinWidthPx');
			var floor = Math.min(Math.max(min, toolbarRowWidthPx()), pane > 0 ? pane : min);
			el.setAttribute('data-outline-width', String(cap));
			p.width = 'max-content';
			p.minWidth = floor + 'px';
			p.maxWidth = cap + 'px';
			// Reserved from the width the outline actually renders at, so it has to run after the sizing
			// above (and with the panel in the document, which is why the first call is post-append).
			applyReserveMargin();
		}

		// ── Issue #2: the outline toolbar — the outline's FIRST row ────────
		//
		// Identical class names and behaviour to the editor's (see editorContentScript.ts); only the
		// data-testid prefix differs. Rebuilt with the panel on every settings change, so it always
		// reflects the CURRENT settings (percent, depth, pressed state) with no second update path.
		var popover = null;
		var popoverFor = null;
		var widthInput = null;
		var toolbarEl = null;

		// The hover outline must not collapse out from under a field the user is TYPING INTO — that, and
		// only that, is the hold. A merely-open popover does not hold it: it is dismissed the moment the
		// pointer leaves (departHold below). That matters most here: once the pointer is out of this
		// iframe no further mousemove arrives and the Escape handler is bound to THIS window, so an
		// outline stranded open behind an idle popover would sit over the note until the next rebuild.
		function holdOpen() {
			return widthInput !== null && document.activeElement === widthInput;
		}

		// Returns whether a popover was actually closed, so Escape can stop at the popover.
		function closePopover() {
			if (!popover) { popoverFor = null; widthInput = null; return false; }
			var pop = popover;
			popover = null;
			popoverFor = null;
			widthInput = null;
			if (pop.parentNode) pop.parentNode.removeChild(pop);
			return true;
		}

		// THE DEPART RULE, shared by every way the pointer can leave the bars/panel zone (a mousemove
		// outside it, departZone's boundary events, a window blur, a visibility loss). Pinned is exempt
		// entirely. A focused width field holds — until it applies or blurs, when releaseHold() picks the
		// outline back up. Otherwise any open popover is dismissed and the normal collapse grace runs.
		function departHold() {
			if (pinned) return;
			if (holdOpen()) return;
			closePopover();
			if (expanded) scheduleCollapse();
		}

		// The width field is finished with (Enter, Escape, or a blur): the typing hold is over, so dismiss
		// the popover and — if the pointer has meanwhile wandered off the outline, or out of this iframe
		// altogether (lastPointer null) — hand it straight back to the normal collapse grace, which
		// departHold could not start while the field held it.
		function releaseHold() {
			closePopover();
			if (pinned) return;
			var onOutline = lastPointer !== null && (
				pointInRect(lastPointer.x, lastPointer.y, barsWrap.getBoundingClientRect()) ||
				pointInRect(lastPointer.x, lastPointer.y, panel.getBoundingClientRect())
			);
			if (expanded && !onOutline) scheduleCollapse();
		}

		// Every toolbar/popover click is swallowed: the toolbar sits INSIDE the panel, whose rows and bars
		// jump on click, so a control must never let its click reach them.
		function onToolbarClick(element, handler) {
			element.addEventListener('click', function (event) {
				event.preventDefault();
				event.stopPropagation();
				handler();
			});
		}

		// A popover lives INSIDE the panel, directly under the toolbar, so the panel's own bounding rect
		// (what the hover hit-test uses) still contains the pointer while it is being used.
		function popoverShell(kind) {
			var pop = document.createElement('div');
			pop.className = 'ridgeline-tb-popover';
			pop.setAttribute('data-for', kind);
			pop.setAttribute('data-testid', 'ridgeline-viewer-tb-popover-' + kind);
			var ps = pop.style;
			ps.display = 'flex';
			ps.flexWrap = 'wrap';
			ps.alignItems = 'center';
			ps.gap = '4px';
			ps.padding = '4px 6px';
			ps.margin = '0 ' + -tokens.panelPaddingPx + 'px 4px ' + -tokens.panelPaddingPx + 'px';
			ps.background = colors.panelBg;
			ps.borderBottom = '1px solid ' + colors.panelBorder;
			ps.cursor = 'default';
			return pop;
		}

		function buildWidthPopover() {
			var pop = popoverShell('width');
			OUTLINE_WIDTH_PRESETS.forEach(function (preset) {
				var button = toolbarButton(
					colors,
					'ridgeline-tb-preset',
					'ridgeline-viewer-tb-preset-' + preset,
					preset + '% of the pane',
					preset === settings.outlineWidthPercent
				);
				button.setAttribute('data-preset', String(preset));
				button.textContent = preset + '%';
				onToolbarClick(button, function () {
					closePopover();
					if (preset !== settings.outlineWidthPercent) sendSettings({ outlineWidthPercent: preset });
				});
				pop.appendChild(button);
			});

			// The free-form field: applies on Enter or on blur, clamped to 10–90; anything unparseable
			// snaps back to the current value rather than writing a nonsense width.
			var input = document.createElement('input');
			input.className = 'ridgeline-tb-width-input';
			input.setAttribute('data-testid', 'ridgeline-viewer-tb-width-input');
			input.type = 'number';
			input.min = String(OUTLINE_WIDTH_MIN);
			input.max = String(OUTLINE_WIDTH_MAX);
			input.step = '1';
			input.value = String(settings.outlineWidthPercent);
			input.title = 'Any width from ' + OUTLINE_WIDTH_MIN + ' to ' + OUTLINE_WIDTH_MAX + '%';
			var istyle = input.style;
			istyle.width = '52px';
			istyle.fontFamily = 'inherit';
			istyle.fontSize = tokens.panelFontPx + 'px';
			istyle.padding = '1px 4px';
			istyle.background = 'transparent';
			istyle.color = colors.panelFg;
			istyle.border = '1px solid ' + colors.panelBorder;
			istyle.borderRadius = '3px';
			// The toolbar row is cursor:default and the panel is cursor:pointer; a text field must read as one.
			istyle.cursor = 'text';
			var applyInput = function () {
				// A blur fired because the popover was removed has nothing to apply.
				if (!input.isConnected) return;
				var raw = String(input.value).trim();
				var parsed = Number(raw);
				if (raw === '' || !isFinite(parsed)) {
					input.value = String(settings.outlineWidthPercent);
					releaseHold();
					return;
				}
				var next = Math.min(OUTLINE_WIDTH_MAX, Math.max(OUTLINE_WIDTH_MIN, Math.round(parsed)));
				input.value = String(next);
				releaseHold();
				if (next !== settings.outlineWidthPercent) sendSettings({ outlineWidthPercent: next });
			};
			input.addEventListener('keydown', function (event) {
				// Kept away from the window-level Escape handler: inside the field, Escape dismisses the
				// popover and leaves the outline exactly as it was.
				event.stopPropagation();
				if (event.key === 'Enter') { event.preventDefault(); applyInput(); }
				else if (event.key === 'Escape') { event.preventDefault(); releaseHold(); }
			});
			input.addEventListener('blur', function (event) {
				// A blur INTO another control of the same popover (clicking a preset) must not tear the
				// popover down under the click — the preset's own handler closes it, after applying.
				var next = event.relatedTarget;
				if (next && popover !== null && popover.contains(next)) return;
				applyInput();
			});
			input.addEventListener('click', function (event) { event.stopPropagation(); });
			pop.appendChild(input);
			widthInput = input;

			var percent = document.createElement('span');
			percent.textContent = '%';
			percent.style.fontSize = tokens.panelFontPx + 'px';
			percent.style.color = colors.panelFg;
			pop.appendChild(percent);
			return pop;
		}

		function buildHeadingsPopover() {
			var pop = popoverShell('headings');
			for (var depth = 1; depth <= 6; depth++) {
				(function (d) {
					var button = toolbarButton(
						colors,
						'ridgeline-tb-depth',
						'ridgeline-viewer-tb-depth-' + d,
						'Show headings down to H' + d,
						d === settings.maxDepth
					);
					button.setAttribute('data-depth', String(d));
					button.textContent = depthRangeLabel(d);
					onToolbarClick(button, function () {
						closePopover();
						if (d !== settings.maxDepth) sendSettings({ maxDepth: d });
					});
					pop.appendChild(button);
				})(depth);
			}
			return pop;
		}

		// Only one popover is ever open; clicking the button that owns the open one closes it again.
		function togglePopover(kind) {
			var wasOpen = popoverFor === kind;
			closePopover();
			if (wasOpen) return;
			var pop = kind === 'width' ? buildWidthPopover() : buildHeadingsPopover();
			popover = pop;
			popoverFor = kind;
			if (toolbarEl && toolbarEl.nextSibling) panel.insertBefore(pop, toolbarEl.nextSibling);
			else panel.appendChild(pop);
		}

		function buildToolbar() {
			var bar = document.createElement('div');
			bar.className = 'ridgeline-toolbar';
			bar.setAttribute('data-testid', 'ridgeline-viewer-toolbar');
			var ts = bar.style;
			// Sticky, so scrolling a long outline never scrolls the Pin button out of reach. Full-bleed via
			// negative side margins (the panel keeps its side padding for the rows).
			ts.position = 'sticky';
			ts.top = '0';
			ts.zIndex = '2';
			ts.display = 'flex';
			ts.alignItems = 'center';
			ts.gap = TOOLBAR_GAP_PX + 'px';
			// NEVER wraps: the three buttons are one control and must read as one row. The outline's floor
			// is this row's own width (toolbarRowWidthPx), so there is always room for them on one line.
			ts.flexWrap = 'nowrap';
			ts.padding = '4px ' + TOOLBAR_PADDING_X_PX + 'px';
			ts.margin = '0 ' + -tokens.panelPaddingPx + 'px 4px ' + -tokens.panelPaddingPx + 'px';
			ts.background = colors.panelBg;
			ts.borderBottom = '1px solid ' + colors.panelBorder;
			ts.fontSize = tokens.panelFontPx + 'px';
			// The rows' pointer cursor must not leak into the toolbar's background: only the buttons click.
			ts.cursor = 'default';

			// WIDTH — Lucide's move-horizontal + the current percent.
			var width = toolbarButton(colors, 'ridgeline-tb-width', 'ridgeline-viewer-tb-width', 'Outline width');
			width.appendChild(svgIcon(ICON_WIDTH));
			width.appendChild(document.createTextNode(settings.outlineWidthPercent + '%'));
			onToolbarClick(width, function () { togglePopover('width'); });
			bar.appendChild(width);

			// HEADINGS — Lucide's heading (which draws the H) + the depth range as bare numbers.
			var headingsButton = toolbarButton(
				colors,
				'ridgeline-tb-headings',
				'ridgeline-viewer-tb-headings',
				depthTitle(settings.maxDepth)
			);
			headingsButton.appendChild(svgIcon(ICON_HEADINGS));
			headingsButton.appendChild(document.createTextNode(depthRangeLabel(settings.maxDepth)));
			onToolbarClick(headingsButton, function () { togglePopover('headings'); });
			bar.appendChild(headingsButton);

			// PIN — Lucide's pin, icon only, in a square of the shared button height; pressed, it fills.
			var pin = toolbarButton(
				colors,
				'ridgeline-tb-pin',
				'ridgeline-viewer-tb-pin',
				pinned ? 'Unpin the outline' : 'Pin the outline open (Ctrl+Alt+P)',
				pinned
			);
			pin.style.width = TOOLBAR_BUTTON_PX + 'px';
			pin.style.padding = '0';
			pin.appendChild(svgIcon(ICON_PIN, pinned));
			onToolbarClick(pin, function () { sendSettings({ outlinePinned: !pinned }); });
			bar.appendChild(pin);

			return bar;
		}

		if (toolbarOn()) {
			toolbarEl = buildToolbar();
			panel.appendChild(toolbarEl);
		}

		// A click anywhere else inside the outline (a row, the panel background) closes an open popover.
		// CAPTURE phase, because the rows stopPropagation on click.
		panel.addEventListener('click', function (event) {
			var target = event.target;
			if (target && target.closest && target.closest('.ridgeline-toolbar, .ridgeline-tb-popover')) return;
			closePopover();
		}, true);

		var bars = [];
		var rows = [];

		headings.forEach(function (h, index) {
			var level = Number(h.tagName.substring(1));
			// Display text, resolved the viewer's way (see headingDisplayText — and read its warning
			// before "unifying" this with the editor's Markdown scanner). `data-anchor` below keeps
			// using h.id: the viewer must go on sending Joplin's OWN id, never our uslug.
			var text = headingDisplayText(h);

			var bar = document.createElement('div');
			bar.className = 'ridgeline-bar';
			bar.setAttribute('data-index', String(index));
			bar.setAttribute('data-level', String(level));
			bar.setAttribute('data-anchor', h.id);
			bar.setAttribute('data-text', text);
			bar.setAttribute('data-testid', 'ridgeline-viewer-tick-' + index);
			bar.title = text;
			var b = bar.style;
			// Q4: absolute on an integer pitch, right-aligned via `right` (flush right edge, ragged left).
			b.position = 'absolute';
			b.right = barSideAir() + 'px';
			// Inactive slot top (updateActive re-centres the current one). W2: offset by centerPad.
			b.top = deviceSnap(index * pitch + centerPad) + 'px';
			b.height = tokens.barHeight + 'px';
			b.width = tokenLength(level) + 'px';
			b.background = colors.normalBar;
			b.borderRadius = '2px';
			b.cursor = 'pointer';
			bar.addEventListener('click', function (event) {
				event.preventDefault();
				event.stopPropagation();
				jump(h.id);
			});
			barsWrap.appendChild(bar);
			bars.push(bar);

			var row = document.createElement('div');
			row.className = 'ridgeline-panel-row';
			row.setAttribute('data-index', String(index));
			row.setAttribute('data-level', String(level));
			row.setAttribute('data-testid', 'ridgeline-viewer-row-' + index);
			row.textContent = text;
			var r = row.style;
			r.fontSize = tokens.panelFontPx + 'px';
			r.lineHeight = '1.4';
			r.padding = tokens.panelRowPaddingPx + 'px 6px';
			r.paddingLeft = (tokens.panelPaddingPx + (level - 1) * tokens.panelIndentPx) + 'px';
			r.color = colors.panelFg;
			// P3: each row is a SINGLE line; a heading too long for the (widened) panel is trimmed with a
			// CSS ellipsis rather than wrapping onto a second line.
			r.whiteSpace = 'nowrap';
			r.overflow = 'hidden';
			r.textOverflow = 'ellipsis';
			// R5: rows read as clickable — pointer cursor + a hover background (see also viewer.css).
			r.cursor = 'pointer';
			r.borderRadius = '3px';
			r.transition = 'background-color 80ms ease';
			row.addEventListener('mouseenter', function () {
				if (!row.classList.contains('is-current')) row.style.background = colors.rowHover;
			});
			row.addEventListener('mouseleave', function () {
				row.style.background = '';
			});
			row.addEventListener('click', function (event) {
				event.preventDefault();
				event.stopPropagation();
				jump(h.id);
			});
			panel.appendChild(row);
			rows.push(row);
		});

		// Issue #2: a PINNED outline stays on a note with no headings (W3 would otherwise unmount the
		// whole strip), so it needs something to say — with the toolbar above it when there is one, so the
		// Pin button stays reachable; without a toolbar the pin is undone from the Settings screen or with
		// Ctrl+Alt+P.
		if (count === 0 && (toolbarOn() || pinned)) {
			var empty = document.createElement('div');
			empty.className = 'ridgeline-panel-empty';
			empty.setAttribute('data-testid', 'ridgeline-viewer-empty');
			empty.textContent = 'No headings';
			var es = empty.style;
			es.fontSize = tokens.panelFontPx + 'px';
			es.lineHeight = '1.4';
			es.padding = tokens.panelRowPaddingPx + 'px 6px';
			es.paddingLeft = tokens.panelPaddingPx + 'px';
			es.color = colors.panelFg;
			es.opacity = '0.7';
			es.whiteSpace = 'nowrap';
			es.cursor = 'default';
			panel.appendChild(empty);
		}

		var activeIndex = -1;

		function updateActive() {
			var active = computeActiveIndex(headings);
			activeIndex = active;
			if (active < 0) {
				el.setAttribute('data-active-index', '');
				el.removeAttribute('data-active-anchor');
			} else {
				el.setAttribute('data-active-index', String(active));
				el.setAttribute('data-active-anchor', headings[active].id);
			}
			for (var i = 0; i < bars.length; i++) {
				var isCur = i === active;
				bars[i].classList.toggle('is-current', isCur);
				// W1: the current bar is bolder via THICKNESS + a brighter colour only — it keeps EXACTLY
				// its level's length (no boost), so a deeper heading never reads as a shallower one.
				bars[i].style.background = isCur ? colors.currentBar : colors.normalBar;
				bars[i].style.height = (isCur ? tokens.currentBarHeight : tokens.barHeight) + 'px';
				var lvl = Number(headings[i].tagName.substring(1));
				bars[i].style.width = tokenLength(lvl) + 'px';
				// W2: centre the current bar in its slot (top up by centerPad); neighbours stay put.
				var slotTop = i * pitch + centerPad;
				bars[i].style.top = deviceSnap(isCur ? slotTop - centerPad : slotTop) + 'px';
				if (isCur) bars[i].setAttribute('data-current', 'true');
				else bars[i].removeAttribute('data-current');
			}
			for (var j = 0; j < rows.length; j++) {
				var cur = j === active;
				rows[j].classList.toggle('is-current', cur);
				rows[j].style.fontWeight = cur ? '700' : '400';
				rows[j].style.color = cur ? colors.currentBar : colors.panelFg;
			}
		}

		var rafPending = false;
		var scrollHandler = function () {
			if (rafPending) return;
			rafPending = true;
			window.requestAnimationFrame(function () {
				rafPending = false;
				updateActive();
			});
		};
		window.addEventListener('scroll', scrollHandler, true);

		// Issue #2: pinned, the outline starts open and stays open — the hover-intent timer, the collapse
		// grace, departZone, blur/visibility and Escape are all held off below.
		var expanded = openAtBuild;
		var collapseTimer = null;
		var openTimer = null;
		function cancelOpen() {
			if (openTimer) { clearTimeout(openTimer); openTimer = null; if (strip) strip.openTimer = null; }
		}
		function cancelCollapse() {
			if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; if (strip) strip.collapseTimer = null; }
		}
		function expand() {
			cancelCollapse();
			if (expanded || count === 0) return;
			expanded = true;
			panel.style.display = 'block';
			el.setAttribute('data-expanded', 'true');
			// Now that the panel is laid out, the toolbar row can finally be measured (everything is 0
			// while it is display:none), so the outline's floor is right from the first frame it shows.
			applyOutlineGeometry();
			if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].scrollIntoView({ block: 'nearest' });
		}
		function collapse() {
			// A pinned outline never collapses, and neither does one whose toolbar popover is open or whose
			// width field is being typed into (the collapse grace is held until it is dismissed).
			if (pinned || holdOpen()) return;
			cancelOpen();
			expanded = false;
			panel.style.display = 'none';
			el.setAttribute('data-expanded', 'false');
		}
		function scheduleCollapse() {
			if (pinned || holdOpen()) return;
			if (collapseTimer) clearTimeout(collapseTimer);
			collapseTimer = setTimeout(function () { collapseTimer = null; collapse(); }, tokens.hoverGraceMs);
			if (strip) strip.collapseTimer = collapseTimer;
		}
		// Q2: arm the hover-intent dwell timer; the panel opens only after the pointer RESTS on the bars
		// hoverOpenDelayMs. Idempotent — a running timer is left to elapse.
		function armOpen() {
			if (openTimer || expanded) return;
			var delay = typeof tokens.hoverOpenDelayMs === 'number' ? tokens.hoverOpenDelayMs : FALLBACK_TOKENS.hoverOpenDelayMs;
			openTimer = setTimeout(function () { openTimer = null; if (strip) strip.openTimer = null; expand(); }, Math.max(0, delay));
			if (strip) strip.openTimer = openTimer;
		}
		// Q2 hover-intent: while over the bars/panel with no button pressed, arm the dwell timer; a quick
		// transit leaves the zone before it elapses and never opens. A held button (selection drag)
		// cancels it, so dragging a selection across the minimap neither opens the panel nor blocks the
		// selection. Once open, staying over the bars/panel keeps it open (cancels the collapse grace).
		var pointermove = function (event) {
			// Recorded before any early return, and module-level so it outlives this build: releaseHold()
			// and the next build's carry-open decision both read it.
			lastPointer = { x: event.clientX, y: event.clientY };
			// Issue #2: a PINNED outline is not driven by hover at all — nothing to arm, nothing to collapse.
			if (pinned) { cancelCollapse(); return; }
			if (count === 0) return;
			var overBars = pointInRect(event.clientX, event.clientY, barsWrap.getBoundingClientRect());
			var overPanel = expanded && pointInRect(event.clientX, event.clientY, panel.getBoundingClientRect());
			if (overBars || overPanel) {
				cancelCollapse();
				if (expanded) return;
				if (event.buttons === 0) armOpen();
				else cancelOpen();
			} else {
				cancelOpen();
				departHold();
			}
		};
		// Z3: the pointer left our surface (out of the note iframe into the main window, into another
		// iframe, or out of the window). Cancel the dwell timer and start the close grace even though no
		// further mousemove will arrive here to drive it.
		function departZone() {
			cancelOpen();
			// The pointer is no longer in this document at all, so any position we stored for it is stale —
			// forget it, or releaseHold() (and the carry-open decision on the next rebuild) would later
			// believe it is still resting on the outline.
			lastPointer = null;
			departHold();
		}
		var docleave = function () { departZone(); };
		// Mirror of the editor fix: a mouseout whose relatedTarget is null (left the iframe document into
		// the main window / a foreign context) or an IFRAME element. Internal moves carry a real
		// relatedTarget and are ignored — the mousemove hit-test handles those.
		var pointerout = function (event) {
			var rt = event.relatedTarget;
			if (rt === null || (rt && rt.tagName === 'IFRAME')) departZone();
		};
		var winblur = function () { departZone(); };
		var visibility = function () {
			if (document.visibilityState === 'visible') return;
			cancelOpen();
			// The same depart rule as a pointer leaving, but collapsing at once rather than on the grace:
			// a hidden surface has nothing to be gentle about. A focused width field still holds.
			if (pinned || holdOpen()) return;
			closePopover();
			if (expanded) collapse();
		};
		var keydown = function (event) {
			if (event.key !== 'Escape') return;
			// Issue #2: Escape closes an open toolbar popover FIRST and stops there; a pinned outline is
			// never closed by it.
			if (closePopover()) return;
			if (pinned) return;
			if (expanded) collapse();
		};
		document.addEventListener('mousemove', pointermove, { passive: true });
		document.addEventListener('mouseleave', docleave);
		document.addEventListener('mouseout', pointerout, { passive: true });
		window.addEventListener('blur', winblur);
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('keydown', keydown);

		// Issue #2: the outline's width — and the room reserved for it — are a PERCENT of the pane, so
		// both are recomputed whenever the pane resizes (the editor half does the same from its own
		// resize/ResizeObserver path).
		var resizeHandler = function () { applyOutlineGeometry(); };
		window.addEventListener('resize', resizeHandler);

		document.body.appendChild(el);
		// Now, not earlier: the room is measured off the rendered panel, which has to be in the document
		// (and its rows and toolbar in place) before it has a width to measure.
		applyOutlineGeometry();
		updateActive();
		// Issue #2: open from the moment it is built (its display and data-expanded were set above), so
		// the current row is brought into view exactly as an expand() would.
		if (openAtBuild && activeIndex >= 0 && rows[activeIndex]) {
			rows[activeIndex].scrollIntoView({ block: 'nearest' });
		}

		strip = { el: el, scrollHandler: scrollHandler, resize: resizeHandler, pointermove: pointermove, docleave: docleave, pointerout: pointerout, winblur: winblur, visibility: visibility, keydown: keydown, collapseTimer: collapseTimer, openTimer: openTimer };
	}

	function jump(anchor) {
		if (typeof webviewApi !== 'undefined' && webviewApi.postMessage) {
			// line is resolved by the coordinator from the anchor; it dual-fires scrollToHash +
			// scrollToLine.
			webviewApi.postMessage(VIEWER_CONTENT_SCRIPT_ID, { type: 'jump', anchor: anchor, line: null });
		}
	}

	function rebuild() {
		currentSig = settingsSignature();
		build();
	}

	function scheduleBuild() {
		// Guards: never even arm the debounce in an exported/printed page or the Rich Text editor.
		if (!stripAllowedHere()) return;
		if (buildTimer) clearTimeout(buildTimer);
		buildTimer = setTimeout(function () {
			buildTimer = null;
			fetchSettings().then(rebuild);
		}, 50);
	}

	// Live settings: poll the coordinator; rebuild only when something actually changed. A MarkdownIt
	// asset has no main→iframe push channel, so polling is the update mechanism.
	function startPolling() {
		// Guards: an exported/printed page has no coordinator to poll (and a stray interval in a hidden
		// print BrowserWindow would keep it busy for nothing), and in the Rich Text editor a poll tick
		// would be a second route back into build().
		if (!stripAllowedHere()) return;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(function () {
			fetchSettings().then(function () {
				if (settingsSignature() !== currentSig) rebuild();
			});
		}, tokens.pollMs || FALLBACK_TOKENS.pollMs);
	}

	// Rebuild on every note render (idempotent + debounced). Canonical Joplin pattern. The listener is
	// registered unconditionally; scheduleBuild() re-checks the guards, so an exported page — or the
	// Rich Text editor, which fires this event on every note render — still builds nothing.
	document.addEventListener('joplin-noteDidUpdate', function () { scheduleBuild(); });

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', scheduleBuild);
	} else {
		scheduleBuild();
	}
	startPolling();
})();
