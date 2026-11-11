# Changelog

## 0.2.0

- **Renamed: `@jurijsk/codon-capture` is now `gooder-capture`**, public on npm and GitHub; its command is `gooder-capture`.
- **The packed file's markers are renamed**: the loader's script is `data-gooder-capture`, an embedded file `data-gooder-capture-file`, an inlined stylesheet `data-gooder-capture-inlined-from`; the loader's object is `window.__gooderCapture`, and the alias host `gooder-capture.invalid`. A file packed by 0.1.0 still opens in any browser; a tool that looks for the old markers should look for both.

## 0.1.0 (unreleased)

- Moved out of the Codon repo (`scripts/web-archive/`), where it was a set of scripts, into its own package.
- One command, `codon-capture`: `<url> <out-dir>` captures, `pack` packs, `drive` exercises a page.
- The loader is compiled at build time: packing needs no TypeScript at run time. `@jurijsk/codon-capture/pack` loads no browser driver.
