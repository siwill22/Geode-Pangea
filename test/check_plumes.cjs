/*
 * The "Plates over plumes" chapter, with real pointer events and the real anchor menu.
 *
 *   NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_plumes.cjs [outDir]
 *   conda run -n pygmt17 python prep/check_plumes_parity.py [outDir]
 *
 * Asserts:
 * - Dragging the anchor moves every plate rigidly with it.
 * - Dragging another plate moves only that plate.
 * - Changing the anchor moves nothing at the reconstruction age but does change the paths
 *   in between.
 *
 * Writes the exported hierarchical .rot, vertices at the reconstruction age and at a
 * mid age, and the page's misfit, for the pygplates comparison.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = (process.env.URL || 'http://127.0.0.1:8765/') + '?chapter=plumes';
const out = process.argv[2] || path.join(__dirname, 'out-plumes');
fs.mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.__dragPlates?.plates.length > 0);

  const state = () => page.evaluate(() => Object.fromEntries(
    window.__dragPlates.plates.map((p) => [p.id, [...p.q]])));
  // Rotation of each plate relative to the current anchor.
  const relative = () => page.evaluate(() => {
    const d = window.__dragPlates, a = d.anchor.q, ai = [-a[0], -a[1], -a[2], a[3]];
    const mul = (x, y) => [
      x[3] * y[0] + x[0] * y[3] + x[1] * y[2] - x[2] * y[1],
      x[3] * y[1] - x[0] * y[2] + x[1] * y[3] + x[2] * y[0],
      x[3] * y[2] + x[0] * y[1] - x[1] * y[0] + x[2] * y[3],
      x[3] * y[3] - x[0] * y[0] - x[1] * y[1] - x[2] * y[2]];
    return Object.fromEntries(d.plates.map((p) => [p.id, mul(ai, p.q)]));
  });
  const same = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9 || Math.abs(x + b[i]) < 1e-9);
  const centreOnScreen = (id) => page.evaluate((id) => {
    const d = window.__dragPlates, p = d.plates.find((x) => x.id === id);
    const s = d.projector.project(d.rotateByPlateShown(id, p.centre));
    return s && [s[0], s[1]];
  }, id);
  async function dragFrom(from, dx, dy) {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(from[0] + dx, from[1] + dy, { steps: 20 });
    await page.mouse.up();
  }

  const misfit0 = await page.evaluate(() => window.__dragPlates.misfit().mean);

  // 1. Drag Africa, the anchor: everything moves with it.
  const rel0 = await relative(), q0 = await state();
  await dragFrom(await centreOnScreen(701), -60, 40);
  const rel1 = await relative(), q1 = await state();
  check(!same(q0[701], q1[701]), 'Africa (the anchor) moved');
  check(Object.keys(q0).every((id) => same(rel0[id], rel1[id])),
    'every plate kept its rotation relative to Africa');
  check(Object.keys(q0).filter((id) => +id !== 701).every((id) => !same(q0[id], q1[id])),
    'so every other plate moved too');
  const misfit1 = await page.evaluate(() => window.__dragPlates.misfit().mean);
  check(misfit1 !== misfit0, `the misfit responds (${Math.round(misfit0)} -> ${Math.round(misfit1)} km)`);

  // 2. Drag South America: only it moves.
  await dragFrom(await centreOnScreen(201), 30, -20);
  const q2 = await state();
  check(!same(q1[201], q2[201]), 'South America moved');
  check(Object.keys(q1).filter((id) => +id !== 201).every((id) => same(q1[id], q2[id])),
    'nothing else did');
  await page.screenshot({ path: path.join(out, '1-dragged.png') });

  // 3. Change the anchor with the real menu.
  const mid = 75;
  const at = (age) => page.evaluate((age) => {
    const d = window.__dragPlates; d.setShownAge(age);
    return Object.fromEntries(d.plates.map((p) => [p.id, [...p.shown]]));
  }, age);
  const midAfrica = await at(mid);
  await page.selectOption('#anchor', '901');
  check((await page.evaluate(() => window.__dragPlates.anchor.name)) === 'Pacific', 'anchor is now the Pacific');
  const q3 = await state();
  check(Object.keys(q2).every((id) => same(q2[id], q3[id])), 'changing the anchor moves nothing at 150 Ma');
  const midPacific = await at(mid);
  check(Object.keys(midAfrica).some((id) => !same(midAfrica[id], midPacific[id])),
    `but at ${mid} Ma the plates are elsewhere: the path depends on the hierarchy`);
  await page.evaluate(() => window.__dragPlates.setShownAge(1e9));

  // 4. Dump for pygplates: the file, vertices at two ages, and the misfit.
  const dump = await page.evaluate((mid) => {
    const d = window.__dragPlates;
    const verts = (age) => { d.setShownAge(age);
      return d.plates.map((p) => ({ id: p.id, name: p.name,
        home: Array.from(p.pickLayer.home), xyz: Array.from(p.pickLayer.xyz),
        live: p.pickLayer.rings.map((r) => p.pickLayer.isLive(r, age)),
        rings: p.pickLayer.rings.map((r) => [r.offset, r.count]) })); };
    const recon = d.shownAge;
    const out = { rot: d.rotationFile(), recon, mid, atRecon: verts(recon), atMid: verts(mid) };
    d.setShownAge(recon);
    out.misfit = d.misfit();
    out.samples = d.hotspots().map((h) => ({ name: h.name, h: h.h,
      samples: h.samples.map((s) => ({ v: s.v, age: s.age, plate: s.plate.id })) }));
    return out;
  }, mid);
  fs.writeFileSync(path.join(out, 'plumes.rot'), dump.rot);
  fs.writeFileSync(path.join(out, 'plumes.json'), JSON.stringify(dump));

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
