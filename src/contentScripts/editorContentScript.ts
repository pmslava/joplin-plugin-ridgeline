/* eslint-disable no-console */
// Ridgeline editor content script (CodeMirror 6).
//
// Runs in the Markdown editor with direct access to the live EditorView. It:
//  - mounts a vertical strip at the left/right edge of the editor pane (S1),
//  - shows the current heading = the top-most heading at/above the viewport top, updated live on
//    scroll and edits (S2),
//  - in 'reserve' mode adds an editor-side margin (via EditorView.theme in a Compartment) so the
//    text is not covered by the strip (S3),
//  - lets a click on a strip tick jump to that heading through the coordinator round-trip (S6),
//  - self-registers the 'ridgeline.scrollToLine' command the coordinator calls to scroll the raw
//    editor (used by both editor and viewer jumps).
//
// It is instantiated once per EditorView, so it appears in every window (main and secondary) that
// hosts a Markdown editor (S8).

import { Compartment } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type {
	CodeMirrorControl,
	ContentScriptContext,
	MarkdownEditorContentScriptModule,
} from 'api/types';
import {
	EDITOR_SCROLL_COMMAND,
	STRIP_WIDTH_PX,
	type PaneMode,
	type RidgelineSettings,
	type Side,
} from '../common';
import { parseHeadings, type EditorHeading } from '../headings';

// How close to the top edge (px) a heading must be to still count as "at the top". A small tolerance
// keeps the active heading stable across sub-pixel layout jitter.
const TOP_EDGE_TOLERANCE_PX = 4;
const STRIP_GAP_PX = 4; // extra breathing room added to the reserved margin

function reserveTheme(settings: RidgelineSettings): ReturnType<typeof EditorView.theme> {
	if (settings.editorMode !== 'reserve') {
		return EditorView.theme({});
	}
	const pad = `${STRIP_WIDTH_PX + STRIP_GAP_PX}px`;
	const prop = settings.side === 'right' ? 'paddingRight' : 'paddingLeft';
	return EditorView.theme({
		'.cm-content': { [prop]: pad },
	});
}

class EditorStrip {
	private readonly container: HTMLDivElement;
	private readonly label: HTMLDivElement;
	private readonly ticks: HTMLDivElement;
	private headings: EditorHeading[] = [];
	private activeIndex = -1;
	private rafPending = false;
	private readonly onScroll: () => void;
	// Content scripts run in the main renderer's JS realm, so the global `document`/`window` are the
	// main window's even for a secondary-window editor. Build the strip in the editor's OWN document
	// (S8) — otherwise a secondary window would get no strip (or one adopted into the wrong doc).
	private readonly ownerDoc: Document;
	private readonly ownerWin: Window;

	public constructor(
		private readonly view: EditorView,
		private readonly settings: RidgelineSettings,
		private readonly onJump: (heading: EditorHeading) => void,
	) {
		this.ownerDoc = view.scrollDOM.ownerDocument;
		this.ownerWin = this.ownerDoc.defaultView ?? window;
		this.container = this.ownerDoc.createElement('div');
		this.container.className = 'ridgeline-strip ridgeline-editor-strip';
		this.container.setAttribute('data-side', settings.side);
		this.container.setAttribute('data-mode', settings.editorMode);

		this.label = this.ownerDoc.createElement('div');
		this.label.className = 'ridgeline-current';
		this.container.appendChild(this.label);

		this.ticks = this.ownerDoc.createElement('div');
		this.ticks.className = 'ridgeline-ticks';
		this.container.appendChild(this.ticks);

		this.applyBaseStyle();
		this.mount();

		this.onScroll = () => this.scheduleUpdate();
		this.view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
	}

	private applyBaseStyle(): void {
		const s = this.container.style;
		s.position = 'absolute';
		s.top = '0';
		s.bottom = '0';
		s.width = `${STRIP_WIDTH_PX}px`;
		s.zIndex = '5';
		s.boxSizing = 'border-box';
		// A visible colour — this is the smoke-build "ugly coloured strip".
		s.background = 'linear-gradient(180deg, #4c8bf5, #7d4cf5)';
		s.cursor = 'pointer';
		s.overflow = 'visible';

		const scrollbarWidth = this.view.scrollDOM.offsetWidth - this.view.scrollDOM.clientWidth;
		if (this.settings.side === 'right') {
			s.right = `${Math.max(0, scrollbarWidth)}px`;
			s.left = '';
		} else {
			s.left = '0';
			s.right = '';
		}

		const label = this.label.style;
		label.position = 'absolute';
		label.top = '2px';
		label.fontSize = '11px';
		label.lineHeight = '14px';
		label.padding = '1px 4px';
		label.whiteSpace = 'nowrap';
		label.maxWidth = '240px';
		label.overflow = 'hidden';
		label.textOverflow = 'ellipsis';
		label.color = '#fff';
		label.background = 'rgba(0,0,0,0.55)';
		label.borderRadius = '3px';
		label.pointerEvents = 'none';
		if (this.settings.side === 'right') {
			label.right = `${STRIP_WIDTH_PX + 2}px`;
		} else {
			label.left = `${STRIP_WIDTH_PX + 2}px`;
		}
	}

