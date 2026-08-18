import { readFile } from 'node:fs/promises';

const entryPath = new URL('../dist/index.js', import.meta.url);
const source = await readFile(entryPath, 'utf8');
const relativeImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']\.{1,2}\//;

if (relativeImport.test(source)) {
  throw new Error('dist/index.js must be self-contained because CloudCLI imports it from a Blob URL');
}

if (!/\bmount\b/.test(source)) {
  throw new Error('dist/index.js does not export the plugin mount entry point');
}
