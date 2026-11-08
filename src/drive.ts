/**
 * drive.ts — exercise a page in a real browser the way a reader would, and report what it loads.
 *
 *   codon-capture drive <url | file.html> [--json]
 *
 * Headless Chrome (puppeteer-core, a local Chrome or Edge) opens the page, scrolls to the end,
 * clicks every button and control, hovers every figure hotspot, waits, and reports every request
 * the page made: which ones went to the network, which failed, and — for a page packed by pack.ts —
 * what its loader could not find (`window.__codonArchive.misses`). A packed page that is complete
 * shows no network requests beyond the file itself and no misses.
 *
 * Used by capture.ts (the drive phase of archiving) and by `codon-capture pack --verify` (cli.ts). No dependency on
 * either, on Codon or on VS Code.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import type { AddressInfo } from 'node:net';
import type { Browser, Frame, Page } from 'puppeteer-core';
/** The types of the browser `launchBrowser` starts. A caller that drives it types its code with
 *  these, not with its own copy of puppeteer-core: a linked or nested copy is a different class,
 *  and a Frame from one is not a Frame of the other. */
export type { Browser, ElementHandle, Frame, KeyInput, Page } from 'puppeteer-core';

/** What one exercise of a page did, and what a packed page's loader served and missed. */
export interface DriveStats {
	scrollHeight: number;
	passes: number;
	clicked: number;
	steps: number;
	hovered: number;
	/** Fingerprints of the steppers pressed until they produced nothing (the drive journal). */
	exhausted: string[];
	overBudget: boolean;
	archive: { hits: number; misses: string[] } | null;
}

/** A drive's stats plus the requests the page made, by kind. */
export interface DriveResult extends DriveStats {
	requests: string[];
	failed: string[];
	notFound: string[];
	navigations: string[];
}

export const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p): p is string => Boolean(p));

/** A headless browser, or null when no Chrome/Edge is installed (callers then skip driving). */
export async function launchBrowser({ headless = true }: { headless?: boolean } = {}): Promise<Browser | null> {
	const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
	if (!executablePath) {
		return null;
	}
	// protocolTimeout: one evaluate() drives the whole page, which can take many minutes on a page
	// with carousels; the default 180 s cut it off mid-drive. The drive bounds itself (DRIVE_BUDGET_MS).
	return puppeteer.launch({ executablePath, headless, defaultViewport: headless ? undefined : null, protocolTimeout: 3_600_000, args: ['--disable-web-security', '--allow-file-access-from-files'] });
}

/**
 * Keep `page` on the document it has loaded. A request to replace it — a button that sets
 * `location`, a submit button sending its form, a link — reaches `onLeave` and is refused before
 * anything is fetched; whatever the page loads inside itself, frames included, goes ahead. An
 * exercise is one evaluate in the page's own context, which a new document would destroy, and the
 * document that came instead is another page, not the one being archived: a crawl boundary. The
 * refusal is net::ERR_ABORTED, which commits nothing, so the page is untouched. Call it once the
 * page has loaded, or it refuses the page itself.
 */
export async function stayOnPage(page: Page, onLeave: (url: string) => void): Promise<void> {
	await page.setRequestInterception(true);
	page.on('request', (req) => {
		if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
			onLeave(req.url());
			void req.abort('aborted');
		} else {
			void req.continue();
		}
	});
}

/**
 * Runs IN the page: scroll to the end, then work every control the way a reader would — in
 * PASSES, because a page is stateful: an "expand" reveals controls that did not exist, a "next"
 * has to be pressed as many times as there are slides, a mode switch changes what the other
 * buttons do. Each pass clicks every control it has not clicked in that pass; a control that
 * looks like a stepper or revealer (next/prev/more/expand/show/load, or ‹›«») is pressed
 * repeatedly until three presses in a row load nothing and change nothing. Passes repeat while
 * new controls keep appearing or new resources keep loading, up to a cap. Then every figure
 * hotspot is hovered. The page's own failures (a handler that throws) are ignored.
 */
