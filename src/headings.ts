// Heading extraction from raw Markdown, used by the CodeMirror editor content script.
//
// The slugs generated here must match the anchor ids Joplin puts on rendered headings, so the
// coordinator's scrollToHash jump lands on the right element. Joplin builds those ids with
// laurent22's uslug fork plus a "-2"/"-3" suffix for duplicate headings; we do the same.
//
// Parsing is a line scan (not a full Markdown parse): it is dependency-light, robust enough for the
// smoke build, and tracks fenced code blocks / HTML comment blocks so "#" inside them is ignored.
// Ported from cqroot/joplin-outline's markdownHeaders.ts + markdownSlug.ts.

import uslug from '@joplin/fork-uslug';

export interface EditorHeading {
	level: number;
	text: string;
	line: number; // 0-based line number of the heading in the document
	slug: string;
}

function removeMarkdownLinks(line: string): string {
	let result = line;
	// [text](url) -> text
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const next = result.replace(/\[(.*?)\]\(.*?\)/, '$1');
		if (next === result) break;
		result = next;
	}
	return result;
}

// Strip the inline emphasis/formatting markers uslug would otherwise fold into the slug oddly, so
// the slug matches what Joplin generates from the same heading.
function cleanForSlug(text: string): string {
	let result = removeMarkdownLinks(text);
	// remove inline code backticks but keep content
	result = result.replace(/`([^`]*)`/g, '$1');
	// strip **bold** / *italic* / __ / _ markers (leave the inner text)
	result = result.replace(/(\*\*|__)(.*?)\1/g, '$2');
	result = result.replace(/(\*|_)(.*?)\1/g, '$2');
	return result;
}

function slugFor(text: string, seen: Map<string, number>): string {
	const base = uslug(cleanForSlug(text));
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
				const text = (atxMatch[2] ?? '').trim();
				if (!text) continue;
				headings.push({ level, text, line: index, slug: slugFor(text, seen) });
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
				const cleaned = textLine.replace(/\s+#*$/, '').trim();
				if (cleaned) {
					headings.push({ level, text: cleaned, line: index - 1, slug: slugFor(cleaned, seen) });
				}
			}
		}
	}

	return headings;
}
