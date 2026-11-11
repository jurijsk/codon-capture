#!/usr/bin/env node
/**
 * cli.ts — the `gooder-capture` command:
 *
 *   gooder-capture <url> <out-dir> [options]                              capture a page as a folder (capture.ts)
 *   gooder-capture pack <archive-dir> <out.html> [--entry F] [--origin URL] [--verify]   pack the folder into one file
 *   gooder-capture drive <url | file.html> [--json]                       exercise a page, report what it loaded
 *
 * capture.ts is a script that reads its own arguments, so a command that is neither `pack` nor
 * `drive` runs it as it is.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packArchive, readFolder } from './pack.ts';
import { drive, launchBrowser, serveFile } from './drive.ts';

const USAGE = `usage:
  gooder-capture <url> <out-dir> [--trail] [--keep-tracking] [--no-drive] [--rounds N] [--max-files N] [--max-total-mb N] [--max-file-mb N] [--max-pages N] [--deny <regex>] [--mirror-remote] [--refresh] [--fetch-list <file>]
  gooder-capture pack <archive-dir> <out.html> [--entry index.html] [--origin URL] [--verify]
  gooder-capture drive <url | file.html> [--json]`;

const [command, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h' || command === 'help') {
	console.log(USAGE);
	process.exit(command ? 0 : 2);
} else if (command === 'pack') {
	await packCommand(rest);
} else if (command === 'drive') {
	await driveCommand(rest);
} else {
	await import('./capture.ts');
}

async function packCommand(args: string[]): Promise<void> {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	const positional: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === '--entry' || args[i] === '--origin') {
			values.set(args[i], args[i + 1]);
			i += 1;
		} else if (args[i].startsWith('--')) {
			flags.add(args[i]);
		} else {
			positional.push(args[i]);
		}
	}
	const [dir, outPath] = positional;
	if (!dir || !outPath) {
		console.error('usage: gooder-capture pack <archive-dir> <out.html> [--entry index.html] [--origin URL] [--verify]');
		process.exit(2);
	}
	const reportPath = join(dir, 'archive-report.json');
	const report: { page?: string; source?: string } = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
	const entry = values.get('--entry') || report.page || 'index.html';
	const origin = values.get('--origin') || report.source;
	const files = readFolder(dir);
	files.delete('archive-report.json');
	const result = packArchive({ files, entry, origin });
	writeFileSync(outPath, result.html);
	console.log(`packed ${result.files} files (${(result.bytesIn / 1e6).toFixed(1)} MB) into ${outPath} (${(result.bytesOut / 1e6).toFixed(1)} MB)`);
	if (flags.has('--verify')) {
		const browser = await launchBrowser();
		if (!browser) {
			console.error('verify: no Chrome/Edge found (set CHROME_PATH)');
			process.exit(1);
		}
		const served = await serveFile(outPath); // over http, as in a frame: a real location.origin
		try {
			const r = await drive(browser, served.url);
			const misses = r.archive ? r.archive.misses : [];
			console.log(
				`verify: ${r.clicked} clicks, ${r.hovered} hovers; loader hits ${r.archive ? r.archive.hits : '?'}, misses ${misses.length}; network requests ${r.requests.length}, failed ${r.failed.length}`,
			);
			for (const u of [...misses, ...r.requests].slice(0, 40)) {
				console.log('  ' + u);
			}
			// The coverage loop: a drive of the PACKED page can ask for things the folder's drive did
			// not (a figure that only initialised once its data was there). The misses go back to
			// capture.ts, which fetches exactly those, and the pack is rerun.
			const missesPath = join(dir, 'pack-misses.json');
			writeFileSync(missesPath, JSON.stringify({ packedAt: new Date().toISOString(), misses, requests: r.requests }, null, '\t') + '\n');
			if (misses.length || r.requests.length) {
				console.log(`incomplete — misses written to ${missesPath}; close the loop with:\n  gooder-capture ${origin} ${dir} --fetch-list ${missesPath}\n  gooder-capture pack ${dir} ${outPath} --verify`);
			}
			process.exit(misses.length || r.requests.length ? 1 : 0);
		} finally {
			await browser.close();
			await served.close();
		}
	}
}

async function driveCommand(args: string[]): Promise<void> {
	const target = args.find((a) => !a.startsWith('--'));
	if (!target) {
		console.error('usage: gooder-capture drive <url | file.html> [--json]');
		process.exit(2);
	}
	const browser = await launchBrowser();
	if (!browser) {
		console.error('no Chrome/Edge found (set CHROME_PATH)');
		process.exit(1);
	}
	const served = /^[a-z][a-z0-9+.-]*:/i.test(target) ? null : await serveFile(target);
	try {
		const result = await drive(browser, served ? served.url : target);
		if (args.includes('--json')) {
			console.log(JSON.stringify(result, null, '\t'));
		} else {
			console.log(`${result.passes} passes, ${result.clicked} clicks, ${result.steps} stepper presses, ${result.hovered} hovers over ${result.scrollHeight}px`);
			for (const n of result.navigations) {
				console.log('  nav  ' + n + '  (a link to another page; not part of this archive)');
			}
			console.log(`network requests: ${result.requests.length}, failed: ${result.failed.length}, 404: ${result.notFound.length}`);
			if (result.archive) {
				console.log(`archive loader: ${result.archive.hits} hits, ${result.archive.misses.length} misses`);
				for (const m of result.archive.misses.slice(0, 40)) {
					console.log('  miss ' + m);
				}
			}
			for (const r of result.requests.slice(0, 40)) {
				console.log('  net  ' + r);
			}
		}
		process.exit(result.failed.length || (result.archive && result.archive.misses.length) ? 1 : 0);
	} finally {
		await browser.close();
		if (served) {
			await served.close();
		}
	}
}
