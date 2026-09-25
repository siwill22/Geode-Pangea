/*
 * Chapter 5 builds on chapters 3 and 4: the fit from "Beneath the waves" and Africa's
 * motion from "Plates over plumes", carried in this browser or loaded from .rot files.
 *
 *   NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_carry.cjs
 *
 * Asserts, with real drags in chapters 3 and 4:
 * - chapter 5 keeps chapter 3's positions relative to Africa;
 * - Africa's chapter 4 rotation (to 150 Ma) arrives with the same pole, angle x 200/150;
 * - in a fresh browser (nothing stored), the same result comes from the exported files.
 */
const { chromium } = require('playwright');

const BASE = process.env.URL || 'http://127.0.0.1:8765/';
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

const mul = (x, y) => [
  x[3] * y[0] + x[0] * y[3] + x[1] * y[2] - x[2] * y[1],
  x[3] * y[1] - x[0] * y[2] + x[1] * y[3] + x[2] * y[0],
  x[3] * y[2] + x[0] * y[1] - x[1] * y[0] + x[2] * y[3],
  x[3] * y[3] - x[0] * y[0] - x[1] * y[1] - x[2] * y[2]];
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
const same = (a, b, tol = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < tol) || a.every((x, i) => Math.abs(x + b[i]) < tol);
const poleAngle = (q) => { const s = Math.hypot(q[0], q[1], q[2]); const sg = q[3] < 0 ? -1 : 1;
  return { axis: q.slice(0, 3).map((x) => sg * x / s), angle: 2 * Math.atan2(s, Math.abs(q[3])) * 180 / Math.PI }; };

async function open(page, chapter) {
  await page.goto(`${BASE}?chapter=${chapter}`);
  await page.waitForFunction(() => window.__dragPlates?.plates.length > 0);
}
const qs = (page) => page.evaluate(() => Object.fromEntries(window.__dragPlates.plates.map((p) => [p.id, [...p.q]])));
async function dragPlate(page, id, dx, dy) {
  const c = await page.evaluate((id) => { const d = window.__dragPlates, p = d.plates.find((x) => x.id === id);
    const s = d.projector.project(d.rotateByPlateShown(id, p.centre)); return s && [s[0], s[1]]; }, id);
  await page.mouse.move(c[0], c[1]); await page.mouse.down();
  await page.mouse.move(c[0] + dx, c[1] + dy, { steps: 15 }); await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Chapter 3: a fit, with Africa moved too, so "relative to Africa" is really tested.
  await open(page, 'shelves');
  await dragPlate(page, 701, -20, 10);
  await dragPlate(page, 201, 60, -10);
  await dragPlate(page, 301, -15, 25);
  const q3 = await qs(page);
  const rot3 = await page.evaluate(() => window.__dragPlates.rotationFile());

  // Chapter 4: Africa over the hotspots.
  await open(page, 'plumes');
  await dragPlate(page, 701, -50, 35);
  const q4 = (await qs(page))[701];
  const rot4 = await page.evaluate(() => window.__dragPlates.rotationFile());

  async function checkTree(p, label, tol = 1e-6) {
    // A .rot file holds degrees to 4 decimals, so a round trip through one agrees to ~1e-4.
    const q5 = await qs(p);
    const r3 = (id) => mul(conj(q3[701]), q3[id]);
    const r5 = (id) => mul(conj(q5[701]), q5[id]);
    check([201, 301, 101, 801].every((id) => same(r3(id), r5(id), tol)), `${label}: chapter 3 fit kept relative to Africa`);
    const a4 = poleAngle(q4), a5 = poleAngle(q5[701]);
    check(same(a4.axis, a5.axis, tol) && Math.abs(a5.angle - a4.angle * 200 / 150) < Math.max(tol, 1e-6) * 10,
      `${label}: Africa's pole kept, angle ${a4.angle.toFixed(3)} -> ${a5.angle.toFixed(3)} deg (x 200/150)`);
    const note = await p.textContent('#carry-note');
    check(/Fit from/.test(note) && /150 Ma/.test(note), `${label}: the panel says what was carried over`);
  }

  // Chapter 5, same browser: carried over by storage.
  await open(page, 'tree');
  await checkTree(page, 'stored');
  require('fs').mkdirSync(require('path').join(__dirname, 'out-carry'), { recursive: true });
  await page.screenshot({ path: require('path').join(__dirname, 'out-carry', 'tree-carried.png') });

  // A fresh browser with nothing stored starts from present day...
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', (e) => errors.push(e.message));
  await open(page2, 'tree');
  const fresh = await qs(page2);
  check(Object.values(fresh).every((q) => same(q, [0, 0, 0, 1])), 'fresh browser: every plate starts at present day');
  check(/No fit/.test(await page2.textContent('#carry-note')), 'fresh browser: the panel says there is no fit yet');
  // ... and the exported files bring the same result, through the real file inputs.
  await page2.setInputFiles('#load-fit', { name: 'pangea-200Ma.rot', mimeType: 'text/plain', buffer: Buffer.from(rot3) });
  await page2.setInputFiles('#load-motion', { name: 'pangea-150Ma.rot', mimeType: 'text/plain', buffer: Buffer.from(rot4) });
  await page2.waitForFunction(() => /file/.test(document.getElementById('carry-note').textContent));
  await checkTree(page2, 'from files', 1e-4);

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
