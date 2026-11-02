/**
 * browser.mjs — launching a browser for the checks, and saying so loudly when
 * one cannot start.
 *
 * Playwright is not vendored: it is resolved from PLAYWRIGHT_ENTRY, an absolute
 * path the Nix dev shell sets, because ESM ignores NODE_PATH. A missing
 * variable is an error rather than a skip. That is a deliberate design choice
 * about the checks themselves: a suite that prints "passed" after painting zero
 * pages is worse than one that exits non-zero, because the red build describes
 * the code, whereas the green one describes nothing at all.
 *
 * Why Firefox is the default rather than Chromium: in this container Chromium's
 * headless shell dies before it paints, because its sandbox helper needs
 * syscalls the surrounding sandbox denies. Firefox does not. Both are still
 * selectable, and a browser that cannot start fails with the reason rather than
 * silently testing a different engine.
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED_ENV = ['PLAYWRIGHT_ENTRY', 'PLAYWRIGHT_BROWSERS_PATH'];

export const DEFAULT_ENGINE = 'firefox';

/** The three shapes the layout is designed and tested against. */
export const SCENES = [
  { name: 'desktop', width: 1280, height: 860, device: false },
  { name: 'phone-portrait', width: 390, height: 844, device: true },
  { name: 'phone-landscape', width: 844, height: 390, device: true },
];

export async function loadPlaywright() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `browser checks need ${missing.join(' and ')}; run inside the project shell:\n` +
        '  nix develop --command ./check.sh',
    );
  }
  const entry = process.env.PLAYWRIGHT_ENTRY;
  if (!existsSync(entry)) {
    throw new Error(`PLAYWRIGHT_ENTRY points at a file that does not exist: ${entry}`);
  }
  const loaded = await import(pathToFileURL(entry).href);
  const playwright = loaded.default && loaded.chromium === undefined ? loaded.default : loaded;
  return { chromium: playwright.chromium, firefox: playwright.firefox, webkit: playwright.webkit };
}

/** Collapse Playwright's wall of launch flags to the line that explains a failure. */
function launchFailureDetail(error) {
  const text = String(error?.message ?? error);
  const decisive = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes('FATAL') || line.includes('Operation not permitted'));
  return decisive ? `: ${decisive}` : `: ${text.slice(0, 400)}`;
}

/**
 * Open the artifact at one scene's viewport and wait until the app declares
 * itself ready. `requestfailed` and `pageerror` are collected because a bundle
 * that half-works — canvas painted, one control throwing — looks fine in a
 * screenshot and is not fine.
 */
/**
 * Open the artifact at one scene's viewport and wait until the app declares
 * itself ready. `requestfailed` and `pageerror` are collected because a bundle
 * that half-works — canvas painted, one control throwing — looks fine in a
 * screenshot and is not fine.
 *
 * Pass `reuseBrowser` to open an isolated context in a browser the caller
 * already launched, which keeps a scenario suite from paying ~10s of launch
 * cost per scenario; that caller owns closing the browser.
 */
export async function openScene(engines, engineName, scene, url, options = {}) {
  const engine = engines[engineName];
  if (!engine) throw new Error(`this Playwright build does not expose "${engineName}"`);
  let browser = options.reuseBrowser;
  if (browser === undefined) {
    try {
      browser = await engine.launch({ args: engineName === 'chromium' ? ['--autoplay-policy=no-user-gesture-required'] : [] });
    } catch (error) {
      throw new Error(`${engineName} could not start${launchFailureDetail(error)}`, { cause: error });
    }
  }
  const closeOnFailure = () => {
    if (options.reuseBrowser === undefined) browser.close().catch(() => {});
  };
  const context = await browser.newContext({
    viewport: { width: scene.width, height: scene.height },
    deviceScaleFactor: scene.device ? 2 : 1,
    isMobile: scene.device,
    hasTouch: true,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    locale: 'en-GB',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => document.documentElement.dataset.quantumReady === '1', { timeout: 20_000 });
  } catch (error) {
    // The readiness flag is set at the end of main(), so a timeout almost always
    // means the script threw. Attach what the page said rather than reporting a
    // bare timeout, which sends you looking for a slow load instead of a crash.
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 400)).catch(() => '');
    closeOnFailure();
    throw new Error(
      `app never became ready in ${engineName} at ${scene.name}. ` +
        `page errors: ${problems.join(' | ') || 'none reported'}. body text: ${text}`,
      { cause: error },
    );
  }
  return { browser, context, page, problems };
}

/**
 * Perform one touch drag on the field.
 *
 * Delivered as a synthetic PointerEvent sequence with pointerType 'touch', in
 * both engines, for two reasons. The app is touched on Android and moused on a
 * desktop, and one scripted gesture should exercise one code path in both. And
 * on Firefox the touchscreen API is not implemented, so a test leaning on it
 * would quietly test nothing at all.
 */
export async function dragField(page, from, to, samples = 12) {
  await page.evaluate(
    async ({ from, to, samples }) => {
      const field = document.querySelector('#field');
      const init = (point) => ({
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: point.x,
        clientY: point.y,
        bubbles: true,
        cancelable: true,
      });
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      field.dispatchEvent(new PointerEvent('pointerdown', init(from)));
      for (let i = 1; i <= samples; i += 1) {
        const t = i / samples;
        field.dispatchEvent(
          new PointerEvent('pointermove', init({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })),
        );
        await frame();
      }
      field.dispatchEvent(new PointerEvent('pointerup', { ...init(to), buttons: 0 }));
    },
    { from, to, samples },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

/** Advance the simulation deterministically, bypassing wall-clock animation. */
export async function stepFrames(page, count) {
  await page.evaluate((n) => window.__quantum.stepFrames(n), count);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}