export async function exercise(page: Page | Frame, { skip = [] }: { skip?: string[] } = {}): Promise<DriveStats> {
	return page.evaluate(async (skipList: string[]): Promise<DriveStats> => {
		const skipSet = new Set(skipList);
		const exhausted: string[] = [];
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		performance.setResourceTimingBufferSize?.(200000);
		// A hard budget for the whole drive: a page can present steppers without end.
		const deadline = Date.now() + 20 * 60 * 1000;
		const overBudget = () => Date.now() > deadline;
		const loaded = () => performance.getEntriesByType('resource').length;
		const size = () => document.querySelectorAll('*').length;
		const h = document.documentElement.scrollHeight;
		for (let y = 0; y < h + 800; y += 700) {
			window.scrollTo(0, y);
			await sleep(40);
		}
		await sleep(1200);

		const CONTROLS = 'button, [role="button"], summary, select, input[type="range"], input[type="checkbox"], input[type="radio"], [data-toggle], .tab, [role="tab"]';
		const STEPPER = /next|prev|previous|more|expand|show|load|forward|back|older|newer|[‹›«»]|▶|◀/i;
		/** A stable name for a control across reloads: its path in the tree plus its label. */
		const fingerprint = (el: Element) => {
			const parts: string[] = [];
			let n: Element | null = el;
			while (n && n.nodeType === 1 && parts.length < 8) {
				let seg = n.localName;
				if (n.id) {
					parts.unshift(seg + '#' + n.id);
					break;
				}
				const p: Element | null = n.parentElement;
				if (p) {
					const name = n.localName;
					seg +=
						':nth-of-type(' +
						(Array.from(p.children)
							.filter((c) => c.localName === name)
							.indexOf(n) +
							1) +
						')';
				}
				parts.unshift(seg);
				n = p;
			}
			return parts.join('>') + '|' + describe(el).trim().replace(/\s+/g, ' ').slice(0, 60);
		};
		const describe = (el: Element) => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.className].map((s) => (s == null ? '' : String(s))).join(' ');
		const activate = (el: Element) => {
			if (el instanceof HTMLSelectElement) {
				if (el.options.length > 1) {
					el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}
			} else if (el instanceof HTMLInputElement) {
				if (el.type === 'checkbox' || el.type === 'radio') {
					el.click();
				} else {
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}
			} else {
				(el as HTMLElement).click(); // an SVG control has no click(): it throws, and is skipped as before
			}
		};
		const seen = new WeakSet<Element>();
		let clicked = 0;
		let steps = 0;
		let passes = 0;
		for (;;) {
			passes += 1;
			const fresh = Array.from(document.querySelectorAll(CONTROLS)).filter((el) => !seen.has(el));
			if (fresh.length === 0 || passes > 6 || overBudget()) {
				break;
			}
			const before = { loaded: loaded(), size: size() };
			for (const el of fresh) {
				seen.add(el);
				const fp = fingerprint(el);
				if (skipSet.has(fp)) {
					continue; // walked to exhaustion by an earlier run (the drive journal)
				}
				try {
					el.scrollIntoView({ block: 'center', behavior: 'instant' });
					activate(el);
					clicked += 1;
					if (STEPPER.test(describe(el))) {
						// Press on until it stops producing anything, three quiet presses in a row.
						let quiet = 0;
						for (let i = 0; i < 80 && quiet < 3 && !overBudget(); i += 1) {
							const l = loaded();
							const s = size();
							await sleep(120);
							activate(el);
							steps += 1;
							await sleep(120);
							quiet = loaded() === l && size() === s ? quiet + 1 : 0;
						}
						if (quiet >= 3) {
							exhausted.push(fp);
						}
					}
				} catch {
					/* a control whose handler throws is the page's business */
				}
				if (clicked % 25 === 0) {
					await sleep(300);
				}
			}
			await sleep(1500);
			if (loaded() === before.loaded && size() === before.size && Array.from(document.querySelectorAll(CONTROLS)).every((el) => seen.has(el))) {
				break;
			}
		}

		const hoverables = Array.from(
			document.querySelectorAll(
				'figure [tabindex], figure [data-id], figure [data-unit], figure [data-lk], figure [data-f], figure [data-n], figure li, figure img, figure svg [data-i], [data-hover]',
			),
		);
		let hovered = 0;
		for (const el of hoverables.slice(0, 3000)) {
			for (const type of ['pointerenter', 'mouseenter', 'mouseover', 'pointerover']) {
				el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('over'), cancelable: true }));
			}
			hovered += 1;
			if (hovered % 100 === 0) {
				await sleep(100);
			}
		}
		await sleep(2500);
		window.scrollTo(0, 0);
		const archive = (window as Window & { __codonArchive?: { hits: number; misses: string[] } }).__codonArchive;
		return { scrollHeight: h, passes, clicked, steps, hovered, exhausted, overBudget: overBudget(), archive: archive ? { hits: archive.hits, misses: archive.misses } : null };
	}, skip);
}

