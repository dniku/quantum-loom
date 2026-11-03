/**
 * Golden screenshot tests.
 *
 * What these can and cannot prove, stated plainly: a byte-identical screenshot
 * proves the pixels did not change, which catches regressions in layout, colour,
 * and geometry. It does not prove the picture is *good*, correct, or readable —
 * that judgment is made by a human looking at each baseline, and the baselines
 * are reviewed, not generated and trusted. A test here that passes on a
 * garbage-but-stable render is working as designed; the design just does not
 * include knowing garbage from good, so no number of green goldens replaces
 * viewing the images.
 *
 * Determinism, and why it holds: the app's simulation is exact and repeatable
 * for a given number of steps (verified in physics.test.mjs to round-off), and
 * every golden scenario advances a fixed step count through __quantum.stepFrames
 * rather than relying on wall-clock animation. The artifact also embeds its own
 * font faces (see tools/build-font.mjs), so the text pixels no longer depend on
 * the host's fontconfig either. That mattered: with the platform's own font the
 * three full-page goldens failed on CI while the four canvas-only ones passed,
 * because the canvas carries no text and only the painted words disagreed.
 * A missing baseline is an error rather than a skip, and the comparison is
 * still done per-engine, since rasterisation differs between engines even when
 * the outlines are the same.
 *
 * Usage:
 *   node tests/golden.test.mjs                 # compare against baselines
 *   node tests/golden.test.mjs --update        # write new baselines
 * A missing baseline is an error, never a skip: an empty suite that reports
 * success is worse than one that fails, so this exits non-zero if there is
 * nothing to compare.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPlaywright, openScene, stepFrames } from '../tools/browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'index.html')).href;
const goldenDir = join(root, 'tests', 'golden');

const engineName = process.argv.includes('--engine')
  ? process.argv[process.argv.indexOf('--engine') + 1]
  : 'firefox';
const update = process.argv.includes('--update');

/**
 * Scenarios. Each is a (scene, setup) pair worth a regression baseline: the
 * three viewports, plus the states whose appearance carries meaning, plus an
 * interaction result. Field crops are used for the physics states so a change
 * in surrounding text (which depends on system fonts) does not masquerade as a
 * physics regression; full pages are captured separately for layout.
 */
const SCENARIOS = [
  // Full-page captures pause and advance a fixed number of frames like every
  // other scenario: the default state is a spreading packet, and photographing
  // it while the page's own animation loop is still running captures whatever
  // frame the wall clock happened to reach.
  { name: 'desktop-page', scene: 'desktop', fullPage: true, setup: async (page) => stepFrames(page, 3) },
  { name: 'phone-portrait-page', scene: 'phone-portrait', fullPage: false, setup: async (page) => stepFrames(page, 3) },
  { name: 'phone-landscape-page', scene: 'phone-landscape', fullPage: false, setup: async (page) => stepFrames(page, 3) },
  {
    name: 'field-ground-state',
    scene: 'desktop',
    clipField: true,
    setup: async (page) => {
      await page.evaluate(() => window.__quantum.setView({ kind: 'ground' }));
      await stepFrames(page, 5);
    },
  },
  {
    name: 'field-superposition',
    scene: 'desktop',
    clipField: true,
    setup: async (page) => {
      await page.evaluate(() => window.__quantum.setView({ kind: 'superposition', parameters: { low: 1, high: 5 } }));
      await stepFrames(page, 5);
    },
  },
  {
    name: 'field-packet-after-100-frames',
    scene: 'desktop',
    clipField: true,
    setup: async (page) => {
      await page.evaluate(() => window.__quantum.setView({ kind: 'packet' }));
      await stepFrames(page, 100);
    },
  },
  {
    name: 'field-travelling-phase',
    scene: 'desktop',
    clipField: true,
    setup: async (page) => {
      await page.evaluate(() => window.__quantum.setView({ kind: 'travelling', view: 'phase' }));
      await stepFrames(page, 5);
    },
  },
];

