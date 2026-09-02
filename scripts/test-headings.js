// Heading display & slug matrix — the one unit-level harness Ridgeline has.
//
// It defends a contract that no type-check, no build and no lint can see: for a given heading line,
// `parseHeadings` must produce (a) the text a READER sees in the rendered note, and (b) an anchor
// byte-identical to the id Joplin's own renderer puts on that heading. Get (b) wrong by one character
// and the viewer→editor jump dies SILENTLY — `resolveLineFromAnchor` returns null and `handleJump`
// skips the editor scroll with no exception and no warning (src/index.ts). That failure mode is
// invisible to every other check in this repo, and it is why this file exists.
//
// The expectations are not invented: every row was measured against Joplin 3.7.6's real renderer
// bundle (markdown-it + markdown-it-anchor + @joplin/fork-uslug), and the rows that CHANGE an anchor
// versus the old regex-based `cleanForSlug` carry a `was:` comment naming the old, broken value — so
// the fourteen intentional moves read as a reviewed diff rather than as drift.
//
// RULE FOR CONTRIBUTORS: a new heading construct gets a MATRIX row before it gets code.
//
// It compiles `src/inlineText.ts` + `src/headings.ts` straight from source with the repo's own
// TypeScript, so a stale `dist/` can never fool it (and `headings.ts` is bundled TWICE by webpack, so
// a hand-run of one pass can ship two copies that disagree — this check sees neither). Output goes to
// node_modules/.cache, which is already gitignored AND, critically, inside the repo tree: an emitted
// file outside it cannot resolve `require('@joplin/fork-uslug')`.
//
// Zero new npm dependencies: node's assert plus the already-installed typescript and uslug.
// House style follows scripts/audit-sandbox-proxy.js — long WHY header, aligned pass/fail table,
// process.exit(1) on failure.

/* eslint-disable no-console */

const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT = path.join(REPO_ROOT, 'node_modules', '.cache', 'ridgeline-heading-tests');

const NOTE = ':/a1b2c3d4e5f60718293a4b5c6d7e8f90';

// ---------------------------------------------------------------------------
// The matrix. `line` and `level` are asserted too, so a refactor that resolves the text correctly but
// loses the line bookkeeping still fails here rather than at the far end of a 45-minute E2E run.
// ---------------------------------------------------------------------------

