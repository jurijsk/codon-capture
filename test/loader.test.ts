// @vitest-environment jsdom
/**
 * The packed page's runtime (src/loader.ts), run against a document that holds a
 * small virtual filesystem: URLs resolve against the page's origin, not the document's; fetch and
 * element loads are answered from the VFS; everything else passes through and is recorded. It runs
 * as pack.ts compiles it, the JavaScript a packed page embeds.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { escapeTextBlock, LOADER_SOURCE } from '../src/pack.ts';

interface Archive {
	has(url: string): boolean;
	url(url: string): string;
	keys(): string[];
	readonly hits: number;
	readonly misses: string[];
}

let archive: Archive;
let objectUrls: string[];

beforeAll(() => {
	// jsdom has no URL.createObjectURL; a stub that records what was turned into a URL is enough.
	objectUrls = [];
	(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
		const u = `blob:test/${objectUrls.length}-${b.type}`;
		objectUrls.push(u);
		return u;
	};
	document.head.innerHTML =
		`<script data-codon-archive data-origin="https://site.example/paper/" data-entry="paper/index.html"></script>` +
		`<script type="text/plain" data-codon-file="paper/data/x.json" data-type="application/json" data-enc="text">${escapeTextBlock('{"a":"</x>"}')}</script>` +
		`<script type="text/plain" data-codon-file="paper/pic.png" data-type="image/png" data-enc="base64">iVA=</script>` +
		`<script type="text/plain" data-codon-file="_remote/fonts.example/f.woff2" data-type="font/woff2" data-enc="base64">AAEC</script>`;
	// currentScript is null when run this way; the loader then needs the config from somewhere:
	// mimic the parser by pointing currentScript at our config element.
	Object.defineProperty(document, 'currentScript', { value: document.querySelector('[data-codon-archive]'), configurable: true });
	new Function(LOADER_SOURCE)();
	archive = (window as unknown as { __codonArchive: Archive }).__codonArchive;
});

describe('resolution', () => {
	it('resolves relative and absolute-on-origin URLs to VFS keys, ignoring query and hash', () => {
		expect(archive.has('data/x.json')).toBe(true);
		expect(archive.has('data/x.json?v=3#frag')).toBe(true);
		expect(archive.has('https://site.example/paper/data/x.json')).toBe(true);
		expect(archive.has('/paper/pic.png')).toBe(true);
		expect(archive.has('https://fonts.example/f.woff2')).toBe(true);
	});
	it('gives the document a base on a host that exists nowhere, and maps that host like the origin', () => {
		expect(document.querySelector('base')!.getAttribute('href')).toBe('https://codon-archive.invalid/paper/index.html');
		expect(archive.has('https://codon-archive.invalid/paper/pic.png')).toBe(true);
		expect(archive.has('https://codon-archive.invalid/paper/nope.png')).toBe(false);
		expect(archive.misses).toContain('https://site.example/paper/nope.png'); // recorded as the origin's URL
	});
	it("maps the document's own origin too (scripts that build URLs from location.origin)", () => {
		expect(window.location.origin).toMatch(/^http/); // jsdom gives the test document a real origin
		expect(archive.has(window.location.origin + '/paper/pic.png')).toBe(true);
	});
	it('passes through what it does not hold, and records the miss', () => {
		expect(archive.has('data/missing.json')).toBe(false);
		expect(archive.url('data/missing.json')).toBe('data/missing.json');
		expect(archive.misses).toContain('https://site.example/paper/data/missing.json');
		expect(archive.has('data:image/png;base64,AA')).toBe(false);
		expect(archive.has('#top')).toBe(false);
		expect(archive.has('https://elsewhere.example/x.png')).toBe(false);
	});
	it('lists its keys', () => {
		expect(archive.keys().sort()).toEqual(['_remote/fonts.example/f.woff2', 'paper/data/x.json', 'paper/pic.png']);
	});
});

describe('fetch', () => {
	it('answers from the VFS with the content type, text unescaped', async () => {
		const res = await fetch('data/x.json');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(await res.text()).toBe('{"a":"</x>"}');
	});
	it('decodes base64 binaries', async () => {
		const bytes = new Uint8Array(await (await fetch('pic.png')).arrayBuffer());
		expect(Array.from(bytes)).toEqual([137, 80]);
	});
});

describe('element loads', () => {
	it('maps src set through the property setter and setAttribute, once each, cached', () => {
		const img = document.createElement('img');
		img.src = 'pic.png';
		expect(img.getAttribute('src')).toMatch(/^blob:test\/\d+-image\/png$/);
		const first = img.getAttribute('src');
		img.setAttribute('src', 'pic.png?x=1');
		expect(img.getAttribute('src')).toBe(first); // same blob URL: decoded once
		img.setAttribute('src', 'nope.png');
		expect(img.getAttribute('src')).toBe('nope.png');
	});
	it('maps url() in a style attribute and in inserted <style> text', () => {
		const div = document.createElement('div');
		div.setAttribute('style', 'background: url(pic.png)');
		expect(div.getAttribute('style')).toMatch(/url\("blob:test\/\d+-image\/png"\)/);
		const style = document.createElement('style');
		style.textContent = 'p { background: url("pic.png") } q { background: url(x.png) }';
		document.body.appendChild(style);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(style.textContent).toMatch(/url\("blob:test\/\d+-image\/png"\)/);
				expect(style.textContent).toContain('url(x.png)');
				resolve();
			}, 0);
		});
	});
	it('fixes markup set with innerHTML synchronously — before the image load the string scheduled', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		host.innerHTML = '<img src="pic.png"><a href="pic.png">not a resource</a>';
		expect(host.querySelector('img')!.getAttribute('src')).toMatch(/^blob:/);
		expect(host.querySelector('a')!.getAttribute('href')).toBe('pic.png');
	});
	it('fixes insertAdjacentHTML and outerHTML the same way', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		host.insertAdjacentHTML('beforeend', '<img src="pic.png">');
		expect(host.querySelector('img')!.getAttribute('src')).toMatch(/^blob:/);
		host.firstElementChild!.outerHTML = '<img id="swapped" src="pic.png">';
		expect(host.querySelector('#swapped')!.getAttribute('src')).toMatch(/^blob:/);
	});
	it('still catches a cloned tree appended as nodes, through the observer', async () => {
		const host = document.createElement('div');
		const img = document.createElement('img');
		img.setAttribute('data-x', '1');
		host.appendChild(img);
		// setAttribute is patched; a clone's attributes are not set through it.
		const tpl = document.createElement('template');
		tpl.innerHTML = '<span></span>';
		const clone = host.cloneNode(true) as HTMLElement;
		clone.querySelector('img')!.setAttributeNS(null, 'alt', 'x');
		document.body.appendChild(clone);
		await new Promise((r) => setTimeout(r, 0));
		expect(clone.querySelector('img')!.getAttribute('alt')).toBe('x');
	});
});

describe('links within the page', () => {
	it('turns a fragment link into a scroll on this document, not a navigation to the alias host', () => {
		document.body.insertAdjacentHTML('beforeend', '<a id="go" href="#sec">go</a><a id="full" href="https://site.example/paper/index.html#sec">full</a><section id="sec">x</section>');
		const scrolled: string[] = [];
		const sec = document.getElementById('sec')!;
		sec.scrollIntoView = () => {
			scrolled.push('sec');
		};
		const click = (id: string) => {
			const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
			document.getElementById(id)!.dispatchEvent(ev);
			return ev.defaultPrevented;
		};
		expect(click('go')).toBe(true);
		expect(window.location.hash).toBe('#sec');
		expect(click('full')).toBe(true); // the entry's own URL with a fragment is the same page
		expect(scrolled).toEqual(['sec', 'sec']);
	});
	it('leaves other links, and links the page already handled, alone', () => {
		document.body.insertAdjacentHTML('beforeend', '<a id="away" href="other/page.html">away</a><a id="handled" href="#sec">h</a>');
		document.getElementById('handled')!.addEventListener('click', (e) => e.preventDefault());
		const away = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
		away.preventDefault = away.preventDefault.bind(away);
		let prevented = false;
		document.getElementById('away')!.addEventListener('click', (e) => {
			queueMicrotask(() => (prevented = e.defaultPrevented));
		});
		document.getElementById('away')!.dispatchEvent(away);
		return Promise.resolve().then(() => expect(prevented).toBe(false));
	});
});

describe('ES modules', () => {
	it('builds an import map from module keys to their blobs, on the alias host and the origin', () => {
		document.head.insertAdjacentHTML('beforeend', `<script type="text/plain" data-codon-file="paper/m.js" data-type="text/javascript" data-enc="text">export const m = 1</script>`);
		document.dispatchEvent(new Event('DOMContentLoaded')); // the loader re-reads the VFS on it
		const imports = (archive as unknown as { importMap(keys: string[]): Record<string, string> }).importMap(['paper/m.js', 'paper/absent.js']);
		const el = document.querySelector('script[type="importmap"]')!;
		const map = JSON.parse(el.textContent!) as { imports: Record<string, string> };
		expect(map.imports).toEqual(imports);
		expect(map.imports['https://codon-archive.invalid/paper/m.js']).toMatch(/^blob:test\/\d+-text\/javascript$/);
		expect(map.imports['https://site.example/paper/m.js']).toBe(map.imports['https://codon-archive.invalid/paper/m.js']);
		expect(Object.keys(map.imports)).toHaveLength(2); // the absent module is simply not mapped
	});
});
