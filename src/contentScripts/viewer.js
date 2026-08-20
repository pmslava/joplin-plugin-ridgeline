// Ridgeline viewer strip — asset JS, runs inside the rendered note iframe with full DOM access.
//
// Responsibilities:
//  - Build a vertical strip fixed to the left/right edge of the viewer (S4).
//  - Rebuild idempotently + debounced on every 'joplin-noteDidUpdate' so it survives edits and note
//    switches without duplicating (S4). Joplin can fire that event twice per switch.
//  - Track the current heading = top-most heading at/above the viewport top, live on scroll (S5).
//  - Jump on tick click through the coordinator round-trip via webviewApi.postMessage (S6).
//  - Honour the 'side' and viewer 'mode' settings fetched from the coordinator (S7).
//
// Plain JavaScript (no build step for this file): it is copied verbatim into the plugin and cannot
// import the TypeScript shared constants, so the content-script id and message shapes are inlined.

(function () {
	'use strict';

	var VIEWER_CONTENT_SCRIPT_ID = 'io.github.pmslava.ridgeline.viewerStrip';
	var STRIP_ID = 'ridgeline-viewer-strip';
	var STRIP_WIDTH_PX = 14;
	var STRIP_GAP_PX = 4;
	var TOP_EDGE_TOLERANCE_PX = 4;

	var settings = { side: 'left', viewerMode: 'overlay' };
	var settingsLoaded = false;
	var buildTimer = null;
	var scrollHandler = null;

	function log() {
		// Kept quiet by default; uncomment for local debugging.
		// console.info.apply(console, ['[ridgeline-viewer]'].concat([].slice.call(arguments)));
	}

	// Width of the viewport's vertical scrollbar, so a right-side (position:fixed) strip can be tucked
	// just inside it instead of overlapping it — mirrors the editor strip's scrollbar offset.
	function verticalScrollbarWidth() {
		var el = document.scrollingElement || document.documentElement;
		if (!el) return 0;
		var w = (el.offsetWidth || 0) - (el.clientWidth || 0);
		return w > 0 ? w : 0;
	}

	function headingElements() {
		var nodes = document.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
		return [].slice.call(nodes);
	}

	function fetchSettings() {
		if (settingsLoaded) return Promise.resolve(settings);
		if (typeof webviewApi === 'undefined' || !webviewApi.postMessage) {
			return Promise.resolve(settings);
		}
		return webviewApi.postMessage(VIEWER_CONTENT_SCRIPT_ID, { type: 'getSettings' })
			.then(function (result) {
				if (result && typeof result === 'object') {
					settings.side = result.side === 'right' ? 'right' : 'left';
					settings.viewerMode = result.viewerMode === 'reserve' ? 'reserve' : 'overlay';
				}
				settingsLoaded = true;
				return settings;
			})
			.catch(function () { return settings; });
	}

	function applyReserveMargin() {
		// Clear any margin we previously set, then apply the current one.
		document.body.style.marginLeft = '';
		document.body.style.marginRight = '';
		if (settings.viewerMode !== 'reserve') return;
		var pad = (STRIP_WIDTH_PX + STRIP_GAP_PX) + 'px';
		if (settings.side === 'right') {
			document.body.style.marginRight = pad;
		} else {
			document.body.style.marginLeft = pad;
		}
	}

	function computeActiveIndex(headings) {
		if (!headings.length) return -1;
		var active = 0;
		for (var i = 0; i < headings.length; i++) {
			var top = headings[i].getBoundingClientRect().top;
			if (top <= TOP_EDGE_TOLERANCE_PX) {
				active = i;
			} else {
				break;
			}
		}
		return active;
	}

	function build() {
		// Idempotent: remove any strip we built before (survives double noteDidUpdate + note switch).
		var existing = document.getElementById(STRIP_ID);
		if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

		if (scrollHandler) {
			window.removeEventListener('scroll', scrollHandler, true);
			scrollHandler = null;
		}

		var headings = headingElements();

		var strip = document.createElement('div');
		strip.id = STRIP_ID;
		strip.className = 'ridgeline-strip ridgeline-viewer-strip';
		strip.setAttribute('data-side', settings.side);
		strip.setAttribute('data-mode', settings.viewerMode);
		strip.style.position = 'fixed';
		strip.style.top = '0';
		strip.style.bottom = '0';
		strip.style.width = STRIP_WIDTH_PX + 'px';
		strip.style.zIndex = '2147483000';
		strip.style.cursor = 'pointer';
		if (settings.side === 'right') {
			strip.style.right = verticalScrollbarWidth() + 'px';
			strip.style.left = '';
		} else {
			strip.style.left = '0';
			strip.style.right = '';
		}

		var label = document.createElement('div');
		label.className = 'ridgeline-current';
		strip.appendChild(label);

		var ticks = document.createElement('div');
		ticks.className = 'ridgeline-ticks';
		strip.appendChild(ticks);

		var tickEls = [];
		var total = headings.length;
		headings.forEach(function (h, index) {
			var tick = document.createElement('button');
			tick.type = 'button';
			tick.className = 'ridgeline-tick';
			tick.setAttribute('data-index', String(index));
			tick.setAttribute('data-anchor', h.id);
			tick.setAttribute('data-testid', 'ridgeline-viewer-tick-' + index);
			tick.title = h.textContent || h.id;
			tick.style.top = total > 1 ? (16 + (index / (total - 1)) * 90) + '%' : '20%';
			tick.addEventListener('click', function (event) {
				event.preventDefault();
				event.stopPropagation();
				if (typeof webviewApi !== 'undefined' && webviewApi.postMessage) {
					// line is resolved by the coordinator from the anchor (the viewer does not know
					// the source line); it dual-fires scrollToHash + scrollToLine.
					webviewApi.postMessage(VIEWER_CONTENT_SCRIPT_ID, {
						type: 'jump',
						anchor: h.id,
						line: null,
					});
				}
			});
			ticks.appendChild(tick);
			tickEls.push(tick);
		});

		function updateActive() {
			var active = computeActiveIndex(headings);
			if (active < 0) {
				label.textContent = '';
				strip.setAttribute('data-active-index', '');
				return;
			}
			label.textContent = headings[active].textContent || headings[active].id;
			strip.setAttribute('data-active-index', String(active));
			strip.setAttribute('data-active-anchor', headings[active].id);
			for (var i = 0; i < tickEls.length; i++) {
				tickEls[i].classList.toggle('is-active', i === active);
			}
		}

		var rafPending = false;
		scrollHandler = function () {
			if (rafPending) return;
			rafPending = true;
			window.requestAnimationFrame(function () {
				rafPending = false;
				updateActive();
			});
		};
		// Capture phase so we catch scrolling on inner scroll containers too.
		window.addEventListener('scroll', scrollHandler, true);

		document.body.appendChild(strip);
		applyReserveMargin();
		updateActive();
		log('built strip with', total, 'headings, side', settings.side);
	}

	function scheduleBuild() {
		if (buildTimer) clearTimeout(buildTimer);
		buildTimer = setTimeout(function () {
			buildTimer = null;
			fetchSettings().then(build);
		}, 50);
	}

	// Rebuild on every note render (idempotent + debounced). This is the canonical pattern used by
	// Joplin's own mermaid_render.js.
	document.addEventListener('joplin-noteDidUpdate', function () {
		scheduleBuild();
	});

	// Also build once on initial load in case the note is already rendered.
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', scheduleBuild);
	} else {
		scheduleBuild();
	}
})();