/**
 * Open `url` in `browser`, exercise it, and report its requests. `requests` has every URL the
 * page asked the network for (blob:, data: and the page's own URL excluded), `failed` the ones
 * that errored, `notFound` the ones answered 404.
 */
export async function drive(browser: Browser, url: string, { onRequest }: { onRequest?: (url: string) => void } = {}): Promise<DriveResult> {
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
	const own = url.split('#')[0];
	const requests = new Set<string>();
	const failed = new Set<string>();
	const notFound = new Set<string>();
	const navigations = new Set<string>();
	// A packed page's loader gives the document a base on a host that exists nowhere
	// (codon-archive.invalid): a load the parser starts before the loader fixes it goes there and
	// fails at DNS. Those are not escapes; what the loader could not serve is in its `misses`.
	const internal = (u: string) => u === own || /^(blob:|data:|about:)/.test(u) || u.startsWith('https://codon-archive.invalid/');
	page.on('request', (req) => {
		const u = req.url();
		if (internal(u)) {
			return;
		}
		// A frame navigating to another page is a link followed, not a resource the page needed: a
		// crawl boundary, reported on its own (the loader cannot intercept navigations).
		if (req.isNavigationRequest()) {
			navigations.add(u);
			return;
		}
		requests.add(u);
		onRequest?.(u);
	});
	page.on('requestfailed', (req) => {
		const u = req.url();
		if (!internal(u) && !navigations.has(u)) {
			failed.add(u);
		}
	});
	page.on('response', (res) => {
		if (res.status() === 404 && res.url() !== own) {
			notFound.add(res.url());
		}
	});
	try {
		await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
		await stayOnPage(page, (u) => navigations.add(u));
		const stats = await exercise(page);
		return { ...stats, requests: [...requests], failed: [...failed], notFound: [...notFound], navigations: [...navigations] };
	} finally {
		await page.close();
	}
}

/** A path on disk or a URL → something the browser can open. */
export function toUrl(target: string): string {
	return /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : pathToFileURL(target).href;
}

/**
 * Serve one file's folder over 127.0.0.1 and return the file's URL plus a `close()`. A packed
 * page is driven over http rather than file:// so that `location.origin` is a real origin (as it
 * is in a frame) — a script that builds URLs from it then lands where the loader can map them —
 * and so file:// quirks never colour the verdict.
 */
export async function serveFile(filePath: string): Promise<{ url: string; close: () => Promise<void> }> {
	const { createServer } = await import('node:http');
	const { readFile } = await import('node:fs/promises');
	const { dirname, basename, join, normalize, extname } = await import('node:path');
	const dir = dirname(filePath);
	const types: Record<string, string> = {
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript',
		'.css': 'text/css',
		'.json': 'application/json',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.webp': 'image/webp',
		'.svg': 'image/svg+xml',
	};
	const server = createServer(async (req, res) => {
		try {
			const rel = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^[/\\]+/, '');
			if (rel.includes('..')) {
				res.writeHead(403).end();
				return;
			}
			const data = await readFile(join(dir, rel));
			res.writeHead(200, { 'content-type': types[extname(rel).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${port}/${encodeURIComponent(basename(filePath))}`;
	return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
