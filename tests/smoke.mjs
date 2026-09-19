/**
 * End-to-end smoke test in headless Chromium with a fake camera.
 *
 *   node tests/smoke.mjs
 *
 * Checks that the page boots without errors, the WebGL pipeline compiles, the preview renders, a capture is
 * stored, the import path works, and the colour pipeline behaves as designed on reference patches.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = 8765;
const server = spawn('npx', ['http-server', '.', '-p', String(PORT), '-s', '-c-1'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
});
let failures = 0;
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    permissions: ['camera'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => document.getElementById('status').hidden, null, { timeout: 15000 });
  await page.waitForTimeout(600);

  // Preview renders something that is not black.
  const previewStats = await page.evaluate(() => {
    const p = window.__hcs.preview;
    window.__hcs.renderPreview();
    const px = p.readPixels();
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    return { w: p.canvas.width, h: p.canvas.height, mean: sum / (px.length / 4) / 3 };
  });
  console.log('preview', previewStats);
  assert.ok(previewStats.w > 100 && previewStats.h > 100, 'preview canvas has size');
  assert.ok(previewStats.mean > 2, 'preview is not black');

  // Lens buttons work (fake device has a single camera, so the others fall back).
  for (const lens of ['uw', 'tele', 'front', 'wide']) {
    await page.click(`.lenses button[data-lens="${lens}"]`);
    await page.waitForFunction((l) => window.__hcs.state.lens === l && !!window.__hcs.state.stream, lens, { timeout: 10000 });
  }
  await page.waitForTimeout(800);
  const pressed = await page.$$eval('.lenses button[aria-pressed="true"]', (b) => b.map((x) => x.dataset.lens));
  assert.deepEqual(pressed, ['wide'], 'exactly one lens button pressed after switching');
  assert.ok(await page.evaluate(() => document.getElementById('status').hidden), 'status hidden after lens switches');
  await page.screenshot({ path: process.env.SHOT || '/tmp/hcs-cam-shot.png' });
  const zoomBadge = await page.textContent('#zoom-badge');
  assert.equal(zoomBadge.trim(), '1×');

  // Capture stores a JPEG.
  await page.click('#btn-shutter');
  await page.waitForFunction(() => document.getElementById('thumb-count').textContent === '1', null, { timeout: 10000 });
  const captured = await page.evaluate(async () => {
    const req = indexedDB.open('hcs-cam');
    const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const all = await new Promise((res, rej) => { const r = db.transaction('photos').objectStore('photos').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return all.map((p) => ({ type: p.blob.type, size: p.blob.size, w: p.width, h: p.height, lens: p.lens, aspect: p.width / p.height }));
  });
  console.log('captured', captured);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].type, 'image/jpeg');
  assert.ok(captured[0].size > 5000);
  assert.ok(Math.abs(captured[0].aspect - 4 / 3) < 0.02 || Math.abs(captured[0].aspect - 3 / 4) < 0.02, '4:3 crop');

  // Aspect cycling changes the crop.
  await page.click('#btn-aspect');
  assert.equal((await page.textContent('#btn-aspect')).trim(), '3:2');
  await page.click('#btn-aspect'); await page.click('#btn-aspect');
  assert.equal((await page.textContent('#btn-aspect')).trim(), 'XPan');
  await page.click('#btn-shutter');
  await page.waitForFunction(() => document.getElementById('thumb-count').textContent === '2', null, { timeout: 10000 });
  await page.click('#btn-aspect');

  // Import path: feed a generated PNG through the file input.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 640, 0); grad.addColorStop(0, '#2a4d8f'); grad.addColorStop(1, '#e0a070');
    g.fillStyle = grad; g.fillRect(0, 0, 640, 480);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.setInputFiles('#file-input', { name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await page.waitForFunction(() => document.getElementById('viewer').open, null, { timeout: 10000 });
  const meta = await page.textContent('#viewer-meta');
  console.log('import', meta);
  assert.ok(meta.includes('Imported') && meta.includes('640×480'));
  await page.click('#viewer-back');

  // Settings sheet: looks and strength.
  await page.click('#btn-settings');
  await page.waitForSelector('#sheet-settings[open]');
  await page.click('#look-picker button[data-look="portrait"]');
  assert.equal(await page.evaluate(() => window.__hcs.settings.look), 'portrait');
  await page.click('#look-picker button[data-look="natural"]');
  await page.click('#sheet-settings [data-close]');

  // Colour behaviour on reference patches (sRGB 8-bit in → out).
  const colour = await page.evaluate(() => {
    const patches = {
      black: [0, 0, 0], white: [255, 255, 255], grey18: [118, 118, 118], grey50: [128, 128, 128], greyLight: [200, 200, 200], greyDark: [40, 40, 40],
      skinLight: [232, 190, 168], skinMid: [198, 140, 108], skinDark: [120, 78, 56],
      red: [200, 40, 40], green: [60, 170, 60], foliage: [90, 130, 50], blue: [50, 90, 200], sky: [120, 170, 235], yellow: [230, 200, 60], magenta: [190, 60, 170],
    };
    const keys = Object.keys(patches);
    const c = document.createElement('canvas'); c.width = keys.length; c.height = 1;
    const g = c.getContext('2d');
    keys.forEach((k, i) => { g.fillStyle = `rgb(${patches[k].join(',')})`; g.fillRect(i, 0, 1, 1); });
    const pipe = window.__hcs.ensureCapturePipeline();
    const run = (lookId, strength) => {
      pipe.setLook(window.__hcs.LOOKS[lookId]); pipe.setStrength(strength); pipe.setExposureOffset(0);
      pipe.upload(c);
      pipe.render({ aspect: null, zoom: 1, mirror: false, width: keys.length, height: 1 });
      const px = pipe.readPixels();
      const out = {};
      keys.forEach((k, i) => { out[k] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]; });
      return out;
    };
    return { input: patches, natural: run('natural', 1), passthrough: run('natural', 0), neutral: run('neutral', 1), portrait: run('portrait', 1) };
  });

  const toOklch = ([r, g, b]) => {
    const lin = [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
    const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
    const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
  };
  const hueDiff = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

  const rows = [];
  for (const k of Object.keys(colour.input)) {
    const i = toOklch(colour.input[k]);
    const o = toOklch(colour.natural[k]);
    rows.push({ patch: k, in: colour.input[k].join(','), out: colour.natural[k].join(','), dL: +(o.L - i.L).toFixed(3), chroma: i.C > 0.01 ? +(o.C / i.C).toFixed(3) : '-', dHue: i.C > 0.01 ? +hueDiff(o.h, i.h).toFixed(1) : '-' });
  }
  console.table(rows);

  const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok:', msg); };
  const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

  // Strength 0 is a true passthrough.
  check(Object.keys(colour.input).every((k) => maxDiff(colour.input[k], colour.passthrough[k]) <= 1), 'strength 0 passes pixels through unchanged');
  // Black and white are anchored; neutrals stay neutral.
  check(maxDiff(colour.natural.black, [0, 0, 0]) <= 1, 'black stays black');
  check(maxDiff(colour.natural.white, [255, 255, 255]) <= 1, 'white stays white');
  for (const k of ['grey18', 'grey50', 'greyLight', 'greyDark']) {
    const [r, g, b] = colour.natural[k];
    check(Math.max(r, g, b) - Math.min(r, g, b) <= 1, `${k} stays neutral (${r},${g},${b})`);
  }
  // Mid grey brightness is preserved within a small tolerance (tone curve pivots near 18% grey).
  check(Math.abs(colour.natural.grey18[0] - 118) <= 6, `18% grey stays near 118 (${colour.natural.grey18[0]})`);
  // Skin: hue held within a few degrees, chroma slightly reduced, not boosted.
  for (const k of ['skinLight', 'skinMid', 'skinDark']) {
    const r = rows.find((x) => x.patch === k);
    check(Math.abs(r.dHue) <= 5, `${k} hue shift ${r.dHue}° within 5°`);
    check(r.chroma >= 0.80 && r.chroma <= 1.0, `${k} chroma ratio ${r.chroma} in [0.80, 1.0]`);
  }
  // Greens are restrained and nudged toward yellow, blues lean cyan and are not boosted.
  const green = rows.find((x) => x.patch === 'green'), foliage = rows.find((x) => x.patch === 'foliage');
  check(green.chroma < 0.95 && foliage.chroma < 0.95, `greens desaturated (${green.chroma}, ${foliage.chroma})`);
  check(green.dHue > 0 && green.dHue < 10, `green hue toward yellow (${green.dHue}°)`);
  const blue = rows.find((x) => x.patch === 'blue'), sky = rows.find((x) => x.patch === 'sky');
  check(blue.dHue < 0 && blue.dHue > -8, `blue hue toward cyan (${blue.dHue}°)`);
  check(blue.chroma <= 1.02 && sky.chroma <= 1.02, 'blues not oversaturated');
  const red = rows.find((x) => x.patch === 'red');
  check(Math.abs(red.dHue) <= 6 && red.chroma >= 0.9 && red.chroma <= 1.08, `red stays rich (${red.chroma}, ${red.dHue}°)`);
  // Neutral look is flatter than Natural on a dark grey.
  check(colour.neutral.greyDark[0] >= colour.natural.greyDark[0], 'neutral look keeps more shadow detail than natural');

  // Service worker registered (http://localhost is a secure context).
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? (reg.active?.state || reg.installing?.state || reg.waiting?.state) : null;
  });
  console.log('service worker:', swState);
  check(!!swState, 'service worker registered');

  // Manifest is reachable and well formed.
  const manifest = await (await page.request.get(`http://localhost:${PORT}/manifest.webmanifest`)).json();
  check(manifest.display === 'standalone' && manifest.icons.length >= 3, 'manifest ok');

  if (errors.length) { failures++; console.error('Page errors:', errors); } else console.log('ok: no page errors');
} finally {
  await browser.close();
  server.kill();
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('smoke: all checks passed');
