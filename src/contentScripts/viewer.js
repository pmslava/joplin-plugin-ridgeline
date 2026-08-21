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
		panelMaxWidth: 420,
		panelMaxWidthFraction: 0.66,
		panelGapPx: 0,
		hoverGraceMs: 200,
		hoverOpenDelayMs: 300,
		pollMs: 700,
	};

	var settings = { side: 'left', viewerMode: 'overlay', maxDepth: 6, showMinimap: true, hideWhenEmpty: true };
	var tokens = FALLBACK_TOKENS;
	var currentSig = null;
	var buildTimer = null;
	var pollTimer = null;
	var strip = null; // { el, scrollHandler, enter, leave, keydown }

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

	function panelMaxWidthPx() {
		var el = document.scrollingElement || document.documentElement;
		var paneWidth = el ? (el.clientWidth || 0) : 0;
		var frac = tokens.panelMaxWidthFraction || FALLBACK_TOKENS.panelMaxWidthFraction;
		var fractionCap = paneWidth > 0 ? Math.floor(paneWidth * frac) : tokens.panelMaxWidth;
		return Math.max(140, Math.min(tokens.panelMaxWidth, fractionCap));
	}

	function verticalScrollbarWidth() {
		var el = document.scrollingElement || document.documentElement;
		if (!el) return 0;
		var w = (el.offsetWidth || 0) - (el.clientWidth || 0);
		return w > 0 ? w : 0;
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

	function fetchSettings() {
		if (typeof webviewApi === 'undefined' || !webviewApi.postMessage) {
			return Promise.resolve();
		}
		return webviewApi.postMessage(VIEWER_CONTENT_SCRIPT_ID, { type: 'getSettings' })
			.then(function (result) {
				if (result && typeof result === 'object') {
					settings.side = result.side === 'right' ? 'right' : 'left';
					settings.viewerMode = result.viewerMode === 'reserve' ? 'reserve' : 'overlay';
					var d = Number(result.maxDepth);
					settings.maxDepth = isFinite(d) ? Math.min(6, Math.max(1, Math.round(d))) : 6;
					// Z2: default true; only an explicit `false` hides the strip.
					settings.showMinimap = result.showMinimap !== false;
					// W3: default true; only an explicit `false` keeps the strip on a heading-less note.
					settings.hideWhenEmpty = result.hideWhenEmpty !== false;
					if (result.tokens) tokens = result.tokens;
				}
			})
			.catch(function () { /* keep current settings */ });
	}

	function settingsSignature() {
		return JSON.stringify({ s: settings.side, m: settings.viewerMode, d: settings.maxDepth, v: settings.showMinimap, e: settings.hideWhenEmpty, t: tokens });
	}

	function applyReserveMargin() {
		document.body.style.marginLeft = '';
		document.body.style.marginRight = '';
		if (settings.viewerMode !== 'reserve') return;
		var pad = (stripTotalWidth() + tokens.edgeGapPx) + 'px';
		if (settings.side === 'right') document.body.style.marginRight = pad;
		else document.body.style.marginLeft = pad;
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

	function build() {
		// Idempotent: remove any strip we (or a previous build) left behind.
		var existing = document.getElementById(STRIP_ID);
		if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
		teardown();

		var colors = computeColors();
		var headings = headingElements();
		var count = headings.length;
		var side = settings.side;

		// Z2/W3: not shown — leave nothing mounted (all listeners torn down by teardown) and drop any
		// reserve margin so the note text reclaims the space. Hidden when the master toggle is off, or
		// (W3) when the note has no headings and hideWhenEmpty is on.
		if (!settings.showMinimap || (settings.hideWhenEmpty && count === 0)) {
			document.body.style.marginLeft = '';
			document.body.style.marginRight = '';
			return;
		}

		var el = document.createElement('div');
		el.id = STRIP_ID;
		el.className = 'ridgeline-strip ridgeline-viewer-strip';
		el.setAttribute('data-side', side);
		el.setAttribute('data-mode', settings.viewerMode);
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
		p.display = 'none';
		p.position = 'absolute';
		p.top = '0';
		p.maxHeight = '100%';
		p.overflowY = 'auto';
		p.overflowX = 'hidden';
		p.boxSizing = 'border-box';
		p.padding = tokens.panelPaddingPx + 'px';
		// P3: size to the longest row up to a (widened) cap; beyond the cap a row stays a single line and
		// is trimmed with an ellipsis, never wrapped.
		p.width = 'max-content';
		p.minWidth = '140px';
		p.maxWidth = panelMaxWidthPx() + 'px';
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

		var bars = [];
		var rows = [];

		headings.forEach(function (h, index) {
			var level = Number(h.tagName.substring(1));
			var text = h.textContent || h.id;

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

		var expanded = false;
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
			if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].scrollIntoView({ block: 'nearest' });
		}
		function collapse() {
			cancelOpen();
			expanded = false;
			panel.style.display = 'none';
			el.setAttribute('data-expanded', 'false');
		}
		function scheduleCollapse() {
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
				if (expanded) scheduleCollapse();
			}
		};
		// Z3: the pointer left our surface (out of the note iframe into the main window, into another
		// iframe, or out of the window). Cancel the dwell timer and start the close grace even though no
		// further mousemove will arrive here to drive it.
		function departZone() { cancelOpen(); if (expanded) scheduleCollapse(); }
		var docleave = function () { departZone(); };
		// Mirror of the editor fix: a mouseout whose relatedTarget is null (left the iframe document into
		// the main window / a foreign context) or an IFRAME element. Internal moves carry a real
		// relatedTarget and are ignored — the mousemove hit-test handles those.
		var pointerout = function (event) {
			var rt = event.relatedTarget;
			if (rt === null || (rt && rt.tagName === 'IFRAME')) departZone();
		};
		var winblur = function () { departZone(); };
		var visibility = function () { if (document.visibilityState !== 'visible') { cancelOpen(); if (expanded) collapse(); } };
		var keydown = function (event) { if (event.key === 'Escape' && expanded) collapse(); };
		document.addEventListener('mousemove', pointermove, { passive: true });
		document.addEventListener('mouseleave', docleave);
		document.addEventListener('mouseout', pointerout, { passive: true });
		window.addEventListener('blur', winblur);
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('keydown', keydown);

		document.body.appendChild(el);
		applyReserveMargin();
		updateActive();

		strip = { el: el, scrollHandler: scrollHandler, pointermove: pointermove, docleave: docleave, pointerout: pointerout, winblur: winblur, visibility: visibility, keydown: keydown, collapseTimer: collapseTimer, openTimer: openTimer };
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
		if (buildTimer) clearTimeout(buildTimer);
		buildTimer = setTimeout(function () {
			buildTimer = null;
			fetchSettings().then(rebuild);
		}, 50);
	}

	// Live settings: poll the coordinator; rebuild only when something actually changed. A MarkdownIt
	// asset has no main→iframe push channel, so polling is the update mechanism.
	function startPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(function () {
			fetchSettings().then(function () {
				if (settingsSignature() !== currentSig) rebuild();
			});
		}, tokens.pollMs || FALLBACK_TOKENS.pollMs);
	}

	// Rebuild on every note render (idempotent + debounced). Canonical Joplin pattern.
	document.addEventListener('joplin-noteDidUpdate', function () { scheduleBuild(); });

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', scheduleBuild);
	} else {
		scheduleBuild();
	}
	startPolling();
})();
