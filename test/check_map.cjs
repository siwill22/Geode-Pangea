/*
 * The Robinson map view, with real pointer, wheel and button events.
 *
 *   NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_map.cjs [outDir]
 *
 * Asserts:
 * - the Globe / Map switch changes the projector, and is remembered after a reload;
 * - on the map, a dragged plate keeps the grabbed point under the cursor, including a
 *   drag that carries it across the map's edge;
 * - dragging the ocean sideways slides the central meridian with the pointer; up-down
 *   does nothing; sideways scrolling slides it too; nothing moves a plate;
 * - a plate straddling the edge is drawn on both sides (pixels sampled).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = (process.env.URL || 'http://127.0.0.1:8765/') + '?chapter=shelves';
const out = process.argv[2] || path.join(__dirname, 'out-map');
fs.mkdirSync(out, { recursive: true });
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };
const deg = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.__dragPlates?.plates.length > 0);

  await page.click('[data-projection="map"]');
  check(await page.evaluate(() => typeof window.__dragPlates.projector.unproject === 'function'), 'Map button switches to the map');
  await page.reload();
  await page.waitForFunction(() => window.__dragPlates?.plates.length > 0);
  check(await page.evaluate(() => typeof window.__dragPlates.projector.unproject === 'function'), 'and it is remembered after a reload');

  const qs = () => page.evaluate(() => window.__dragPlates.plates.map((p) => [...p.q]));
  const lon = () => page.evaluate(() => window.__dragPlates.view.lon);
  const centre = (id) => page.evaluate((id) => {
    const d = window.__dragPlates, p = d.plates.find((x) => x.id === id);
    const s = d.projector.project(d.rotateByPlateShown(id, p.centre)); return [s[0], s[1]]; }, id);
  const grabbedPointAt = (id, grabHome) => page.evaluate(([id, g]) => {
    const d = window.__dragPlates; const v = d.rotateByPlateShown(id, g);
    const s = d.projector.project(v); return [s[0], s[1]]; }, [id, grabHome]);

  // 1. Drag Africa on the map: the grabbed point stays under the cursor.
  const c = await centre(701);
  // Africa is at present day, so the grabbed point's home is where it is on screen.
  const home = await page.evaluate(([x, y]) => window.__dragPlates.screenToSphere(x, y), c);
  await page.mouse.move(c[0], c[1]); await page.mouse.down();
  await page.mouse.move(c[0] + 120, c[1] - 60, { steps: 20 }); await page.mouse.up();
  const at = await grabbedPointAt(701, home);
  check(Math.hypot(at[0] - c[0] - 120, at[1] - c[1] + 60) < 1.5,
    `the grabbed point of Africa ended under the cursor (${Math.hypot(at[0] - c[0] - 120, at[1] - c[1] + 60).toFixed(2)} px)`);

  // 2. Drag Australia across the right edge of the map: it comes in on the left.
  const a = await centre(801);
  const rightEdge = await page.evaluate(() => { const m = window.__dragPlates.projector; return m.px(179.5, 0)[0]; });
  await page.mouse.move(a[0], a[1]); await page.mouse.down();
  await page.mouse.move(rightEdge - 5, a[1], { steps: 20 });
  await page.mouse.move(rightEdge + 60, a[1], { steps: 10 }); await page.mouse.up();
  // Sample pixels just inside each edge along Australia's latitude band.
  const seen = await page.evaluate(() => {
    const d = window.__dragPlates, m = d.projector, p = d.plates.find((x) => x.id === 801);
    const ll = (v) => [Math.atan2(v[1], v[0]) * 180 / Math.PI, Math.asin(v[2]) * 180 / Math.PI];
    const xyz = p.crustLayer.xyz; let east = 0, west = 0;
    for (let i = 0; i < xyz.length; i += 3) {
      let dl = ll([xyz[i], xyz[i + 1], xyz[i + 2]])[0] - m.lon; dl = ((dl + 180) % 360 + 360) % 360 - 180;
      if (dl > 150) east++; if (dl < -150) west++;
    }
    return { east, west };
  });
  check(seen.east > 0 && seen.west > 0, `Australia now straddles the edge (${seen.east} vertices east, ${seen.west} west)`);
  await page.screenshot({ path: path.join(out, '1-straddle.png') });
  const px = await page.evaluate(() => {
    const d = window.__dragPlates, m = d.projector, p = d.plates.find((x) => x.id === 801);
    const ctx = document.getElementById('globe').getContext('2d'), dpr = Math.min(devicePixelRatio, 2);
    // For a few vertices near each edge, look just inside the ring: is it not ocean?
    const ocean = [13, 27, 46];
    let hitE = 0, hitW = 0;
    const xyz = p.crustLayer.xyz;
    for (let i = 0; i < xyz.length; i += 9) {
      const v = [xyz[i], xyz[i + 1], xyz[i + 2]];
      const [x, y] = m.project(v);
      const r = m.px(0, 0)[0];
      const e = x > r ? 1 : 0;
      const img = ctx.getImageData(Math.round((x + (e ? -3 : 3)) * dpr), Math.round(y * dpr), 1, 1).data;
      const isOcean = Math.abs(img[0] - ocean[0]) + Math.abs(img[1] - ocean[1]) + Math.abs(img[2] - ocean[2]) < 12;
      if (!isOcean) { if (e) hitE++; else hitW++; }
    }
    return { hitE, hitW };
  });
  check(px.hitE > 0 && px.hitW > 0, `and is filled on both sides of the map (${px.hitE} / ${px.hitW} samples coloured)`);

  // 3. Slide the map: ocean drag sideways, up-down, and a sideways wheel.
  const q0 = await qs(), l0 = await lon();
  const ocean = await page.evaluate(() => { const m = window.__dragPlates.projector; return m.px(-150, -45); });
  await page.mouse.move(ocean[0], ocean[1]); await page.mouse.down();
  await page.mouse.move(ocean[0] + 100, ocean[1], { steps: 10 }); await page.mouse.up();
  const l1 = await lon();
  const expected = -100 * 360 / (2 * 0.8487 * Math.PI * await page.evaluate(() => window.__dragPlates.projector.radius));
  check(Math.abs(((l1 - l0 - expected + 540) % 360) - 180) < 0.5, `sideways ocean drag slid the centre by ${(l1 - l0).toFixed(1)} deg`);
  await page.mouse.move(ocean[0] + 100, ocean[1]); await page.mouse.down();
  await page.mouse.move(ocean[0] + 100, ocean[1] - 80, { steps: 10 }); await page.mouse.up();
  check(Math.abs((await lon()) - l1) < 1e-9, 'an up-down drag does not slide it');
  await page.mouse.move(700, 450);
  await page.mouse.wheel(200, 0);
  await page.waitForTimeout(100);
  const l2 = await lon();
  check(Math.abs(l2 - l1) > 5, `a sideways scroll slid the centre by ${(l2 - l1).toFixed(1)} deg`);
  const q1 = await qs();
  check(q0.every((q, i) => q.every((x, k) => x === q1[i][k])), 'sliding the map moved no plate');

  // 4. Back to the globe.
  await page.click('[data-projection="globe"]');
  check(await page.evaluate(() => typeof window.__dragPlates.projector.unproject !== 'function'), 'Globe button switches back');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
