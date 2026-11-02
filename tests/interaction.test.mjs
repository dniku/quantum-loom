/**
 * Interaction tests: does the artifact behave when driven through its interface?
 *
 * These exercise the loaded page the way a person does — press, drag, tap a
 * chip — and assert on what a user would then observe, rather than on internal
 * calls. They run against the built index.html, so they catch a bundling or
 * initialisation failure that unit tests of the source modules cannot: the
 * physics can be perfect and the page still blank.
 *
 * The gestures are dispatched as synthetic PointerEvents (see tools/browser.mjs)
 * because Firefox has no touchscreen API and the checks must exercise the real
 * touch code path in both engines.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPlaywright, openScene, dragField, stepFrames, SCENES } from '../tools/browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(join(root, 'index.html')).href;
const engineName = process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : 'firefox';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const engines = await loadPlaywright();
let browser;
try {
  const opened = await openScene(engines, engineName, SCENES[0], url);
  browser = opened.browser;
  const { page, problems } = opened;

  // The app is live and shows the invitation to touch.
  check('app signals ready', await page.evaluate(() => document.documentElement.dataset.quantumReady === '1'));
  const hintVisible = await page.locator('#hint').isVisible();
  check('onboarding hint is visible on load', hintVisible);

  // Two canvases exist and are actually painted (non-zero pixels), so a blank
  // canvas cannot pass as "rendered".
  const painted = await page.evaluate(() => {
    const report = (id) => {
      const canvas = document.getElementById(id);
      if (!canvas || !canvas.width) return { ok: false, why: 'missing or zero-sized' };
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlack = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 24) nonBlack += 1;
      return { ok: nonBlack > 100, nonBlack };
    };
    return { field: report('field'), spectrum: report('spectrum') };
  });
  check('field canvas is painted (not blank)', painted.field.ok, JSON.stringify(painted.field));
  check('spectrum canvas is painted (not blank)', painted.spectrum.ok, JSON.stringify(painted.spectrum));

  // Dragging the field places and kicks the packet, and reports it.
  const box = await page.locator('#field').boundingBox();
  const before = await page.evaluate(() => ({ ...window.__quantum.view.parameters }));
  await dragField(
    page,
    { x: box.x + box.width * 0.35, y: box.y + box.height * 0.5 },
    { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 },
  );
  const after = await page.evaluate(() => ({ ...window.__quantum.view.parameters }));
  check('a drag moves where the packet is placed', after.offsetX !== before.offsetX, `${before.offsetX} -> ${after.offsetX}`);
  const title = await page.locator('#state-title').innerText();
  check('the app explains what the drag did', /flicked/i.test(title), JSON.stringify(title));

  // A free packet spreads: sigma_x grows. Chosen after a fresh narrow packet so
  // the effect is present; a wide packet barely spreads and that is correct.
  await page.evaluate(() => window.__quantum.setView({ kind: 'packet', parameters: { width: 4, offsetX: 0, offsetY: 0 } }));
  const sigmaStart = Number(await page.evaluate(() => document.getElementById('readout-sigma-x').textContent));
  await stepFrames(page, 60);
  const sigmaEnd = Number(await page.evaluate(() => document.getElementById('readout-sigma-x').textContent));
  check('a narrow packet spreads over time', sigmaEnd > sigmaStart, `${sigmaStart} -> ${sigmaEnd}`);

  // Probability stays 1: the readout, not an internal call.
  const norm = await page.evaluate(() => Number(document.getElementById('readout-norm').textContent));
  check('probability left stays 1.000', Math.abs(norm - 1) < 0.001, String(norm));

  // Switching to the walled box reveals the wall control and reports absorption.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('[data-boundary]')].find((b) => b.dataset.boundary === 'walls');
    button.click();
  });
  const wallRowVisible = await page.locator('#well-width-row').isVisible();
  check('choosing walls reveals the wall control', wallRowVisible);
  const absorbedRow = await page.evaluate(() => {
    document.getElementById('wellWidth').value = '16';
    document.getElementById('wellWidth').dispatchEvent(new Event('input', { bubbles: true }));
    return !document.getElementById('readout-absorbed-row').hidden;
  });
  check('with walls, the absorption readout is shown', absorbedRow);

  // The periodic control hides it again — the attribute actually takes effect
  // (this is the regression the [hidden] CSS rule fixes).
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('[data-boundary]')].find((b) => b.dataset.boundary === 'periodic');
    button.click();
  });
  check('choosing periodic hides the wall control', !(await page.locator('#well-width-row').isVisible()));

  // No page errors across all of that.
  check('no page errors or failed requests', problems.length === 0, problems.join(' | '));
} catch (error) {
  check('interaction run completed', false, String(error && error.message ? error.message : error));
} finally {
  if (browser) await browser.close();
}

const failures = results.filter((r) => !r.ok).length;
process.stdout.write(`\n${results.length - failures}/${results.length} interaction checks passed (engine: ${engineName})\n`);
process.exit(failures > 0 ? 1 : 0);
