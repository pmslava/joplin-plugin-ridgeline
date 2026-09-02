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
 * Deliberately small. markdown-it decodes the full HTML5 named-entity table; we decode the handful that
 * plausibly appear in a heading and leave the rest literal (`&hellip;` stays `&hellip;`). The slug is
 * unaffected either way — uslug deletes `&` and `;` with no separator — so the only cost of a miss is a
 * display string that shows the entity source, which is what today's code does for all of them.
 */
const ENTITIES: { [name: string]: string } = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

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
		// Strikethrough and mark are two-character delimiters only: a lone `~` is a path, not a marker.
		if ((c === '~' || c === '=') && len !== 2) {
			i += len - 1;
			continue;
		}
		if ((c === '*' || c === '_') && len > 3) {
			i += len - 1;
			continue;
		}
		const prev = i > 0 ? ch[i - 1] : undefined;
		const next = i + len < n ? ch[i + len] : undefined;
		const leftFlank = !isWs(next) && (!isAsciiPunct(next) || isWs(prev) || isAsciiPunct(prev));
		const rightFlank = !isWs(prev) && (!isAsciiPunct(prev) || isWs(next) || isAsciiPunct(next));
		let canOpen = leftFlank;
		let canClose = rightFlank;
		if (c === '_') {
			// CommonMark's intraword rule — the reason `snake_case_name` keeps its underscores.
			canOpen = leftFlank && (!rightFlank || isAsciiPunct(prev));
			canClose = rightFlank && (!leftFlank || isAsciiPunct(next));
		}
		runs.push({ at: i, len, c, canOpen, canClose, drop: false });
		i += len - 1;
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

	let out = '';
	for (let q = 0; q < n; q++) if (!drop[q]) out += ch[q];
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
 */
function scan(src: string, depth: number, allowLinks: boolean): ScanResult {
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
			m = /^<!--[\s\S]*?-->/.exec(rest);
			if (m) {
				i += m[0].length;
				continue;
			}
			m = /^<\/?[A-Za-z][A-Za-z0-9\-]*(\s+[^<>]*?)?\/?>/.exec(rest);
			if (m) {
				// html_inline is excluded from the id; the text BETWEEN two tags is not.
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
					dec = String.fromCodePoint(parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10));
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
		if (c === '!' && src[i + 1] === '[') {
			const lend = matchLabel(src, i + 1);
			if (lend > 0 && src[lend] === '(') {
				const dend = matchDestination(src, lend);
				if (dend > 0) {
					if (!alt) {
						const a = scan(src.slice(i + 2, lend - 1), depth + 1, true);
						alt = collapse(stripEmphasis(a.D));
					}
					i = dend;
					continue;
				}
			}
		}

		// (f) footnote reference — excluded from the id, and dropped from the display too (Joplin's own
		// textContent leaks a bare `[1]`, which the viewer walker also skips, so both surfaces agree).
		if (c === '[' && src[i + 1] === '^') {
			const f = /^\[\^[^\]\s]+\]/.exec(src.slice(i));
			if (f) {
				i += f[0].length;
				continue;
			}
		}

		// (g) inline link — the label is unwrapped into both buffers; the destination reaches neither.
		if (c === '[' && allowLinks && depth < 4) {
			const le = matchLabel(src, i);
			if (le > 0 && src[le] === '(') {
				const de = matchDestination(src, le);
				if (de > 0) {
					// THE NO-LINKS-INSIDE-LINKS RULE — do not omit this. CommonMark forbids a link inside a
					// link, so if the label already produced one, the OUTER brackets are literal text and
					// only the INNER link unwraps. Measured:
					//   `# [see [x](u) here](https://e.example.com)`
					//     display "[see x here](https://e.example.com)", id "see-x-herehttpseexamplecom".
					// The label MUST be scanned with allowLinks = true: scanning it with links disabled can
					// never set sawLink, which silently reintroduces the bug.
					const innerScan = scan(src.slice(i + 1, le - 1), depth + 1, true);
					if (!innerScan.sawLink) {
						pushBuf(D, innerScan.D);
						pushBuf(S, innerScan.S);
						if (!alt && innerScan.alt) alt = innerScan.alt;
						sawLink = true;
						i = de;
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
			const mm =
				/^\$\$([\s\S]+?)\$\$/.exec(src.slice(i)) || /^\$([^\s$][^$]*?)\$(?!\d)/.exec(src.slice(i));
			if (mm) {
				push(D, mm[1], true);
				i += mm[0].length;
				continue;
			}
		}

		// (i) ordinary character — unprotected, so the emphasis pass can still see it.
		push(D, c, false);
		push(S, c, false);
		i++;
	}

	return { D, S, alt, sawLink };
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
 * and silently freeze the strip for the rest of the session, so the whole body degrades to today's
 * behaviour (`{ display: collapse(raw), slugSource: raw }`) rather than dying — and every unparseable
 * construct inside the scan falls through to "emit the character literally", never to an error.
 */
export function renderInline(raw: string): InlineText {
	// S0 — guards. The last two make identity for a plain prose heading structural, not emergent.
	if (typeof raw !== 'string') return { display: '', slugSource: '' };
	if (raw.length > MAX_INLINE_LEN) return { display: collapse(raw), slugSource: raw };
	if (!TRIGGER.test(raw)) return { display: collapse(raw), slugSource: raw };

	try {
		const r = scan(raw, 0, true);
		let display = collapse(stripEmphasis(r.D));
		// S3 — image alt fallback. Fires ONLY when strict parity would be empty, so it can never
		// overwrite real text; `viewer.js` has the same img[alt] fallback so the two surfaces agree.
		if (!display && r.alt) display = r.alt;
		return { display, slugSource: stripEmphasis(r.S) };
	} catch (error) {
		return { display: collapse(raw), slugSource: raw };
	}
}
