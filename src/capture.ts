/**
 * capture.ts — archive a web page as a FOLDER that works offline, interactions included.
 *
 *   gooder-capture <url> <out-dir> [--keep-tracking] [--no-drive] [--rounds N]
 *
 * Why a folder and not one file (docs/html-documents-plan.md, "Direction"): a page's scripts
 * fetch what they need by relative URL at runtime — JSON for a figure, a thumbnail per click, a
 * script injected on demand — and a single file cannot answer those requests without a shim
 * inside someone else's page. A folder that mirrors the site's own paths can: `<out-dir>/index.html`
 * is the page as served, every resource sits where the page already looks for it, and nothing in
 * the page is rewritten except references to OTHER hosts (mirrored under `_remote/<host>/…`, so
 * fonts and such are local too) and, unless `--keep-tracking`, the analytics it carried.
 * Single-file embedding is a separate task that can start from this folder.
 *
 * Two phases, because reading the page is not enough:
 *  1. STATIC: every URL the markup, its stylesheets (recursively) and its scripts mention is
 *     fetched and mirrored — attributes (`src`, `href`, `data-src`, `data-lazy-href`, `srcset`,
 *     `poster`, SVG `href`), CSS `url()` and `@import`, and path-like string literals in script
 *     text. Mentioned-but-unused resources are kept on purpose.
 *  2. DRIVE: the mirror is served locally — a server that FETCHES WHAT IT LACKS: a request for a
 *     path the folder does not have is fetched from the origin right then, saved, and served —
 *     and opened in a real Chrome (puppeteer-core, headless). The page is scrolled to the end,
 *     every control worked in passes (an "expand" reveals controls; a "next" is pressed until
 *     nothing new loads; see drive.ts), every figure hotspot hovered. The page is complete as it
 *     is used; a second round that fetched nothing is the proof, and never more than `--rounds`
 *     (5) rounds run. A DRIVE JOURNAL (drive-journal.json) records the steppers walked to
 *     exhaustion, so a run cut short by its time budget — or a run next month — continues where
 *     the last one stopped instead of pressing the same "next" eighty times again. A control that
 *     would open ANOTHER page in this one's place (a button setting `location`, a submit button,
 *     a link) is refused before anything is fetched and listed in the report's `navigations`:
 *     that page is not the one being archived, and a new document would end the drive mid-page.
 *  2'. TRAIL (`--trail`): the same server, a VISIBLE browser, and a person instead of the driver:
 *     browse the page, click what matters, and every resource it asks for is saved as you go,
 *     listed on the console; close the window to finish. For a page too large or too branching
 *     to click through blindly, a human trailblazes and the drive fills in behind, or the other
 *     way round — both write to the same folder, both are incremental.
 *     Requests to other hosts during the drive are mirrored under `_remote/` too, but a script's
 *     runtime URL cannot be rewritten, so they are listed in the report for the embed task.
 *
 * TRACKING (default: stripped, `--keep-tracking` to leave it): `<script>` elements whose src or
 * text names a known analytics/beacon service, and the `<link rel=preconnect|dns-prefetch>`,
 * `<img>`, `<iframe>` and `<noscript>` blocks pointing at those hosts. Every removal is listed in
 * the report. The list is TRACKER_PATTERNS below — extend it as pages turn up new ones.
 *
 * BUDGETS, because a page can ask without end (a thumbnail per neuron, a map widget's tiles): at
 * most `--max-files` (2000), `--max-total-mb` (200) in all, `--max-file-mb` (25) per file, paths
 * matching `--deny <regex>` never. Requests the page makes at runtime to OTHER hosts are listed in
 * the report, not fetched, unless `--mirror-remote`. A file already in the folder is reused, so a
 * rerun is incremental (`--refresh` to fetch everything again). Every refusal is in the report's
 * `skipped`, and `budget.exhausted` says the archive is cut short rather than complete.
 *
 * Output: `<out-dir>/index.html`, the mirrored tree, and `<out-dir>/archive-report.json` (source,
 * date, counts, bytes, what was stripped, what the origin did not have, what the drive still
 * fetched from other hosts). Rerunning into the same folder refreshes it.
 *
 * Node 22+ (global fetch). Chrome or Edge on this machine for the drive phase.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, extname, normalize, relative, posix } from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchBrowser, exercise, stayOnPage } from './drive.ts';
import type { DriveStats } from './drive.ts';

// ---- arguments ---------------------------------------------------------------------------------
const args = process.argv.slice(2);
const VALUED = new Set(['--rounds', '--max-files', '--max-total-mb', '--max-file-mb', '--max-pages', '--deny', '--fetch-list']);
const flags = new Set<string>();
const values = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i += 1) {
	const a = args[i];
	if (VALUED.has(a)) {
		values.set(a, args[i + 1]);
		i += 1;
	} else if (a.startsWith('--')) {
		flags.add(a);
	} else {
		positional.push(a);
	}
}
const [pageUrlArg, outDirArg] = positional;
if (!pageUrlArg || !outDirArg) {
	console.error(
		'usage: gooder-capture <url> <out-dir> [--keep-tracking] [--no-drive] [--rounds N] [--max-files N] [--max-total-mb N] [--max-file-mb N] [--deny <regex>] [--max-pages N] [--mirror-remote] [--refresh] [--trail]',
	);
	process.exit(2);
}
const PAGE_URL = new URL(pageUrlArg);
const OUT_DIR = normalize(outDirArg);
const STRIP_TRACKING = !flags.has('--keep-tracking');
const DRIVE = !flags.has('--no-drive');
// RECURSION CAP: a drive round can add a resource (a script injected at runtime) that asks for
// more on the next drive. Rounds stop as soon as one adds nothing, and never exceed this many —
// the rule is "no more than 5 recursive pulls", whatever the page keeps asking for.
const MAX_ROUNDS = Number(values.get('--rounds')) || 5;
// BUDGETS — the archive is bounded by construction, whatever the page asks for. A figure that
// fetches a thumbnail per neuron, or a map widget pulling tiles, can request without end; the
// drive phase would follow it. Each cap is reported when it bites, so a truncated archive says so.
const MAX_FILES = Number(values.get('--max-files')) || 2000;
const MAX_TOTAL_BYTES = (Number(values.get('--max-total-mb')) || 200) * 1e6;
const MAX_FILE_BYTES = (Number(values.get('--max-file-mb')) || 25) * 1e6;
/** SUB-PAGES: a request the browser marks as a document or a frame (`Sec-Fetch-Dest`) is another
 *  page of the site — a gallery that shows a paper per click in a frame can ask for hundreds, each
 *  with its own assets (seen: 69 of them, 152 MB, before the origin dropped the connection). At
 *  most this many are fetched on demand; the rest are refused and listed in the report, for a
 *  human to raise the cap or trail the ones that matter. */