const MATRIX = [
	// --- the reported bug and its immediate neighbourhood -------------------
	{ id: 'note-link', raw: '# [Note title](' + NOTE + ')', level: 1, line: 0, display: 'Note title', anchor: 'note-title' },
	{ id: 'note-link-inline', raw: '## See [Note title](' + NOTE + ') for details', level: 2, line: 0, display: 'See Note title for details', anchor: 'see-note-title-for-details' },
	// The :/ID#hash form changes only the onclick payload — guards a fix that only strips bare 32-hex.
	{ id: 'note-link-with-anchor', raw: '# [Note title](' + NOTE + '#some-section)', level: 1, line: 0, display: 'Note title', anchor: 'note-title' },
	// The destination scanner must swallow the quoted title, which becomes the <a title=…> tooltip.
	{ id: 'note-link-title-attr', raw: '# [Note title](' + NOTE + ' "Tooltip")', level: 1, line: 0, display: 'Note title', anchor: 'note-title' },
	{ id: 'external-link', raw: '# [Docs](https://example.com/a?b=1)', level: 1, line: 0, display: 'Docs', anchor: 'docs' },
	{ id: 'external-link-title-attr', raw: '# [Docs](https://example.com "The title")', level: 1, line: 0, display: 'Docs', anchor: 'docs' },
	{ id: 'link-text-emphasis', raw: '# [**Bold** note](' + NOTE + ')', level: 1, line: 0, display: 'Bold note', anchor: 'bold-note' },
	{ id: 'link-text-code', raw: '# [`api` docs](' + NOTE + ')', level: 1, line: 0, display: 'api docs', anchor: 'api-docs' },
	// Guards a greedy match that would swallow everything from the first '[' to the last ')'.
	{ id: 'multiple-links', raw: '# [A](' + NOTE + ') and [B](https://example.com)', level: 1, line: 0, display: 'A and B', anchor: 'a-and-b' },
	// CommonMark allows BALANCED brackets in a label — needs a depth counter, not [^\[\]]*.
	{ id: 'nested-brackets', raw: '# [a [b] c](https://e.example.com)', level: 1, line: 0, display: 'a [b] c', anchor: 'a-b-c' },
	// Balanced parens in the DESTINATION. was: foo-barc (the old non-greedy \(.*?\) stopped at the
	// first ')' and left a stray 'c' in the slug).
	{ id: 'link-parens-in-text-and-url', raw: '# [foo (bar)](https://e.example.com/a(b)c)', level: 1, line: 0, display: 'foo (bar)', anchor: 'foo-bar' },
	// CommonMark forbids links inside links: the OUTER brackets stay literal, only the INNER link
	// unwraps. was: see-x-here
	{ id: 'link-in-link', raw: '# [see [x](https://u.example.com) here](https://e.example.com)', level: 1, line: 0, display: '[see x here](https://e.example.com)', anchor: 'see-x-herehttpseexamplecom' },

	// --- reference links: DELIBERATELY OUT OF SCOPE, pinned so a half-fix fails loudly -------
	// With a '[ref]: :/…' definition elsewhere in the body Joplin renders "See t" / id "see-t".
	// Resolving that needs a whole-body pre-pass, which would make a heading's label depend on a line
	// hundreds of rows away. These two rows record TODAY'S behaviour on purpose.
	{ id: 'ref-link-defined', raw: '# See [t][ref]', level: 1, line: 0, display: 'See [t][ref]', anchor: 'see-tref' },
	{ id: 'ref-link-undefined', raw: '# See [t][ref]', level: 1, line: 0, display: 'See [t][ref]', anchor: 'see-tref' },
	{ id: 'shortcut-ref-undefined', raw: '# [t]', level: 1, line: 0, display: '[t]', anchor: 't' },

	// --- links the renderer makes for you -----------------------------------
	{ id: 'autolink', raw: '# <https://e.example.com/a>', level: 1, line: 0, display: 'https://e.example.com/a', anchor: 'httpseexamplecoma' },
	// linkify is on with fuzzy matching off, so the URL IS the visible text — never delete it.
	{ id: 'bare-url', raw: '# See https://e.example.com/a now', level: 1, line: 0, display: 'See https://e.example.com/a now', anchor: 'see-httpseexamplecoma-now' },
	{ id: 'heading-anchor-link', raw: '# Back to [Overview](#overview)', level: 1, line: 0, display: 'Back to Overview', anchor: 'back-to-overview' },

	// --- images: in NEITHER the id nor textContent ---------------------------
	// The empty anchor is measured. Display falls back to the alt (it fires ONLY when strict parity
	// would be empty), and viewer.js has the same img[alt] fallback so the two surfaces agree.
	// was: alt-text
	{ id: 'image-only', raw: '# ![alt text](https://e.example.com/i.png)', level: 1, line: 0, display: 'alt text', anchor: '' },
	// The alt must propagate OUT of the recursive link-label scan. was: alt-text
	{ id: 'image-in-link', raw: '# [![alt text](https://e.example.com/i.png)](' + NOTE + ')', level: 1, line: 0, display: 'alt text', anchor: '' },

	// --- code spans are opaque to everything --------------------------------
	{ id: 'inline-code', raw: '# The `parseHeadings()` function', level: 1, line: 0, display: 'The parseHeadings() function', anchor: 'the-parseheadings-function' },
	// THE ordering case: the old code stripped links BEFORE backticks and un-linked inside the code
	// span. was: use-text-here
	{ id: 'code-wrapping-link', raw: '# Use `[text](url)` here', level: 1, line: 0, display: 'Use [text](url) here', anchor: 'use-texturl-here' },
	{ id: 'code-wrapping-brackets', raw: '# The `[ ]` checkbox syntax', level: 1, line: 0, display: 'The [ ] checkbox syntax', anchor: 'the-checkbox-syntax' },
	// Backslash escapes are NOT processed inside a code span, so the backslash SURVIVES (measured).
	{ id: 'escape-inside-code', raw: '# Use `a\\*b` here', level: 1, line: 0, display: 'Use a\\*b here', anchor: 'use-ab-here' },

	// --- emphasis -----------------------------------------------------------
	{ id: 'bold', raw: '# A **bold** word', level: 1, line: 0, display: 'A bold word', anchor: 'a-bold-word' },
	{ id: 'italic-star', raw: '# A *italic* word', level: 1, line: 0, display: 'A italic word', anchor: 'a-italic-word' },
	{ id: 'italic-underscore', raw: '# A _under_ word', level: 1, line: 0, display: 'A under word', anchor: 'a-under-word' },
	// uslug KEEPS '~', so an unstripped ~~ leaked straight into the id. was: a-~~strike~~-word
	{ id: 'strike', raw: '# A ~~strike~~ word', level: 1, line: 0, display: 'A strike word', anchor: 'a-strike-word' },
	{ id: 'mark', raw: '# A ==mark== word', level: 1, line: 0, display: 'A mark word', anchor: 'a-mark-word' },

	// --- html, entities, escapes --------------------------------------------
	// html_inline is excluded from the id; the text BETWEEN two tags is not. was: a-bxb-word
	{ id: 'inline-html', raw: '# A <b>x</b> word', level: 1, line: 0, display: 'A x word', anchor: 'a-x-word' },
	// Joplin's own textContent keeps a DOUBLE space here ("a  b"); both our surfaces collapse it.
	{ id: 'html-comment', raw: '# a <!-- c --> b', level: 1, line: 0, display: 'a b', anchor: 'a-b' },
	// text_special becomes the text "&", which uslug then deletes. was: tom-amp-jerry
	{ id: 'entity-amp', raw: '# Tom &amp; Jerry', level: 1, line: 0, display: 'Tom & Jerry', anchor: 'tom-jerry' },
	{ id: 'escape-bracket', raw: '# A \\[not a link\\] here', level: 1, line: 0, display: 'A [not a link] here', anchor: 'a-not-a-link-here' },
	// Unescaped characters must be MASKED from the emphasis pass or these asterisks pair up and vanish.
	{ id: 'escape-star', raw: '# Literal \\*stars\\* here', level: 1, line: 0, display: 'Literal *stars* here', anchor: 'literal-stars-here' },

	// --- whitespace ---------------------------------------------------------
	{ id: 'trailing-hashes', raw: '##  Spaced  heading  ##', level: 2, line: 0, display: 'Spaced heading', anchor: 'spaced-heading' },
	{ id: 'link-text-padded', raw: '# [  Padded title  ](' + NOTE + ')', level: 1, line: 0, display: 'Padded title', anchor: 'padded-title' },

	// --- emoji --------------------------------------------------------------
	// markdown.plugin.emoji defaults to FALSE — do not invent shortcode conversion.
	{ id: 'emoji-shortcode', raw: '# Nice :smile: work', level: 1, line: 0, display: 'Nice :smile: work', anchor: 'nice-smile-work' },
	// uslug unemojifies BEFORE slugging: the id says "rocket" while the visible text keeps the glyph.
	// Regression guard — the display text must never be derived from the slug.
	{ id: 'emoji-char', raw: '# Hello 🚀 world', level: 1, line: 0, display: 'Hello 🚀 world', anchor: 'hello-rocket-world' },

	// --- the two asymmetric constructs --------------------------------------
	// math_inline is excluded from the id. The display shows the KaTeX SOURCE, which is deliberately
	// better than Joplin's own textContent ("Solve x^2x2x^2x2 now" — hidden source + MathML annotation
	// + katex-html all concatenate); viewer.js has a matching walker. was: solve-x2-now
	{ id: 'math-inline', raw: '# Solve $x^2$ now', level: 1, line: 0, display: 'Solve x^2 now', anchor: 'solve-now' },
	// footnote_ref is excluded from the id; the marker is dropped from the display on BOTH surfaces
	// (Joplin's textContent leaks a bare "[1]"). Needs the definition in the body. was: claim1-here
	{ id: 'footnote-ref', raw: '# Claim[^1] here\n\n[^1]: the footnote', level: 1, line: 0, display: 'Claim here', anchor: 'claim-here' },

	// --- false-positive guards: nothing here is a link ----------------------
	{ id: 'task-list-like', raw: '# [ ] Not a task', level: 1, line: 0, display: '[ ] Not a task', anchor: 'not-a-task' },
	{ id: 'plain-parens', raw: '# Notes (see below)', level: 1, line: 0, display: 'Notes (see below)', anchor: 'notes-see-below' },
	// ']' and '(' separated by a space is NOT a link.
	{ id: 'bracket-space-paren', raw: '# [draft] (2024)', level: 1, line: 0, display: '[draft] (2024)', anchor: 'draft-2024' },
	// Both empty, both measured. The heading must still PRODUCE a bar, which is why the emptiness
	// guard in parseHeadings tests the RAW content and not the display string.
	{ id: 'empty-link-text', raw: '# [](' + NOTE + ')', level: 1, line: 0, display: '', anchor: '' },

	// --- CommonMark flanking: six headings that are CORRECT on main ----------
	// Every one of these would be broken by an emphasis stripper without flanking rules. The first two
	// also move their anchor, because uslug KEEPS '_' and the old regex ate intraword underscores.
	// was: snakecasename-here
	{ id: 'snake-case', raw: '# snake_case_name here', level: 1, line: 0, display: 'snake_case_name here', anchor: 'snake_case_name-here' },
	// was: set-myvar-and-othervar-now
	{ id: 'underscore-vars', raw: '# set MY_VAR and OTHER_VAR now', level: 1, line: 0, display: 'set MY_VAR and OTHER_VAR now', anchor: 'set-my_var-and-other_var-now' },
	{ id: 'star-arithmetic', raw: '# 2 * 3 * 4 items', level: 1, line: 0, display: '2 * 3 * 4 items', anchor: '2-3-4-items' },
	{ id: 'cpp-pointers', raw: '# C++ pointers *p and *q', level: 1, line: 0, display: 'C++ pointers *p and *q', anchor: 'c-pointers-p-and-q' },
	{ id: 'double-equals', raw: '# x == y == z', level: 1, line: 0, display: 'x == y == z', anchor: 'x-y-z' },
	// A single '~' is a path, not a strikethrough delimiter — and uslug keeps it.
	{ id: 'tilde-path', raw: '# path ~/a and ~/b', level: 1, line: 0, display: 'path ~/a and ~/b', anchor: 'path-~a-and-~b' },

	// --- setext is a SEPARATE code path -------------------------------------
	{ id: 'setext-h1-note-link', raw: '[Note title](' + NOTE + ')\n===', level: 1, line: 0, display: 'Note title', anchor: 'note-title' },
	{ id: 'setext-h2-inline-link', raw: 'See [Note title](' + NOTE + ') here\n---', level: 2, line: 0, display: 'See Note title here', anchor: 'see-note-title-here' },
	// The same ordering bug as code-wrapping-link, proving the defect lived in the inline layer rather
	// than in the ATX branch. was: use-x-now
	{ id: 'setext-h1-code-link', raw: 'Use `[x](y)` now\n===', level: 1, line: 0, display: 'Use [x](y) now', anchor: 'use-xy-now' },
];

