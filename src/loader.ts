/**
 * loader.ts — the runtime a PACKED page carries: serves the page's own resources from inside the
 * file, so one HTML document works offline, from any location, in any browser, and inside a frame.
 *
 * pack.ts compiles this file to JavaScript — a classic script, so it imports and exports nothing —
 * and embeds it first in <head>, followed by the virtual filesystem (VFS): one inert
 * block per resource,
 *     <script type="text/plain" data-gooder-capture-file="data/x.json" data-type="application/json" data-enc="text">…</script>
 * (`data-enc` is `text` with `\` → `\\` and `</` → `<\/` escaped, or `base64`). Decoding is lazy:
 * a resource costs nothing until something asks for it, then it becomes a Blob and a blob: URL,
 * cached. A page nested in a frame (an embedded HTML file) finds the VFS in its parent document,
 * since both are same-origin blob documents.
 *
 * WHAT IS INTERCEPTED. Every way a page asks for a URL that a script can reach:
 *  - fetch() and XMLHttpRequest: answered from the VFS with the right content type;
 *  - element loads: the `src`/`href`/`poster`/`data`/`srcset` property setters on the element
 *    classes, Element.setAttribute/setAttributeNS, SVGAnimatedString.baseVal (SVG <image href>),
 *    new Image(), new Worker();
 *  - markup inserted at runtime: the innerHTML/outerHTML setters and insertAdjacentHTML fix the
 *    inserted tree SYNCHRONOUSLY (an <img> set as a string asks for its src in the same task,
 *    before any observer runs), and a MutationObserver catches every other way (appendChild of
 *    a cloned tree, the parser) — resource attributes and the `style` attribute's url() refs;
 *  - CSS written at runtime: CSSStyleSheet.insertRule, CSSStyleDeclaration.setProperty, and the
 *    text of added <style> elements, with url() rewritten;
 *  - ES module imports: the module loader resolves specifiers itself and no script can hook it,
 *    so pack.ts rewrites every relative specifier in the modules it embeds to an absolute URL on
 *    the alias host below, and `importMap(keys)` — called right after those modules' blocks,
 *    before any module script is parsed — inserts an import map that sends each of those URLs
 *    to the module's blob.
 * The initial markup is handled by pack.ts (stylesheets and scripts inlined) and by the
 * observer (images and SVG images set as the parser adds them). A dynamic import() with a
 * computed specifier still escapes; drive.ts reports anything that reaches the network.
 *
 * RESOLUTION. The page's URLs are resolved against where it came from (`data-origin` +
 * `data-entry` on this script's element), never against the document's own URL (a blob: URL
 * resolves nothing). A URL on the original origin maps to the VFS path = its pathname; one on
 * another host maps to `_remote/<host>/<pathname>` (how capture.ts mirrors them); anything not
 * in the VFS passes through untouched, and every miss is recorded on `window.__gooderCapture`.
 */

/** What the loader leaves on the page as `window.__gooderCapture`. */
interface CaptureArchive {
	origin: string;
	entry: string;
	has(url: string): boolean;
	url<T>(url: T): T | string;
	keys(): string[];
	importMap(keys: Iterable<string>): Record<string, string>;
	readonly misses: string[];
	readonly hits: number;
}
/** One VFS block, decoded on first use: text stays a string, base64 becomes bytes. */
interface Decoded {
	bytes: Uint8Array<ArrayBuffer> | string;
	type: string;
	blob: Blob;
	url: string;
}

