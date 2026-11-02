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
if (html.includes('__QUANTUM_JS__') || html.includes('__QUANTUM_CSS__')) {
  problems.push('a build placeholder survived into the artifact');
}

if (problems.length > 0) {
  process.stderr.write(`artifact check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`artifact OK (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB, self-contained)\n`);
