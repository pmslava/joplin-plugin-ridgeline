// Structural audit: no `joplin.*` member may be READ without being CALLED in the same expression.
//
// `joplin` is not an object, it is sandboxProxy(wrappedTarget). Its get trap PUSHES the property name
// onto a SHARED pending-call path and only the apply trap POPS a segment. So any member read that is
// not immediately called leaves that path permanently one segment too long, and every later call on it
// is rejected host-side with "Property or method X does not exist in ..." — the laurent22/joplin#4569
// class. `const p = joplin.views.panels;` followed by `typeof p.create` is the canonical way to break
// it, and the probe buys nothing anyway: a proxy member is always truthy and always typeof 'function'.
// The plugin API can never be feature-detected by inspection, only called and caught.
//
// Ported from joplin-plugin-cockpit, where this bug ate the clipboard actions (fixed in v2.1.2). The
// rule is deliberately identical there, in harper and here, including the stricter half: namespace
// capture (`const s = joplin.settings`) is rejected even though the proxy nominally tolerates one,
// because the moment such a capture is read a second time the shared path is wrong again.
//
// Ridgeline's only unit-level harness is the heading display/slug matrix (`npm run test:headings`),
// so this runs as its own fast STATIC check instead — `npm run test:sandbox-proxy` locally, and a step
// in the CI build gate the publish flow depends on. It reads source only; nothing has to be built
// first.

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Only the plugin's own source. `api/` is vendored Joplin typing, and `e2e/` is Playwright-side code
// where a local `joplin` variable is a launched-app handle, not the sandbox proxy.
const ROOTS = ['src'];

// Sentinels, not a count: prove the walk really reached the plugin's entry points rather than passing
// vacuously over an empty list (a moved directory would otherwise silently disable this audit).
const SENTINELS = ['src/index.ts', 'src/common.ts', 'src/contentScripts/editorContentScript.ts'];

/**
 * Blank out comments, string/template literals and regex literals, preserving newlines so reported
 * line numbers stay true. Several comment blocks in this repo say "joplin." as prose, and a regex
 * literal's slashes would otherwise swallow the code after it. A `${...}` interpolation is re-entered
 * as code, so a call written inside a template is still audited.
 */
function blankNonCode(source) {
	let out = '';
	let i = 0;
	const n = source.length;
	let prev = '';
	while (i < n) {
		const c = source[i];
		const next = source[i + 1];
		if (c === '/' && next === '/') {
			while (i < n && source[i] !== '\n') {
				out += ' ';
				i++;
			}
			continue;
		}
		if (c === '/' && next === '*') {
			while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
				out += source[i] === '\n' ? '\n' : ' ';
				i++;
			}
			out += '  ';
			i += 2;
			continue;
		}
		if (c === '"' || c === "'") {
			out += ' ';
			i++;
			while (i < n && source[i] !== c) {
				if (source[i] === '\\') {
					out += '  ';
					i += 2;
					continue;
				}
				out += source[i] === '\n' ? '\n' : ' ';
				i++;
			}
			out += ' ';
			i++;
			prev = 'x';
			continue;
		}
		if (c === '`') {
			out += ' ';
			i++;
			while (i < n) {
				if (source[i] === '\\') {
					out += '  ';
					i += 2;
					continue;
				}
				if (source[i] === '`') {
					out += ' ';
					i++;
					break;
				}
				if (source[i] === '$' && source[i + 1] === '{') {
					out += '  ';
					i += 2;
					let depth = 1;
					const start = i;
					while (i < n && depth) {
						if (source[i] === '{') depth++;
						else if (source[i] === '}') depth--;
						if (!depth) break;
						i++;
					}
					out += blankNonCode(source.slice(start, i));
					out += ' ';
					i++;
					continue;
				}
				out += source[i] === '\n' ? '\n' : ' ';
				i++;
			}
			prev = 'x';
			continue;
		}
		// A `/` in operand position opens a regex literal; in operator position it is division.
		if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(prev || '(')) {
			out += ' ';
			i++;
			let inClass = false;
			while (i < n) {
				if (source[i] === '\\') {
					out += '  ';
					i += 2;
					continue;
				}
				if (source[i] === '[') inClass = true;
				else if (source[i] === ']') inClass = false;
				else if (source[i] === '/' && !inClass) break;
				else if (source[i] === '\n') break;
				out += ' ';
				i++;
			}
			out += ' ';
			i++;
			while (i < n && /[a-z]/.test(source[i])) {
				out += ' ';
				i++;
			}
			prev = 'x';
			continue;
		}
		out += c;
		if (!/\s/.test(c)) prev = c;
		i++;
	}
	return out;
}

function collectSourceFiles() {
	const files = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(ts|js)$/.test(entry.name)) files.push(full);
		}
	};
	for (const root of ROOTS) walk(path.join(REPO_ROOT, root));
	return files;
}

function relative(file) {
	return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function main() {
	const files = collectSourceFiles();
	const found = files.map(relative);
	const missing = SENTINELS.filter((sentinel) => !found.includes(sentinel));
	if (missing.length) {
		console.error(
			`Sandbox-proxy audit did not reach ${missing.join(', ')} — it walked ${found.length} file(s). ` +
				'Update ROOTS/SENTINELS in scripts/audit-sandbox-proxy.js if the source tree moved.',
		);
		process.exit(1);
	}

	const offenders = [];
	for (const file of files) {
		// `(joplin as any).x()` is the same one-get-then-call shape, so the cast is normalised away
		// rather than left to hide the expression from the audit. Padded to keep every offset true.
		const code = blankNonCode(fs.readFileSync(file, 'utf8')).replace(
			/\(\s*joplin\s+as\s+any\s*\)/g,
			' joplin        ',
		);
		// The bare `joplin` identifier of the import is not a member read and never matches: the member
		// group is one-or-more. A COMPUTED member that is called at once —
		// `joplin.workspace[eventName](handler)` — is one get plus one apply and is correct, so the rule
		// is about the next character rather than the syntax: whatever follows the chain must be `(`.
		const re = /\bjoplin\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]+\])+/g;
		let match;
		while ((match = re.exec(code)) !== null) {
			const after = (code.slice(match.index + match[0].length).match(/^\s*(\S)/) || [])[1];
			if (after === '(') continue;
			const line = code.slice(0, match.index).split('\n').length;
			offenders.push(`${relative(file)}:${line} -> ${match[0].replace(/\s+/g, '')}`);
		}
	}

	if (offenders.length) {
		console.error(
			'Sandbox-proxy audit FAILED. Rule: no joplin.* member may be read without being called in the ' +
				'same expression — every read pushes a segment onto the shared pending-call path and only a ' +
				'call pops one, so a read left uncalled corrupts every later call on that chain. Offenders:',
		);
		for (const offender of offenders) console.error(`  ${offender}`);
		process.exit(1);
	}

	console.log(
		`Sandbox-proxy audit passed: every joplin.* chain in ${files.length} source file(s) is one ` +
			'uninterrupted read-and-call.',
	);
}

main();