// A body whose fenced block contains a line that looks like a heading: it must contribute NO heading
// and must not consume a duplicate-counter slot. Asserted as a whole-array case because the point is
// the COUNT, not one row.
const FENCED_FAKE_HEADING = {
	id: 'fenced-fake-heading',
	body: '```\n# Not a heading\n```\n\n# Real [link](' + NOTE + ')',
	expected: [{ level: 1, text: 'Real link', line: 4, slug: 'real-link' }],
};

// Sets that MUST be parsed together, in order, as one body: they exercise the duplicate counter, which
// is shared state across the whole note. Parsed individually every one of them would pass vacuously.
const GROUPS = [
	{
		ids: ['dup-link-first', 'dup-plain-second', 'dup-lower-third'],
		body: '# [Same](' + NOTE + ')\n## Same\n### same',
		// uniqueSlug starts the suffix at 2 and the counter is shared across LEVELS; the third differs
		// only in case, which uslug lowercases, so it still collides.
		expected: [
			{ level: 1, text: 'Same', line: 0, slug: 'same' },
			{ level: 2, text: 'Same', line: 1, slug: 'same-2' },
			{ level: 3, text: 'same', line: 2, slug: 'same-3' },
		],
	},
	{
		ids: ['dup-image-empty-anchors-first', 'dup-image-empty-anchors-second'],
		body: '# ![a](https://e.example.com/i.png)\n# ![b](https://e.example.com/j.png)',
		// markdown-it-anchor numbers an EMPTY base too, producing the literal id "-2". This is also why
		// viewer.js's old `|| h.id` fallback had to go: it drew a bar labelled "-2". was: ['a','b']
		expected: [
			{ level: 1, text: 'a', line: 0, slug: '' },
			{ level: 1, text: 'b', line: 1, slug: '-2' },
		],
	},
	{
		ids: ['collide-after-cleaning-first', 'collide-after-cleaning-second'],
		body: '# A ~~x~~\n# A x',
		// The one way a slug change reaches an UNMODIFIED heading: the second line contains no Markdown
		// at all, yet its anchor moves because the heading above it now collides once its markup is
		// resolved. Verified to be exactly what Joplin does. was: ['a-~~x~~', 'a-x']
		expected: [
			{ level: 1, text: 'A x', line: 0, slug: 'a-x' },
			{ level: 1, text: 'A x', line: 1, slug: 'a-x-2' },
		],
	},
];

