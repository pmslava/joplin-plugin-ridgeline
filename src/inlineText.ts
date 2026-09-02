// Inline Markdown resolution for a heading line: one left-to-right scan producing TWO strings.
//
// `display` mirrors what a reader sees — the rendered `<h*>` element's `textContent` — with links
// unwrapped to their label, code/emphasis markers gone, escapes and entities decoded, whitespace
// collapsed and trimmed. That is the string the strip's bar tooltip and hover-TOC row show, and it is
// the whole point of GitHub issue #1: `## See [Note title](:/0123…)` must read `See Note title`.
//
// `slugSource` mirrors something different and deliberately narrower: the concatenation
// markdown-it-anchor actually slugifies. Joplin loads markdown-it-anchor with a custom `slugify` that
// is bare uslug, and the title it feeds in is
//     children.filter(t => t.type === 'text' || t.type === 'code_inline').reduce((a, t) => a + t.content, '')
// — so only `text` and `code_inline` token contents reach the id. Image alt text, math, footnote
// markers, HTML tags and link destinations do not.
//
// The two strings therefore LEGITIMATELY differ, and no single string can serve both. Two measured
// proofs (real 3.7.6 renderer):
//   `# Solve $x^2$ now`   → display "Solve x^2 now", id "solve-now"   (uslug('Solve x^2 now') = 'solve-x2-now')
//   `# ![alt text](…)`    → display "alt text",      id ""            (uslug('alt text')      = 'alt-text')
// Hence two parallel buffers, filled in the same pass, rather than one string slugified afterwards.
//
// Each buffer is a `{ ch, pr }` pair: `pr[i] === true` marks a character that came OUT of an escape, a
// code span, an autolink, an entity or math, and is therefore invisible to the emphasis pass. That mask
// is what keeps `\*stars\*` showing its asterisks and lets a code span containing `*` survive intact.
//
// PORTABILITY RULE — no tool in this repo can catch a violation, so it is stated here and is a review
// item: ES2017 APIs only (tsconfig pins target/lib es2017, so `replaceAll`/`matchAll` fail the
// type-check — but TypeScript does NOT transpile regex SYNTAX). No lookbehind, no `\p{…}` unicode
// property escapes, no named capture groups, no `s` (dotAll) flag: any of those compile silently here
// and throw at runtime on an older Electron (`manifest.json` declares app_min_version 3.3, while the
// E2E pins 3.7.6 and would never see it). None of them are needed — bracket and paren balance are
// counters, not regexes.
//
// HOT PATH — `parseHeadings` runs from the CodeMirror updateListener on every `docChanged`, over every
// heading. The scan is index-based (indexOf/character comparison/explicit depth counters); no regex
// here has a nested or adjacent quantifier, and the survivors are short anchored probes at the cursor.
// Measured: 10 000 plain headings in 6.5 ms, 10 000 link headings in 70.8 ms, worst adversarial input
// 3.5 ms. Guarded further by the S0 trigger fast path, a 1024-character circuit breaker and a recursion
// depth cap of 4. `scripts/test-headings.js` pins all of this (PATHOLOGY block, 50 ms per input).
//
// SETTINGS ASSUMPTION — the math rule assumes Joplin's `markdown.plugin.katex` is at its default (on)
// and `linkify` likewise; with katex off, `$x^2$` renders literally and Joplin's id becomes
// `solve-x2-now` instead. Surfacing the real global settings is a clean follow-up (see PLAN "Out of
// scope"); nothing else in this module depends on a non-default setting.

/** Beyond this many characters a heading is not worth scanning — see S0. */
const MAX_INLINE_LEN = 1024;

/**
 * If none of these appear in the line there is no inline construct to resolve, so the raw text IS the
 * display text. This makes the pass-through guarantee STRUCTURAL rather than emergent (every plain
 * prose heading in the E2E fixtures takes this branch, byte-identical) and keeps the per-keystroke cost
 * of an ordinary heading at ~0.65 µs.
 */
