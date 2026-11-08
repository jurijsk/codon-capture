/**
 * pack.ts — pack an archive FOLDER (capture.ts's output, or any folder with an HTML entry and
 * the files it uses) into ONE self-serving HTML file.
 *
 *   codon-capture pack <archive-dir> <out.html> [--entry index.html] [--origin URL] [--verify]
 *
 * The packed file is the entry page with three changes, nothing else:
 *  1. loader.ts, compiled to JavaScript, first in <head> — the runtime that serves the page's resources from inside the
 *     file (fetch, XHR, element loads, runtime CSS; see its header), resolving the page's URLs
 *     against `--origin` (default: `source` in the folder's archive-report.json);
 *  2. the virtual filesystem right after it: every file in the folder except the entry, as an
 *     inert <script type="text/plain" data-codon-file="…"> block — text files escaped, binaries
 *     base64 — used or not, so a resource the page only asks for on some click is there;
 *  3. the entry's own <link rel=stylesheet> and <script src> inlined (url() inside the CSS
 *     resolved to data: URIs), because the parser starts those loads before any script runs and
 *     a <script src> that failed once will not run again. Images and SVG images stay as written;
 *     the loader fixes them as the parser adds them;
 *  4. ES modules resolved ahead of the module loader, which no script can hook: every relative
 *     specifier in the entry's module scripts, and in the modules they reach (the closure, each
 *     rewritten in its embedded copy), becomes an absolute URL on the loader's alias host, and
 *     the closure's blocks come first, followed by a call to the loader's `importMap(keys)` that
 *     sends those URLs to the modules' blobs before the parser meets the first module script.
 * Other HTML files in the folder (a nested frame's page) get the loader injected too, so they
 * work when framed; they find the VFS in the parent document.
 *
 * `--verify` (cli.ts) then opens the packed file in a headless Chrome and drives it (drive.ts): a
 * complete pack shows no network requests and no loader misses.
 *
 * Exports `packArchive({ files, entry, origin })` for use as a library (no filesystem, no browser,
 * no Codon, no VS Code): `files` is a Map of path → { bytes: Uint8Array, type? }. Importing
 * `@jurijsk/codon-capture/pack` loads nothing else.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, posix, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** loader.ts as the JavaScript the packed page runs: a classic script in a <script> tag, so no
 *  module syntax may survive the compile (it imports and exports nothing). The build compiles it
 *  beside this file (tsconfig.loader.json), so the package needs no TypeScript at run time; run
 *  from source, as the tests do, it is compiled here with the same options. */
export const LOADER_SOURCE = existsSync(join(HERE, 'loader.js')) ? readFileSync(join(HERE, 'loader.js'), 'utf8') : await compileLoader(join(HERE, 'loader.ts'));

async function compileLoader(path: string): Promise<string> {
	const { default: ts } = await import('typescript');
	return ts.transpileModule(readFileSync(path, 'utf8'), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Preserve, moduleDetection: ts.ModuleDetectionKind.Legacy, removeComments: false },
	}).outputText;
}

/** One file of an archive: its bytes and, when known, its media type. */
export interface ArchiveFile {
	bytes: Uint8Array;
	type?: string;
}
/** An archive's files by path, relative to the folder (other hosts under `_remote/<host>/…`). */
export type ArchiveFiles = Map<string, ArchiveFile>;

const MIME: Record<string, string> = {
	'.html': 'text/html',
	'.htm': 'text/html',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wasm': 'application/wasm',
	'.bin': 'application/octet-stream',
	'.gz': 'application/gzip',
	'.txt': 'text/plain',
	'.csv': 'text/csv',
	'.xml': 'application/xml',
	'.pdf': 'application/pdf',
	'.map': 'application/json',
};
const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml)|image\/svg)/;

export function mimeFor(path: string): string {
	return MIME[extname(path).toLowerCase()] || 'application/octet-stream';
}

/** Escape text for a <script type="text/plain"> block: the only terminator is `</`, so `</` → `<\/` (and `\` → `\\` to keep it unambiguous). */
export function escapeTextBlock(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/<\//g, '<\\/');
}

