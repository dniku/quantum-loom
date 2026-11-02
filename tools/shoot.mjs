#!/usr/bin/env node
/** Capture one screenshot per scene, for looking at with human eyes. */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPlaywright, openScene, SCENES, DEFAULT_ENGINE } from './browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'index.html')).href;
const engineName = process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : DEFAULT_ENGINE;
const outDir = join(root, '.tmp', 'shots');
mkdirSync(outDir, { recursive: true });

const engines = await loadPlaywright();
for (const scene of SCENES) {
  const { browser, page, problems } = await openScene(engines, engineName, scene, url);
  await page.waitForTimeout(400);
  const file = join(outDir, `${scene.name}.png`);
  await page.screenshot({ path: file, fullPage: scene.name === 'phone-portrait' });
  process.stdout.write(`${scene.name} -> ${file}${problems.length ? `  PROBLEMS: ${problems.join(' | ')}` : ''}\n`);
  await browser.close();
}