const TRIGGER = /[\\`<&![\]$*_~=]/;

/**
 * A subset of markdown-it's full HTML5 named-entity table: the XML five, the no-break space, and the
 * punctuation that actually turns up in prose headings. An unlisted name stays literal — `&frac12;`
 * displays as `&frac12;`.
 *
 * A MISS IS NOT FREE, and an earlier version of this comment wrongly claimed it was ("the slug is
 * unaffected either way — uslug deletes & and ;"). uslug deletes the punctuation but KEEPS the letters
 * between it, so an unlisted `# Design &mdash; a note` slugs to `design-mdash-a-note` while Joplin's
 * rendered id is `design-a-note` — a silently dead viewer→editor jump, not merely a display string
 * showing its source. That is why this list is longer than the six basics, and why
 * `entity-unlisted-named` is pinned in scripts/test-headings.js recording what we still get wrong.
 *
 * NBSP is written as an escape, and is U+00A0 rather than a plain space: markdown-it emits the real
 * character, `&nbsp;` and `&#160;` must not decode to two different strings, and a literal NBSP byte
 * here is invisible in a diff and can be normalised away by an editor or a lint autofix.
 */
const ENTITIES: { [name: string]: string } = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
	mdash: '\u2014',
	ndash: '\u2013',
	hellip: '\u2026',
	lsquo: '\u2018',
	rsquo: '\u2019',
	ldquo: '\u201c',
	rdquo: '\u201d',
	copy: '\u00a9',
	reg: '\u00ae',
	trade: '\u2122',
	deg: '\u00b0',
	times: '\u00d7',
	middot: '\u00b7',
};

/**
 * Pushed into a buffer in place of a construct that contributes NO text — an image, an HTML tag or
 * comment, a footnote marker, and math on the slug side. It is protected, so the emphasis pass cannot
 * read it as a delimiter, and `stripEmphasis` deletes every occurrence on its way out, so it can never
 * reach a caller (this is emphatically NOT the raw-NUL leak an earlier prototype shipped).
 *
 * Its whole job is to BREAK a delimiter run. Without it the `**` before an image and the `**` after it
 * become one contiguous run of four, the length gate skips it, and the markers survive into the bar
 * label: `# **![alt](u)** tail` showed "**** tail" against the viewer's "tail". For `~` and `_`, which
 * uslug KEEPS, the merged run moved the anchor too (`~~~~-tail` instead of `tail`).
 *
 * A literal U+0000 in the source cannot be confused with it: markdown-it normalises NUL to U+FFFD
 * before parsing, and branch (i) below does the same.
 */
const SENTINEL = '\u0000';

