/**
 * The packer (src/pack.ts): a folder's files become one self-serving HTML file —
 * loader first, the virtual filesystem after it, the entry's stylesheets and scripts inlined,
 * everything else the page as captured.
 */
import { describe, it, expect } from 'vitest';
import { packArchive, escapeTextBlock, headInsertionPoint, resolveKey, inlineCss, mimeFor, rewriteModuleSpecifiers } from '../src/pack.ts';

const ORIGIN = 'https://site.example/paper/';
const enc = (s: string) => ({ bytes: new TextEncoder().encode(s) });

function files(entries: Record<string, string | Uint8Array>): Map<string, { bytes: Uint8Array; type?: string }> {
	const m = new Map<string, { bytes: Uint8Array; type?: string }>();
	for (const [k, v] of Object.entries(entries)) {
		m.set(k, typeof v === 'string' ? enc(v) : { bytes: v });
	}
	return m;
}

describe('escapeTextBlock', () => {
	it('makes text safe inside a text/plain script and stays reversible', () => {
		const text = 'a </script> b <\\/ c \\ d';
		const escaped = escapeTextBlock(text);
		expect(escaped).not.toContain('</');
		const unescaped = escaped.replace(/\\\\|<\\\//g, (m) => (m === '\\\\' ? '\\' : '</'));
		expect(unescaped).toBe(text);
	});
});

describe('headInsertionPoint', () => {
	it('is just past <head>, skipping a comment that mentions one', () => {
		const html = '<!-- <head> --><!doctype html><html><head lang="x"><title>t</title></head></html>';
		expect(html.slice(headInsertionPoint(html) - 15, headInsertionPoint(html))).toBe('<head lang="x">');
	});
	it('falls back to <html>, then to the start', () => {
		expect(headInsertionPoint('<html><body></body></html>')).toBe(6);
		expect(headInsertionPoint('<p>x</p>')).toBe(0);
	});
});

describe('resolveKey', () => {
	it.each([
		['style.css', 'paper/index.html', 'paper/style.css'],
		['../shared/a.png', 'paper/index.html', 'shared/a.png'],
		['/abs/b.json', 'paper/sub/x.html', 'abs/b.json'],
		['x.js', 'paper/sub/page.html', 'paper/sub/x.js'],
		['https://site.example/paper/data/c.json?v=1', 'paper/index.html', 'paper/data/c.json'],
		['https://fonts.example/css?family=F', 'paper/index.html', '_remote/fonts.example/css'],
		['sub/', 'paper/index.html', 'paper/sub/index.html'],
		['data:image/png;base64,AA', 'paper/index.html', null],
		['#top', 'paper/index.html', null],
	])('%s from %s → %s', (ref, from, want) => {
		expect(resolveKey(ref, from, 'https://site.example/paper/')).toBe(want);
	});
});

describe('inlineCss', () => {
	it('turns url() and @import into data: URIs and inlined text', () => {
		const f = files({ 'paper/a.png': new Uint8Array([1, 2, 3]), 'paper/more.css': 'p { x: url(a.png) }' });
		f.get('paper/a.png')!.type = 'image/png';
		const out = inlineCss('@import "more.css" print; body { background: url("a.png") } q { y: url(missing.png) }', 'paper/base.css', f, ORIGIN);
		expect(out).toContain('@media print {\np { x: url("data:image/png;base64,AQID") }\n}');
		expect(out).toContain('background: url("data:image/png;base64,AQID")');
		expect(out).toContain('url(missing.png)');
	});
});

describe('packArchive', () => {
	const f = files({
		'paper/index.html': '<!doctype html><html><head><title>T</title><link rel="stylesheet" href="style.css?v=2"><script src="app.js"></script></head><body><img src="pic.png"><p>hi</p></body></html>',
		'paper/style.css': 'body { background: url(pic.png) }',
		'paper/app.js': 'console.log("</script> inside");',
		'paper/pic.png': new Uint8Array([137, 80]),
		'paper/data/x.json': '{"a":1}',
		'paper/frame/index.html': '<html><head></head><body>nested</body></html>',
	});
	const result = packArchive({ files: f, entry: 'paper/index.html', origin: ORIGIN });
	const html = result.html;

	it('puts the loader first in <head>, configured with origin and entry', () => {
		const at = html.indexOf('<script data-codon-archive');
		expect(at).toBeGreaterThan(0);
		expect(at).toBeLessThan(html.indexOf('<title>'));
		expect(html).toContain(`data-origin="${ORIGIN}" data-entry="paper/index.html"`);
		expect(html).toContain('window.__codonArchive');
	});

	it('embeds every other file as an inert block, text escaped and binaries base64', () => {
		expect(result.files).toBe(5);
		expect(html).toContain('<script type="text/plain" data-codon-file="paper/data/x.json" data-type="application/json" data-enc="text">{"a":1}</script>');
		expect(html).toContain('data-codon-file="paper/pic.png" data-type="image/png" data-enc="base64">iVA=</script>');
		expect(html).toContain('data-codon-file="paper/app.js" data-type="text/javascript" data-enc="text">console.log("<\\/script> inside");</script>');
	});

	it('inlines the entry stylesheet (with its url() as data:) and script, escaped', () => {
		expect(html).toContain('<style data-codon-inlined-from="style.css?v=2">\nbody { background: url("data:image/png;base64,iVA=") }\n</style>');
		expect(html).toContain('<script data-codon-inlined-from="app.js">\nconsole.log("<\\/script> inside");\n</script>');
		expect(html).not.toContain('<link rel="stylesheet"');
	});

	it('leaves images as written for the loader and keeps the rest of the page', () => {
		expect(html).toContain('<img src="pic.png">');
		expect(html).toContain('<p>hi</p>');
	});

	it('gives a nested HTML file its own loader, with its own entry path', () => {
		const block = /data-codon-file="paper\/frame\/index.html"[^>]*>([\s\S]*?)<\/script>/.exec(html)!;
		expect(block[1]).toContain('data-entry="paper/frame/index.html"');
		expect(block[1]).toContain('nested');
	});

	it('refuses to pack without an origin', () => {
		expect(() => packArchive({ files: f, entry: 'paper/index.html', origin: '' })).toThrow(/origin/);
	});
});

describe('ES modules', () => {
	const ALIAS = 'https://codon-archive.invalid';
	it('rewrites relative specifiers the archive holds to the alias host, query dropped, and names them', () => {
		const f = files({ 'paper/assets/a.js': '', 'paper/assets/lib/t.js': '', 'paper/b.js': '' });
		const code = `import { a } from "./lib/t.js?v=2";\nimport '../b.js';\nexport * from './lib/t.js';\nconst x = import("./nope.js");\nimport y from 'bare';\nimport z from "https://cdn.example/z.js";`;
		const r = rewriteModuleSpecifiers(code, 'paper/assets/a.js', f, ORIGIN);
		expect(r.code).toContain(`from "${ALIAS}/paper/assets/lib/t.js"`);
		expect(r.code).toContain(`import '${ALIAS}/paper/b.js'`);
		expect(r.code).toContain(`export * from '${ALIAS}/paper/assets/lib/t.js'`);
		expect(r.code).toContain('import("./nope.js")'); // not in the archive: left alone
		expect(r.code).toContain("from 'bare'");
		expect(r.code).toContain('from "https://cdn.example/z.js"');
		expect(r.keys).toEqual(['paper/assets/lib/t.js', 'paper/b.js']);
	});
	it('packs the closure first, then the import map call, then the rest — specifiers rewritten in the embedded copies', () => {
		const f = files({
			'paper/index.html':
				'<html><head></head><body><script type="module">import { a } from "./assets/a.js?v=2"; import("./assets/b.js")</script><script type="module" src="assets/c.js"></script></body></html>',
			'paper/assets/a.js': 'import * as T from "./lib/t.js"; export const a = T;',
			'paper/assets/lib/t.js': 'export default 1',
			'paper/assets/b.js': 'export {}',
			'paper/assets/c.js': "import './lib/t.js'",
			'paper/other.js': 'x',
		});
		const r = packArchive({ files: f, entry: 'paper/index.html', origin: ORIGIN });
		expect(r.html).toContain(`from "${ALIAS}/paper/assets/a.js"`);
		expect(r.html).toContain(`import("${ALIAS}/paper/assets/b.js")`);
		// the module loaded by src is inlined with specifiers resolved against ITS path, not the entry's
		expect(r.html).toContain(`import '${ALIAS}/paper/assets/lib/t.js'`);
		expect(r.modules).toEqual(['paper/assets/a.js', 'paper/assets/b.js', 'paper/assets/lib/t.js']); // c.js is inlined into the page: only what it imports needs a block
		expect(r.html).toContain(`import * as T from "${ALIAS}/paper/assets/lib/t.js"`); // the embedded copy of a.js
		const call = r.html.indexOf('window.__codonArchive.importMap(');
		expect(call).toBeGreaterThan(r.html.indexOf('data-codon-file="paper/assets/lib/t.js"'));
		expect(call).toBeLessThan(r.html.indexOf('data-codon-file="paper/other.js"'));
		expect(r.html).toContain(JSON.stringify(r.modules));
		expect(f.get('paper/assets/a.js')!.bytes).toEqual(enc('import * as T from "./lib/t.js"; export const a = T;').bytes); // the caller's map is untouched
		expect(r.files).toBe(5);
	});
	it('emits no import map when the page has no modules', () => {
		const r = packArchive({ files: files({ 'paper/index.html': '<html><head></head><body><script>1</script></body></html>', 'paper/x.js': 'x' }), entry: 'paper/index.html', origin: ORIGIN });
		expect(r.modules).toEqual([]);
		expect(r.html).not.toContain('window.__codonArchive.importMap(');
	});
});

describe('mimeFor', () => {
	it.each([
		['a.webp', 'image/webp'],
		['a.JSON', 'application/json'],
		['a.unknown', 'application/octet-stream'],
	])('%s → %s', (p, want) => {
		expect(mimeFor(p)).toBe(want);
	});
});
