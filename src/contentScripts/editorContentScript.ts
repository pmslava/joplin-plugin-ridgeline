/* eslint-disable no-console */
// Ridgeline editor content script (CodeMirror 6).
//
// Runs in the Markdown editor with direct access to the live EditorView. It mounts the compact
// minimap — one thin horizontal bar per heading, length encoding heading level, the current
// section's bar bold + white/foreground — at the left/right edge of the editor pane, expands into a
// full hover TOC, and jumps on click through the coordinator round-trip. It also:
//  - self-registers 'ridgeline.scrollToLine' (the coordinator calls it to scroll the raw editor),
//  - self-registers 'ridgeline.applySettings' (the coordinator calls it to push new settings live,
//    no relaunch),
//  - in 'reserve' mode adds an editor-side margin (via EditorView.theme in a Compartment) sized to
//    the compact strip width so text is not covered.
//
// Colours are derived at runtime from the editor surface (theme-aware): normal bars are the
// foreground at ~45% opacity; the current bar is pure white on dark themes / full-strength
// foreground on light. No hardcoded palette.
//
// Instantiated once per EditorView, so it appears in every window (main and secondary) hosting a
// Markdown editor.

import { Compartment } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type {
	CodeMirrorControl,
	ContentScriptContext,
	MarkdownEditorContentScriptModule,
} from 'api/types';
import {
	EDITOR_APPLY_SETTINGS_COMMAND,
	EDITOR_SCROLL_COMMAND,
	type PaneMode,
	type RidgelineSettings,
	type SettingsResponse,
	type Side,
} from '../common';
import { parseHeadings, type EditorHeading } from '../headings';
import { barLengthFor, DESIGN_TOKENS, stripTotalWidth, type RidgelineTokens } from '../tokens';

// How close to the top edge (px) a heading must be to still count as "at the top". A small tolerance
// keeps the active heading stable across sub-pixel layout jitter.
const TOP_EDGE_TOLERANCE_PX = 4;

interface Rgb {
	r: number;
	g: number;
	b: number;
}

function parseColor(value: string): Rgb | null {
	const match = value.match(/rgba?\(([^)]+)\)/);
	if (!match) return null;
	const parts = match[1].split(',').map((p) => parseFloat(p.trim()));
	if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
	// If a colour is fully transparent it carries no usable hue.
	if (parts.length >= 4 && parts[3] === 0) return null;
	return { r: parts[0], g: parts[1], b: parts[2] };
}