/** The canonical whitespace rule. Duplicated (by necessity) in `contentScripts/viewer.js` — see D3. */
export function collapse(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

function isAsciiPunct(c: string | undefined): boolean {
	return !!c && /[!-\/:-@\[-`{-~]/.test(c);
}

function isWs(c: string | undefined): boolean {
	return c === undefined || /\s/.test(c);
}

/**
 * markdown-it's own `isValidEntityCode` (common/utils.js), transcribed. A code point it rejects is
 * rendered as U+FFFD, never as the entity source — and, critically, `String.fromCodePoint` THROWS a
 * RangeError above U+10FFFF, which the catch in `renderInline` would turn into "degrade the whole
 * heading back to raw Markdown": the exact issue #1 symptom, resurrected by `# a &#9999999; b`.
 */
function isValidEntityCode(c: number): boolean {
	if (c >= 0xd800 && c <= 0xdfff) return false; // surrogate half
	if (c >= 0xfdd0 && c <= 0xfdef) return false; // never used
	// markdown-it writes these two as `c & 0xFFFF`; the code here is always a non-negative decimal or
	// hex literal, so the modulo is the same test without a bitwise operator.
	if (c % 0x10000 === 0xffff || c % 0x10000 === 0xfffe) return false; // non-characters
	if (c >= 0x00 && c <= 0x08) return false; // control codes
	if (c === 0x0b) return false;
	if (c >= 0x0e && c <= 0x1f) return false;
	if (c >= 0x7f && c <= 0x9f) return false;
	if (c > 0x10ffff) return false;
	return true;
}

/**
 * CommonMark's comment production is narrower than "anything between `<!--` and `-->`": the text may
 * not begin with `>` or `->`, may not contain `--`, and may not end with `-`. Joplin's bundled
 * markdown-it carries it as `<!---->|<!--(?:-?[^>-])(?:-?[^-])*-->`, so `# a <!-- a--b --> c` is NOT a
 * comment — it renders literally and its id is `a-a-b-c`. Written as plain string tests because no
 * lookbehind is available here (see the PORTABILITY RULE above).
 */
function isCommentBody(body: string): boolean {
	if (body === '') return true;
	if (body[0] === '>') return false;
	if (body[0] === '-' && body[1] === '>') return false;
	if (body.indexOf('--') >= 0) return false;
	if (body[body.length - 1] === '-') return false;
	return true;
}

/**
 * The slug source used when the scan is SKIPPED — an over-long heading (S0) or a bug caught below.
 *
 * It is deliberately not `raw`. uslug over raw Markdown folds a link destination into the anchor,
 * including a note link's 32 hex characters, which the regex pair this module replaced never did: a
 * 1100-character heading ending in `[T](:/a1b2…)` slugged to `…yyy-t` before and would slug to
 * `…yyy-ta1b2c3d4…` if we passed raw through. So the fallback is a cheap, linear approximation of that
 * old behaviour — unwrap `[text](dest)`, drop code-span backticks — rather than a strict identity.
 * Both character classes exclude their own delimiters, so there is no nested quantifier to backtrack.
 */
function fallbackSlugSource(raw: string): string {
	let out = raw;
	for (let pass = 0; pass < 8; pass++) {
		const next = out.replace(/\[([^[\]]*)\]\([^()]*\)/g, '$1');
		if (next === out) break;
		out = next;
	}
	return out.replace(/`/g, '');
}

function runLength(src: string, i: number, ch: string): number {
	let n = 0;
	while (src[i + n] === ch) n++;
	return n;
}

// --- balanced scanners -------------------------------------------------------
// CommonMark link labels and destinations nest, so they are counted, not matched by a regex. A
// character class like `[^\[\]]*` gets `[a [b] c](url)` wrong, and a non-greedy `\(.*?\)` stops at the
// first `)` inside `https://e.example.com/a(b)c` — which is exactly the bug that makes main's slug for
// that heading `foo-barc`.

/** Index just past the `]` closing the label that starts at `src[open] === '['`, or -1. */
function matchLabel(src: string, open: number): number {
	let depth = 0;
	let i = open;
	while (i < src.length) {
		const c = src[i];
		if (c === '\\' && isAsciiPunct(src[i + 1])) {
			i += 2;
			continue;
		}
		// A code span inside the label is opaque: its brackets must not move the depth counter.
		if (c === '`') {
			const n = runLength(src, i, '`');
			const close = findFence(src, i + n, n);
			i = close < 0 ? i + n : close + n;
			continue;
		}
		if (c === '[') {
			depth++;
			i++;
			continue;
		}
		if (c === ']') {
			depth--;
			i++;
			if (depth === 0) return i;
			continue;
		}
		i++;
	}
	return -1;
}

/** Index of the backtick run of exactly `n` that closes a code span opened at `from - n`, or -1. */
function findFence(src: string, from: number, n: number): number {
	let i = from;
	while (i < src.length) {
		if (src[i] === '`') {
			const r = runLength(src, i, '`');
			if (r === n) return i;
			i += r;
			continue;
		}
		i++;
	}
	return -1;
}

/** Index just past the `)` closing the destination that starts at `src[open] === '('`, or -1. */
function matchDestination(src: string, open: number): number {
	let depth = 0;
	let i = open;
	while (i < src.length) {
		const c = src[i];
		if (c === '\\' && isAsciiPunct(src[i + 1])) {
			i += 2;
			continue;
		}
		if (c === '(') {
			depth++;
			i++;
			continue;
		}
		if (c === ')') {
			depth--;
			i++;
			if (depth === 0) return i;
			continue;
		}
		if (c === '\n') return -1;
		i++;
	}
	return -1;
}

// --- link reference definitions ----------------------------------------------

/**
 * markdown-it's `normalizeReference` (common/utils.js), transcribed:
 *
 *   `str.trim().replace(/\s+/g, ' ')` … `.toLowerCase().toUpperCase()`
 *
 * so `[The  Guide]` and `[the guide]:` are the SAME label — measured: `# Read [the  guide]` with a
 * `[the guide]:` definition renders "Read the  guide" with id `read-the-guide`.
 *
 * The double case-fold is not a typo and is not the same as one `toLowerCase()`: it is markdown-it's
 * way of collapsing characters whose upper- and lower-case forms are not bijective (ﬀ, ς, ı …). It is
 * transcribed verbatim rather than approximated because it costs nothing to be exact here.
 *
 * markdown-it also carries a `'\u1E9E'.toLowerCase() === '\u1E7E'` guard for an ancient engine that
 * mis-folded capital ẞ; that test is false on every engine this plugin can run on, so the branch it
 * guards is dead and is omitted.
 *
 * The label handed in is the RAW source slice, backslashes intact, on BOTH sides — that is what
 * markdown-it normalises too (`src.slice(labelStart, labelEnd)` and `str.slice(1, labelEnd)`), so
 * `# See [a\]b]` and `[a\]b]: …` still match.
 */
export function normalizeReference(label: string): string {
	return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

/**
 * The label a reference link or image looks up, and the index just past the construct — markdown-it's
 * three forms in one place (`rules_inline/link.js`, the `parseReference` branch):
 *
 *   full      `[text][label]`  the second bracket pair IS the label
 *   collapsed `[text][]`       the second pair is empty, so `if (!label) label = text` fires
 *   shortcut  `[text]`         there is no second pair, and the same fallback fires
 *
 * `textStart` is the first character of the label text (i + 1 for a link, i + 2 for an image) and
 * `labelEnd` the index just past its `]`. When a second `[` opens but never closes, markdown-it leaves
 * `pos` at `labelEnd` and treats the construct as a shortcut, so the stray `[` is scanned again — that
 * is why `end` starts at `labelEnd` and only moves for a complete second pair.
 *
 * The second label is matched WITH nesting allowed, as markdown-it does (`parseLinkLabel(state, pos)`
 * without the disable flag), so `[t][a[b]]` looks up `a[b]` — which no definition can ever carry,
 * because the definition rule rejects a raw `[` in a label. Measured: that heading stays literal.
 */
function referenceAt(src: string, textStart: number, labelEnd: number): { label: string; end: number } {
	let label = '';
	let end = labelEnd;
	if (src[labelEnd] === '[') {
		const second = matchLabel(src, labelEnd);
		if (second > 0) {
			label = src.slice(labelEnd + 1, second - 1);
			end = second;
		}
	}
	if (!label) label = src.slice(textStart, labelEnd - 1);
	return { label, end };
}

/**
 * Is this label defined in the note body? An UNDEFINED label is not a link at all, and markdown-it is
 * precise about the consequence: it emits the opening `[` as literal text and resumes at the next
 * character, so `# See [foo][bar]` with only `foo` defined renders wholly literal — NOT a link on
 * `foo`. Branch (g) reproduces that by falling through to the literal path.
 *
 * The empty label is rejected here rather than merely missing from the set, because it is what
 * `[ ]` and `[]` normalise to: `# [ ] Not a task` must stay a false-positive guard, and a `[ ]:` line
 * cannot define it (markdown-it's definition rule bails on an empty normalised label). Both measured.
 */
function isDefinedReference(references: ReferenceLabels, label: string): boolean {
	if (!references) return false;
	const key = normalizeReference(label);
	return key !== '' && references.has(key);
}

// --- buffers ----------------------------------------------------------------

interface Buffer {
	ch: string[];
	pr: boolean[];
}

function buf(): Buffer {
	return { ch: [], pr: [] };
}

function push(b: Buffer, s: string, prot: boolean): void {
	for (let i = 0; i < s.length; i++) {
		b.ch.push(s[i]);
		b.pr.push(!!prot);
	}
}

function pushBuf(dst: Buffer, src: Buffer): void {
	for (let i = 0; i < src.ch.length; i++) {
		dst.ch.push(src.ch[i]);
		dst.pr.push(src.pr[i]);
	}
}

// --- emphasis ---------------------------------------------------------------

interface Run {
	at: number;
	len: number;
	c: string;
	canOpen: boolean;
	canClose: boolean;
	drop: boolean;
}

/**
 * Strip `* _ ~ =` emphasis delimiters, honouring the protection mask and CommonMark's FLANKING rules.
 *
 * The flanking rules are not optional polish: they are the single place where a naive stripper turns a
 * display string that is already CORRECT on main into a wrong one. All six of these render literally in
 * Joplin and must keep doing so — `snake_case_name`, `set MY_VAR and OTHER_VAR now`, `2 * 3 * 4 items`,
 * `C++ pointers *p and *q`, `x == y == z`, `path ~/a and ~/b`.
 *
 * We match equal-length runs of the same character only, and an unmatched run stays literal. That is a
 * deliberate simplification of markdown-it's delimiter algorithm: exotic nesting like `***a** b*` will
 * not resolve exactly. uslug deletes `*` and `=` anyway, so a mismatch can only ever show a stray marker
 * in the display — never move an anchor. (`_` and `~` DO survive uslug, which is why their rules here
 * are the strict CommonMark ones.)
 */
function stripEmphasis(b: Buffer): string {
	const ch = b.ch;
	const pr = b.pr;
	const n = ch.length;
	const runs: Run[] = [];

	for (let i = 0; i < n; i++) {
		if (pr[i]) continue;
		const c = ch[i];
		if (c !== '*' && c !== '_' && c !== '~' && c !== '=') continue;
		let len = 1;
		while (i + len < n && ch[i + len] === c && !pr[i + len]) len++;
		const runEnd = i + len - 1;
		let at = i;
		if (c === '~' || c === '=') {
			// Strikethrough and mark are TWO-character delimiters. A lone `~` is a path, not a marker; a
			// LONGER run is split the way markdown-it splits it (rules_inline/strikethrough.js) — the odd
			// delimiter is emitted as literal text and the rest nest — so `a ~~~b~~~ c` renders `a ~b~ c`
			// and `a ~~~~b~~~~ c` renders `a b c`. uslug KEEPS `~`, so treating a 3-run as literal moved
			// the anchor as well as the label.
			if (len < 2) {
				i = runEnd;
				continue;
			}
			at = i + (len % 2);
			len -= len % 2;
		}
		if ((c === '*' || c === '_') && len > 3) {
			i = runEnd;
			continue;
		}
		const prev = at > 0 ? ch[at - 1] : undefined;
		const next = at + len < n ? ch[at + len] : undefined;
		const leftFlank = !isWs(next) && (!isAsciiPunct(next) || isWs(prev) || isAsciiPunct(prev));
		const rightFlank = !isWs(prev) && (!isAsciiPunct(prev) || isWs(next) || isAsciiPunct(next));
		let canOpen = leftFlank;
		let canClose = rightFlank;
		if (c === '_') {
			// CommonMark's intraword rule — the reason `snake_case_name` keeps its underscores.
			canOpen = leftFlank && (!rightFlank || isAsciiPunct(prev));
			canClose = rightFlank && (!leftFlank || isAsciiPunct(next));
		}
		runs.push({ at, len, c, canOpen, canClose, drop: false });
		i = runEnd;
	}

	const open: Run[] = [];
	for (let k = 0; k < runs.length; k++) {
		const r = runs[k];
		let matched = false;
		if (r.canClose) {
			for (let j = open.length - 1; j >= 0; j--) {
				if (open[j].c === r.c && open[j].len === r.len) {
					open[j].drop = true;
					r.drop = true;
					open.splice(j, open.length - j);
					matched = true;
					break;
				}
			}
		}
		if (!matched && r.canOpen) open.push(r);
	}

	const drop: boolean[] = new Array(n).fill(false);
	for (let m = 0; m < runs.length; m++) {
		if (!runs[m].drop) continue;
		for (let d = 0; d < runs[m].len; d++) drop[runs[m].at + d] = true;
	}

	// SENTINEL characters are deleted here, on the one path every buffer leaves by, so a placeholder for
	// a text-free construct can never reach a bar label, a tooltip or uslug.
	let out = '';
	for (let q = 0; q < n; q++) if (!drop[q] && ch[q] !== SENTINEL) out += ch[q];
	return out;
}

// --- the scan ---------------------------------------------------------------

interface ScanResult {
	D: Buffer;
	S: Buffer;
	alt: string;
	sawLink: boolean;
}

/**
 * S1 — one left-to-right pass. THE BRANCH ORDER IS LOAD-BEARING; do not reorder:
 *
 *  (a) backslash escape BEFORE (g), so `\[` cannot open a link.
 *  (b) code span BEFORE the escape rule takes effect inside one and BEFORE (g): a code span is opaque
 *      to EVERYTHING, and backslash escapes are NOT processed inside it, so `` Use `a\*b` here ``
 *      displays with the backslash kept (measured against the real renderer). This is precisely the
 *      ordering bug `cleanForSlug` had — it stripped links before backticks, so main slugs
 *      `` # Use `[text](url)` here `` as `use-text-here` instead of `use-texturl-here`.
 *  (e) image BEFORE (g), so a nested image is not mangled by the link branch.
 *  (h) math is display-only: Joplin excludes `math_inline` from the id, but a reader sees the formula.
 *
 * `env` carries the two whole-body facts a heading line cannot know on its own: the `[^label]:`
 * footnote definitions and the `[label]:` link reference definitions — see the `InlineEnv` doc comment.
 */
function scan(src: string, depth: number, allowLinks: boolean, env: InlineEnv): ScanResult {
	const D = buf();
	const S = buf();
	let alt = '';
	let sawLink = false;
	let i = 0;

	while (i < src.length) {
		const c = src[i];

		// (a) backslash escape — the character comes out PROTECTED so the emphasis pass cannot re-read
		// it as a delimiter (`# Literal \*stars\* here` must keep both asterisks).
		if (c === '\\' && isAsciiPunct(src[i + 1])) {
			push(D, src[i + 1], true);
			push(S, src[i + 1], true);
			i += 2;
			continue;
		}

		// (b) code span: a run of N backticks closed by a run of exactly N. Its content reaches BOTH
		// buffers (code_inline.content is counted toward the id) and is fully protected.
		if (c === '`') {
			const n = runLength(src, i, '`');
			const close = findFence(src, i + n, n);
			if (close < 0) {
				// Unclosed run: literal backticks, exactly as markdown-it leaves them.
				push(D, src.slice(i, i + n), false);
				push(S, src.slice(i, i + n), false);
				i += n;
				continue;
			}
			let inner = src.slice(i + n, close);
			// CommonMark: one space is stripped from each end iff both ends have one and the content is
			// not all spaces (`` ` `` ` `` ` `` renders a literal backtick).
			if (inner.length > 1 && inner[0] === ' ' && inner[inner.length - 1] === ' ' && /[^ ]/.test(inner)) {
				inner = inner.slice(1, -1);
			}
			inner = inner.replace(/\n/g, ' ');
			push(D, inner, true);
			push(S, inner, true);
			i = close + n;
			continue;
		}

		// (c) angle brackets: autolink (URL or email) is visible text; an HTML tag or comment is not.
		if (c === '<') {
			const rest = src.slice(i);
			let m = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\x00-\x20]*)>/.exec(rest);
			if (m) {
				push(D, m[1], true);
				push(S, m[1], true);
				i += m[0].length;
				continue;
			}
			m = /^<([^<>\x00-\x20@]+@[^<>\x00-\x20@]+\.[^<>\x00-\x20@]+)>/.exec(rest);
			if (m) {
				push(D, m[1], true);
				push(S, m[1], true);
				i += m[0].length;
				continue;
			}
			m = /^<!--([\s\S]*?)-->/.exec(rest);
			if (m && isCommentBody(m[1])) {
				push(D, SENTINEL, true);
				push(S, SENTINEL, true);
				i += m[0].length;
				continue;
			}
			m = /^<\/?[A-Za-z][A-Za-z0-9\-]*(\s+[^<>]*?)?\/?>/.exec(rest);
			if (m) {
				// html_inline is excluded from the id; the text BETWEEN two tags is not.
				push(D, SENTINEL, true);
				push(S, SENTINEL, true);
				i += m[0].length;
				continue;
			}
			// Not a recognised construct — fall through and emit '<' literally.
		}

		// (d) entity — decoded, and protected so a decoded `*` is not read as emphasis.
		if (c === '&') {
			const e = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(i));
			if (e) {
				const body = e[1];
				let dec: string | null = null;
				if (body[0] === '#') {
					const hex = body[1] === 'x' || body[1] === 'X';
					const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
					dec = isValidEntityCode(code) ? String.fromCodePoint(code) : '\ufffd';
				} else if (Object.prototype.hasOwnProperty.call(ENTITIES, body)) {
					dec = ENTITIES[body];
				}
				if (dec !== null) {
					push(D, dec, true);
					push(S, dec, true);
					i += e[0].length;
					continue;
				}
			}
		}

		// (e) image — contributes to NEITHER buffer (an image token reaches neither textContent nor the
		// id: `# ![alt](…)` renders as `<h1 id="">`). The alt is stashed for the S3 fallback so a
		// heading that would otherwise draw a blank bar still says something.
		//
		// Inline `![alt](dest)` first, then the three REFERENCE forms, exactly as markdown-it's image
		// rule orders them. A reference image with NO definition is not an image at all: the whole thing
		// stays literal, `!` included — `# ![alt text][ref]` renders as `![alt text][ref]`, id
		// `alt-textref` (measured). Note the image rule uses the NESTING-permissive label scan, so it
		// has no no-links-inside-links check to mirror; only the link branch (g) does.
		if (c === '!' && src[i + 1] === '[') {
			const lend = matchLabel(src, i + 1);
			if (lend > 0) {
				let imageEnd = -1;
				if (src[lend] === '(') {
					const dend = matchDestination(src, lend);
					if (dend > 0) imageEnd = dend;
				}
				if (imageEnd < 0) {
					const ref = referenceAt(src, i + 2, lend);
					if (isDefinedReference(env.references, ref.label)) imageEnd = ref.end;
				}
				if (imageEnd > 0) {
					if (!alt) {
						const a = scan(src.slice(i + 2, lend - 1), depth + 1, true, env);
						alt = collapse(stripEmphasis(a.D));
					}
					push(D, SENTINEL, true);
					push(S, SENTINEL, true);
					i = imageEnd;
					continue;
				}
			}
		}

		// (f) footnote reference — excluded from the id, and dropped from the display too (Joplin's own
		// textContent leaks a bare `[1]`, which the viewer walker also skips, so both surfaces agree).
		//
		// ONLY when a `[^label]:` definition exists in the body. markdown-it-footnote's ref rule bails on
		// an unknown label (`if (typeof state.env.footnotes.refs[':' + label] === 'undefined') return
		// false;`), so an UNDEFINED `[^1]` renders literally. Dropping it unconditionally moved the
		// anchor away from Joplin — and, since the viewer can only skip a real `sup.footnote-ref`
		// element, made the two strips disagree — for a plain typo and for the regex negated class in
		// `# Use [^0-9] to match`.
		if (c === '[' && src[i + 1] === '^') {
			const f = /^\[\^([^\]\s]+)\]/.exec(src.slice(i));
			if (f && env.footnotes && env.footnotes.has(f[1])) {
				push(D, SENTINEL, true);
				push(S, SENTINEL, true);
				i += f[0].length;
				continue;
			}
		}

		// (g) link — the label is unwrapped into both buffers; the destination reaches neither.
		//
		// Inline `[text](dest)` is tried first and, when its destination does not close, the REFERENCE
		// forms are tried on the same label — that fallback is markdown-it's own (`parseReference` is
		// set when the `)` is missing), and it is measurable: `# See [ref](unclosed` with a `[ref]:`
		// definition renders "See ref(unclosed", not the literal.
		if (c === '[' && allowLinks && depth < 4) {
			const le = matchLabel(src, i);
			if (le > 0) {
				let linkEnd = -1;
				if (src[le] === '(') {
					const de = matchDestination(src, le);
					if (de > 0) linkEnd = de;
				}
				if (linkEnd < 0) {
					const ref = referenceAt(src, i + 1, le);
					if (isDefinedReference(env.references, ref.label)) linkEnd = ref.end;
				}
				if (linkEnd > 0) {
					// THE NO-LINKS-INSIDE-LINKS RULE — do not omit this. CommonMark forbids a link inside a
					// link, so if the label already produced one, the OUTER brackets are literal text and
					// only the INNER link unwraps. Measured:
					//   `# [see [x](u) here](https://e.example.com)`
					//     display "[see x here](https://e.example.com)", id "see-x-herehttpseexamplecom".
					//   `# [see [x][ref] here][ref]` (ref defined)
					//     display "[see x here]ref",                    id "see-x-hereref".
					// It covers the reference forms for the same reason it covers the inline one:
					// markdown-it scans a LINK label with nesting disabled, so an inner link makes
					// `parseLinkLabel` return -1 and the whole rule fail before it ever looks a label up.
					// The label MUST be scanned with allowLinks = true: scanning it with links disabled can
					// never set sawLink, which silently reintroduces the bug.
					const innerScan = scan(src.slice(i + 1, le - 1), depth + 1, true, env);
					if (!innerScan.sawLink) {
						// An EMPTY label contributes nothing, so like an image it needs a run-breaking
						// sentinel: without one, `# **[](u)** tail` merges its two `**` into a run of four
						// and shows "**** tail".
						if (!innerScan.D.ch.length) push(D, SENTINEL, true);
						if (!innerScan.S.ch.length) push(S, SENTINEL, true);
						pushBuf(D, innerScan.D);
						pushBuf(S, innerScan.S);
						if (!alt && innerScan.alt) alt = innerScan.alt;
						sawLink = true;
						i = linkEnd;
						continue;
					}
					// else: fall through — emit '[' literally and rescan from i+1 so the inner link unwraps
					// on its own and the outer `](url)` stays literal, exactly as CommonMark does.
				}
			}
		}

		// (h) math — ASYMMETRIC on purpose. The KaTeX source goes to the DISPLAY buffer only, because
		// `math_inline` never reaches the id (`# Solve $x^2$ now` → id `solve-now`, measured). Showing
		// the source is also strictly better than Joplin's own textContent for that heading, which
		// concatenates the hidden source, the MathML annotation and the katex-html into
		// "Solve x^2x2x^2x2 now"; viewer.js gets a matching walker so both surfaces show the same string.
		if (c === '$') {
			// `$$…$$` is NOT display math inside a heading. katex's INLINE rule sees an empty span
			// between the first two dollars and emits them literally; its BLOCK rule needs `$$` alone on
			// its own line, which a heading's inline content never is. So Joplin renders the delimiters:
			// `# a $$x^2$$ b` has textContent "a $$x^2$$ b" and id "a-x2-b". Emitting both characters
			// literally reproduces that, and stops the second `$` from opening a spurious inline span.
			if (src[i + 1] === '$') {
				push(D, '$$', false);
				push(S, '$$', false);
				i += 2;
				continue;
			}
			const mm = /^\$([^\s$][^$]*?)\$(?!\d)/.exec(src.slice(i));
			if (mm) {
				push(D, mm[1], true);
				// The slug side gets a placeholder, not the formula: `math_inline` never reaches the id,
				// but the delimiters on either side of it must not merge into one emphasis run.
				push(S, SENTINEL, true);
				i += mm[0].length;
				continue;
			}
		}

		// (i) ordinary character — unprotected, so the emphasis pass can still see it. A literal NUL is
		// normalised to U+FFFD exactly as markdown-it does (core/normalize), which is also what keeps
		// SENTINEL unambiguous.
		const lit = c === SENTINEL ? '\ufffd' : c;
		push(D, lit, false);
		push(S, lit, false);
		i++;
	}

	return { D, S, alt, sawLink };
}

/**
 * The `[^label]:` definitions present in the note body, or null when the caller has none.
 *
 * A footnote MARKER is a footnote only if a definition for it exists somewhere in the body — that is
 * markdown-it-footnote's own rule, not a nicety — so `renderInline` cannot decide branch (f) from the
 * heading line alone. `parseHeadings` collects the labels in the single line scan it already runs and
 * hands them down; a caller with no body (the fast check's direct `renderInline` calls) passes null and
 * gets every `[^…]` literal, which is what Joplin renders for a note that defines no footnotes.
 *
 * The `[label]:` link-reference pre-pass below now rides in the very same loop, for the very same
 * reason and at the same cost.
 */
export type FootnoteLabels = ReadonlySet<string> | null;

/**
 * The NORMALISED `[label]: destination` link reference definitions present in the note body, or null
 * when the caller has none.
 *
 * Same shape and same justification as `FootnoteLabels`, and the same rule decides them: markdown-it
 * resolves `[text][label]`, `[text][]` and `[text]` against `state.env.references`, which the block
 * pass fills from the WHOLE body — so a definition BELOW the heading counts, and a heading with no
 * definition anywhere is literal text. `parseHeadings` collects them in the line scan it already runs;
 * a caller with no body passes null and gets every reference form literal, which is exactly what
 * Joplin renders for a note that defines none.
 *
 * The set holds labels already through `normalizeReference`, so the lookup in `isDefinedReference` is
 * a plain `Set.has` on the hot path and the folding cost is paid once per definition line instead of
 * once per lookup.
 */
export type ReferenceLabels = ReadonlySet<string> | null;

/** The whole-body facts a single heading line cannot determine on its own. */
interface InlineEnv {
	footnotes: FootnoteLabels;
	references: ReferenceLabels;
}

export interface InlineText {
	/** What a reader sees: the rendered `<h*>`'s textContent, whitespace-collapsed and trimmed. */
	display: string;
	/** The `text` + `code_inline` concatenation Joplin hands to uslug. NOT collapsed — uslug does that. */
	slugSource: string;
}

/**
 * Resolve one heading's inline Markdown into the display text and the slug source. Never throws.
 *
 * A throw here would kill the CodeMirror updateListener that calls `parseHeadings` on every keystroke
 * and silently freeze the strip for the rest of the session, so the whole body degrades rather than
 * dying — and every unparseable construct inside the scan falls through to "emit the character
 * literally", never to an error.
 *
 * The degraded value is `collapse(raw)` for the display, which IS what the strip showed before this
 * module existed, and `fallbackSlugSource(raw)` for the slug, which is NOT `raw`: feeding raw Markdown
 * to uslug folds link destinations into the anchor, something the regexes this module replaced never
 * did. See `fallbackSlugSource`.
 */
export function renderInline(
	raw: string,
	footnotes: FootnoteLabels = null,
	references: ReferenceLabels = null,
): InlineText {
	// S0 — guards. The last two make identity for a plain prose heading structural, not emergent.
	if (typeof raw !== 'string') return { display: '', slugSource: '' };
	if (raw.length > MAX_INLINE_LEN) return { display: collapse(raw), slugSource: fallbackSlugSource(raw) };
	if (!TRIGGER.test(raw)) return { display: collapse(raw), slugSource: raw };

	try {
		const r = scan(raw, 0, true, { footnotes, references });
		let display = collapse(stripEmphasis(r.D));
		// S3 — image alt fallback. Fires ONLY when strict parity would be empty (and AFTER the emphasis
		// strip, so `# **![banner](u)**` still falls back rather than labelling the bar "****"), so it can
		// never overwrite real text; `viewer.js` has the same img[alt] fallback so the surfaces agree.
		if (!display && r.alt) display = r.alt;
		return { display, slugSource: stripEmphasis(r.S) };
	} catch (error) {
		return { display: collapse(raw), slugSource: fallbackSlugSource(raw) };
	}
}
