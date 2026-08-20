// Ridgeline design tokens — the SINGLE source of truth for the minimap's look.
//
// The whole point of this file is one-file tuning: change a number here, rebuild, and both the
// editor strip and the viewer strip pick it up. The editor content script imports these directly
// (it is TypeScript compiled through webpack). The viewer strip runs as a plain-JS asset inside the
// rendered-note iframe and cannot `import`, so the main-process coordinator ships these same tokens
// to it inside the getSettings response (see index.ts / viewer.js). There is exactly one place to
// edit — here.

export interface RidgelineTokens {
	// Bar LENGTH (px) by heading level. Diminishes clearly H1→H3, then only subtly after H3.
	levelLengths: { [level: number]: number };
	// Bar thickness (px) for a normal bar and for the current-section bar.
	barHeight: number;
	currentBarHeight: number;
	// Vertical gap (px) between stacked bars, and the floor it may be compressed to when a note has
	// so many headings the stack would overflow the pane.
	barGap: number;
	minBarGap: number;
	// Opacity of a normal (non-current) bar, applied to the surface foreground colour.
	normalOpacity: number;
	// Small inset (px) from the pane edge the strip sits on.
	edgeGapPx: number;
	// Hover-expanded TOC panel.
	panelFontPx: number; // row font size
	panelIndentPx: number; // extra left indent per heading level
	panelPaddingPx: number; // panel inner padding
	panelRowPaddingPx: number; // per-row vertical padding
	panelMaxWidth: number; // panel max width (px); it scrolls if content is taller than the pane
	panelGapPx: number; // gap between the compact strip and the panel
	// Grace period (ms) before the panel collapses after the pointer leaves, so crossing the
	// strip↔panel boundary does not flicker it shut.
	hoverGraceMs: number;
	// How often (ms) the viewer strip polls the coordinator for changed settings (its live-update
	// mechanism, since a MarkdownIt asset has no main→iframe push channel).
	pollMs: number;
}

export const DESIGN_TOKENS: RidgelineTokens = {
	levelLengths: { 1: 40, 2: 30, 3: 22, 4: 19, 5: 17, 6: 15 },
	barHeight: 2,
	currentBarHeight: 3,
	barGap: 7,
	minBarGap: 1,
	normalOpacity: 0.45,
	edgeGapPx: 2,
	panelFontPx: 12.5,
	panelIndentPx: 12,
	panelPaddingPx: 8,
	panelRowPaddingPx: 3,
	panelMaxWidth: 260,
	panelGapPx: 0,
	hoverGraceMs: 200,
	pollMs: 700,
};

// The compact strip's width = the longest bar (H1). Both the strip container width and the reserve
// margin derive from this, so widening H1 automatically widens the reserved gutter.
export function stripWidth(tokens: RidgelineTokens): number {
	let max = 0;
	for (const key of Object.keys(tokens.levelLengths)) {
		const v = tokens.levelLengths[Number(key)];
		if (v > max) max = v;
	}
	return max;
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
