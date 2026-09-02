// Heading extraction from raw Markdown, used by the CodeMirror editor content script.
//
// TWO LAYERS, deliberately separated:
//   * BLOCK structure is a LINE SCAN (not a full Markdown parse): dependency-light, and it tracks
//     fenced code blocks / HTML comment blocks so a "#" inside them is ignored. Ported from
//     cqroot/joplin-outline's markdownHeaders.ts + markdownSlug.ts.
//   * INLINE content of a heading line goes through `renderInline` (src/inlineText.ts) — ONE pass
//     producing both the text a reader sees and the token stream Joplin slugifies. It replaced a pair
//     of regexes (`removeMarkdownLinks` + `cleanForSlug`) that could express neither: they showed raw
//     Markdown in the strip (GitHub issue #1) and mis-slugged 14 measured constructs, every one of
//     them a silently dead jump.
//
// The slugs generated here must match the anchor ids Joplin puts on rendered headings, so the
// coordinator's scrollToHash jump lands on the right element. Joplin builds those ids with
// laurent22's uslug fork over the heading's `text` + `code_inline` token contents, plus a "-2"/"-3"
// suffix for duplicates; we do the same, feeding uslug `renderInline`'s `slugSource`.
//
// ASSUMES Joplin's `markdown.plugin.*` are at their 3.7.6 defaults — the two that can move an id are
// katex (on: `$x^2$` is excluded from the id) and linkify (on: a bare URL becomes link text, which is
// included either way). See the header of src/inlineText.ts.

import uslug from '@joplin/fork-uslug';
import { renderInline } from './inlineText';

export interface EditorHeading {
	level: number;
	/**
	 * Display text: the heading's inline Markdown resolved to what a reader sees — the same string the
	 * rendered <h*> element's textContent yields (links unwrapped to their label, emphasis and code
	 * markers gone, escapes and entities decoded), trimmed with internal whitespace collapsed.
	 * NOT the raw Markdown: `# [Note title](:/abc…)` yields "Note title" (GitHub issue #1).
	 */
	text: string;
	line: number; // 0-based line number of the heading in the document
	/** uslug of the token stream Joplin's markdown-it-anchor slugifies; equals the rendered id. */
	slug: string;
}

/**
 * Slugify one heading's `slugSource` and apply Joplin's duplicate suffix.
 *
 * The suffix logic is byte-for-byte markdown-it-anchor's `uniqueSlug`: the first occurrence keeps the
 * bare base, later ones get "-2", "-3", …, and the counter is shared across heading LEVELS. It is
 * deliberately left exactly as it was when `slugSource` replaced `cleanForSlug`: changing what is fed
 * to uslug already changes which headings collide (`# A ~~x~~` and `# A x` now both slug to `a-x`, so
 * the second becomes `a-x-2` — measured, and exactly what Joplin does), and touching the counter in the
 * same change would compound two effects.
 *
 * An EMPTY base is legal and is Joplin's own behaviour: an image-only heading renders as `<h1 id="">`,
 * and a second one gets the literal id `-2`.
 */
function slugFor(slugSource: string, seen: Map<string, number>): string {
	const base = uslug(slugSource);
	const count = seen.get(base) ?? 0;
	seen.set(base, count + 1);
	return count === 0 ? base : `${base}-${count + 1}`;
}

