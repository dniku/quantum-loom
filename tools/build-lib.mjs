/**
 * build-lib.mjs — inline the app into one self-contained index.html.
 *
 * Why a bundler at all, for three files: the artifact has to open from
 * file://, from a sandboxed opaque-origin iframe, and with no network. That
 * rules out `<script type="module" src>` (module scripts are blocked from
 * file:// by CORS, and an opaque origin cannot fetch siblings either), so the
 * JavaScript has to be inline — and an inline classic script cannot use
 * `import`, so the modules get concatenated instead.
 *
 * The approach is therefore deliberately dumb: concatenate quantum.js then
 * app.js, strip the inter-module `import` line and the `export` keywords, and
 * wrap the whole thing in an IIFE so nothing leaks onto the global scope except
 * the documented test seam. Dumb is a virtue here: no minifier, no parse-
 * rewrite-print of the physics, and no dependency whose version could change
 * the bytes. The physics you can read in src/ is byte-for-byte the physics in
 * the artifact, apart from the import/export lines listed above.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Modules in dependency order: a file may only use names defined above it. */
const MODULES = ['quantum.js', 'app.js'];

/**
 * Remove `import` statements and `export` keywords.
 *
 * Only the exact shapes used in this project are handled — a top-of-file
 * `import { a, b } from './x.js';` and a leading `export ` — and anything else
 * throws rather than being silently passed through, so a future edit that
 * introduces, say, a default export or a dynamic import fails the build instead
 * of shipping a broken bundle.
 */
function stripModuleSyntax(source, name) {
  const lines = source.split('\n');
  const kept = [];
  for (const line of lines) {
    // Imports are how src/ files depend on each other; in one shared scope the
    // names are simply already there, so the statement is dropped.
    if (/^import\s+\{[^}]*\}\s+from '\.\/[^']+';?\s*$/.test(line)) continue;
    if (/^import\s/.test(line)) {
      throw new Error(`${name}: unsupported import form: ${line}`);
    }
    // Only `export class|function|const|let` at column 0 is used in this project.
    // Anything else that still says `export` is a form we have not implemented,
    // and shipping it would put a syntax error into the artifact.
    const exportMatch = line.match(/^export\s+(class|function|const|let)\s/);
    if (exportMatch) {
      kept.push(line.replace(/^export\s+/, ''));
      continue;
    }
    if (/^export\b/.test(line)) {
      throw new Error(`${name}: unsupported export form: ${line}`);
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Guard against the failure mode concatenation actually introduces: two modules
 * declaring the same top-level name. In separate files this is fine; in one
 * scope it is a redeclaration error that would kill the whole page.
 */
function checkForNameCollisions(transformed) {
  const declared = new Map();
  for (const [name, source] of transformed) {
    for (const match of source.matchAll(/^(?:class|function|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
      const symbol = match[1];
      if (declared.has(symbol)) {
        throw new Error(`name collision in bundle: "${symbol}" declared in both ${declared.get(symbol)} and ${name}`);
      }
      declared.set(symbol, name);
    }
  }
}

/** Build the artifact text from the project root. */
export function buildArtifact(root) {
  const template = readFileSync(join(root, 'src', 'index.template.html'), 'utf8');
  const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

  const transformed = MODULES.map((name) => [name, stripModuleSyntax(readFileSync(join(root, 'src', name), 'utf8'), name)]);
  checkForNameCollisions(transformed);

  // quantum.js's exports become plain declarations, but app.js refers to them by
  // name, which now works because they share a scope. Nothing else is needed.
  const bundle = transformed.map(([, source]) => source).join('\n\n/* ---- next module ---- */\n\n');

  const placeholderScript = '<script type="module">/*__QUANTUM_JS__*/</script>';
  const placeholderCss = '/*__QUANTUM_CSS__*/';
  if (!template.includes(placeholderScript)) throw new Error('template is missing the script placeholder');
  if (!template.includes(placeholderCss)) throw new Error('template is missing the style placeholder');

  // Inline as a classic script: module scripts are refused on file://, and the
  // IIFE keeps the bundle's helpers off window.
  const inlined = `<script>\n(function () {\n'use strict';\n\n${bundle}\n})();\n</script>`;

  const page = template.replace(placeholderScript, inlined).replace(placeholderCss, () => css);

  // A bundle that still contains a placeholder is one where a replacement
  // silently did nothing, which would present as a blank page.
  if (page.includes('__QUANTUM_JS__') || page.includes('__QUANTUM_CSS__')) {
    throw new Error('a placeholder survived into the artifact');
  }
  return page;
}