/** One VFS block. */
function vfsBlock(path: string, bytes: Uint8Array, type: string): string {
	const isText = TEXT_TYPES.test(type);
	const enc = isText ? 'text' : 'base64';
	const body = isText ? escapeTextBlock(Buffer.from(bytes).toString('utf8')) : Buffer.from(bytes).toString('base64');
	return `<script type="text/plain" data-codon-file="${escapeAttr(path)}" data-type="${escapeAttr(type)}" data-enc="${enc}">${body}</script>`;
}
function escapeAttr(s: string): string {
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The loader as a script element, configured for an HTML file at `entryPath` from `origin`. */
export function loaderTag(origin: string, entryPath: string): string {
	return `<script data-codon-archive data-origin="${escapeAttr(origin)}" data-entry="${escapeAttr(entryPath)}">${LOADER_SOURCE.replace(/<\/script/gi, '<\\/script')}</script>`;
}

/** Index just past the opening <head> tag (first one outside comments), or after <html …>, or 0. */
export function headInsertionPoint(html: string): number {
	const blanked = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
	const head = /<head\b[^>]*>/i.exec(blanked);
	if (head) {
		return head.index + head[0].length;
	}
	const root = /<html\b[^>]*>/i.exec(blanked);
	return root ? root.index + root[0].length : 0;
}

/** A relative reference inside a file at `fromPath`, resolved to a VFS key; null when it points elsewhere. */
export function resolveKey(ref: string, fromPath: string, origin: string): string | null {
	const s = ref.trim();
	if (!s || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(s)) {
		return null;
	}
	let abs: URL;
	try {
		// Keys are root-relative (capture.ts mirrors a URL at its pathname), so a file at `fromPath`
		// lives at `/<fromPath>` on the origin, whatever path the page itself was served from.
		abs = new URL(s, new URL('/' + fromPath, origin));
	} catch {
		return null;
	}
	const originHost = new URL(origin).origin;
	let path = decodeURIComponent(abs.pathname).replace(/^\/+/, '');
	if (path === '' || path.endsWith('/')) {
		path += 'index.html';
	}
	return abs.origin === originHost ? path : `_remote/${abs.host}/${path}`;
}

function dataUri(bytes: Uint8Array, type: string): string {
	return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** The host the loader gives the document as its <base>: a reserved name that resolves nowhere. */
export const ALIAS_HOST = 'https://codon-archive.invalid';

/**
 * ES module `code` that lives at `fromPath`, with every RELATIVE specifier the archive holds
 * (`from "./x"`, `import "./x"`, `import("./x")`, `export … from "./x"`) rewritten to that
 * module's absolute URL on the alias host — the key an import map can match, query dropped.
 * Returns the code and the keys it now names; bare and absolute specifiers, and files the archive
 * lacks, are left as they are.
 */
export function rewriteModuleSpecifiers(code: string, fromPath: string, files: ArchiveFiles, origin: string): { code: string; keys: string[] } {
	const keys: string[] = [];
	const out = code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g, (whole: string, lead: string, q: string, spec: string) => {
		if (!/^(\.\.?\/|\/)/.test(spec)) {
			return whole;
		}
		const key = resolveKey(spec.replace(/[?#][\s\S]*$/, ''), fromPath, origin);
		if (!key || !files.has(key)) {
			return whole;
		}
		if (!keys.includes(key)) {
			keys.push(key);
		}
		return `${lead}${q}${ALIAS_HOST}/${key}${q}`;
	});
	return { code: out, keys };
}

/** CSS with every url()/@import that the files map has turned into a data: URI (imports inlined). */
export function inlineCss(css: string, cssPath: string, files: ArchiveFiles, origin: string, depth = 0): string {
	css = css.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?\s*([^;]*);/g, (whole: string, _q: string, ref: string, media: string) => {
		const key = resolveKey(ref, cssPath, origin);
		const f = key && files.get(key);
		if (!key || !f || depth > 5) {
			return whole;
		}
		const inner = inlineCss(Buffer.from(f.bytes).toString('utf8'), key, files, origin, depth + 1);
		return media.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
	});
	return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole: string, _q: string, ref: string) => {
		const key = resolveKey(ref, cssPath, origin);
		const f = key && files.get(key);
		return key && f ? `url("${dataUri(f.bytes, f.type || mimeFor(key))}")` : whole;
	});
}

/**
 * Inline the entry's <link rel=stylesheet> and <script src> (see the header for why those two),
 * and rewrite the specifiers of every module script, inline or inlined, against its own path;
 * the keys they name go into `modules`. Attribute scans run on a comment-blanked copy so offsets
 * match the real text.
 */
export function inlineStaticLoads(html: string, entryPath: string, files: ArchiveFiles, origin: string, modules: string[] = []): string {
	const blanked = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
	const edits: { start: number; end: number; text: string }[] = [];
	const linkRe = /<link\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = linkRe.exec(blanked)) !== null) {
		const tag = m[0];
		if (!/rel=["'][^"']*stylesheet[^"']*["']/i.test(tag)) {
			continue;
		}
		const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
		const key = href && resolveKey(href, entryPath, origin);
		const f = key && files.get(key);
		if (!href || !key || !f) {
			continue;
		}
		const media = /\bmedia=["']([^"']+)["']/i.exec(tag)?.[1];
		const css = inlineCss(Buffer.from(f.bytes).toString('utf8'), key, files, origin);
		edits.push({
			start: m.index,
			end: m.index + tag.length,
			text: `<style data-codon-inlined-from="${escapeAttr(href)}"${media ? ` media="${escapeAttr(media)}"` : ''}>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`,
		});
	}
	const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
	const noteModules = (keys: string[]) => {
		for (const k of keys) {
			if (!modules.includes(k)) {
				modules.push(k);
			}
		}
	};
	while ((m = scriptRe.exec(blanked)) !== null) {
		const attrs = m[1];
		const isModule = /\btype=["']module["']/i.test(attrs);
		const src = /(?<![\w-])src=["']([^"']+)["']/i.exec(attrs)?.[1];
		if (!src) {
			if (isModule) {
				// An inline module: its specifiers resolve against the document, i.e. the entry. The
				// body is read from the real text (the blanked copy has the same offsets).
				const bodyStart = m.index + m[0].indexOf('>') + 1;
				const inline = html.slice(bodyStart, bodyStart + m[2].length);
				const r = rewriteModuleSpecifiers(inline, entryPath, files, origin);
				if (r.keys.length) {
					noteModules(r.keys);
					edits.push({ start: m.index, end: m.index + m[0].length, text: `<script${attrs}>${r.code}</script>` });
				}
			}
			continue;
		}
		const key = resolveKey(src, entryPath, origin);
		const f = key && files.get(key);
		if (!key || !f) {
			continue;
		}
		const cleaned = attrs.replace(/\s*(?<![\w-])src=["'][^"']+["']/i, '') + ` data-codon-inlined-from="${escapeAttr(src)}"`;
		let body = Buffer.from(f.bytes).toString('utf8');
		if (isModule) {
			// Inlined, the module's relative specifiers would resolve against the entry; rewrite
			// them against the path it actually lived at.
			const r = rewriteModuleSpecifiers(body, key, files, origin);
			noteModules(r.keys);
			body = r.code;
		}
		body = body.replace(/<\/script/gi, '<\\/script');
		edits.push({ start: m.index, end: m.index + m[0].length, text: `<script${cleaned}>\n${body}\n</script>` });
	}
	edits.sort((a, b) => b.start - a.start);
	for (const e of edits) {
		html = html.slice(0, e.start) + e.text + html.slice(e.end);
	}
	return html;
}

/**
 * Pack `files` (Map path → { bytes, type? }) around the entry HTML into one document.
 * Returns the HTML string and what was done.
 */
export function packArchive({ files, entry = 'index.html', origin }: { files: ArchiveFiles; entry?: string; origin?: string }) {
	if (!origin) {
		throw new Error('pack: origin is required (the URL the page came from; archive-report.json has it)');
	}
	const entryFile = files.get(entry);
	if (!entryFile) {
		throw new Error(`pack: entry ${entry} not in files`);
	}
	let html = Buffer.from(entryFile.bytes).toString('utf8');
	// ES modules: the entry's module scripts name modules, those name more; every one in that
	// closure gets its own specifiers rewritten in the copy that is embedded (the caller's map is
	// left alone), and the closure is what the import map covers.
	const modules: string[] = [];
	html = inlineStaticLoads(html, entry, files, origin, modules);
	const embedded = new Map(files);
	// for-of sees the entries pushed while it runs: the closure is walked to its end.
	for (const key of modules) {
		const f = embedded.get(key);
		if (!f) {
			continue;
		}
		const r = rewriteModuleSpecifiers(Buffer.from(f.bytes).toString('utf8'), key, files, origin);
		embedded.set(key, { bytes: Buffer.from(r.code, 'utf8'), type: f.type || mimeFor(key) });
		for (const k of r.keys) {
			if (!modules.includes(k)) {
				modules.push(k);
			}
		}
	}
	let bytesIn = 0;
	const blockFor = (path: string, f: ArchiveFile) => {
		const type = f.type || mimeFor(path);
		let bytes = f.bytes;
		if (type === 'text/html') {
			// A nested page: give it the loader too, so it works when framed (it reads the parent's VFS).
			const nested = Buffer.from(bytes).toString('utf8');
			const at = headInsertionPoint(nested);
			bytes = Buffer.from(nested.slice(0, at) + loaderTag(origin, path) + nested.slice(at), 'utf8');
		}
		bytesIn += bytes.length;
		return vfsBlock(path, bytes, type);
	};
	const blocks: string[] = [];
	// The modules' blocks first, then the import map that points at them — both before the
	// parser can meet a module script — then everything else.
	for (const key of modules) {
		const f = embedded.get(key);
		if (f && key !== entry) {
			blocks.push(blockFor(key, f));
		}
	}
	if (modules.length) {
		blocks.push(`<script>window.__codonArchive.importMap(${JSON.stringify(modules).replace(/</g, '\\u003c')});</script>`);
	}
	for (const [path, f] of embedded) {
		if (path === entry || modules.includes(path)) {
			continue;
		}
		blocks.push(blockFor(path, f));
	}
	const at = headInsertionPoint(html);
	const head = `\n${loaderTag(origin, entry)}\n${blocks.join('\n')}\n`;
	const out = html.slice(0, at) + head + html.slice(at);
	return { html: out, files: embedded.size - 1, modules, bytesIn, bytesOut: Buffer.byteLength(out, 'utf8') };
}

/** Read a folder into the files map pack needs. */
export function readFolder(dir: string): ArchiveFiles {
	const files: ArchiveFiles = new Map();
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const full = join(d, name);
			if (statSync(full).isDirectory()) {
				walk(full);
			} else {
				const rel = relative(dir, full).split(/[\\/]/).join(posix.sep);
				files.set(rel, { bytes: readFileSync(full), type: mimeFor(rel) });
			}
		}
	};
	walk(dir);
	return files;
}
