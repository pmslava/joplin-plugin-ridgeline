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
		levelLengths: { 1: 40, 2: 35, 3: 30, 4: 25, 5: 20, 6: 15 },
		barHeight: 2,
		currentBarHeight: 4,
		currentBarLengthBoostPx: 5,
		barGap: 7,
		minBarGap: 1,
		normalOpacity: 0.45,
		edgeGapPx: 2,
		stripTopOffsetPx: 6,
		panelFontPx: 12.5,
		panelIndentPx: 12,
		panelPaddingPx: 8,
		panelRowPaddingPx: 3,
		panelMaxWidth: 320,
		panelMaxWidthFraction: 0.6,
		panelGapPx: 0,
		hoverGraceMs: 200,
		pollMs: 700,
	};

	var settings = { side: 'left', viewerMode: 'overlay', maxDepth: 6 };
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
					if (result.tokens) tokens = result.tokens;
				}
			})
			.catch(function () { /* keep current settings */ });
	}

	function settingsSignature() {
		return JSON.stringify({ s: settings.side, m: settings.viewerMode, d: settings.maxDepth, t: tokens });
	}

	function applyReserveMargin() {
		document.body.style.marginLeft = '';
		document.body.style.marginRight = '';
		if (settings.viewerMode !== 'reserve') return;
		var pad = (stripWidth() + tokens.edgeGapPx) + 'px';
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
		if (strip.keydown) window.removeEventListener('keydown', strip.keydown);
		if (strip.collapseTimer) clearTimeout(strip.collapseTimer);
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
		s.width = stripWidth() + 'px';
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

		var barsWrap = document.createElement('div');
		barsWrap.className = 'ridgeline-bars';
		var bw = barsWrap.style;
		bw.display = 'flex';
		bw.flexDirection = 'column';
		bw.alignItems = 'flex-end';
		bw.rowGap = currentGap(count) + 'px';
		bw.overflow = 'hidden';
		bw.maxHeight = '100%';
		bw.width = '100%';
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
		// R4: size to the longest row up to a cap; wrap beyond it (no ellipsis).
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
			b.height = tokens.barHeight + 'px';
			b.width = tokenLength(level) + 'px';
			b.background = colors.normalBar;
			b.borderRadius = '2px';
			b.flex = '0 0 auto';
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
			// R4: wrap long headings instead of trimming with an ellipsis.
			r.whiteSpace = 'normal';
			r.overflowWrap = 'anywhere';
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
				// R3: the current bar is clearly bolder — brighter, thicker, AND a touch longer.
				bars[i].style.background = isCur ? colors.currentBar : colors.normalBar;
				bars[i].style.height = (isCur ? tokens.currentBarHeight : tokens.barHeight) + 'px';
				var lvl = Number(headings[i].tagName.substring(1));
				bars[i].style.width = (tokenLength(lvl) + (isCur ? (tokens.currentBarLengthBoostPx || 0) : 0)) + 'px';
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
		function expand() {
			if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
			if (expanded || count === 0) return;
			expanded = true;
			panel.style.display = 'block';
			el.setAttribute('data-expanded', 'true');
			if (activeIndex >= 0 && rows[activeIndex]) rows[activeIndex].scrollIntoView({ block: 'nearest' });
		}
		function collapse() {
			expanded = false;
			panel.style.display = 'none';
			el.setAttribute('data-expanded', 'false');
		}
		function scheduleCollapse() {
			if (collapseTimer) clearTimeout(collapseTimer);
			collapseTimer = setTimeout(function () { collapseTimer = null; collapse(); }, tokens.hoverGraceMs);
			if (strip) strip.collapseTimer = collapseTimer;
		}
		// R6/R7: the hover trigger is the bar stack's actual bounding box (plus the open panel), tested
		// on a document-level mousemove — which keeps firing while a mouse BUTTON is held, so dragging a
		// text selection onto the minimap still opens the TOC.
		var pointermove = function (event) {
			if (count === 0) return;
			var overBars = pointInRect(event.clientX, event.clientY, barsWrap.getBoundingClientRect());
			var overPanel = expanded && pointInRect(event.clientX, event.clientY, panel.getBoundingClientRect());
			if (overBars || overPanel) expand();
			else if (expanded) scheduleCollapse();
		};
		var docleave = function () { if (expanded) scheduleCollapse(); };
		var keydown = function (event) { if (event.key === 'Escape' && expanded) collapse(); };
		document.addEventListener('mousemove', pointermove, { passive: true });
		document.addEventListener('mouseleave', docleave);
		window.addEventListener('keydown', keydown);

		document.body.appendChild(el);
		applyReserveMargin();
		updateActive();

		strip = { el: el, scrollHandler: scrollHandler, pointermove: pointermove, docleave: docleave, keydown: keydown, collapseTimer: collapseTimer };
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