	private mount(): void {
		const parent = this.view.scrollDOM.parentElement ?? this.view.dom;
		// .cm-editor is position:relative in CodeMirror's base theme, so an absolutely-positioned
		// child anchors to the editor pane.
		parent.appendChild(this.container);
	}

	public setHeadings(headings: EditorHeading[]): void {
		this.headings = headings;
		this.renderTicks();
		this.update();
	}

	private renderTicks(): void {
		this.ticks.textContent = '';
		const total = this.headings.length;
		if (total === 0) return;

		this.headings.forEach((heading, index) => {
			const tick = this.ownerDoc.createElement('button');
			tick.className = 'ridgeline-tick';
			tick.type = 'button';
			tick.setAttribute('data-index', String(index));
			tick.setAttribute('data-line', String(heading.line));
			tick.setAttribute('data-anchor', heading.slug);
			tick.setAttribute('data-testid', `ridgeline-editor-tick-${index}`);
			tick.title = heading.text;

			const t = tick.style;
			t.position = 'absolute';
			t.left = '2px';
			t.right = '2px';
			t.height = '3px';
			t.padding = '0';
			t.margin = '0';
			t.border = 'none';
			t.borderRadius = '2px';
			t.background = 'rgba(255,255,255,0.75)';
			t.cursor = 'pointer';
			// Spread ticks across the strip height by heading order.
			t.top = total > 1 ? `${16 + (index / (total - 1)) * 90}%` : '20%';

			tick.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.onJump(heading);
			});

			this.ticks.appendChild(tick);
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
		const active = this.computeActiveIndex();
		this.activeIndex = active;

		if (active < 0) {
			this.label.textContent = '';
			this.container.setAttribute('data-active-index', '');
		} else {
			this.label.textContent = this.headings[active].text;
			this.container.setAttribute('data-active-index', String(active));
			this.container.setAttribute('data-active-anchor', this.headings[active].slug);
		}

		const tickEls = this.ticks.children;
		for (let i = 0; i < tickEls.length; i++) {
			const el = tickEls[i] as HTMLElement;
			el.style.background = i === active ? '#ffe066' : 'rgba(255,255,255,0.75)';
			el.style.height = i === active ? '5px' : '3px';
		}
	}

	public destroy(): void {
		this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
		this.container.remove();
	}
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

		const rebuildHeadings = () => {
			if (!strip) return;
			strip.setHeadings(parseHeadings(view.state.doc.toString()));
		};

		const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
			if (!strip) return;
			if (update.docChanged) {
				rebuildHeadings();
			} else if (update.geometryChanged || update.viewportChanged) {
				strip.update();
			}
		});

		// A lifecycle plugin so the strip is torn down when the EditorView is destroyed (note close,
		// window close, plugin reload) — preventing duplicate strips.
		const lifecycle = ViewPlugin.fromClass(
			class {
				public destroy() {
					strip?.destroy();
					strip = null;
				}
			},
		);

		// Fetch settings from the coordinator, then build the strip and apply the reserve margin.
		void (async () => {
			let settings: RidgelineSettings = { side: 'left', editorMode: 'overlay', viewerMode: 'overlay' };
			try {
				const fetched = (await context.postMessage({ type: 'getSettings' })) as RidgelineSettings | null;
				if (fetched) settings = fetched;
			} catch (error) {
				console.warn('[ridgeline] could not fetch settings, using defaults', error);
			}

			const side: Side = settings.side === 'right' ? 'right' : 'left';
			const editorMode: PaneMode = settings.editorMode === 'reserve' ? 'reserve' : 'overlay';
			const resolved: RidgelineSettings = { ...settings, side, editorMode };

			// Reconfigure the reserve compartment now that we know the settings.
			view.dispatch({
				effects: reserveCompartment.reconfigure(reserveTheme(resolved)),
			});

			strip = new EditorStrip(view, resolved, (heading) => {
				void context.postMessage({ type: 'jump', anchor: heading.slug, line: heading.line });
			});
			rebuildHeadings();
		})();

		editorControl.addExtension([reserveCompartment.of(reserveTheme({ side: 'left', editorMode: 'overlay', viewerMode: 'overlay' })), updateListener, lifecycle]);
	},
});
