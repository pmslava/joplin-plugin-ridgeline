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
import { barLengthFor, DESIGN_TOKENS, stripWidth, type RidgelineTokens } from '../tokens';

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
}

function reserveTheme(
	settings: RidgelineSettings,
	tokens: RidgelineTokens,
): ReturnType<typeof EditorView.theme> {
	if (settings.editorMode !== 'reserve') {
		return EditorView.theme({});
	}
	const pad = `${stripWidth(tokens) + tokens.edgeGapPx}px`;
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
	private rafPending = false;
	private colors: SurfaceColors;
	private readonly onScroll: () => void;
	private readonly onResize: () => void;
	private readonly onKeyDown: (event: KeyboardEvent) => void;
	private readonly onEnter: () => void;
	private readonly onLeave: () => void;
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
			this.refreshSidePosition();
			this.layoutBars();
			this.scheduleUpdate();
		};
		this.ownerWin.addEventListener('resize', this.onResize, { passive: true });

		this.onEnter = () => this.expand();
		this.onLeave = () => this.scheduleCollapse();
		this.container.addEventListener('mouseenter', this.onEnter);
		this.container.addEventListener('mouseleave', this.onLeave);

		this.onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && this.expanded) this.collapse();
		};
		this.ownerWin.addEventListener('keydown', this.onKeyDown);
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
		};
	}

	private refreshSidePosition(): void {
		const s = this.container.style;
		if (this.settings.side === 'right') {
			s.right = `${this.measureScrollbarWidth()}px`;
			s.left = '';
			this.container.style.alignItems = 'flex-end';
		} else {
			s.left = '0';
			s.right = '';
			this.container.style.alignItems = 'flex-start';
		}
	}

	private applyBaseStyle(): void {
		this.container.setAttribute('data-side', this.settings.side);
		this.container.setAttribute('data-mode', this.settings.editorMode);

		const s = this.container.style;
		s.position = 'absolute';
		s.top = '0';
		s.bottom = '0';
		s.width = `${stripWidth(this.tokens)}px`;
		s.zIndex = '5';
		s.boxSizing = 'border-box';
		s.background = 'transparent';
		s.display = 'flex';
		s.flexDirection = 'column';
		s.justifyContent = 'center';
		s.cursor = 'pointer';
		s.overflow = 'visible';

		const bw = this.barsWrap.style;
		bw.display = 'flex';
		bw.flexDirection = 'column';
		bw.overflow = 'hidden';
		bw.maxHeight = '100%';
		bw.width = '100%';

		this.refreshSidePosition();
		this.stylePanelShell();
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
		p.minWidth = '140px';
		p.maxWidth = `${this.tokens.panelMaxWidth}px`;
		p.background = this.colors.panelBg;
		p.color = this.colors.panelFg;
		p.border = `1px solid ${this.colors.panelBorder}`;
		p.borderRadius = '4px';
		p.boxShadow = '0 2px 10px rgba(0, 0, 0, 0.25)';
		p.zIndex = '6';
		if (this.settings.side === 'right') {
			p.right = `calc(100% + ${this.tokens.panelGapPx}px)`;
			p.left = '';
		} else {
			p.left = `calc(100% + ${this.tokens.panelGapPx}px)`;
			p.right = '';
		}
	}

	private mount(): void {
		const parent = this.view.scrollDOM.parentElement ?? this.view.dom;
		// .cm-editor is position:relative in CodeMirror's base theme, so an absolutely-positioned
		// child anchors to the editor pane.
		parent.appendChild(this.container);
	}

	public setHeadings(headings: EditorHeading[]): void {
		this.rawHeadings = headings;
		this.headings = headings.filter((h) => h.level <= this.settings.maxDepth);
		this.renderBars();
		this.renderPanel();
		this.update();
	}

	// Compress the inter-bar gap so a very tall stack still fits the pane; never below the token floor.
	private currentGap(): number {
		const n = this.headings.length;
		if (n <= 1) return this.tokens.barGap;
		const avail = this.view.scrollDOM.clientHeight || 0;
		if (avail <= 0) return this.tokens.barGap;
		const barsHeight = n * this.tokens.currentBarHeight;
		const fitGap = Math.floor((avail - barsHeight) / (n - 1));
		return Math.max(this.tokens.minBarGap, Math.min(this.tokens.barGap, fitGap));
	}

	private layoutBars(): void {
		this.barsWrap.style.rowGap = `${this.currentGap()}px`;
		this.barsWrap.style.alignItems = this.settings.side === 'right' ? 'flex-end' : 'flex-start';
	}

	private renderBars(): void {
		this.barsWrap.textContent = '';
		this.bars = [];
		this.layoutBars();

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
			b.height = `${this.tokens.barHeight}px`;
			b.width = `${barLengthFor(this.tokens, heading.level)}px`;
			b.background = this.colors.normalBar;
			b.borderRadius = '2px';
			b.flex = '0 0 auto';
			b.cursor = 'pointer';

			bar.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.onJump(heading);
			});

			this.barsWrap.appendChild(bar);
			this.bars.push(bar);
		});
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
			r.lineHeight = '1.5';
			r.padding = `${this.tokens.panelRowPaddingPx}px 6px`;
			r.paddingLeft = `${this.tokens.panelPaddingPx + (heading.level - 1) * this.tokens.panelIndentPx}px`;
			r.color = this.colors.panelFg;
			r.whiteSpace = 'nowrap';
			r.overflow = 'hidden';
			r.textOverflow = 'ellipsis';
			r.cursor = 'pointer';
			r.borderRadius = '3px';

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
		this.refreshSidePosition();
		this.barsWrap.style.rowGap = `${this.currentGap()}px`;

		const active = this.computeActiveIndex();
		this.activeIndex = active;

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
			bar.style.background = isCurrent ? this.colors.currentBar : this.colors.normalBar;
			bar.style.height = `${isCurrent ? this.tokens.currentBarHeight : this.tokens.barHeight}px`;
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

	private expand(): void {
		if (this.collapseTimer !== null) {
			this.ownerWin.clearTimeout(this.collapseTimer);
			this.collapseTimer = null;
		}
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
		this.ownerWin.removeEventListener('keydown', this.onKeyDown);
		this.container.removeEventListener('mouseenter', this.onEnter);
		this.container.removeEventListener('mouseleave', this.onLeave);
		if (this.collapseTimer !== null) this.ownerWin.clearTimeout(this.collapseTimer);
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
	return { side, editorMode, viewerMode, maxDepth };
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

		const rebuildHeadings = () => {
			if (!strip) return;
			strip.setHeadings(parseHeadings(view.state.doc.toString()));
		};

		// Live settings: the coordinator pushes new values here on joplin.settings.onChange, so the
		// strip re-themes / re-sides / re-filters without a relaunch.
		editorControl.registerCommand(EDITOR_APPLY_SETTINGS_COMMAND, (payload: SettingsResponse) => {
			currentSettings = coerceSettings(payload);
			if (payload && payload.tokens) currentTokens = payload.tokens;
			if (destroyed || !view.dom.isConnected) return;
			view.dispatch({
				effects: reserveCompartment.reconfigure(reserveTheme(currentSettings, currentTokens)),
			});
			if (strip) strip.applySettings(currentSettings, currentTokens);
		});

		const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
			if (!strip) return;
			if (update.docChanged) {
				rebuildHeadings();
			} else if (update.geometryChanged || update.viewportChanged) {
				strip.update();
			}
		});

		const lifecycle = ViewPlugin.fromClass(
			class {
				public destroy() {
					destroyed = true;
					strip?.destroy();
					strip = null;
				}
			},
		);

		void (async () => {
			try {
				const fetched = (await context.postMessage({ type: 'getSettings' })) as SettingsResponse | null;
				if (fetched) {
					currentSettings = coerceSettings(fetched);
					if (fetched.tokens) currentTokens = fetched.tokens;
				}
			} catch (error) {
				console.warn('[ridgeline] could not fetch settings, using defaults', error);
			}

			// The view may have been destroyed while the settings request was in flight. Bail before
			// dispatching or mounting anything.
			if (destroyed || !view.dom.isConnected) return;

			view.dispatch({
				effects: reserveCompartment.reconfigure(reserveTheme(currentSettings, currentTokens)),
			});

			const newStrip = new EditorStrip(view, currentSettings, currentTokens, (heading) => {
				void context.postMessage({ type: 'jump', anchor: heading.slug, line: heading.line });
			});
			if (destroyed || !view.dom.isConnected) {
				newStrip.destroy();
				return;
			}
			strip = newStrip;
			rebuildHeadings();
		})();

		editorControl.addExtension([
			reserveCompartment.of(reserveTheme(coerceSettings(null), DESIGN_TOKENS)),
			updateListener,
			lifecycle,
		]);
	},
});
