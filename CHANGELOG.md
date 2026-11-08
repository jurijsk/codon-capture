# Changelog

## 0.1.0 (unreleased)

- Moved out of the Codon repo (`scripts/web-archive/`), where it was a set of scripts, into its own package.
- One command, `codon-capture`: `<url> <out-dir>` captures, `pack` packs, `drive` exercises a page.
- The loader is compiled at build time: packing needs no TypeScript at run time. `@jurijsk/codon-capture/pack` loads no browser driver.
