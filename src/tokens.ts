// Ridgeline design tokens — the SINGLE source of truth for the minimap's look.
//
// The whole point of this file is one-file tuning: change a number here, rebuild, and both the
// editor strip and the viewer strip pick it up. The editor content script imports these directly
// (it is TypeScript compiled through webpack). The viewer strip runs as a plain-JS asset inside the
// rendered-note iframe and cannot `import`, so the main-process coordinator ships these same tokens
// to it inside the getSettings response (see index.ts / viewer.js). There is exactly one place to
// edit — here.

export interface RidgelineTokens {
	// Bar LENGTH (px) by heading level. With only six levels a LINEAR progression (equal decrements)
	// keeps every adjacent pair of levels equally distinguishable — 40/35/30/25/20/15, a 5px step.
	levelLengths: { [level: number]: number };
	// Bar thickness (px) for a normal bar and for the (clearly bolder) current-section bar. The current
	// bar's prominence comes ONLY from this extra thickness plus its brighter colour — it keeps EXACTLY
	// its level's length (W1: no length boost, so an H3 never reads as an H2), and it is CENTRED in its
	// pitch slot (W2) rather than grown downward from the slot top.
	barHeight: number;
	currentBarHeight: number;
	// Vertical gap (px) between stacked bars, and the floor it may be compressed to when a note has
	// so many headings the stack would overflow the pane.
	barGap: number;
	minBarGap: number;
	// Horizontal breathing room (px) on EACH side of the bar stack, inside the strip. The strip's
	// total width is the longest bar + 2×this, so the bars float with air on both the pane-edge side
	// and the text side (they are never flush against either). The reserve margin uses the total
	// width too, so reserve mode keeps that same air between the text and the strip.
	barSideAirPx: number;
	// Opacity of a normal (non-current) bar, applied to the surface foreground colour.
	normalOpacity: number;
	// Small inset (px) from the pane edge the strip sits on.
	edgeGapPx: number;
	// Small offset (px) from the pane's TOP edge; the bar stack anchors to the top, not the centre.
	stripTopOffsetPx: number;
	// Hover-expanded TOC panel.
	panelFontPx: number; // row font size
	panelIndentPx: number; // extra left indent per heading level
	panelPaddingPx: number; // panel inner padding
	panelRowPaddingPx: number; // per-row vertical padding
	panelGapPx: number; // gap between the compact strip and the panel
	// Grace period (ms) before the panel collapses after the pointer leaves, so crossing the
	// strip↔panel boundary does not flicker it shut.
	hoverGraceMs: number;
	// HOVER-INTENT dwell (ms): the pointer must REST over the bar hit-zone this long before the panel
	// opens. A pointer merely crossing the strip on its way to the note list (transit takes tens of ms)
	// must NOT pop the panel. Overridable as a plugin setting (see index.ts); the token is the default.
	hoverOpenDelayMs: number;
	// How often (ms) the viewer strip polls the coordinator for changed settings (its live-update
	// mechanism, since a MarkdownIt asset has no main→iframe push channel).
	pollMs: number;
	// ── Outline geometry (issue #2, the outline toolbar) ──────────────────
	// The outline is ALWAYS content-fit — as narrow as its headings allow — between a floor and a cap.
	// The cap is a PERCENT of the pane (the outlineWidthPercent setting), itself clamped by these two:
	// never below outlineMinWidthPx, never above outlineMaxWidthFraction of the pane. This replaced the
	// old fixed 420px / two-thirds-of-the-pane cap outright, so there is one width rule, not two.
	// outlineMinWidthPx is the promoted form of the panel's old hard-coded minWidth = '140px'.
	outlineMinWidthPx: number;
	outlineMaxWidthFraction: number;
	// Room (the pinned outline's wide margin) is only made when at least this much text column would be
	// left beside it; on a narrower pane the outline overlays instead, as it does on hover.
	outlineMinTextPx: number;
	// Air (px) between the text and the pinned outline's border, on top of the strip's edge gap.
	outlineRoomGapPx: number;
}

