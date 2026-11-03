#!/usr/bin/env node
/**
 * Assert the built artifact is self-contained and syntactically valid.
 *
 * The whole promise of this project's distribution is one file that opens with
 * no network, no sibling files, and no storage. Each of those has a concrete way
 * to break silently: a stray <script src>, a <link rel=stylesheet>, an image
 * reference, or an inline module that cannot run on file://. This check names the
 * specific violation instead of leaving it to a blank page.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'index.html');
const html = readFileSync(path, 'utf8');
const problems = [];

if (html.length < 1000) problems.push(`artifact is suspiciously small (${html.length} bytes)`);

// Any external reference breaks offline/sandboxed use. Only bare in-page
// fragments (#anchor) are allowed to look like a reference.
const external = [...html.matchAll(/<(script|link|img|source|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => m[2])
  .filter((value) => !value.startsWith('#') && !value.startsWith('data:'));
if (external.length > 0) problems.push(`references ${external.length} external resource(s): ${external.join(', ')}`);

// Module scripts are refused from file:// and from an opaque-origin iframe, so
// the artifact must not depend on one.
if (/<script[^>]+type=["']module["']/i.test(html)) {
  problems.push('contains a type="module" script, which will not run from file:// or an opaque origin');
}

// The inline classic script must parse. Extract the last <script>...</script>.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
if (scripts.length === 0) problems.push('no inline script found');
for (const [index, body] of scripts.entries()) {
  try {
    new vm.Script(body, { filename: `inline-script-${index}` });
  } catch (error) {
    problems.push(`inline script ${index} does not parse: ${error.message}`);
  }
}

// Placeholder comments must not survive the build.
if (html.includes('__QUANTUM_JS__') || html.includes('__QUANTUM_CSS__') || html.includes('__FONT_FACE__')) {
  problems.push('a build placeholder survived into the artifact');
}

/*
 * The embedded font faces.
 *
 * The artifact declares its own fonts because golden screenshots contain
 * painted text, and `system-ui` resolves to whatever the host provides: CI and
 * this container disagreed, glyph advances shifted, and the full-page goldens
 * failed there while the canvas-only ones passed. That fix only holds if the
 * faces are actually in the file, so their presence and form are asserted here
 * rather than left to a screenshot that would only show the symptom.
 *   - Two faces, Regular and Bold: with one face, each engine synthesises its
 *     own bold, and synthetic stem weight varies between engines.
 *   - Data URI, not a URL: a fetched font breaks the offline single-file
 *     promise, which is the same class of bug as a stray <script src>.
 *   - wOF2 magic: base64 that decodes to something else (a truncated file, a
 *     TTF committed by mistake) is a build error, not a page that renders in
 *     a fallback face and drifts.
 */
const faces = [...html.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
if (faces.length !== 2) {
  problems.push(`expected 2 @font-face rules for the embedded faces, found ${faces.length}`);
}
for (const [index, rule] of faces.entries()) {
  const dataUri = rule.match(/url\(data:font\/woff2;base64,([A-Za-z0-9+/]+={0,2})\)/);
  if (!dataUri) {
    problems.push(`@font-face ${index} has no inline data:font/woff2;base64 source`);
    continue;
  }
  const bytes = Buffer.from(dataUri[1], 'base64');
  const magic = bytes.subarray(0, 4).toString('latin1');
  if (magic !== 'wOF2') {
    problems.push(`@font-face ${index} decodes to ${JSON.stringify(magic)}, not a WOFF2 signature`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`artifact check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`artifact OK (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB, self-contained)\n`);