export function parseHeadings(body: string): EditorHeading[] {
	const headings: EditorHeading[] = [];
	const seen = new Map<string, number>();
	const lines = body.split('\n');

	// Tracks the marker (``` or ~~~) that opened the current fenced block, or null when outside a
	// fence. A fence can only be closed by its own marker type, so a ~~~ line inside a ``` block is
	// treated as content — not as a fence toggle.
	let fenceMarker: string | null = null;
	let inComment = false;

	for (let index = 0; index < lines.length; index++) {
		const rawLine = lines[index];

		// Toggle fenced code blocks (``` or ~~~), but not a single-line inline `code`.
		const fenceMatch = rawLine.match(/^\s{0,3}(```|~~~)/);
		if (fenceMatch && !/^\s{0,3}(```|~~~).*\1/.test(rawLine)) {
			const marker = fenceMatch[1];
			if (fenceMarker === null) {
				fenceMarker = marker; // opening a fence
			} else if (fenceMarker === marker) {
				fenceMarker = null; // closing the matching fence
			}
			// A non-matching marker inside an open fence is content — leave the fence state alone.
			continue;
		}
		if (fenceMarker !== null) continue;

		// Toggle HTML comment blocks.
		if (/<!--/.test(rawLine) && !/-->/.test(rawLine)) {
			inComment = true;
			continue;
		}
		if (inComment) {
			if (/-->/.test(rawLine)) inComment = false;
			continue;
		}

		// ATX headings: `# Heading` … `###### Heading`. CommonMark allows only 0-3 spaces of leading
		// indent; a line indented by 4+ spaces (or a leading tab) is an indented code block, which
		// Joplin renders as <code> — not a heading. Matching the RAW line's indent (instead of
		// trimming all leading whitespace) keeps the editor list in sync with the viewer's rendered
		// h1-h6 on realistic technical notes (e.g. a `    # note` code sample). CommonMark §4.2/§4.4.
		if (/^ {0,3}#/.test(rawLine)) {
			const line = rawLine.replace(/^\s+/, '').replace(/\s+#*$/, '');
			const atxMatch = line.match(/^(#{1,6})\s+(.*?)\s*$/);
			if (atxMatch) {
				const level = atxMatch[1].length;
				// The emptiness guard tests the RAW heading content, never the resolved display text: an
				// image-only heading (`# ![alt](…)`) resolves to "" for parity with Joplin's textContent,
				// yet Joplin still emits <h1 id="">, which viewer.js:137's `h1[id]` selector finds. Gating
				// on the display string would drop the bar editor-side and desynchronise the two counts.
				const raw = (atxMatch[2] ?? '').trim();
				if (!raw) continue;
				const r = renderInline(raw);
				headings.push({ level, text: r.display, line: index, slug: slugFor(r.slugSource, seen) });
				continue;
			}
		}

		// Setext headings: a line of text underlined by === (H1) or --- (H2). We detect them when we
		// reach the underline line and look back at the text line above it. The text line was already
		// visited on the previous iteration and skipped (it is not ATX), so there is no double count.
		//
		// Guards keep an ordinary `---` (thematic break) or a paragraph's last line from being misread
		// as a heading: the underline must be a run of only = or -, the text line must be a plain
		// paragraph line (non-blank, not ATX, not a list/blockquote/table/fence marker), and the line
		// ABOVE the text line must be blank or the start of the document (a heading stands alone).
		const underline = rawLine.match(/^\s{0,3}(=+|-+)\s*$/);
		if (underline && index > 0) {
			const textLineRaw = lines[index - 1];
			const textLine = textLineRaw.trim();
			const aboveBlank = index - 2 < 0 || lines[index - 2].trim() === '';
			const looksLikeBlock = /^(#|>|\||[-*+]\s|\d+[.)]\s)/.test(textLine);
			if (textLine !== '' && !looksLikeBlock && aboveBlank) {
				const level = underline[1][0] === '=' ? 1 : 2;
				// Setext is a genuinely separate code path from ATX, so it resolves its inline content the
				// same way — an ATX-only fix leaves `[Note title](:/…)\n===` raw in the strip and leaves
				// the code-span slug bug alive under an underline. Guard on the RAW text (see above); the
				// recorded line stays the TEXT line, not the underline.
				const raw = textLine.replace(/\s+#*$/, '').trim();
				if (raw) {
					const r = renderInline(raw);
					headings.push({ level, text: r.display, line: index - 1, slug: slugFor(r.slugSource, seen) });
				}
			}
		}
	}

	return headings;
}