// ---------------------------------------------------------------------------
// IDENTITY — every heading string the E2E suite asserts on today, verbatim.
//
// Six specs compare `data-text` to a plain string. If any of these 22 strings came back even one byte
// different, those specs would fail 45 minutes into a real-Electron run instead of here in a second.
// The S0 trigger fast path in src/inlineText.ts makes the pass-through structural, and this block is
// the machine-checked proof.
// ---------------------------------------------------------------------------

const IDENTITY = [
	// e2e/helpers.ts HEADINGS
	'Introduction', 'Installation', 'Configuration', 'Usage', 'Advanced Topics', 'Troubleshooting',
	// e2e/helpers.ts MIXED_HEADINGS
	'Alpha One', 'Bravo Two', 'Charlie Three', 'Delta Four', 'Echo Five', 'Foxtrot Six',
	// e2e/helpers.ts buildSetextNoteBody
	'Setext Title', 'Setext Subtitle', 'Real ATX Heading', 'Another ATX Heading',
	// e2e/leading-space-headings.spec.ts HEADINGS
	'Overview', 'Spaced Alpha', 'Spaced Bravo', 'Charlie', 'Spaced Delta',
	// e2e/round1-fixes.spec.ts LONG_HEADING
	'A very long heading that is wider than the panel and so is trimmed to a single line with a CSS ellipsis rather than wrapping',
];