function luminance(c: Rgb): number {
	return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

function rgbaString(c: Rgb, alpha: number): string {
	return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;
}

function rgbString(c: Rgb): string {
	return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}

interface SurfaceColors {
	isDark: boolean;
	normalBar: string;
	currentBar: string;
	panelBg: string;
	panelFg: string;
	panelBorder: string;
	rowHover: string;
}

function reserveTheme(
	settings: RidgelineSettings,
	tokens: RidgelineTokens,
	visible: boolean,
): ReturnType<typeof EditorView.theme> {
	// Z2/W3: a strip that is not actually shown reserves no margin — there is nothing to keep the text
	// clear of. `visible` folds in both the master showMinimap toggle AND the W3 hide-when-empty rule
	// (heading-less note + hideWhenEmpty), so an empty note in reserve mode reclaims the full width.
	if (settings.editorMode !== 'reserve' || !visible) {
		return EditorView.theme({});
	}
	const pad = `${stripTotalWidth(tokens) + tokens.edgeGapPx}px`;
	const prop = settings.side === 'right' ? 'paddingRight' : 'paddingLeft';
	return EditorView.theme({
		'.cm-content': { [prop]: pad },
	});
}

class EditorStrip {
	private readonly container: HTMLDivElement;
	private readonly barsWrap: HTMLDivElement;
	private readonly panel: HTMLDivElement;
	private rawHeadings: EditorHeading[] = [];
	private headings: EditorHeading[] = [];
	private bars: HTMLElement[] = [];
	private rows: HTMLElement[] = [];
	private activeIndex = -1;
	private expanded = false;
	private collapseTimer: number | null = null;
	// Q2: hover-intent. The dwell timer is armed when the pointer enters the bar hit-zone with no
	// button pressed, and fires (opening the panel) only after it has RESTED there hoverOpenDelayMs.
	// It is cancelled the instant the pointer leaves the zone or presses a button, so a mouse merely
	// crossing the strip on its way to the note list never opens the panel.
	private openTimer: number | null = null;
	private rafPending = false;
	private colors: SurfaceColors;
	private readonly onScroll: () => void;
	private readonly onResize: () => void;
	private readonly onWinScroll: () => void;
	private readonly onKeyDown: (event: KeyboardEvent) => void;
	private readonly onPointerMove: (event: MouseEvent) => void;
	private readonly onDocLeave: () => void;
	// Z3: event-boundary handlers. Once the pointer enters ANY iframe (his Cockpit panel, the note
	// viewer, another plugin panel) our document stops receiving mousemove, so neither the dwell-timer
	// cancel nor the open-panel close can be driven by mousemove any more. These fire without further
	// mousemove: mouseout whose relatedTarget is null / an IFRAME (pointer left our surface into another
	// pane), window blur, and visibility loss.
	private readonly onPointerOut: (event: MouseEvent) => void;
	private readonly onWinBlur: () => void;
	private readonly onVisibility: () => void;
	private resizeObserver: { disconnect(): void } | null = null;
	// Content scripts run in the main renderer's JS realm, so the global `document`/`window` are the
	// main window's even for a secondary-window editor. Build the strip in the editor's OWN document
	// — otherwise a secondary window would get no strip (or one adopted into the wrong doc).
	private readonly ownerDoc: Document;
	private readonly ownerWin: Window;

	public constructor(
		private readonly view: EditorView,
		private settings: RidgelineSettings,
		private tokens: RidgelineTokens,
		private readonly onJump: (heading: EditorHeading) => void,
	) {
		this.ownerDoc = view.scrollDOM.ownerDocument;
		this.ownerWin = this.ownerDoc.defaultView ?? window;

		this.container = this.ownerDoc.createElement('div');
		this.container.className = 'ridgeline-strip ridgeline-editor-strip';

		this.barsWrap = this.ownerDoc.createElement('div');
		this.barsWrap.className = 'ridgeline-bars';
		this.container.appendChild(this.barsWrap);

		this.panel = this.ownerDoc.createElement('div');
		this.panel.className = 'ridgeline-panel';
		this.panel.style.display = 'none';
		this.container.appendChild(this.panel);

		this.colors = this.computeColors();
		this.applyBaseStyle();
		this.mount();

		this.onScroll = () => this.scheduleUpdate();
		this.view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });

		this.onResize = () => {
			this.reposition();
			this.layoutBars();
			this.scheduleUpdate();
		};
		this.ownerWin.addEventListener('resize', this.onResize, { passive: true });

		// Q3: the strip is a FIXED element on the document body (see mount), so it must be repositioned
		// whenever the editor pane moves or resizes — a window scroll, and any layout change to the
		// editor element (pane split drag, sidebar/note-list toggle, panes toggle) caught by a
		// ResizeObserver on the editor DOM.
		this.onWinScroll = () => this.reposition();
		this.ownerWin.addEventListener('scroll', this.onWinScroll, { passive: true, capture: true });
		const RO = (this.ownerWin as unknown as { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } }).ResizeObserver;
		if (typeof RO === 'function') {
			const ro = new RO(() => this.reposition());
			ro.observe(this.view.dom);
			this.resizeObserver = ro;
		}

		// R6/P5: the hover trigger is the bar stack's actual bounding box (plus the open panel), not the
		// full-height container. We hit-test the pointer on a document-level mousemove and pass the
		// button state: the panel OPENS only when no mouse button is pressed (buttons === 0), so
		// dragging a text selection across the minimap neither opens the panel nor blocks the selection.
		this.onPointerMove = (event: MouseEvent) =>
			this.handlePointerMove(event.clientX, event.clientY, event.buttons);
		this.ownerDoc.addEventListener('mousemove', this.onPointerMove, { passive: true });
		this.onDocLeave = () => this.departZone();
		this.ownerDoc.addEventListener('mouseleave', this.onDocLeave);

		// Z3: the pointer crossing from our document into an iframe (or out of the window) fires a
		// mouseout on the last-hovered element whose relatedTarget is the IFRAME element, or null when it
		// leaves the document / enters a foreign browsing context. Internal element-to-element moves carry
		// a real relatedTarget and are ignored (the mousemove hit-test already handles those), so this
		// only trips on a genuine departure to another pane — exactly the case where no more mousemove
		// arrives to cancel the dwell timer or close the open panel.
		this.onPointerOut = (event: MouseEvent) => {
			const rt = event.relatedTarget as Node | null;
			if (rt === null || (rt as HTMLElement).tagName === 'IFRAME') this.departZone();
		};
		this.ownerDoc.addEventListener('mouseout', this.onPointerOut, { passive: true });

		// Z3: backstops for departures that emit no mouseout in our document — focus moving into an
		// iframe/other app (blur) and the window being hidden/occluded (visibilitychange).
		this.onWinBlur = () => this.departZone();
		this.ownerWin.addEventListener('blur', this.onWinBlur);
		this.onVisibility = () => {
			if (this.ownerDoc.visibilityState !== 'visible') {
				this.cancelOpen();
				if (this.expanded) this.collapse();
			}
		};
		this.ownerDoc.addEventListener('visibilitychange', this.onVisibility);

		this.onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && this.expanded) this.collapse();
		};
		this.ownerWin.addEventListener('keydown', this.onKeyDown);
	}

	// Z3: the pointer left our interactive surface (into another pane, an iframe, or out of the window).
	// Cancel any pending dwell-open and, if the panel is open, start the close grace — even though no
	// further mousemove will arrive in this document to drive it.
	private departZone(): void {
		this.cancelOpen();
		if (this.expanded) this.scheduleCollapse();
	}

	private measureScrollbarWidth(): number {
		return Math.max(0, this.view.scrollDOM.offsetWidth - this.view.scrollDOM.clientWidth);
	}

	// Resolve an opaque surface background by walking up from the editor scroller until a non-
	// transparent background is found; fall back to white so a light panel is always readable.
	private resolveBackground(): Rgb {
		let el: HTMLElement | null = this.view.scrollDOM;
		for (let hops = 0; el && hops < 12; hops++, el = el.parentElement) {
			const parsed = parseColor(this.ownerWin.getComputedStyle(el).backgroundColor);
			if (parsed) return parsed;
		}
		return { r: 255, g: 255, b: 255 };
	}

	private computeColors(): SurfaceColors {
		const fg = parseColor(this.ownerWin.getComputedStyle(this.view.contentDOM).color) ?? {
			r: 120,
			g: 120,
			b: 120,
		};
		const bg = this.resolveBackground();
		const isDark = luminance(bg) < 0.5;
		return {
			isDark,
			normalBar: rgbaString(fg, this.tokens.normalOpacity),
			currentBar: isDark ? '#ffffff' : rgbString(fg),
			panelBg: rgbString(bg),
			panelFg: rgbaString(fg, 0.75),
			panelBorder: rgbaString(fg, 0.18),
			// Row hover highlight: a faint wash of the foreground, readable on either theme.
			rowHover: rgbaString(fg, isDark ? 0.16 : 0.1),
		};
	}

	// Q3: position the FIXED container to track the editor pane. Reads the scroller's viewport rect and
	// pins the strip to its top-left (or top-right) edge. Hidden when the editor is not laid out.
	private reposition(): void {
		const s = this.container.style;
		const rect = this.view.scrollDOM.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			s.display = 'none';
			return;
		}
		s.display = 'flex';
		this.container.setAttribute('data-side', this.settings.side);
		const total = stripTotalWidth(this.tokens);
		s.top = `${Math.round(rect.top)}px`;
		s.height = `${Math.round(rect.height)}px`;
		s.width = `${total}px`;
		s.right = '';
		if (this.settings.side === 'right') {
			// Tuck just inside the vertical scrollbar on the right edge of the pane.
			s.left = `${Math.round(rect.right - this.measureScrollbarWidth() - total)}px`;
		} else {
			s.left = `${Math.round(rect.left)}px`;
		}
	}

	private applyBaseStyle(): void {
		this.container.setAttribute('data-side', this.settings.side);
		this.container.setAttribute('data-mode', this.settings.editorMode);

		const s = this.container.style;
		// Q3: FIXED on the document body (not absolute inside .cm-editor) so no CodeMirror layer or CM
		// cursor rule can ever sit over the panel or win the cursor — the whole reason the pointer cursor
		// kept not showing on the real machine while clean-profile specs passed. Positioned to the pane
		// via reposition().
		s.position = 'fixed';
		s.paddingTop = `${this.tokens.stripTopOffsetPx}px`;
		s.width = `${stripTotalWidth(this.tokens)}px`;
		// Z4: comfortably above Joplin's editor UI (its editor-area chrome tops out around z-index 20)
		// while staying well below Joplin's dialogs/menus/overlays (1000+). 50 could be undercut by some
		// editor-layer UI; 200 clears the editor stack without ever covering a dialog.
		s.zIndex = '200';
		s.boxSizing = 'border-box';
		s.background = 'transparent';
		s.display = 'flex';
		s.flexDirection = 'column';
		s.justifyContent = 'flex-start';
		s.alignItems = 'flex-end';
		// R6: the full-height container must NOT capture pointer events (it would swallow hover/clicks
		// over the text in the empty band). Only the bar stack and the open panel are interactive.
		s.pointerEvents = 'none';
		s.overflow = 'visible';

		const bw = this.barsWrap.style;
		// Q4: bars are absolutely positioned on an integer pixel PITCH (see renderBars/layoutBars) rather
		// than distributed by a flex gap, so every inactive bar lands on an exact integer y and the
		// current bar can thicken without reflowing (and thus visually shifting) the bars below it.
		bw.position = 'relative';
		bw.overflow = 'hidden';
		bw.maxHeight = '100%';
		bw.width = '100%';
		bw.boxSizing = 'border-box';
		bw.pointerEvents = 'auto';
		bw.cursor = 'pointer';

		this.reposition();
		this.stylePanelShell();
	}

	// The longest panel width we allow: a hard token cap, also limited to a fraction of the pane width.
	private panelMaxWidthPx(): number {
		const paneWidth = this.view.scrollDOM.clientWidth || 0;
		const fractionCap = paneWidth > 0 ? Math.floor(paneWidth * this.tokens.panelMaxWidthFraction) : this.tokens.panelMaxWidth;
		return Math.max(140, Math.min(this.tokens.panelMaxWidth, fractionCap));
	}

	private stylePanelShell(): void {
		const p = this.panel.style;
		p.position = 'absolute';
		p.top = '0';
		p.maxHeight = '100%';
		p.overflowY = 'auto';
		p.overflowX = 'hidden';
		p.boxSizing = 'border-box';
		p.padding = `${this.tokens.panelPaddingPx}px`;
		// P3: size to the longest row (max-content) up to a (widened) cap; beyond the cap a row stays a
		// single line and is trimmed with an ellipsis (see renderPanel), never wrapped.
		p.width = 'max-content';
		p.minWidth = '140px';
		p.maxWidth = `${this.panelMaxWidthPx()}px`;
		p.background = this.colors.panelBg;
		p.color = this.colors.panelFg;
		p.border = `1px solid ${this.colors.panelBorder}`;
		p.borderRadius = '4px';
		p.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.25)';
		p.zIndex = '6';
		// R6: the open panel is interactive (its rows are clickable and part of the hover zone).
		p.pointerEvents = 'auto';
		// P4: the whole panel reads as clickable. Setting the pointer cursor on the PANEL (not only the
		// rows) guarantees it regardless of which descendant document.elementFromPoint reports under the
		// pointer — the earlier row-only cursor could lose to the panel body / a child that actually
		// received the pointer, and CodeMirror's own `.cm-content { cursor: text }` never leaks in here.
		p.cursor = 'pointer';
		// R4: the panel is anchored at the PANE EDGE and draws OVER the compact strip (and onward over
		// the text), rather than beside the strip leaving it visible.
		if (this.settings.side === 'right') {
			p.right = '0';
			p.left = '';
		} else {
			p.left = '0';
			p.right = '';
		}
	}

	private mount(): void {
		// Q3: mount on the editor's OWN document body (multi-window-safe), NOT inside .cm-editor. A
		// fixed-position element on <body> is fully outside CodeMirror's DOM and CSS scope, so CM's
		// cursor rules and stacking layers can never touch the panel — exactly what made the pointer
		// cursor unreliable when the panel lived inside the editor. reposition() keeps it on the pane.
		this.ownerDoc.body.appendChild(this.container);
	}

	public setHeadings(headings: EditorHeading[]): void {
		this.rawHeadings = headings;
		this.headings = headings.filter((h) => h.level <= this.settings.maxDepth);
		this.renderBars();
		this.renderPanel();
		this.update();
	}

	// Compress the inter-bar gap so a very tall stack still fits the pane; never below the token floor.
	// Kept an INTEGER (Math.floor) so the bar pitch stays whole-pixel (Q4).
	private currentGap(): number {
		const n = this.headings.length;
		if (n <= 1) return this.tokens.barGap;
		const avail = this.view.scrollDOM.clientHeight || 0;
		if (avail <= 0) return this.tokens.barGap;
		const barsHeight = n * this.tokens.currentBarHeight;
		const fitGap = Math.floor((avail - barsHeight) / (n - 1));
		return Math.max(this.tokens.minBarGap, Math.min(this.tokens.barGap, fitGap));
	}

	// Q4: the integer pixel distance from one bar's top to the next.
	private pitch(): number {
		return this.tokens.barHeight + this.currentGap();
	}

	// Z1: place every bar with DEVICE-PIXEL-AWARE rounding on a fixed pitch (absolute positioning), and
	// size the hit-zone box to bound them. top_i = round(i * pitch * dpr) / dpr snaps each bar's top to
	// an exact integer DEVICE pixel (phase 0) at ANY zoom, so every inactive bar antialiases identically
	// (uniform boldness — the old Q4 fix, now zoom-proof) even at the halved pitch. The current bar
	// (taller) is CENTRED in its slot by layoutBars (W2), without reflowing its neighbours.
	private deviceSnap(px: number): number {
		const dpr = this.ownerWin.devicePixelRatio || 1;
		return Math.round(px * dpr) / dpr;
	}

	// W2: the current bar is thicker (currentBarHeight vs barHeight); to keep it CENTRED in its pitch
	// slot rather than growing downward from the slot top, its top is shifted up by half the thickness
	// delta. To keep that upward shift from clipping the topmost bar against the barsWrap top edge, the
	// whole grid is offset down by that same amount (`pad`): an inactive bar's slot top is i*pitch+pad,
	// and the current bar sits at (i*pitch+pad) − pad = i*pitch. Both are device-snapped so every bar's
	// top still lands on an exact integer DEVICE pixel (phase 0 — the Z1 discipline) at any zoom, and
	// inactive neighbours never move as the current bar changes.
	private centerPad(): number {
		return (this.tokens.currentBarHeight - this.tokens.barHeight) / 2;
	}

	private layoutBars(): void {
		const pitch = this.pitch();
		const pad = this.centerPad();
		for (let i = 0; i < this.bars.length; i++) {
			const slotTop = i * pitch + pad;
			const isCurrent = i === this.activeIndex;
			this.bars[i].style.top = `${this.deviceSnap(isCurrent ? slotTop - pad : slotTop)}px`;
		}
		const n = this.bars.length;
		const boxHeight = n > 0 ? this.deviceSnap((n - 1) * pitch + pad) + this.tokens.currentBarHeight : 0;
		this.barsWrap.style.height = `${boxHeight}px`;
	}

	private renderBars(): void {
		this.barsWrap.textContent = '';
		this.bars = [];

		this.headings.forEach((heading, index) => {
			const bar = this.ownerDoc.createElement('div');
			bar.className = 'ridgeline-bar';
			bar.setAttribute('data-index', String(index));
			bar.setAttribute('data-level', String(heading.level));
			bar.setAttribute('data-line', String(heading.line));
			bar.setAttribute('data-anchor', heading.slug);
			bar.setAttribute('data-text', heading.text);
			// Legacy-compatible testid so the click-to-jump E2E keeps addressing the bar.
			bar.setAttribute('data-testid', `ridgeline-editor-tick-${index}`);
			bar.title = heading.text;

			const b = bar.style;
			// Q4: absolute on an integer pitch, right-aligned via `right` (flush right edge, ragged left)
			// so a longer/current bar extends leftward without moving its right edge or its neighbours.
			b.position = 'absolute';
			b.right = `${this.tokens.barSideAirPx}px`;
			b.height = `${this.tokens.barHeight}px`;
			b.width = `${barLengthFor(this.tokens, heading.level)}px`;
			b.background = this.colors.normalBar;
			b.borderRadius = '2px';
			b.cursor = 'pointer';

			bar.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.onJump(heading);
			});

			this.barsWrap.appendChild(bar);
			this.bars.push(bar);
		});
		this.layoutBars();
	}

	private renderPanel(): void {
		this.panel.textContent = '';
		this.rows = [];
		this.stylePanelShell();

		this.headings.forEach((heading, index) => {
			const row = this.ownerDoc.createElement('div');
			row.className = 'ridgeline-panel-row';
			row.setAttribute('data-index', String(index));
			row.setAttribute('data-level', String(heading.level));
			row.setAttribute('data-testid', `ridgeline-editor-row-${index}`);
			row.textContent = heading.text;

			const r = row.style;
			r.fontSize = `${this.tokens.panelFontPx}px`;
			r.lineHeight = '1.4';
			r.padding = `${this.tokens.panelRowPaddingPx}px 6px`;
			r.paddingLeft = `${this.tokens.panelPaddingPx + (heading.level - 1) * this.tokens.panelIndentPx}px`;
			r.color = this.colors.panelFg;
			// P3: each row is a SINGLE line; a heading too long for the (widened) panel is trimmed with a
			// CSS ellipsis rather than wrapping onto a second line.
			r.whiteSpace = 'nowrap';
			r.overflow = 'hidden';
			r.textOverflow = 'ellipsis';
			// R5: rows read as clickable — pointer cursor, and a background change on hover.
			r.cursor = 'pointer';
			r.borderRadius = '3px';
			r.transition = 'background-color 80ms ease';

			row.addEventListener('mouseenter', () => {
				if (!row.classList.contains('is-current')) row.style.background = this.colors.rowHover;
			});
			row.addEventListener('mouseleave', () => {
				row.style.background = '';
			});
			row.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.onJump(heading);
			});

			this.panel.appendChild(row);
			this.rows.push(row);
		});
	}

	private scheduleUpdate(): void {
		if (this.rafPending) return;
		this.rafPending = true;
		this.ownerWin.requestAnimationFrame(() => {
			this.rafPending = false;
			this.update();
		});
	}

	// The current heading is the last heading whose top is at or above the viewport's top edge; when
	// the document is scrolled to the very top (all headings below the edge) it is the first heading.
	private computeActiveIndex(): number {
		const total = this.headings.length;
		if (total === 0) return -1;

		const topEdge = this.view.scrollDOM.getBoundingClientRect().top;
		const docTop = this.view.documentTop;
		const docLines = this.view.state.doc.lines;

		let active = 0;
		for (let i = 0; i < total; i++) {
			const lineNo = Math.min(this.headings[i].line + 1, docLines);
			const pos = this.view.state.doc.line(lineNo).from;
			const blockTop = this.view.lineBlockAt(pos).top;
			const screenY = docTop + blockTop;
			if (screenY <= topEdge + TOP_EDGE_TOLERANCE_PX) {
				active = i;
			} else {
				break;
			}
		}
		return active;
	}

	public update(): void {
		this.reposition();

		// Compute the active heading BEFORE laying out the bars, so layoutBars can centre THIS frame's
		// current bar (W2) rather than the previous frame's.
		const active = this.computeActiveIndex();
		this.activeIndex = active;
		this.layoutBars();

		if (active < 0) {
			this.container.setAttribute('data-active-index', '');
			this.container.removeAttribute('data-active-anchor');
		} else {
			this.container.setAttribute('data-active-index', String(active));
			this.container.setAttribute('data-active-anchor', this.headings[active].slug);
		}

		for (let i = 0; i < this.bars.length; i++) {
			const bar = this.bars[i];
			const isCurrent = i === active;
			bar.classList.toggle('is-current', isCurrent);
			// W1: the current bar is bolder via THICKNESS + a brighter colour only — it keeps EXACTLY its
			// level's length (no boost), so a deeper heading never reads as a shallower one. Its top is
			// centred in the slot by layoutBars (W2); here we set only colour, thickness and level width.
			bar.style.background = isCurrent ? this.colors.currentBar : this.colors.normalBar;
			bar.style.height = `${isCurrent ? this.tokens.currentBarHeight : this.tokens.barHeight}px`;
			bar.style.width = `${barLengthFor(this.tokens, this.headings[i].level)}px`;
			if (isCurrent) bar.setAttribute('data-current', 'true');
			else bar.removeAttribute('data-current');
		}

		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			const isCurrent = i === active;
			row.classList.toggle('is-current', isCurrent);
			row.style.fontWeight = isCurrent ? '700' : '400';
			row.style.color = isCurrent ? this.colors.currentBar : this.colors.panelFg;
		}
	}

	// Is the point within a rect (with a small tolerance so the strip↔panel seam never gaps)?
	private pointInRect(x: number, y: number, rect: DOMRect, pad = 2): boolean {
		return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
	}

	// Q2 hover-intent driver. While the pointer is over the bar hit-zone (or the open panel) with no
	// button pressed, arm a DWELL timer; the panel opens only once that timer elapses — i.e. the pointer
	// actually rested there. A quick transit across the strip leaves the zone (or the app-level
	// mouseleave fires) before the timer elapses, so it never opens. A held button (selection drag)
	// cancels the timer, so dragging a selection across the minimap neither opens the panel nor blocks
	// the selection. Once open, staying over the bars/panel keeps it open (cancels the collapse grace).
	private handlePointerMove(x: number, y: number, buttons: number): void {
		if (this.headings.length === 0) return;
		const overBars = this.pointInRect(x, y, this.barsWrap.getBoundingClientRect());
		const overPanel = this.expanded && this.pointInRect(x, y, this.panel.getBoundingClientRect());
		if (overBars || overPanel) {
			this.cancelCollapse();
			if (this.expanded) return;
			if (buttons === 0) this.armOpen();
			else this.cancelOpen(); // a drag entered the zone — do not open
		} else {
			this.cancelOpen();
			if (this.expanded) this.scheduleCollapse();
		}
	}

	// Arm the dwell timer (idempotent: a timer already ticking is left to run).
	private armOpen(): void {
		if (this.openTimer !== null || this.expanded) return;
		this.openTimer = this.ownerWin.setTimeout(() => {
			this.openTimer = null;
			this.expand();
		}, Math.max(0, this.tokens.hoverOpenDelayMs));
	}

	private cancelOpen(): void {
		if (this.openTimer !== null) {
			this.ownerWin.clearTimeout(this.openTimer);
			this.openTimer = null;
		}
	}

	private cancelCollapse(): void {
		if (this.collapseTimer !== null) {
			this.ownerWin.clearTimeout(this.collapseTimer);
			this.collapseTimer = null;
		}
	}

	private expand(): void {
		this.cancelCollapse();
		if (this.expanded) return;
		if (this.headings.length === 0) return;
		this.expanded = true;
		this.panel.style.display = 'block';
		this.container.setAttribute('data-expanded', 'true');
		// Bring the current row into view within the panel.
		if (this.activeIndex >= 0 && this.rows[this.activeIndex]) {
			this.rows[this.activeIndex].scrollIntoView({ block: 'nearest' });
		}
	}

	private scheduleCollapse(): void {
		if (this.collapseTimer !== null) this.ownerWin.clearTimeout(this.collapseTimer);
		this.collapseTimer = this.ownerWin.setTimeout(() => {
			this.collapseTimer = null;
			this.collapse();
		}, this.tokens.hoverGraceMs);
	}

	private collapse(): void {
		this.cancelOpen();
		this.expanded = false;
		this.panel.style.display = 'none';
		this.container.setAttribute('data-expanded', 'false');
	}

	// Live settings push (no relaunch): re-theme, re-side, re-filter by maxDepth, re-render.
	public applySettings(settings: RidgelineSettings, tokens: RidgelineTokens): void {
		this.settings = settings;
		this.tokens = tokens;
		this.colors = this.computeColors();
		this.applyBaseStyle();
		this.setHeadings(this.rawHeadings);
	}

	public destroy(): void {
		this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
		this.ownerWin.removeEventListener('resize', this.onResize);
		this.ownerWin.removeEventListener('scroll', this.onWinScroll, { capture: true } as EventListenerOptions);
		this.ownerWin.removeEventListener('keydown', this.onKeyDown);
		this.ownerDoc.removeEventListener('mousemove', this.onPointerMove);
		this.ownerDoc.removeEventListener('mouseleave', this.onDocLeave);
		this.ownerDoc.removeEventListener('mouseout', this.onPointerOut);
		this.ownerWin.removeEventListener('blur', this.onWinBlur);
		this.ownerDoc.removeEventListener('visibilitychange', this.onVisibility);
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.collapseTimer !== null) this.ownerWin.clearTimeout(this.collapseTimer);
		if (this.openTimer !== null) this.ownerWin.clearTimeout(this.openTimer);
		this.container.remove();
	}
}

