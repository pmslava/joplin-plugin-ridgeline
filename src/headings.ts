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
// The two layers run as two PHASES over one line scan: the block pass collects the heading lines, the
// `[^label]:` footnote definitions and the `[label]: destination` link reference definitions, then the
// inline pass resolves each heading. The split exists only because either kind of definition may sit
// BELOW the heading that uses it, and an undefined marker or label is literal text in Joplin — see
// branches (e), (f) and (g) of src/inlineText.ts.
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
import { normalizeReference, renderInline } from './inlineText';

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

/**
 * A `[^label]:` definition line. markdown-it-footnote's block rule wants the `[` at the start of the
 * block (0-3 spaces of indent, since 4+ is a code block) and a label with no whitespace in it.
 *
 * It is tested BEFORE the link-reference definition below, mirroring the block ruler: markdown-it-footnote
 * registers `footnote_def` with `md.block.ruler.before('reference', …)`, so `[^1]: note` is a footnote
 * definition and never a link reference.
 */
const FOOTNOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:/;

/** Cheap gate: only a line whose first non-indent character is `[` can be a definition of either kind. */
const DEF_OPENER = /^ {0,3}\[/;

/**
 * The RAW label of a `[label]: destination "optional title"` link reference definition line, or null.
 *
 * Hand-rolled rather than regex'd, for the same reason `matchLabel` in src/inlineText.ts is: the parts
 * nest and escape, and expressing "a label, then a destination, then an optional quoted title, then
 * nothing" as one pattern needs adjacent quantifiers on the keystroke hot path. Every rule below is
 * markdown-it's `rules_block/reference.js`, and every one of them was measured against Joplin 3.7.6:
 *
 *   `   [ref]: url`                    definition (0-3 spaces of indent)
 *   `    [ref]: url`                   NOT — 4 spaces is an indented code block
 *   `[a\]b]: url`                      definition; the label keeps its backslash on BOTH sides, which
 *                                      is what makes it match `# See [a\]b]`
 *   `[a[b]]: url`                      NOT — a raw `[` inside the label kills the rule outright
 *   `[]: url`, `[ ]: url`              NOT — the label normalises to empty (so `# [ ] Not a task` is
 *                                      still safe from a shortcut reference; measured)
 *   `[ref]:url`                        definition — the space after the colon is optional
 *   `[ref]: <url>`                     definition
 *   `[ref]: url "Title"`               definition
 *   `[ref]: url junk`                  NOT — anything but a title after the destination fails the rule
 *   `[ref]:`                           NOT — an empty destination is not a definition
 *
 * KNOWN NARROWER THAN markdown-it, both times in the SAFE direction (we leave the heading literal,
 * which is exactly what v0.2.10 did, so no anchor can move to a value the renderer disagrees with):
 *   * a MULTI-LINE definition (`[ref]:` on one line, the destination on the next) is not recognised;
 *   * a definition inside a blockquote (`> [ref]: url`) is not recognised, though markdown-it hoists
 *     it into the shared `env.references` all the same.
 */
function referenceDefinitionLabel(line: string): string | null {
	let i = 0;
	while (i < 3 && line[i] === ' ') i++;
	if (line[i] !== '[') return null;

	const labelStart = i + 1;
	let j = labelStart;
	let labelEnd = -1;
	while (j < line.length) {
		const c = line[j];
		if (c === '\\') {
			j += 2;
			continue;
		}
		if (c === '[') return null;
		if (c === ']') {
			labelEnd = j;
			break;
		}
		j++;
	}
	if (labelEnd < 0 || line[labelEnd + 1] !== ':') return null;

	let k = labelEnd + 2;
	while (line[k] === ' ' || line[k] === '\t') k++;
	if (k >= line.length) return null;

	if (line[k] === '<') {
		// The `<destination>` form: no unescaped angle bracket inside, and it must close on this line.
		let d = k + 1;
		let closed = false;
		while (d < line.length) {
			const c = line[d];
			if (c === '\\') {
				d += 2;
				continue;
			}
			if (c === '<') return null;
			if (c === '>') {
				closed = true;
				d++;
				break;
			}
			d++;
		}
		if (!closed) return null;
		k = d;
	} else {
		const destStart = k;
		while (k < line.length && line[k] !== ' ' && line[k] !== '\t') {
			k += line[k] === '\\' ? 2 : 1;
		}
		if (k === destStart) return null;
	}

	while (line[k] === ' ' || line[k] === '\t') k++;
	if (k < line.length) {
		const open = line[k];
		const close = open === '(' ? ')' : open;
		if (open !== '"' && open !== "'" && open !== '(') return null;
		let d = k + 1;
		let closed = false;
		while (d < line.length) {
			const c = line[d];
			if (c === '\\') {
				d += 2;
				continue;
			}
			if (c === close) {
				closed = true;
				d++;
				break;
			}
			d++;
		}
		if (!closed) return null;
		k = d;
		while (line[k] === ' ' || line[k] === '\t') k++;
		if (k < line.length) return null;
	}

	return line.slice(labelStart, labelEnd);
}

export function parseHeadings(body: string): EditorHeading[] {
	const headings: EditorHeading[] = [];
	const seen = new Map<string, number>();
	const lines = body.split('\n');

	// The heading lines, collected by the block scan below and resolved afterwards. Two phases, still
	// ONE pass over the lines: a `[^1]` marker is a footnote, and a `[label]` a link, only if a matching
	// definition exists somewhere in the body — including BELOW the heading — so the inline resolution
	// cannot start until the whole body has been walked. Collecting both kinds inside the existing loop
	// (rather than in a pre-pass of their own) also means a definition inside a fenced block or an HTML
	// comment is correctly ignored, because the fence and comment state is right here.
	const pending: { level: number; raw: string; line: number }[] = [];
	const footnotes = new Set<string>();
	const references = new Set<string>();

	// Tracks the marker (``` or ~~~) that opened the current fenced block, or null when outside a
	// fence. A fence can only be closed by its own marker type, so a ~~~ line inside a ``` block is
	// treated as content — not as a fence toggle.
	let fenceMarker: string | null = null;
	let inComment = false;

	// Is a paragraph currently open? A link reference definition is a BLOCK rule, and `reference` is not
	// one of the rules that can terminate a paragraph, so a line shaped like a definition that merely
	// CONTINUES a paragraph is ordinary prose. Measured, both with a `# See [ref]` heading above them:
	//     "some text\n[ref]: https://…"   → NOT a definition, the heading stays literal
	//     "- item\n[ref]: https://…"      → NOT a definition (lazy list continuation)
	//     "Title\n=====\n[ref]: https://…" → IS a definition (the setext heading closed the block)
	// This one boolean is what removes the "false positives on any paragraph line shaped like [x]: y"
	// objection that deferred this feature in the first place. A footnote definition line counts as
	// opening a paragraph, because its container swallows the following line the same way.
	let paragraphOpen = false;

	// The line the scan last CONSUMED as a definition of either kind, or -1. Armed by the two branches
	// below and read by the setext branch at the bottom of the loop.
	let definitionLine = -1;

	for (let index = 0; index < lines.length; index++) {
		const rawLine = lines[index];

		if (rawLine.trim() === '') {
			paragraphOpen = false;
			continue;
		}

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
			paragraphOpen = false;
			continue;
		}
		if (fenceMarker !== null) continue;

		// Toggle HTML comment blocks.
		if (/<!--/.test(rawLine) && !/-->/.test(rawLine)) {
			inComment = true;
			paragraphOpen = false;
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
				// image-only heading with an empty alt (`# ![](…)`) resolves to "" for parity with Joplin's
				// textContent, yet Joplin still emits <h1 id="">, which the `h1[id], h2[id], …` selector in
				// viewer.js's headingElements() finds. (A NON-empty alt falls back to the alt text, so
				// `# ![alt](…)` still labels its bar.) Gating on the display string would drop the bar
				// editor-side and desynchronise the two counts.
				const raw = (atxMatch[2] ?? '').trim();
				// An ATX heading is its own block either way, so the next line starts fresh.
				paragraphOpen = false;
				if (!raw) continue;
				pending.push({ level, raw, line: index });
				continue;
			}
		}

		// Both kinds of DEFINITION line, in the block ruler's own order (footnote_def is registered
		// `before('reference')`, so `[^1]: note` can never be a link reference). A definition anywhere in
		// the body — above the heading or below it — is what turns a `[^1]` marker into a footnote and a
		// `[label]` into a link; without one both stay literal text. See branches (e)/(f)/(g) of
		// src/inlineText.ts. Doing this HERE rather than in a pre-pass of its own is what keeps a
		// definition inside a fenced block or an HTML comment correctly ignored: that state is right here.
		if (DEF_OPENER.test(rawLine)) {
			const footnoteDef = rawLine.match(FOOTNOTE_DEF);
			if (footnoteDef) {
				footnotes.add(footnoteDef[1]);
				// A footnote definition opens a container whose first paragraph swallows the next line.
				paragraphOpen = true;
				definitionLine = index;
				continue;
			}
			if (!paragraphOpen) {
				const label = referenceDefinitionLabel(rawLine);
				if (label !== null) {
					const key = normalizeReference(label);
					// markdown-it rejects an empty normalised label outright (`[]:`, `[ ]:`), and the FIRST
					// definition of a label wins — a Set gives us both, since we never store a destination.
					// The rejected line stays ordinary paragraph text, and a `===` under it therefore IS a
					// heading (`[]: https://example.com\n===` renders <h1 id="httpsexamplecom">; measured),
					// so the setext guard below is armed only when the label survives.
					if (key !== '') {
						references.add(key);
						definitionLine = index;
					}
					continue;
				}
			}
		}

		paragraphOpen = true;

		// Setext headings: a line of text underlined by === (H1) or --- (H2). We detect them when we
		// reach the underline line and look back at the text line above it. The text line was already
		// visited on the previous iteration and skipped (it is not ATX), so there is no double count.
		//
		// Guards keep an ordinary `---` (thematic break) or a paragraph's last line from being misread
		// as a heading: the underline must be a run of only = or -, the text line must be a plain
		// paragraph line (non-blank, not ATX, not a list/blockquote/table/fence marker), and the line
		// ABOVE the text line must be blank or the start of the document (a heading stands alone).
		//
		// The fourth guard is the one line the scan already ATE. `reference` and `footnote_def` are BLOCK
		// rules that run before the paragraph/setext logic ever sees the line, so a definition directly
		// under an underline leaves no paragraph for the underline to underline. Measured against Joplin
		// 3.7.6 — every one of these renders NO heading at all:
		//     "[ref]: https://example.com\n==="  → <p>===</p>
		//     "[ref]: https://example.com\n---"  → <hr>
		//     "[^1]: the note\n==="              → nothing (an unreferenced footnote renders nothing)
		//     "[^1]: the note\n---"              → <hr>
		// We used to emit a phantom heading there ("ref: https://example.com", slug `ref-httpsexamplecom`)
		// — an extra bar in the strip whose click landed on nothing, because no rendered element carries
		// that id. Reading the scan's own verdict instead of re-testing the text line is deliberate: the
		// reference branch is gated on `paragraphOpen`, so a second, context-free test could disagree with
		// the scan about the very same line, and it would cost a re-scan on the keystroke hot path.
		const underline = rawLine.match(/^\s{0,3}(=+|-+)\s*$/);
		if (underline) paragraphOpen = false;
		if (underline && index > 0) {
			const textLineRaw = lines[index - 1];
			const textLine = textLineRaw.trim();
			const aboveBlank = index - 2 < 0 || lines[index - 2].trim() === '';
			const looksLikeBlock = /^(#|>|\||[-*+]\s|\d+[.)]\s)/.test(textLine);
			if (textLine !== '' && !looksLikeBlock && aboveBlank && index - 1 !== definitionLine) {
				const level = underline[1][0] === '=' ? 1 : 2;
				// Setext is a genuinely separate code path from ATX, so it resolves its inline content the
				// same way — an ATX-only fix leaves `[Note title](:/…)\n===` raw in the strip and leaves
				// the code-span slug bug alive under an underline. Guard on the RAW text (see above); the
				// recorded line stays the TEXT line, not the underline.
				const raw = textLine.replace(/\s+#*$/, '').trim();
				if (raw) pending.push({ level, raw, line: index - 1 });
			}
		}
	}

	// Phase two. Order is preserved, so the duplicate counter in `slugFor` sees exactly the sequence the
	// old single-pass version fed it.
	for (const h of pending) {
		const r = renderInline(h.raw, footnotes, references);
		headings.push({ level: h.level, text: r.display, line: h.line, slug: slugFor(r.slugSource, seen) });
	}

	return headings;
}
