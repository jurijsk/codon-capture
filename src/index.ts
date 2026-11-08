/**
 * The library: pack a folder into one self-serving file, and drive a page in a real browser.
 * capture.ts is command-line only (`codon-capture <url> <out-dir>`). For packing alone, import
 * `@jurijsk/codon-capture/pack`, which loads no browser driver.
 */
export * from './pack.ts';
export * from './drive.ts';