// ---------------------------------------------------------------------------
// PATHOLOGY — adversarial inputs. The point is not today's numbers; it is to fail a future
// regex-based rewrite that reintroduces catastrophic backtracking on a path that runs from the
// CodeMirror updateListener on EVERY keystroke.
//
// The 50 ms budget is applied to `renderInline` — the scanner this repo owns and the thing the budget
// exists to police. It deliberately is NOT applied to `parseHeadings`, because that also calls uslug,
// which on these inputs costs 11-46 ms all by itself and swamps the signal: measured, `'*' x 2000`
// is renderInline 0.02 ms + uslug 38.3 ms, and the 5000-character heading is renderInline 0.08 ms +
// uslug 46.4 ms. uslug is a third-party dependency, unchanged by us and out of our control; folding
// its cost in here would make the check flake at 50 ms while telling us nothing about the scanner.
// Against renderInline the same budget is ~35x headroom over the measured worst case (1.4 ms), which
// is the margin the check was designed to have.
//
// `parseHeadings` is still driven over every input, and still asserted not to throw — the no-throw
// half is about the whole pipeline. It carries only a loose ceiling that exists to catch a genuine
// hang, not to police uslug.
// ---------------------------------------------------------------------------

const PATHOLOGY_BUDGET_MS = 50;
const PATHOLOGY_PIPELINE_CEILING_MS = 500;

const PATHOLOGY = [
	{ name: '600 open brackets', body: '# ' + '['.repeat(600) },
	{ name: '400 image openers', body: '# ' + '!['.repeat(400) },
	{ name: '2000 asterisks', body: '# ' + '*'.repeat(2000) },
	{ name: '500 backticks', body: '# ' + '`'.repeat(500) },
	{ name: '600 close brackets', body: '# ' + ']'.repeat(600) },
	{ name: '900 tildes', body: '# ' + '~'.repeat(900) },
	{ name: '900 underscores', body: '# ' + '_'.repeat(900) },
	{ name: '600 ampersands', body: '# ' + '&'.repeat(600) },
	{ name: '600 angle brackets', body: '# ' + '<'.repeat(600) },
	{ name: '600 dollar signs', body: '# ' + '$'.repeat(600) },
	{ name: '50 nested link openers', body: '# ' + '['.repeat(50) + 'x' + ']('.repeat(50) + 'u' + ')'.repeat(50) },
	{ name: '5000-char heading', body: '# ' + 'a b '.repeat(1250) },
];

// ---------------------------------------------------------------------------

