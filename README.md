# gooder-capture — capture a web page, pack it into one self-serving file

Capture a web page as a folder that works offline, its interactions included, then pack the folder into one HTML file that serves its own resources, from any location, with no server. No editor dependency. Node 22.12+, and a local Chrome or Edge for the parts that drive a browser (`CHROME_PATH` names one the search misses). Packed files open in any browser, or in an editor view that runs a page's scripts.

| Piece        | Role                                                                                                                                                                   | Depends on                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `capture.ts` | URL → folder. Mirrors every resource the page mentions (static scan) and every one it asks for while driven (clicks, hovers, scroll), in bounded rounds.               | `drive.ts`, `puppeteer-core`                          |
| `pack.ts`    | folder → one HTML file. Embeds every file as an inert block, inlines the entry's stylesheets and scripts, and prepends `loader.ts`. Pure: `packArchive()` takes a Map. | `loader.ts` (compiled by the build, embedded as text) |
| `loader.ts`  | Runs inside the packed page. Serves its resources from the embedded blocks: fetch, XHR, element loads, runtime CSS. Browser code, no dependencies.                     | —                                                     |
| `drive.ts`   | Opens a page in headless Chrome, exercises it, reports what it loaded, what failed, and what a packed page's loader missed. The verification tool for both.            | `puppeteer-core`                                      |
| `cli.ts`     | The `gooder-capture` command.                                                                                                                                           | all of the above                                      |

## Use

```sh
npx gooder-capture https://example.org/page/ out/page            # the folder
npx gooder-capture pack out/page out/page.html --verify          # the file, checked
npx gooder-capture drive out/page.html                           # check again later
```

Installed in a project (`npm install -D gooder-capture`), the command is `npx gooder-capture …`.

Capturing serves the folder to the browser through a server that **fetches what it lacks**: a request for a path the folder does not have is fetched from the origin on the spot, saved, and served. The page is complete as it is used, and the folder fills with exactly what was asked for. Two ways to use the page:

- **drive** (default): headless Chrome works every control in passes and walks steppers to exhaustion; a second round that fetched nothing is the proof of completeness. `drive-journal.json` records the steppers already exhausted, so a run cut short by its time budget, or a run next month, continues where the last stopped. The page never leaves: a control that would open another page in its place (a button setting `location`, a submit button, a link) is refused before anything is fetched and listed in the report's `navigations`.
- **trail** (`--trail`): a visible browser and you. Browse, click what matters, close the window; everything the page asked for was saved as you went. For a page too large to click through blindly, trailblaze it by hand and let the drive fill in behind, or the other way round. Same folder, both incremental.

```sh
npx gooder-capture https://example.org/page/ out/page --trail    # you drive
```

Capturing writes `archive-report.json` beside the page: what was fetched statically, on demand, reused, refused by a budget, missing at the origin, stripped as tracking. `pack --verify` ends with the loader's hit and miss counts and the number of network requests the packed page still made; a complete pack has zero of both. When it has not, it writes `pack-misses.json` and prints the two commands that close the loop: capture with `--fetch-list` fetches exactly what was missed, then pack again.

## Interfaces

- Capture: command line only (`gooder-capture <url> <out-dir>` plus `--trail`, `--keep-tracking`, `--no-drive`, `--rounds`, `--max-files`, `--max-total-mb`, `--max-file-mb`, `--max-pages`, `--deny`, `--mirror-remote`, `--refresh`, `--fetch-list`). `--max-pages` (20) bounds SUB-PAGES: a request the browser marks as a document or frame (`Sec-Fetch-Dest`) is another page of the site, and a gallery that shows one per click in a frame can ask for hundreds, each with its own assets; past the cap they are refused and listed in the report's `skippedPages`.
- Pack: `gooder-capture pack <archive-dir> <out.html> [--entry index.html] [--origin URL] [--verify]`. The entry and the origin default to `page` and `source` in the folder's `archive-report.json`; a folder that was not captured needs `--origin`, the URL its page is to believe it came from. As a library, `packArchive({ files, entry, origin })` → `{ html, files, bytesIn, bytesOut }`, where `files` is `Map<path, { bytes: Uint8Array, type?: string }>` and paths are the page's own relative paths (other hosts under `_remote/<host>/…`). `readFolder(dir)` builds that map from disk. `import { packArchive } from 'gooder-capture/pack'` loads no browser driver.
- Drive: `gooder-capture drive <url | file.html> [--json]`. As a library (`gooder-capture/drive`, or the package root): `launchBrowser()`, `serveFile(path)`, `drive(browser, url)` → `{ passes, clicked, steps, hovered, requests, failed, notFound, navigations, archive: { hits, misses } | null }`, `exercise(page)`, `stayOnPage(page, onLeave)`. The drive is stateful: passes repeat while new controls appear or new resources load (an "expand" reveals buttons that did not exist), and a control that looks like a stepper or revealer (next, prev, more, expand, show, load, ‹ ›) is pressed until three presses in a row load nothing — a carousel is walked to its end, not nudged once. `navigations` are links followed to another page — a frame's, or the page's own, which `stayOnPage` refuses before it is fetched because a new document would end the exercise: a crawl boundary, reported, never counted as a gap.
- The packed file's own contract: `window.__gooderCapture` with `has(url)`, `url(url)`, `keys()`, `hits`, `misses`.

## The packed file

The entry page with three additions: `loader.ts` first in `<head>`, the virtual filesystem after it (`<script type="text/plain" data-gooder-capture-file="…" data-type="…" data-enc="text|base64">`), and the entry's own `<link rel=stylesheet>` / `<script src>` inlined because the parser starts those before any script can intercept. Everything else is the page as captured. Resolution is against the page's original URL, so the file works from any location, including a `blob:` frame. The loader also gives the document a `<base>` on `https://gooder-capture.invalid/` (a reserved name that resolves nowhere) at the entry's path: every relative URL the page builds, by any means, resolves to that host, which the loader maps like the origin, and a load the parser starts before the loader can fix it fails at DNS with no traffic. `drive.ts` treats that host as internal; what the loader could not serve is in its `misses`, as the origin's URLs.

ES modules: the module loader resolves specifiers itself and no script can hook it, so `pack.ts` rewrites every relative specifier in the page's module scripts, and in the modules they reach, to an absolute URL on the alias host, embeds that closure first, and has the loader insert an import map from those URLs to the modules' blobs before the parser meets a module script. A fragment link (`href="#section"`) would resolve against the `<base>` and leave the page; the loader turns it into a scroll on the document itself. Markup set as a string (`innerHTML`, `outerHTML`, `insertAdjacentHTML`) is fixed synchronously, before the image loads it schedules.

Known limits: an `import()` with a computed specifier escapes the import map. A `url()` written through a style property (`el.style.backgroundImage = …`) cannot be intercepted, because Chromium defines those properties on each style object rather than on a prototype; the observer serves it right after, so the browser makes one failed lookup on the alias host and nothing shows broken. CSS `url()` inside stylesheets applied through `adoptedStyleSheets` is rewritten only through `insertRule`. All of these show up in `drive` output, which is the point of running it.

## Development

```sh
npm run build      # tsc → dist/: the Node side (tsconfig.json), then the loader as a classic script (tsconfig.loader.json)
npm run typecheck
npm test           # vitest; the loader's test runs in jsdom
node src/cli.ts …  # the sources as they are (Node 22.18+ erases the types); pack compiles the loader on the spot
```

The loader is compiled at build time, so the package needs no TypeScript at run time. `dist/loader.js` is byte for byte what `pack.ts` compiles from source.
