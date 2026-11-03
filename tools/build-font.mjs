#!/usr/bin/env node
/**
 * Produce the font faces embedded in the artifact.
 *
 * Why the artifact owns its fonts
 * -------------------------------
 * The stylesheet used to ask for `system-ui, -apple-system, …`, which lets the
 * browser pick a face the project does not control. For a person reading the
 * page that is correct behaviour. For a screenshot test it is fatal: CI's
 * Firefox resolved the stack to different faces than this container's Firefox,
 * glyph advances shifted, and the three full-page goldens failed there while all
 * four canvas-only goldens passed — the canvas carries no text, so only the
 * painted words disagreed. That is a CI that cannot be made green without
 * either pinning fonts or weakening the test, and pinning is the honest option.
 *
 * It is also the right call independent of testing: "one self-contained file
 * that works offline" is not true while the page depends on a font the operating
 * system happens to provide.
 *
 * Why two faces, and why subsetted
 * --------------------------------
 * The sheet asks for weights 400, 550 and 600, so both the Regular and the Bold
 * face are embedded and CSS picks between them with ordinary weight matching.
 * Embedding only the Regular face would make the browser synthesise its own
 * bold, and synthetic stem weight is engine-specific — the same drift being
 * removed here, reintroduced through a different door.
 *
 * The subset exists because the whole DejaVu Sans file is 620 KiB and the page
 * draws a few hundred characters. Subset-and-compressed, the pair costs about
 * 18 KiB in the artifact instead of megabytes.
 *
 * Glyph coverage is a contract
 * ----------------------------
 * Coverage is deliberately wider than plain Latin-1: the copy uses Greek (sigma,
 * psi) and barred-h for the physics symbols, plus en/em dashes and the
 * superscript-two in |psi|². A glyph missing from the subset silently falls back
 * to a system font for that one character, changing a line's width — the precise
 * failure this file exists to prevent, and one that would reappear only on a
 * machine with different fonts. So COVERAGE below is a contract, and a new
 * non-ASCII character in src/ must be added to it.
 *
 * One tool, not two
 * -----------------
 * Subsetting and WOFF2 encoding are normally two steps (`pyftsubset`, then the
 * `woff2_compress` binary from the woff2 package). They are one step here
 * because fonttools writes WOFF2 itself whenever it can `import brotli`. The
 * woff2 package's binaries turn out not to be exec-able in the sandbox this
 * project is verified in, so depending on them would put a tool the checks
 * cannot run in the middle of a build. `--flavor=woff2` with brotli on the
 * import path is the smaller, verifiable dependency.
 *
 * Run tools/with-fonttools.sh, which supplies pyftsubset, a brotli module built
 * for the same interpreter, and the source fonts from the pinned nixpkgs. The
 * output is committed, so building and viewing the artifact needs neither
 * network nor font tooling.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');

/**
 * Characters that must have a glyph in the embedded subset.
 *
 * The ASCII printable range plus Latin-1 covers ordinary copy, including the
 * superscript two and middot used in readouts. Beyond it:
 *   ×    multiplication sign, as in "128 × 128"
 *   ħ    reduced Planck constant
 *   σ ψ  standard deviation and the wavefunction
 *   – —  en and em dashes used throughout the prose
 * Anything added to src/ outside these ranges must be listed here too.
 */
const COVERAGE = [
  ...Array.from({ length: 0x00ff - 0x0020 + 1 }, (_, i) => String.fromCharCode(0x0020 + i)),
  '\u00d7', // ×
  '\u0127', // ħ
  '\u03c3', // σ
  '\u03c8', // ψ
  '\u2013', // –
  '\u2014', // —
  // Headings and readouts are static markup today, but a stray typographic
  // character in a future string should degrade visibly rather than silently
  // re-widening a line, so these common ones are covered rather than falling
  // back to a system font for one character.
  '\u2018\u2019\u201c\u201d\u2022\u2026\u2264\u2265\u00b1',
];

/** Two faces, aliased to one CSS family so weight matching does the work. */
const FACES = [
  { cssWeight: 400, source: 'DejaVuSans.ttf', label: 'regular' },
  { cssWeight: 700, source: 'DejaVuSans-Bold.ttf', label: 'bold' },
];

/**
 * Subset and encode in one pyftsubset invocation.
 *
 * `--layout-features=` disables OpenType shaping features: the copy is plain
 * Latin and Greek runs, and features such as ligatures would make glyph choice
 * depend on which features a given browser engine enables by default.
 */
function subsetToWoff2(sourceTtf, outWoff2) {
  const unicodes = [...new Set(COVERAGE)]
    .map((character) => character.codePointAt(0).toString(16))
    .join(',');
  execFileSync('pyftsubset', [
    sourceTtf,
    `--output-file=${outWoff2}`,
    `--unicodes=${unicodes}`,
    '--flavor=woff2',
    '--layout-features=',
    '--no-hinting',
    '--desubroutinize',
    '--name-IDs=',
    '--recalc-bounds',
  ], { stdio: 'inherit' });
}

const [fontDir] = process.argv.slice(2);
if (!fontDir) {
  process.stderr.write('usage: build-font.mjs <directory containing DejaVuSans.ttf and DejaVuSans-Bold.ttf>\n');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const summary = [];
for (const face of FACES) {
  const source = join(fontDir, face.source);
  // Read it here so a changed package layout fails with this path in the
  // message rather than as a stack trace from inside the subsetter.
  readFileSync(source);
  const outWoff2 = join(outDir, `QuantumLoom-${face.label}.woff2`);
  subsetToWoff2(source, outWoff2);
  const bytes = readFileSync(outWoff2);
  if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') {
    throw new Error(`${outWoff2} is not WOFF2; fonttools could not import brotli`);
  }
  writeFileSync(`${outWoff2}.base64`, bytes.toString('base64'));
  summary.push(`  weight ${face.cssWeight} (${face.label}): ${(bytes.length / 1024).toFixed(1)} KiB WOFF2`);
}
process.stdout.write(`embedded faces written to ${outDir}\n${summary.join('\n')}\n`);