(function () {
	'use strict';
	const win = window as Window & typeof globalThis & { __gooderCapture?: CaptureArchive };
	if (win.__gooderCapture) {
		return;
	}
	const me = document.currentScript;
	const origin = (me && me.getAttribute('data-origin')) || 'https://archive.invalid/';
	const entry = (me && me.getAttribute('data-entry')) || 'index.html';
	// Entry and VFS keys are root-relative paths on the origin (capture.ts mirrors a URL at its pathname).
	const baseUrl = new URL('/' + entry, origin).href;
	const originHost = new URL(origin).origin;
	// The document's own base is useless (a blob: URL resolves nothing) or wrong (a file:// path
	// would make `new Request('data/x.json')` ask the disk). So the page gets a <base> on a host
	// that exists nowhere — a reserved .invalid name — at the entry's path: every relative URL,
	// however it is built, resolves to that host, which keyFor maps like the origin; a load the
	// parser starts before this script can fix it fails at DNS instantly, with no traffic.
	const ALIAS_HOST = 'https://gooder-capture.invalid';
	if (!document.querySelector('base[href]')) {
		const base = document.createElement('base');
		base.setAttribute('href', ALIAS_HOST + '/' + entry);
		(document.head || document.documentElement).insertBefore(base, me ? me.nextSibling : null);
	}

	// ---- the VFS: blocks in this document, else in the parent's (a nested frame) ----------------
	let blocks: Record<string, Element> | null = null;
	function vfsDocument(): Document {
		if (document.querySelector('script[data-gooder-capture-file]')) {
			return document;
		}
		try {
			if (window.parent !== window && window.parent.document.querySelector('script[data-gooder-capture-file]')) {
				return window.parent.document;
			}
		} catch {
			/* cross-origin parent: no VFS there */
		}
		return document;
	}
	function index(): Record<string, Element> {
		if (blocks) {
			return blocks;
		}
		const map: Record<string, Element> = Object.create(null);
		const list = vfsDocument().querySelectorAll('script[data-gooder-capture-file]');
		for (const el of list) {
			map[el.getAttribute('data-gooder-capture-file')!] = el;
		}
		// Before the parser has reached every block, keep looking up fresh; afterwards cache.
		if (document.readyState !== 'loading') {
			blocks = map;
		}
		return map;
	}
	const decoded: Record<string, Decoded> = Object.create(null);
	function unescapeText(s: string): string {
		return s.replace(/\\\\|<\\\//g, function (m) {
			return m === '\\\\' ? '\\' : '</';
		});
	}
	function decode(key: string): Decoded | null {
		if (decoded[key]) {
			return decoded[key];
		}
		const el = index()[key];
		if (!el) {
			return null;
		}
		const type = el.getAttribute('data-type') || 'application/octet-stream';
		let bytes: Uint8Array<ArrayBuffer> | string;
		if (el.getAttribute('data-enc') === 'base64') {
			const bin = atob(el.textContent!.replace(/\s+/g, ''));
			bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) {
				bytes[i] = bin.charCodeAt(i);
			}
		} else {
			bytes = unescapeText(el.textContent!);
		}
		const blob = new Blob([bytes], { type: type });
		decoded[key] = { bytes: bytes, type: type, blob: blob, url: URL.createObjectURL(blob) };
		return decoded[key];
	}

	// ---- URL → VFS key ----------------------------------------------------------------------------
	const misses: string[] = [];
	let hits = 0;
	/** The VFS key for `url`, or null: not a string, not http(s), or not in the VFS (a miss, recorded). */
	function keyFor(url: unknown): string | null {
		if (typeof url !== 'string' || !url) {
			return null;
		}
		const s = url.trim();
		if (/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(s)) {
			return null;
		}
		let abs: URL;
		try {
			abs = new URL(s, baseUrl);
		} catch {
			return null;
		}
		if (abs.protocol !== 'http:' && abs.protocol !== 'https:') {
			return null;
		}
		let path = decodeURIComponent(abs.pathname).replace(/^\/+/, '');
		if (path === '' || path.slice(-1) === '/') {
			path += 'index.html';
		}
		// A script that builds URLs from `location.origin` (seen in the wild: `location.origin +
		// '/neuron-scientist/…'`) lands on the DOCUMENT's origin — the shell's for a blob frame, the
		// server's when served — which is this page's as far as the archive is concerned.
		const docOrigin = window.location.origin;
		const onOrigin = abs.origin === originHost || abs.origin === ALIAS_HOST || (docOrigin && docOrigin !== 'null' && abs.origin === docOrigin);
		const key = onOrigin ? path : '_remote/' + abs.host + '/' + path;
		if (index()[key]) {
			hits++;
			return key;
		}
		// Recorded as the ORIGIN's URL, so capture.ts --fetch-list can go and get it.
		const missed = onOrigin ? originHost + abs.pathname + abs.search : abs.href;
		if (misses.indexOf(missed) === -1) {
			misses.push(missed);
		}
		return null;
	}
	/** A blob: URL for `url` when the VFS has it, else `url` unchanged (whatever it is: setters pass anything). */
	function map<T>(url: T): T | string {
		const key = keyFor(url);
		return key ? decode(key)!.url : url;
	}
	function mapSrcset(value: unknown): string {
		return String(value)
			.split(',')
			.map(function (part) {
				const m = part.trim().match(/^(\S+)(\s+.*)?$/);
				return m ? map(m[1]) + (m[2] || '') : part;
			})
			.join(', ');
	}
	function mapCss(text: string): string {
		return String(text).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (whole, q, ref) {
			const mapped = map(ref);
			return mapped === ref ? whole : 'url("' + mapped + '")';
		});
	}

	// ---- fetch / XHR -------------------------------------------------------------------------------
	const nativeFetch = window.fetch;
	window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		// A URL object has no `url`: undefined, which keyFor passes through.
		const url = typeof input === 'string' ? input : input && (input as Request).url;
		const key = keyFor(url);
		if (key) {
			const d = decode(key)!;
			return Promise.resolve(new Response(d.bytes, { status: 200, headers: { 'content-type': d.type } }));
		}
		return nativeFetch.call(window, input, init);
	};
	const nativeOpen = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
	XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
		args[1] = map(args[1]);
		return nativeOpen.apply(this, args);
	};

	// ---- element loads -----------------------------------------------------------------------------
	const URL_ATTRS: Record<string, 1> = { src: 1, href: 1, 'xlink:href': 1, poster: 1, data: 1 };
	const RESOURCE_TAGS: Record<string, 1> = { img: 1, image: 1, script: 1, link: 1, iframe: 1, video: 1, audio: 1, source: 1, track: 1, embed: 1, object: 1, input: 1, use: 1 };
	function isResourceElement(el: Element): boolean {
		const tag = el.localName;
		if (tag === 'link') {
			const rel = (el.getAttribute('rel') || '').toLowerCase();
			return /stylesheet|icon|preload|modulepreload|manifest/.test(rel);
		}
		return RESOURCE_TAGS[tag] === 1;
	}
	const nativeSetAttribute = Element.prototype.setAttribute;
	const nativeSetAttributeNS = Element.prototype.setAttributeNS;
	Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
		const n = String(name).toLowerCase();
		if (URL_ATTRS[n] && isResourceElement(this)) {
			value = map(value);
		} else if (n === 'srcset') {
			value = mapSrcset(value);
		} else if (n === 'style') {
			value = mapCss(value);
		}
		return nativeSetAttribute.call(this, name, value);
	};
	Element.prototype.setAttributeNS = function (this: Element, ns: string | null, name: string, value: string) {
		const local = String(name).split(':').pop()!.toLowerCase();
		if ((local === 'href' || local === 'src') && isResourceElement(this)) {
			value = map(value);
		}
		return nativeSetAttributeNS.call(this, ns, name, value);
	};
	function patchSetter(proto: object | undefined, prop: string, mapper: (v: unknown) => unknown) {
		if (!proto) {
			return;
		}
		const desc = Object.getOwnPropertyDescriptor(proto, prop);
		const set = desc && desc.set;
		if (!desc || !set) {
			return;
		}
		Object.defineProperty(proto, prop, {
			configurable: true,
			enumerable: desc.enumerable,
			get: desc.get,
			set: function (v: unknown) {
				set.call(this, mapper(v));
			},
		});
	}
	patchSetter(HTMLImageElement.prototype, 'src', map);
	patchSetter(HTMLImageElement.prototype, 'srcset', mapSrcset);
	patchSetter(HTMLScriptElement.prototype, 'src', map);
	patchSetter(HTMLLinkElement.prototype, 'href', map);
	patchSetter(HTMLIFrameElement.prototype, 'src', map);
	patchSetter(HTMLMediaElement.prototype, 'src', map);
	patchSetter(HTMLSourceElement.prototype, 'src', map);
	patchSetter(HTMLSourceElement.prototype, 'srcset', mapSrcset);
	patchSetter(HTMLEmbedElement.prototype, 'src', map);
	patchSetter(HTMLObjectElement.prototype, 'data', map);
	patchSetter(HTMLTrackElement.prototype, 'src', map);
	patchSetter(HTMLInputElement.prototype, 'src', map);
	patchSetter(window.SVGAnimatedString && SVGAnimatedString.prototype, 'baseVal', map);
	if (window.Worker) {
		const NativeWorker = window.Worker;
		// Called with `new`: a constructor that returns an object hands back that object, the native worker.
		window.Worker = function (url: string | URL, opts?: WorkerOptions) {
			return new NativeWorker(map(String(url)), opts);
		} as unknown as typeof Worker;
		window.Worker.prototype = NativeWorker.prototype;
	}

	// ---- CSS written at runtime --------------------------------------------------------------------
	const nativeInsertRule = CSSStyleSheet.prototype.insertRule;
	CSSStyleSheet.prototype.insertRule = function (this: CSSStyleSheet, rule: string, idx?: number) {
		return nativeInsertRule.call(this, mapCss(rule), idx);
	};
	const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty;
	CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, value: string | null, priority?: string) {
		return nativeSetProperty.call(this, name, typeof value === 'string' ? mapCss(value) : value, priority);
	};
	// `el.style.backgroundImage = 'url(…)'` is NOT intercepted: Chromium defines those properties on
	// each style object, not on a prototype, so no setter can be patched. The observer fixes the style
	// attribute right after; the browser has by then asked the alias host once and failed at DNS (no
	// traffic, nothing shown broken). The harness lists these as served late.

	// ---- markup the parser or scripts insert -------------------------------------------------------
	function fixElement(node: Node) {
		if (node.nodeType !== 1) {
			return;
		}
		const el = node as Element;
		const tag = el.localName;
		if (tag === 'script' && el.hasAttribute('data-gooder-capture-file')) {
			return; // a VFS block
		}
		if (isResourceElement(el)) {
			for (const attr in URL_ATTRS) {
				if (el.hasAttribute(attr)) {
					const v = el.getAttribute(attr)!;
					const mapped = map(v);
					if (mapped !== v) {
						nativeSetAttribute.call(el, attr, mapped);
					}
				}
			}
			if (el.hasAttribute('srcset')) {
				const ss = el.getAttribute('srcset')!;
				const mss = mapSrcset(ss);
				if (mss !== ss) {
					nativeSetAttribute.call(el, 'srcset', mss);
				}
			}
		}
		if (el.hasAttribute('style')) {
			const st = el.getAttribute('style')!;
			const mst = mapCss(st);
			if (mst !== st) {
				nativeSetAttribute.call(el, 'style', mst);
			}
		}
		if (tag === 'style' && el.textContent!.indexOf('url(') !== -1) {
			const css = el.textContent!;
			const mcss = mapCss(css);
			if (mcss !== css) {
				el.textContent = mcss;
			}
		}
	}
	function fixTree(root: Node) {
		fixElement(root);
		// A text node has no querySelectorAll.
		const parent = root as Node & Partial<ParentNode>;
		if (parent.querySelectorAll) {
			const all = parent.querySelectorAll('[src],[href],[xlink\\:href],[poster],[data],[srcset],[style],style');
			for (const el of all) {
				fixElement(el);
			}
		}
	}
	const observer = new MutationObserver(function (records) {
		for (const rec of records) {
			if (rec.type === 'attributes') {
				fixElement(rec.target);
			} else {
				for (const node of rec.addedNodes) {
					fixTree(node);
				}
			}
		}
	});
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'xlink:href', 'poster', 'data', 'srcset', 'style'] });
	document.addEventListener('DOMContentLoaded', function () {
		blocks = null;
		fixTree(document.documentElement);
	});
	// Markup set as a string: the observer above runs as a microtask, and so does the image load
	// an <img> in that string schedules — in that order, so the first request went to the alias
	// host and failed before the observer rewrote the src (seen: a widget's thumbnails, each
	// requested twice). Fixing the tree right after the native setter runs before either.
	function patchMarkupSetter(proto: object, prop: string, rootOf: (el: Element) => Node | null) {
		const desc = Object.getOwnPropertyDescriptor(proto, prop);
		const set = desc && desc.set;
		if (!desc || !set) {
			return;
		}
		Object.defineProperty(proto, prop, {
			configurable: true,
			enumerable: desc.enumerable,
			get: desc.get,
			set: function (this: Element, v: unknown) {
				const root = rootOf(this);
				set.call(this, v);
				if (root) {
					fixTree(root);
				}
			},
		});
	}
	patchMarkupSetter(Element.prototype, 'innerHTML', function (el) {
		return el;
	});
	patchMarkupSetter(Element.prototype, 'outerHTML', function (el) {
		return el.parentNode;
	});
	const nativeInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
	Element.prototype.insertAdjacentHTML = function (this: Element, position: InsertPosition, text: string) {
		const result = nativeInsertAdjacentHTML.call(this, position, text);
		fixTree(this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : this);
		return result;
	};

	// ---- links within the page ---------------------------------------------------------------------
	// The <base> above has a cost: `href="#prior-work"` resolves against it too, to the alias host,
	// so the browser treats the click as a navigation to another document — away from the page,
	// onto an error page — instead of a scroll. A link that names a fragment of THIS page (a bare
	// fragment, or the entry's own URL with one) is therefore done here: the target scrolled into
	// view and the fragment set on the document's real URL, which also fires `hashchange` and
	// applies `:target` as the page expects. The page's own handlers go first (bubble phase, and a
	// click the page prevented is left alone).
	function samePageFragment(a: Element): string | null {
		const href = a.getAttribute('href');
		if (!href || href.indexOf('#') === -1) {
			return null;
		}
		if (href.charAt(0) === '#') {
			return href;
		}
		try {
			const u = new URL(href, ALIAS_HOST + '/' + entry);
			const onEntry = (u.origin === ALIAS_HOST || u.origin === originHost) && u.pathname.replace(/^\/+/, '').replace(/(^|\/)$/, '$1index.html') === entry && !u.search;
			return onEntry && u.hash ? u.hash : null;
		} catch {
			return null;
		}
	}
	window.addEventListener('click', function (e) {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
			return;
		}
		const t = e.target as Element | null;
		const a = t && t.closest ? t.closest('a[href]') : null;
		const hash = a && samePageFragment(a);
		if (!hash) {
			return;
		}
		e.preventDefault();
		const id = decodeURIComponent(hash.slice(1));
		const target = id ? document.getElementById(id) || document.getElementsByName(id)[0] : null;
		try {
			window.location.hash = hash; // the document's own URL: a fragment navigation, no reload
		} catch {
			/* some frames refuse; scrolling below is what matters */
		}
		if (target) {
			target.scrollIntoView();
		} else if (hash === '#' || hash === '#top') {
			window.scrollTo(0, 0);
		}
	});

	// ---- ES modules ---------------------------------------------------------------------------------
	/** An import map from every `key` (a module pack.ts embedded, specifiers already absolute) to its blob. */
	function importMap(keys: Iterable<string>): Record<string, string> {
		const imports: Record<string, string> = {};
		for (const key of keys) {
			const d = decode(key);
			if (d) {
				imports[ALIAS_HOST + '/' + key] = d.url;
				imports[originHost + '/' + key] = d.url;
			}
		}
		const s = document.createElement('script');
		s.type = 'importmap';
		s.textContent = JSON.stringify({ imports: imports });
		const at = document.currentScript;
		const parent = at && at.parentNode ? at.parentNode : document.head || document.documentElement;
		parent.insertBefore(s, at ? at.nextSibling : null);
		return imports;
	}

	win.__gooderCapture = {
		origin: origin,
		entry: entry,
		has: function (url: string) {
			return keyFor(url) !== null;
		},
		url: map,
		keys: function () {
			return Object.keys(index());
		},
		importMap: importMap,
		get misses() {
			return misses.slice();
		},
		get hits() {
			return hits;
		},
	};
})();