function compile() {
	execFileSync(
		process.execPath,
		[
			require.resolve('typescript/bin/tsc'),
			'src/inlineText.ts',
			'src/headings.ts',
			'--outDir', OUT,
			'--module', 'commonjs',
			'--target', 'es2017',
			'--lib', 'es2017,dom',
			'--esModuleInterop',
			'--skipLibCheck',
		],
		{ cwd: REPO_ROOT, stdio: 'inherit' },
	);
}

const results = [];

function block(name) {
	const entry = { name, passed: 0, failures: [] };
	results.push(entry);
	return {
		check(label, fn) {
			try {
				fn();
				entry.passed++;
			} catch (error) {
				entry.failures.push(`${label}: ${error.message.split('\n').slice(0, 6).join('\n      ')}`);
			}
		},
	};
}

function main() {
	compile();
	const { parseHeadings } = require(path.join(OUT, 'headings.js'));
	const { renderInline } = require(path.join(OUT, 'inlineText.js'));

	// --- 1. MATRIX ----------------------------------------------------------
	const matrix = block('MATRIX');
	const grouped = new Set();
	for (const g of GROUPS) for (const id of g.ids) grouped.add(id);
	for (const row of MATRIX) {
		if (grouped.has(row.id)) continue;
		matrix.check(row.id, () => {
			assert.deepEqual(parseHeadings(row.raw), [
				{ level: row.level, text: row.display, line: row.line, slug: row.anchor },
			]);
		});
	}
	for (const g of GROUPS) {
		matrix.check(g.ids.join(' + '), () => {
			assert.deepEqual(parseHeadings(g.body), g.expected);
		});
	}
	matrix.check(FENCED_FAKE_HEADING.id, () => {
		assert.deepEqual(parseHeadings(FENCED_FAKE_HEADING.body), FENCED_FAKE_HEADING.expected);
	});

	// --- 2. IDENTITY --------------------------------------------------------
	const identity = block('IDENTITY');
	for (const text of IDENTITY) {
		identity.check(JSON.stringify(text.slice(0, 40)), () => {
			const parsed = parseHeadings(`# ${text}`);
			assert.equal(parsed.length, 1, 'exactly one heading');
			assert.equal(parsed[0].text, text, 'display text passes through byte-identical');
		});
	}

	// --- 3. STRUCTURE -------------------------------------------------------
	// The block layer must be exactly as it was: the inline change is not allowed to move a line
	// number, resurrect a fenced fake heading, or loosen a setext guard.
	const structure = block('STRUCTURE');
	structure.check('backtick fence hides a heading', () => {
		assert.deepEqual(parseHeadings('```\n# Hidden\n```\n# Shown').map((h) => h.text), ['Shown']);
	});
	structure.check('tilde fence hides a heading', () => {
		assert.deepEqual(parseHeadings('~~~\n# Hidden\n~~~\n# Shown').map((h) => h.text), ['Shown']);
	});
	structure.check('a ~~~ line inside a ``` fence is content, not a toggle', () => {
		assert.deepEqual(parseHeadings('```\n~~~\n# Hidden\n```\n# Shown').map((h) => h.text), ['Shown']);
	});
	structure.check('multi-line HTML comment hides a heading', () => {
		assert.deepEqual(parseHeadings('<!--\n# Hidden\n-->\n# Shown').map((h) => h.text), ['Shown']);
	});
	structure.check('0-3 spaces of indent are still an ATX heading', () => {
		assert.deepEqual(
			parseHeadings('# A\n # B\n  ## C\n   ### D').map((h) => `${h.level}:${h.text}`),
			['1:A', '1:B', '2:C', '3:D'],
		);
	});
	structure.check('4+ spaces of indent is an indented code block, not a heading', () => {
		assert.deepEqual(parseHeadings('    # Indented').map((h) => h.text), []);
	});
	structure.check('a setext heading records the TEXT line, not the underline', () => {
		assert.deepEqual(parseHeadings('Alpha\n=====\n\nBravo\n-----'), [
			{ level: 1, text: 'Alpha', line: 0, slug: 'alpha' },
			{ level: 2, text: 'Bravo', line: 3, slug: 'bravo' },
		]);
	});
	structure.check('a --- after a paragraph line is a thematic break, not a setext heading', () => {
		assert.deepEqual(parseHeadings('Intro paragraph.\nStill the paragraph.\n---').map((h) => h.text), []);
	});
	structure.check('a list/blockquote line above an underline is not a setext heading', () => {
		assert.deepEqual(parseHeadings('> quoted\n---').map((h) => h.text), []);
	});
	structure.check('an empty heading produces no bar', () => {
		assert.deepEqual(parseHeadings('#\n#   ').map((h) => h.text), []);
	});
	structure.check('#{7} is not a heading', () => {
		assert.deepEqual(parseHeadings('####### Seven').map((h) => h.text), []);
	});

	// --- 4. PATHOLOGY -------------------------------------------------------
	const pathology = block('PATHOLOGY');
	for (const p of PATHOLOGY) {
		pathology.check(p.name, () => {
			// The scanner, timed. This is the assertion that matters.
			const inlineStarted = Date.now();
			const resolved = renderInline(p.body.slice(2));
			const inlineElapsed = Date.now() - inlineStarted;
			assert.equal(typeof resolved.display, 'string', 'renderInline returns a display string');
			assert.ok(
				inlineElapsed <= PATHOLOGY_BUDGET_MS,
				`renderInline took ${inlineElapsed}ms, budget ${PATHOLOGY_BUDGET_MS}ms — a ` +
					'quadratic/backtracking regression in the scanner',
			);

			// The whole pipeline, for the no-throw guarantee (a throw here would kill the CodeMirror
			// updateListener and silently freeze the strip for the rest of the session).
			const pipelineStarted = Date.now();
			const parsed = parseHeadings(p.body);
			const pipelineElapsed = Date.now() - pipelineStarted;
			assert.ok(Array.isArray(parsed), 'parseHeadings returns an array rather than throwing');
			assert.ok(
				pipelineElapsed <= PATHOLOGY_PIPELINE_CEILING_MS,
				`parseHeadings took ${pipelineElapsed}ms, ceiling ${PATHOLOGY_PIPELINE_CEILING_MS}ms — ` +
					'this is a hang guard, not a scanner guard (most of it is uslug)',
			);
		});
	}

	// --- 5. VIEWER DRIFT GUARD ---------------------------------------------
	// src/contentScripts/viewer.js is a MarkdownIt asset copied verbatim: it has no bundler pass and
	// cannot import src/inlineText.ts. Exactly one rule is therefore duplicated across the two files —
	// the whitespace normaliser. A SOURCE comparison would be meaningless (one side is a string
	// scanner, the other a DOM walker), so this pins the one shared literal plus its behaviour; the
	// row-array equality in e2e/heading-links.spec.ts is the behavioural half.
	const drift = block('VIEWER DRIFT GUARD');
	const VIEWER = path.join(REPO_ROOT, 'src', 'contentScripts', 'viewer.js');
	const NORMALISER = ".replace(/\\s+/g, ' ').trim()";
	drift.check('viewer.js still carries the canonical whitespace normaliser', () => {
		const source = fs.readFileSync(VIEWER, 'utf8');
		assert.ok(
			source.includes(NORMALISER),
			`src/contentScripts/viewer.js no longer contains ${NORMALISER}. It MUST stay byte-identical ` +
				'to collapse() in src/inlineText.ts, or the editor and viewer strips will label the same ' +
				'heading differently.',
		);
	});
	drift.check('collapse() is that same rule', () => {
		assert.equal(renderInline('  a   b  ').display, 'a b');
	});

	// --- report -------------------------------------------------------------
	const width = Math.max(...results.map((r) => r.name.length));
	let failed = 0;
	for (const r of results) {
		const total = r.passed + r.failures.length;
		const status = r.failures.length ? 'FAIL' : 'ok';
		console.log(`  ${r.name.padEnd(width)}  ${String(r.passed).padStart(3)}/${String(total).padEnd(3)}  ${status}`);
		failed += r.failures.length;
	}
	if (failed) {
		console.error('\nHeading matrix FAILED. Joplin\'s live behaviour is the authority: if the real app now ' +
			'disagrees with a row, change the row (and say so), never the assertion.\n');
		for (const r of results) {
			for (const f of r.failures) console.error(`  [${r.name}] ${f}`);
		}
		process.exit(1);
	}
	const total = results.reduce((a, r) => a + r.passed, 0);
	const cases = MATRIX.length + GROUPS.reduce((a, g) => a + g.ids.length, 0) + 1;
	console.log(`\nHeading display & slug matrix passed: ${total} checks over ${cases} measured cases.`);
}

main();