const SCENE_BY_NAME = new Map([
  ['desktop', { name: 'desktop', width: 1280, height: 860, device: false }],
  ['phone-portrait', { name: 'phone-portrait', width: 390, height: 844, device: true }],
  ['phone-landscape', { name: 'phone-landscape', width: 844, height: 390, device: true }],
]);

function differenceReport(a, b) {
  const bytes = Math.min(a.length, b.length);
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < bytes; i += 1) {
    const delta = Math.abs(a[i] - b[i]);
    if (delta > 0) differing += 1;
    if (delta > maxDelta) maxDelta = delta;
  }
  return { differing, maxDelta, length: a.length, sizeMismatch: a.length !== b.length };
}

const engines = await loadPlaywright();
let failures = 0;
let compared = 0;
mkdirSync(goldenDir, { recursive: true });

/**
 * One browser per scene rather than per scenario: launching Firefox takes about
 * ten seconds, so launching it once per scenario made the suite take minutes for
 * reasons unrelated to what it is checking. Contexts are cheap and isolated,
 * which is all the independence these scenarios need.
 */
const byScene = new Map();
for (const scenario of SCENARIOS) {
  if (!byScene.has(scenario.scene)) byScene.set(scenario.scene, []);
  byScene.get(scenario.scene).push(scenario);
}

for (const [sceneName, sceneScenarios] of byScene) {
  const scene = SCENE_BY_NAME.get(sceneName);
  const { browser } = await openScene(engines, engineName, scene, url, { stayOpen: true });
  for (const scenario of sceneScenarios) {
    const { page, problems } = await openScene(engines, engineName, scene, url, { reuseBrowser: browser });
    await scenario.setup(page);
    await page.waitForTimeout(80);
    const options = { type: 'png', fullPage: scenario.fullPage === true };
    if (scenario.clipField) {
      const box = await page.locator('#field').boundingBox();
      Object.assign(options, { clip: box });
    }
    const shot = await page.screenshot(options);
    const baseline = join(goldenDir, `${scenario.name}.png`);

    if (problems.length > 0) {
      process.stdout.write(`FAIL ${scenario.name}: page reported problems: ${problems.join(' | ')}\n`);
      failures += 1;
    } else if (update) {
      writeFileSync(baseline, shot);
      process.stdout.write(`updated ${scenario.name} (${shot.length} bytes)\n`);
    } else if (!existsSync(baseline)) {
      process.stdout.write(`FAIL ${scenario.name}: no baseline at ${baseline}. Run with --update after reviewing it.\n`);
      failures += 1;
    } else {
      const expected = readFileSync(baseline);
      const report = differenceReport(expected, shot);
      if (report.sizeMismatch || report.differing > 0) {
        writeFileSync(join(root, '.tmp', `${scenario.name}.actual.png`), shot);
        process.stdout.write(
          `FAIL ${scenario.name}: ${report.differing} bytes differ (max delta ${report.maxDelta}${report.sizeMismatch ? `, size ${expected.length} vs ${shot.length}` : ''}). Actual written to .tmp/${scenario.name}.actual.png\n`,
        );
        failures += 1;
      } else {
        process.stdout.write(`ok ${scenario.name}\n`);
      }
      compared += 1;
    }
  }
  await browser.close();
}

// Guard against the suite silently checking nothing: no comparisons made is a
// failure, so a rename or misconfigured engine cannot present as a pass.
const baselines = readdirSync(goldenDir).filter((name) => name.endsWith('.png'));
if (!update && baselines.length === 0) {
  process.stdout.write('FAIL: no baseline screenshots exist; the suite would verify nothing.\n');
  failures += 1;
}

process.stdout.write(`\n${compared} compared, ${failures} failures (engine: ${engineName})\n`);
process.exit(failures > 0 ? 1 : 0);