function coerceSettings(raw: Partial<RidgelineSettings> | null | undefined): RidgelineSettings {
	const side: Side = raw?.side === 'right' ? 'right' : 'left';
	const editorMode: PaneMode = raw?.editorMode === 'reserve' ? 'reserve' : 'overlay';
	const viewerMode: PaneMode = raw?.viewerMode === 'reserve' ? 'reserve' : 'overlay';
	let maxDepth = Number(raw?.maxDepth);
	if (!Number.isFinite(maxDepth)) maxDepth = 6;
	maxDepth = Math.min(6, Math.max(1, Math.round(maxDepth)));
	// Default true: only an explicit `false` hides the strip.
	const showMinimap = raw?.showMinimap !== false;
	// W3: default true — only an explicit `false` keeps the strip (and reserve margin) on a note that
	// has no headings.
	const hideWhenEmpty = raw?.hideWhenEmpty !== false;
	return { side, editorMode, viewerMode, maxDepth, showMinimap, hideWhenEmpty };
}

export default (context: ContentScriptContext): MarkdownEditorContentScriptModule => ({
	plugin: (editorControl: CodeMirrorControl) => {
		const view = editorControl.editor as EditorView | undefined;
		if (!view) {
			console.warn('[ridgeline] editor control has no CodeMirror 6 view; strip not mounted');
			return;
		}

		// Self-register the scroll command the coordinator calls (for both editor and viewer jumps).
		editorControl.registerCommand(EDITOR_SCROLL_COMMAND, (lineNumber: number) => {
			let line = Number(lineNumber);
			if (!Number.isFinite(line) || line < 0) line = 0;
			const maxLine = view.state.doc.lines - 1;
			if (line > maxLine) line = maxLine;
			const lineInfo = view.state.doc.line(line + 1);
			view.dispatch({
				effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start' }),
			});
		});

		const reserveCompartment = new Compartment();
		let strip: EditorStrip | null = null;
		let currentSettings: RidgelineSettings = coerceSettings(null);
		let currentTokens: RidgelineTokens = DESIGN_TOKENS;
		// Set the instant the lifecycle plugin is destroyed. The settings round-trip below is async and
		// cannot be cancelled, so if the EditorView is torn down mid-flight we must NOT mount a strip
		// into the now-detached DOM (it would leave listeners nothing tears down).
		let destroyed = false;

		const onJump = (heading: EditorHeading) => {
			void context.postMessage({ type: 'jump', anchor: heading.slug, line: heading.line });
		};

		// The last-parsed headings of the live document. Recomputed on every doc change; drives both the
		// strip contents and the W3 empty-note visibility decision (0 headings → hide when hideWhenEmpty).
		let lastHeadings: EditorHeading[] = parseHeadings(view.state.doc.toString());
		const recomputeHeadings = () => {
			lastHeadings = parseHeadings(view.state.doc.toString());
		};

		// W3: the strip is actually shown only when the master toggle is on AND (the note has headings OR
		// the user opted to keep the empty strip). showMinimap=false always wins (hidden); hideWhenEmpty
		// off restores the pre-W3 behaviour (empty strip + reserve margin even with no headings).
		const shouldShow = (): boolean => {
			if (!currentSettings.showMinimap) return false;
			if (currentSettings.hideWhenEmpty && lastHeadings.length === 0) return false;
			return true;
		};

		// Reconfigure the reserve-margin theme to match the current visibility. Dispatches a transaction,
		// so it must NOT be called from inside a CodeMirror update (see the updateListener, which defers).
		const reconfigureReserve = () => {
			view.dispatch({
				effects: reserveCompartment.reconfigure(reserveTheme(currentSettings, currentTokens, shouldShow())),
			});
		};

		// The last visibility decision actually applied, so a doc edit only mounts/unmounts (and re-themes)
		// when it CROSSES the empty↔non-empty (or hidden↔shown) boundary — typing more text within an
		// already-headed note never churns the strip.
		let lastVisible: boolean | null = null;

		// Z2/W3: reconcile the strip's presence + reserve margin with the resolved visibility. Mount when
		// it should be shown and is not; fully unmount (destroy → all listeners torn down) when it should
		// be hidden; otherwise push the new settings into the live strip. Called on first load, on every
		// live settings push, and (deferred) whenever a doc edit crosses the visibility boundary.
		const syncStrip = () => {
			if (destroyed || !view.dom.isConnected) return;
			if (shouldShow()) {
				if (strip) {
					strip.applySettings(currentSettings, currentTokens);
				} else {
					strip = new EditorStrip(view, currentSettings, currentTokens, onJump);
				}
				strip.setHeadings(lastHeadings);
			} else if (strip) {
				strip.destroy();
				strip = null;
			}
		};

		// Apply the current visibility to BOTH the reserve margin and the strip mount state, and record it.
		// Safe to call only outside a CodeMirror update (it dispatches via reconfigureReserve).
		const applyVisibility = () => {
			if (destroyed || !view.dom.isConnected) return;
			reconfigureReserve();
			syncStrip();
			lastVisible = shouldShow();
		};

		// A signature of the last-applied settings+tokens, so the poll (below) only re-applies on a real
		// change and never fights the push.
		let settingsSig = '';

		// Apply a fetched/pushed settings response: re-theme (reserve margin) and mount/unmount/re-render
		// the strip. Idempotent via the signature guard when `force` is false.
		const applySettingsResponse = (payload: SettingsResponse | null | undefined, force: boolean): void => {
			const next = coerceSettings(payload);
			const nextTokens = payload && payload.tokens ? payload.tokens : currentTokens;
			const sig = JSON.stringify(next) + '|' + JSON.stringify(nextTokens);
			if (!force && sig === settingsSig) return;
			settingsSig = sig;
			currentSettings = next;
			currentTokens = nextTokens;
			if (destroyed || !view.dom.isConnected) return;
			// Re-theme (reserve margin) and mount/unmount to match the new settings + current heading count.
			applyVisibility();
		};

		// Live settings PUSH: the coordinator calls this on joplin.settings.onChange for the FOCUSED
		// window, so the strip re-themes / re-sides / re-filters / shows / hides instantly, no relaunch.
		editorControl.registerCommand(EDITOR_APPLY_SETTINGS_COMMAND, (payload: SettingsResponse) => {
			applySettingsResponse(payload, true);
		});

		// Live settings POLL (multi-window backstop): editor.execCommand only reaches the focused
		// window's editor, so a change made while another window is focused would never reach THIS
		// window via the push. Poll the coordinator and apply on a real change (signature guard), so
		// the strip shows/hides/re-sides in EVERY window, not just the focused one. Cheap: one message
		// per interval, and applySettingsResponse is a no-op unless something actually changed.
		const timerWin: Window = view.scrollDOM.ownerDocument.defaultView ?? window;
		const pollId = timerWin.setInterval(() => {
			if (destroyed || !view.dom.isConnected) return;
			void (async () => {
				try {
					const fetched = (await context.postMessage({ type: 'getSettings' })) as SettingsResponse | null;
					if (fetched) applySettingsResponse(fetched, false);
				} catch {
					/* transient; try again next tick */
				}
			})();
		}, Math.max(200, currentTokens.pollMs || DESIGN_TOKENS.pollMs));

		const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
			if (update.docChanged) {
				recomputeHeadings();
				// W3: a doc edit may have crossed the empty↔non-empty boundary (first heading typed, last
				// heading deleted). Mounting/unmounting the strip is safe here, but reconfigureReserve
				// dispatches — which is forbidden from inside an update — so defer the whole reconciliation
				// out of the update cycle. When visibility is unchanged, just refresh the mounted strip's
				// headings in place (no dispatch, no churn).
				if (shouldShow() !== lastVisible) {
					timerWin.setTimeout(() => applyVisibility(), 0);
				} else if (strip) {
					strip.setHeadings(lastHeadings);
				}
			} else if (strip && (update.geometryChanged || update.viewportChanged)) {
				strip.update();
			}
		});

		const lifecycle = ViewPlugin.fromClass(
			class {
				public destroy() {
					destroyed = true;
					timerWin.clearInterval(pollId);
					strip?.destroy();
					strip = null;
				}
			},
		);

		void (async () => {
			let fetched: SettingsResponse | null = null;
			try {
				fetched = (await context.postMessage({ type: 'getSettings' })) as SettingsResponse | null;
			} catch (error) {
				console.warn('[ridgeline] could not fetch settings, using defaults', error);
			}

			// The view may have been destroyed while the settings request was in flight. Bail before
			// dispatching or mounting anything.
			if (destroyed || !view.dom.isConnected) return;

			// Z2: mount only if showMinimap; applySettingsResponse seeds the poll signature and syncStrip
			// guards the destroyed/disconnected race itself.
			applySettingsResponse(fetched ?? { ...coerceSettings(null), tokens: currentTokens }, true);
		})();

		editorControl.addExtension([
			reserveCompartment.of(reserveTheme(coerceSettings(null), DESIGN_TOKENS, shouldShow())),
			updateListener,
			lifecycle,
		]);
	},
});