export const DESIGN_TOKENS: RidgelineTokens = {
	// Q1: even slimmer, airier bars. A near-linear H1→H6 progression capped at 20px down to a 6px floor
	// (step ~3px), so the stack reads as a thin sliver while every adjacent level stays distinguishable.
	levelLengths: { 1: 20, 2: 17, 3: 14, 4: 11, 5: 8, 6: 6 },
	// Q4: inactive bars raised 2→3px so they render solidly and uniformly (a 2px bar lands on half-pixel
	// boundaries at the user's zoom/DPI and looks unevenly bold). The current bar stays clearly bolder
	// at 5px (same +2px contrast as before) — prominence is thickness + a brighter colour ONLY. W1: the
	// current bar keeps its exact level length (no length boost), so a deeper heading never masquerades
	// as a shallower one; W2 centres it in its slot so it never looks dropped toward the bar below.
	barHeight: 3,
	currentBarHeight: 5,
	// Z1: vertical condensing ~2×. The bar PITCH (barHeight + barGap = 3 + 4 = 7) is roughly HALF the
	// old 15, so a heading-dense note's stack is about twice as compact — while the bar THICKNESS is
	// unchanged (3px inactive / 5px current). The old "keep pitch a multiple of 5 so 15 CSS px = 18
	// device px at 120% zoom" rule is retired: bars are now placed with DEVICE-PIXEL-AWARE rounding —
	// top_i = Math.round(i * pitch * dpr) / dpr with dpr = the surface window's devicePixelRatio — so
	// every bar's top lands on an exact integer DEVICE pixel (phase 0) at ANY zoom. That keeps every
	// inactive bar antialiasing identically (no "some look bolder", the old Q4 bug) and frees the pitch
	// from the multiple-of-5 constraint. Retune barGap freely; the dpr rounding keeps the phase honest.
	barGap: 4,
	minBarGap: 1,
	normalOpacity: 0.45,
	// Q1: more breathing room between the note text and the minimap — nearly doubled from 7px. Applies
	// on both sides of the stack and (in reserve mode) to the reserved text margin.
	barSideAirPx: 12,
	edgeGapPx: 2,
	stripTopOffsetPx: 6,
	panelFontPx: 12.5,
	panelIndentPx: 12,
	panelPaddingPx: 8,
	panelRowPaddingPx: 3,
	panelGapPx: 0,
	hoverGraceMs: 200,
	// Q2: 300ms dwell before opening — long enough that a mouse crossing the strip to the note list
	// (tens of ms) never triggers it, short enough to feel responsive on a deliberate rest.
	hoverOpenDelayMs: 300,
	pollMs: 700,
	outlineMinWidthPx: 140,
	outlineMaxWidthFraction: 0.9,
	outlineMinTextPx: 200,
	outlineRoomGapPx: 6,
};

// The bar AREA width = the longest bar (H1). This is the width the bars themselves occupy.
export function stripWidth(tokens: RidgelineTokens): number {
	let max = 0;
	for (const key of Object.keys(tokens.levelLengths)) {
		const v = tokens.levelLengths[Number(key)];
		if (v > max) max = v;
	}
	return max;
}

// The strip's TOTAL width = the longest bar + horizontal air on each side. Both the strip container
// width and the reserve margin derive from this, so the bars float with air on both sides and reserve
// mode keeps that air between the text and the strip.
export function stripTotalWidth(tokens: RidgelineTokens): number {
	return stripWidth(tokens) + 2 * tokens.barSideAirPx;
}

// The outline's maximum width in px for a given pane width and percent setting — THE resolver, mirrored
// verbatim in viewer.js. Recomputed on every reposition/resize/rebuild, because the pane width changes
// under a split drag, a sidebar toggle or a window resize and the percent must follow it. The outline
// itself is content-fit within this cap (and its own floor); this is the ceiling, not the width.
//
// clamp(round(pane * percent / 100), outlineMinWidthPx, floor(pane * outlineMaxWidthFraction)) — with
// one guard in front: a pane NARROWER than the minimum cannot honour the minimum, so the outline is
// simply the whole pane there (very narrow panes must not look surprising).
export function outlineWidthPx(paneWidth: number, percent: number, tokens: RidgelineTokens): number {
	const pane = Math.round(paneWidth);
	if (!Number.isFinite(pane) || pane <= 0) return tokens.outlineMinWidthPx;
	if (pane < tokens.outlineMinWidthPx) return pane;
	const wanted = Math.round((pane * percent) / 100);
	const cap = Math.floor(pane * tokens.outlineMaxWidthFraction);
	return Math.max(tokens.outlineMinWidthPx, Math.min(wanted, cap));
}

// The outline ROOM in px: the width the outline ACTUALLY renders at, plus the strip's edge inset and a
// little air, so the text stops short of the outline's border rather than touching it.
//
// `outlineWidth` is the MEASURED panel width, not the cap: the outline is content-fit, so a note with
// short headings docks narrow and must not have a wide empty gutter reserved for it. Callers re-measure
// after every render, settings apply and pane resize, and pass the result here.
//
// 0 means "no room" — the pane cannot spare outlineMinTextPx of text column beside the outline, so the
// outline overlays instead (exactly as it does on hover) and the legacy minimap margin governs.
export function outlineRoomPx(paneWidth: number, outlineWidth: number, tokens: RidgelineTokens): number {
	const pane = Math.round(paneWidth);
	const width = Math.ceil(outlineWidth);
	if (!Number.isFinite(pane) || pane <= 0 || !Number.isFinite(width) || width <= 0) return 0;
	const room = width + tokens.edgeGapPx + tokens.outlineRoomGapPx;
	if (pane - room < tokens.outlineMinTextPx) return 0;
	return room;
}

// Bar length for a level, clamped to the deepest defined level.
export function barLengthFor(tokens: RidgelineTokens, level: number): number {
	const lengths = tokens.levelLengths;
	if (lengths[level] != null) return lengths[level];
	// Fall back to the deepest defined length for anything past the table.
	let deepest = 1;
	for (const key of Object.keys(lengths)) deepest = Math.max(deepest, Number(key));
	return lengths[deepest];
}
