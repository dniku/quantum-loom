#!/usr/bin/env node
/** Representative screenshots for the README: three viewports plus a phase view. */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPlaywright, openScene, stepFrames, dragField, SCENES } from './browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'index.html')).href;
const out = join(root, 'docs');
mkdirSync(out, { recursive: true });
const { firefox } = await loadPlaywright();

for (const scene of SCENES) {
  const { browser, page } = await openScene({ firefox }, 'firefox', scene, url, { });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `readme-${scene.name}.png`), fullPage: false });
  await browser.close();
  process.stdout.write(`docs/readme-${scene.name}.png\n`);
}

// A flicked packet: shows momentum off-centre in the spectrum, on desktop.
const desktop = SCENES[0];
const opened = await openScene({ firefox }, 'firefox', desktop, url);
const box = await opened.page.locator('#field').boundingBox();
await dragField(
  opened.page,
  { x: box.x + box.width * 0.4, y: box.y + box.height * 0.55 },
  { x: box.x + box.width * 0.6, y: box.y + box.height * 0.4 },
);
await stepFrames(opened.page, 2);
await opened.page.screenshot({ path: join(out, 'readme-flicked.png') });
await opened.browser.close();
process.stdout.write('docs/readme-flicked.png\n');
