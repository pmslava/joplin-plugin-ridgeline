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
	// Bar thickness (px) for a normal bar and for the (clearly bolder) current-section bar.
	barHeight: number;
	currentBarHeight: number;
	// Extra length (px) added to the CURRENT bar on top of its per-level length, so "where am I" is
	// instantly visible (bolder = thicker + brighter + a touch longer).
	currentBarLengthBoostPx: number;
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
	panelMaxWidth: number; // panel max width (px) — a hard cap; see panelMaxWidthFraction too
	panelMaxWidthFraction: number; // panel max width also capped to this fraction of the pane width
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
}

export const DESIGN_TOKENS: RidgelineTokens = {
	// Q1: even slimmer, airier bars. A near-linear H1→H6 progression capped at 20px down to a 6px floor
	// (step ~3px), so the stack reads as a thin sliver while every adjacent level stays distinguishable.
	levelLengths: { 1: 20, 2: 17, 3: 14, 4: 11, 5: 8, 6: 6 },
	// Q4: inactive bars raised 2→3px so they render solidly and uniformly (a 2px bar lands on half-pixel
	// boundaries at the user's zoom/DPI and looks unevenly bold). The current bar stays clearly bolder
	// at 5px (same +2px contrast as before) — plus brighter and a touch longer.
	barHeight: 3,
	currentBarHeight: 5,
	// A touch longer for the current bar — scaled with the shorter bars so it still reads as "bolder"
	// without dominating.
	currentBarLengthBoostPx: 4,
	// Q4: the bar PITCH (barHeight + barGap = 3 + 12 = 15) is a multiple of 5 on purpose: at the user's
	// 120% zoom, 15 CSS px → exactly 18 device px, so every inactive bar lands on the SAME sub-device-
	// pixel phase and antialiases identically (no "some bars look bolder"). Keep pitch a multiple of 5
	// if you retune these.
	barGap: 12,
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
	panelMaxWidth: 420,
	panelMaxWidthFraction: 0.66,
	panelGapPx: 0,
	hoverGraceMs: 200,
	// Q2: 300ms dwell before opening — long enough that a mouse crossing the strip to the note list
	// (tens of ms) never triggers it, short enough to feel responsive on a deliberate rest.
	hoverOpenDelayMs: 300,
	pollMs: 700,
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

// Bar length for a level, clamped to the deepest defined level.
export function barLengthFor(tokens: RidgelineTokens, level: number): number {
	const lengths = tokens.levelLengths;
	if (lengths[level] != null) return lengths[level];
	// Fall back to the deepest defined length for anything past the table.
	let deepest = 1;
	for (const key of Object.keys(lengths)) deepest = Math.max(deepest, Number(key));
	return lengths[deepest];
}