const MAX_PAGES = Number(values.get('--max-pages')) || 20;
/** Paths matching this are never fetched (`--deny 'data/huge/|\.mp4$'`). */
const DENY = values.has('--deny') ? new RegExp(values.get('--deny')!) : null;
/** Runtime requests to OTHER hosts are listed, not fetched, unless asked: they are the unbounded
 *  case (tile servers, CDN galleries), and a script's runtime URL cannot be rewritten to the
 *  mirror anyway. Static references to other hosts (a fonts stylesheet) are always mirrored. */
const MIRROR_REMOTE_RUNTIME = flags.has('--mirror-remote');
/** A file already in the folder is kept, so a rerun is incremental; `--refresh` fetches everything again. */
const REFRESH = flags.has('--refresh');
/** Human-driven capture: open the mirror in a visible browser and save what the browsing asks for. */
const TRAIL = flags.has('--trail');
/** `pack.ts --verify` writes the URLs a packed page still asked for to `pack-misses.json`; this
 *  fetches exactly those (same-origin ones) into the folder — the coverage loop's return path. */
const FETCH_LIST: { misses?: string[]; requests?: string[] } | null = values.has('--fetch-list') ? JSON.parse(readFileSync(values.get('--fetch-list')!, 'utf8')) : null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// ---- what counts as tracking -------------------------------------------------------------------
/** Hosts and script fingerprints of analytics, tag managers, session recorders and beacons. */
const TRACKER_PATTERNS = [
	/googletagmanager\.com/i,
	/google-analytics\.com/i,
	/\bgtag\s*\(/,
	/\bga\s*\(\s*['"]create['"]/,
	/plausible\.io/i,
	/plausible\s*\(/,
	/data-domain=/i, // plausible's tag
	/segment\.(com|io)/i,
	/analytics\.js/i,
	/hotjar\.com/i,
	/mixpanel\.com/i,
	/connect\.facebook\.net/i,
	/\bfbq\s*\(/,
	/clarity\.ms/i,
	/matomo|piwik/i,
	/\b_paq\b/,
	/posthog\.com/i,
	/amplitude\.com/i,
	/intercom(cdn)?\.(com|io)/i,
	/hubspot\.com|hs-scripts\.com/i,
	/sentry\.io|sentry-cdn\.com/i,
	/cdn\.heapanalytics\.com/i,
	/fullstory\.com/i,
	/doubleclick\.net/i,
	/newrelic\.com|nr-data\.net/i,
	/navigator\.sendBeacon\s*\(/,
];
const isTracking = (text: string) => TRACKER_PATTERNS.some((re) => re.test(text));

// ---- fetching and the mirror -------------------------------------------------------------------
/** archive-report.json. */
interface ArchiveReport {
	source: string;
	archivedAt: string;
	outDir: string;
	/** The entry page's path in the folder, set once the static phase has written it. */
	page?: string;
	trackingStripped: string[];
	mirrored: number;
	mirroredBytes: number;
	remote: number;
	missingAtOrigin: string[];
	literalMisses: string[];
	runtimeRemote: string[];
	skipped: { url: string; reason: string }[];
	budget: { maxFiles: number; maxTotalMB: number; maxFileMB: number; maxPages: number; deny: string | null; exhausted: boolean };
	reused: number;
	onDemand: string[];
	pages: string[];
	skippedPages: string[];
	/** Other pages a control in the driven page tried to open in its place: refused, not fetched. */
	navigations: string[];
	rounds: (DriveStats & { round: number; fetchedOnDemand: string[]; remote: string[] })[];
	trail?: { at: string; fetched: number };
}
const report: ArchiveReport = {
	source: PAGE_URL.href,
	archivedAt: new Date().toISOString(),
	outDir: OUT_DIR,
	trackingStripped: [],
	mirrored: 0,
	mirroredBytes: 0,
	remote: 0,
	missingAtOrigin: [],
	/** Path-like literals from script/JSON text the origin did not have — probably relative to a
	 *  base the script computes (`"examples/0-0-0.webp"` under a figure's asset folder), not gaps. */
	literalMisses: [],
	runtimeRemote: [],
	/** Fetches refused by a budget or the deny pattern — the archive is incomplete where these point. */
	skipped: [],
	budget: { maxFiles: MAX_FILES, maxTotalMB: MAX_TOTAL_BYTES / 1e6, maxFileMB: MAX_FILE_BYTES / 1e6, maxPages: MAX_PAGES, deny: DENY ? DENY.source : null, exhausted: false },
	reused: 0,
	/** Resources fetched from the origin the moment the page asked for them (drive or trail). */
	onDemand: [],
	/** Sub-pages (documents, frames) fetched on demand, and the ones refused past --max-pages. */
	pages: [],
	skippedPages: [],
	navigations: [],
	rounds: [],
};
const fetched = new Map<string, string | null>(); // absolute URL (no hash) → local path | null

/** Where an absolute URL lives in the mirror: same-origin under its own path, others under _remote. */
function localPathFor(url: string): string {
	const u = new URL(url);
	let p = decodeURIComponent(u.pathname);
	if (p.endsWith('/')) {
		p += 'index.html';
	}
	p = p.replace(/^\/+/, '');
	const rel = u.origin === PAGE_URL.origin ? p : posix.join('_remote', u.host, p);
	return rel;
}

/** The reference to write into the archive for an absolute URL, relative to a file at `fromRel`. */
function refFor(url: string, fromRel: string): string {
	const target = localPathFor(url);
	const fromDir = posix.dirname(fromRel);
	const rel = posix.relative(fromDir === '.' ? '' : fromDir, target);
	const u = new URL(url);
	return rel + (u.search && u.origin === PAGE_URL.origin ? u.search : '');
}

/** Read a response body, giving up (and cancelling the stream) past `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<{ buf: Buffer; tooBig?: undefined } | { buf?: undefined; tooBig: number }> {
	const declared = Number(res.headers.get('content-length'));
	if (declared > cap) {
		await res.body?.cancel();
		return { tooBig: declared };
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = res.body!.getReader(); // no body throws, and the caller counts the miss
	for (;;) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		size += value.length;
		if (size > cap) {
			await reader.cancel();
			return { tooBig: size };
		}
		chunks.push(value);
	}
	return { buf: Buffer.concat(chunks) };
}

/**
 * Fetch one resource into the mirror. `soft` marks a reference of low confidence — a path-like
 * string found in script or JSON text, which may be relative to some base the script computes
 * rather than to the page — so a miss at the origin goes to `literalMisses`, not `missingAtOrigin`.
 */
const inflight = new Map<string, Promise<string | null>>();
/** mirrorOnce, with one fetch per URL even when several requests for it arrive together. */
async function mirror(url: string, soft = false): Promise<string | null> {
	const key = url.split('#')[0];
	if (fetched.has(key)) {
		return fetched.get(key) ?? null;
	}
	const pending = inflight.get(key);
	if (pending) {
		return pending;
	}
	const p = mirrorOnce(url, soft).finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}
async function mirrorOnce(url: string, soft = false): Promise<string | null> {
	const key = url.split('#')[0];
	if (fetched.has(key)) {
		return fetched.get(key) ?? null;
	}
	fetched.set(key, null);
	const miss = (why: string) => (soft ? report.literalMisses : report.missingAtOrigin).push(`${key} — ${why}`);
	const rel = localPathFor(key);
	const abs = join(OUT_DIR, rel);
	if (DENY && DENY.test(rel)) {
		report.skipped.push({ url: key, reason: 'deny pattern' });
		return null;
	}
	if (!REFRESH && existsSync(abs) && statSync(abs).isFile()) {
		// Already here from a previous run: keep it (incremental reruns; no second download).
		fetched.set(key, rel);
		report.reused += 1;
		return rel;
	}
	if (report.mirrored >= MAX_FILES || report.mirroredBytes >= MAX_TOTAL_BYTES) {
		report.budget.exhausted = true;
		report.skipped.push({ url: key, reason: report.mirrored >= MAX_FILES ? `max-files ${MAX_FILES}` : `max-total-mb ${MAX_TOTAL_BYTES / 1e6}` });
		return null;
	}
	let res: Response;
	try {
		res = await fetch(key, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow' });
	} catch (e) {
		miss((e as Error).message);
		return null;
	}
	if (!res.ok) {
		miss(`http ${res.status}`);
		return null;
	}
	let body;
	try {
		body = await readCapped(res, MAX_FILE_BYTES);
	} catch (e) {
		miss(`body: ${(e as Error).message}`); // the origin dropped the connection mid-file (seen: ECONNRESET)
		return null;
	}
	if (!body.buf) {
		report.skipped.push({ url: key, reason: `max-file-mb ${MAX_FILE_BYTES / 1e6} (${(body.tooBig / 1e6).toFixed(1)} MB)` });
		return null;
	}
	const buf = body.buf;
	mkdirSync(dirname(abs), { recursive: true });
	const type = (res.headers.get('content-type') || '').split(';')[0].trim();
	if (type === 'text/css' || /\.css$/i.test(new URL(key).pathname)) {
		// Stylesheets are processed: their url()/@import references are mirrored and rewritten.
		const css = await processCss(buf.toString('utf8'), key, rel);
		writeFileSync(abs, css);
	} else {
		writeFileSync(abs, buf);
	}
	fetched.set(key, rel);
	report.mirrored += 1;
	report.mirroredBytes += buf.length;
	if (new URL(key).origin !== PAGE_URL.origin) {
		report.remote += 1;
	}
	return rel;
}

// `${…}` marks a JavaScript template literal the attribute scan met inside script text — not a URL.
const isSkippable = (ref: string | undefined) => !ref || /^(data:|blob:|#|javascript:|mailto:|tel:|about:)/i.test(ref.trim()) || ref.includes('${');
function resolveRef(ref: string, base: string): string | null {
	try {
		return new URL(ref.trim(), base).href;
	} catch {
		return null;
	}
}

/** Mirror every url()/@import in a stylesheet; rewrite the ones that point elsewhere. */
async function processCss(css: string, cssUrl: string, cssRel: string): Promise<string> {
	const jobs: { whole: string; ref: string; abs: string; index: number; local?: string | null }[] = [];
	const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
	let m;
	while ((m = re.exec(css)) !== null) {
		const ref = m[2] ?? m[4];
		if (isSkippable(ref)) {
			continue;
		}
		const abs = resolveRef(ref, cssUrl);
		if (!abs) {
			continue;
		}
		jobs.push({ whole: m[0], ref, abs, index: m.index });
	}
	for (const j of jobs) {
		j.local = await mirror(j.abs);
	}
	let out = '';
	let last = 0;
	for (const j of jobs) {
		out += css.slice(last, j.index);
		const needsRewrite = j.local && new URL(j.abs).origin !== PAGE_URL.origin;
		out += needsRewrite ? j.whole.replace(j.ref, refFor(j.abs, cssRel)) : j.whole;
		last = j.index + j.whole.length;
	}
	return out + css.slice(last);
}

// ---- phase 1: the page -------------------------------------------------------------------------
async function fetchPage() {
	const res = await fetch(PAGE_URL.href, { headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
	if (!res.ok) {
		throw new Error(`page: http ${res.status}`);
	}
	return await res.text();
}

function stripTracking(html: string): string {
	const removed: string[] = [];
	const drop = (re: RegExp, kind: string) =>
		html.replace(re, (whole) => {
			if (isTracking(whole)) {
				removed.push(`${kind}: ${whole.replace(/\s+/g, ' ').slice(0, 140)}`);
				return '';
			}
			return whole;
		});
	html = drop(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, 'script');
	html = drop(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, 'noscript');
	html = drop(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, 'iframe');
	html = drop(/<link\b[^>]*rel=["'](?:preconnect|dns-prefetch|preload|prefetch)["'][^>]*>/gi, 'link');
	html = drop(/<img\b[^>]*>/gi, 'img');
	report.trackingStripped = removed;
	return html;
}

/** Every URL the markup mentions in a resource attribute, with the attribute's text span. */
function htmlRefs(html: string): { ref: string; start: number; text: string; attr: string }[] {
	const refs: { ref: string; start: number; text: string; attr: string }[] = [];
	const attrRe = /\s(src|href|data-src|data-lazy-href|xlink:href|poster|srcset)\s*=\s*(["'])([^"']*)\2/gi;
	const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
	let t;
	while ((t = tagRe.exec(html)) !== null) {
		const tag = t[1].toLowerCase();
		const attrs = t[2];
		let a;
		while ((a = attrRe.exec(attrs)) !== null) {
			const name = a[1].toLowerCase();
			// `href` is a resource only on <link>, <image>, <use>; on <a> it is navigation.
			if ((name === 'href' || name === 'xlink:href') && !['link', 'image', 'use'].includes(tag)) {
				continue;
			}
			// A <link> is a resource only for these relations.
			if (tag === 'link' && !/rel=["'][^"']*(stylesheet|icon|preload|modulepreload|manifest|apple-touch-icon)[^"']*["']/i.test(attrs)) {
				continue;
			}
			const values = name === 'srcset' ? a[3].split(',').map((s) => s.trim().split(/\s+/)[0]) : [a[3]];
			for (const v of values) {
				if (!isSkippable(v)) {
					refs.push({ ref: v, start: t.index + a.index, text: a[0], attr: name });
				}
			}
		}
		attrRe.lastIndex = 0;
	}
	return refs;
}

/** Path-like string literals in script text: `'data/x.json'`, `"assets/a/b.webp"`, `` `${BASE}x.json` `` (the fixed tail only). */
function scriptLiteralRefs(html: string): string[] {
	const out = new Set<string>();
	const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
	let s;
	while ((s = scriptRe.exec(html)) !== null) {
		const litRe = /['"`]((?:\.{0,2}\/)?[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.(?:json|js|mjs|css|png|jpe?g|webp|gif|svg|bin|gz|html?|woff2?|ttf|otf|mp4|webm|mp3|wasm|csv|txt))(\?[^'"`\s]*)?['"`]/g;
		let l;
		while ((l = litRe.exec(s[1])) !== null) {
			out.add(l[1] + (l[2] ?? ''));
		}
	}
	return [...out];
}

async function phaseStatic() {
	let html = await fetchPage();
	if (STRIP_TRACKING) {
		html = stripTracking(html);
	}
	const pageRel = localPathFor(PAGE_URL.href);
	const refs = htmlRefs(html);
	const rewrites = [];
	for (const r of refs) {
		const abs = resolveRef(r.ref, PAGE_URL.href);
		if (!abs) {
			continue;
		}
		const local = await mirror(abs);
		if (local && new URL(abs).origin !== PAGE_URL.origin) {
			rewrites.push({ start: r.start, text: r.text, replaced: r.text.replace(r.ref, refFor(abs, pageRel)) });
		}
	}
	// Apply attribute rewrites from the end so earlier offsets stay valid.
	rewrites.sort((a, b) => b.start - a.start);
	for (const w of rewrites) {
		html = html.slice(0, w.start) + w.replaced + html.slice(w.start + w.text.length);
	}
	for (const lit of scriptLiteralRefs(html)) {
		const abs = resolveRef(lit, PAGE_URL.href);
		if (abs && new URL(abs).origin === PAGE_URL.origin) {
			await mirror(abs, true); // low confidence: the literal may be relative to a base the script computes
		}
	}
	if (FETCH_LIST) {
		const wanted = [...(FETCH_LIST.misses ?? []), ...(FETCH_LIST.requests ?? [])];
		let added = 0;
		for (const raw of wanted) {
			// A packed page's drive may report a URL on the host it was served from, or a file://
			// path (a script building URLs from `location`): the PATH is what matters — fetch it
			// from the origin. URLs on other real hosts are listed only, like runtime remotes.
			let u = raw;
			try {
				const parsed = new URL(raw);
				if (parsed.origin !== PAGE_URL.origin && (parsed.protocol === 'file:' || /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:|$)/.test(parsed.host) || parsed.host === 'gooder-capture.invalid')) {
					u = new URL(parsed.pathname + parsed.search, PAGE_URL.origin).href;
				}
			} catch {
				continue;
			}
			if (new URL(u).origin === PAGE_URL.origin && (await mirror(u)) !== null) {
				added += 1;
			}
		}
		console.log(`fetch-list: ${wanted.length} wanted, ${added} fetched`);
	}
	const abs = join(OUT_DIR, pageRel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, html);
	report.page = pageRel;
	console.log(`static: ${report.mirrored} files, ${(report.mirroredBytes / 1e6).toFixed(1)} MB; tracking stripped: ${report.trackingStripped.length}`);
}

// ---- phase 2: drive the mirror in a browser ----------------------------------------------------
const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.bin': 'application/octet-stream',
	'.gz': 'application/gzip',
	'.wasm': 'application/wasm',
	'.mp4': 'video/mp4',
};
/** A page at a path with no extension (`/planning-agents`) is saved under that name; served as
 *  octet-stream, the browser downloads it instead of opening it, so markup is told by its start. */
function mimeFor(file: string, bytes: Buffer): string {
	const ext = extname(file).toLowerCase();
	if (MIME[ext]) {
		return MIME[ext];
	}
	return !ext && /^\s*</.test(bytes.subarray(0, 64).toString('utf8')) ? MIME['.html'] : 'application/octet-stream';
}
/**
 * Serve the mirror on 127.0.0.1 — and, with `onDemand`, FETCH WHAT IT LACKS: a request for a
 * path the folder does not have is fetched from the origin right then (budgets and the deny
 * pattern apply), saved, and served. The page being driven or browsed is therefore complete as
 * it is used, and the folder fills with exactly what was asked for. Rounds and miss lists
 * become a confirmation step rather than the mechanism.
 */
function serveMirror({ onDemand }: { onDemand?: (url: string) => void } = {}): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer(async (req, res) => {
			try {
				const url = new URL(req.url ?? '/', 'http://x');
				const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
				if (rel.includes('..')) {
					res.writeHead(403).end();
					return;
				}
				let file = join(OUT_DIR, rel || 'index.html');
				if (existsSync(file) && statSync(file).isDirectory()) {
					file = join(file, 'index.html');
				}
				if (!existsSync(file) && onDemand) {
					const originUrl = new URL(url.pathname + url.search, PAGE_URL.origin).href;
					const dest = String(req.headers['sec-fetch-dest'] || '');
					const isPage = dest === 'document' || dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object';
					if (isPage && report.pages.length >= MAX_PAGES) {
						if (!report.skippedPages.includes(originUrl)) {
							report.skippedPages.push(originUrl);
							console.log(`  page refused (--max-pages ${MAX_PAGES}): ${originUrl}`);
						}
						res.writeHead(404).end();
						return;
					}
					const local = await mirror(originUrl);
					if (local) {
						onDemand(originUrl);
						if (isPage) {
							report.pages.push(originUrl);
						}
						file = join(OUT_DIR, local);
					}
				}
				if (!existsSync(file)) {
					res.writeHead(404).end();
					return;
				}
				const bytes = readFileSync(file);
				res.writeHead(200, { 'content-type': mimeFor(file, bytes), 'cache-control': 'no-store' });
				res.end(bytes);
			} catch {
				if (!res.headersSent) {
					res.writeHead(500);
				}
				res.end();
			}
		});
		server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
	});
}

/** Requests to other hosts a page makes while driven or browsed: listed, fetched only on request. */
function trackRemote(page: Page, remote: Set<string>) {
	const local = /^https?:\/\/127\.0\.0\.1:/;
	page.on('response', (res) => {
		const u = res.url();
		if (!local.test(u) && /^https?:/.test(u)) {
			remote.add(u);
		}
	});
	page.on('requestfailed', (req) => {
		const u = req.url();
		// Another page the drive refused to open (stayOnPage) is not a resource this one needs.
		if (!local.test(u) && /^https?:/.test(u) && !(req.isNavigationRequest() && req.frame() === page.mainFrame())) {
			remote.add(u);
		}
	});
}
async function noteRemote(remote: Set<string>) {
	for (const u of remote) {
		if (!fetched.has(u.split('#')[0]) && !report.runtimeRemote.includes(u)) {
			report.runtimeRemote.push(u); // listed for the embed task; a runtime URL cannot be rewritten here
			if (MIRROR_REMOTE_RUNTIME) {
				await mirror(u);
			}
		}
	}
}

/** The drive journal: steppers already walked to exhaustion, so a later run — after a time
 *  budget cut one short, or just another day — continues where it stopped instead of pressing
 *  the same "next" eighty times again. Cheap clicks are repeated; skipping an "expand" would hide
 *  what it reveals. */
const JOURNAL_PATH = join(OUT_DIR, 'drive-journal.json');
interface DriveJournal {
	exhausted: string[];
}
function readJournal(): DriveJournal {
	return existsSync(JOURNAL_PATH) ? JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) : { exhausted: [] };
}
function writeJournal(journal: DriveJournal) {
	writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, '\t') + '\n');
}

/** Automated: drive the mirror, with misses fetched on demand. A round that fetched nothing is the proof of completeness. */
async function phaseDrive() {
	const browser = await launchBrowser();
	if (!browser) {
		console.warn('drive: no Chrome/Edge found (set CHROME_PATH) — skipping the runtime phase');
		return;
	}
	const onDemandUrls: string[] = [];
	const { server, port } = await serveMirror({ onDemand: (u) => onDemandUrls.push(u) });
	const local = `http://127.0.0.1:${port}/`;
	const journal = readJournal();
	try {
		for (let round = 1; round <= MAX_ROUNDS; round += 1) {
			const before = onDemandUrls.length;
			const page = await browser.newPage();
			await page.setViewport({ width: 1280, height: 900 });
			const remote = new Set<string>();
			trackRemote(page, remote);
			await page.goto(local + report.page, { waitUntil: 'load', timeout: 120_000 });
			await stayOnPage(page, (u) => {
				const origin = u.startsWith(local) ? new URL(u.slice(local.length - 1), PAGE_URL.origin).href : u;
				if (!report.navigations.includes(origin)) {
					report.navigations.push(origin);
					console.log(`  other page refused: ${origin}`);
				}
			});
			const stats = await exercise(page, { skip: journal.exhausted });
			await page.close();
			journal.exhausted = [...new Set([...journal.exhausted, ...(stats.exhausted ?? [])])];
			writeJournal(journal);
			await noteRemote(remote);
			const fetchedNow = onDemandUrls.slice(before);
			report.onDemand.push(...fetchedNow);
			report.rounds.push({ round, ...stats, fetchedOnDemand: fetchedNow, remote: [...remote] });
			console.log(
				`drive round ${round}: ${stats.passes} passes, ${stats.clicked} clicks, ${stats.steps} stepper presses, ${stats.hovered} hovers${stats.overBudget ? ' (time budget reached — rerun to continue)' : ''}; fetched on demand ${fetchedNow.length}; steppers exhausted so far ${journal.exhausted.length}`,
			);
			if (fetchedNow.length === 0 && !stats.overBudget) {
				break;
			}
		}
	} finally {
		await browser.close();
		server.close();
	}
}

/** Human: open the mirror in a visible browser and record what the person's browsing asks for. */
async function phaseTrail() {
	const browser = await launchBrowser({ headless: false });
	if (!browser) {
		console.error('trail: no Chrome/Edge found (set CHROME_PATH)');
		return;
	}
	const { server, port } = await serveMirror({
		onDemand: (u) => {
			report.onDemand.push(u);
			console.log('  + ' + u);
		},
	});
	const local = `http://127.0.0.1:${port}/`;
	try {
		const page = (await browser.pages())[0] ?? (await browser.newPage());
		const remote = new Set<string>();
		trackRemote(page, remote);
		await page.goto(local + report.page, { waitUntil: 'load', timeout: 120_000 });
		console.log('trail: browse the page in the window — every resource it asks for is saved as you go (listed below). Close the window to finish.');
		await new Promise((resolve) => {
			browser.on('disconnected', resolve);
			page.on('close', resolve);
		});
		await noteRemote(remote);
		report.trail = { at: new Date().toISOString(), fetched: report.onDemand.length };
	} finally {
		try {
			await browser.close();
		} catch {
			/* already gone */
		}
		server.close();
	}
}

// ---- run ---------------------------------------------------------------------------------------
await phaseStatic();
if (TRAIL) {
	await phaseTrail();
} else if (DRIVE) {
	await phaseDrive();
}
writeFileSync(join(OUT_DIR, 'archive-report.json'), JSON.stringify(report, null, '\t') + '\n');
console.log(
	`done: ${report.mirrored} files (${(report.mirroredBytes / 1e6).toFixed(1)} MB), ${report.onDemand.length} fetched on demand, ${report.remote} from other hosts, ${report.missingAtOrigin.length} missing at origin, ${report.trackingStripped.length} tracking elements stripped → ${relative(process.cwd(), join(OUT_DIR, 'archive-report.json'))}`,
);
