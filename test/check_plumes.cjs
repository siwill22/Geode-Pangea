/*
 * The "Plates over plumes" chapter, with real pointer events and the real anchor menu.
 *
 *   NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_plumes.cjs [outDir]
 *   conda run -n pygmt17 python prep/check_plumes_parity.py [outDir]
 *
 * Asserts:
 * - Only Africa is shown, starting at present day (no rotation).
 * - The five chosen hotspots load, with Maher et al. (2015) samples; Azores with no
 *   samples but still a trail. The chains' seafloor cells load.
 * - Dragging Africa moves it, and the misfit responds.
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

  const info = await page.evaluate(() => {
    const d = window.__dragPlates;
    return { plates: d.plates.map((p) => p.name), q: [...d.plates[0].q],
      hs: Object.fromEntries(d.hotspots().map((h) => [h.name, [h.samples.length, h.plates.length]])) };
  });
  check(info.plates.join() === 'Africa', `only Africa is shown (${info.plates})`);
  check(info.q.slice(0, 3).every((x) => Math.abs(x) < 1e-12), 'Africa starts at present day');
  check(Object.keys(info.hs).sort().join() === 'Azores,Canary,Réunion,St Helena,Tristan',
    `the five hotspots (${JSON.stringify(info.hs)})`);
  check(info.hs.Azores[0] === 0 && info.hs.Azores[1] === 1, 'Azores: no samples, but a trail on Africa');
  check(info.hs['Réunion'][0] === 6 && info.hs.Tristan[0] === 28, 'Maher et al. (2015) Table 2 samples');
  const cells = await page.evaluate(() => window.__dragPlates.trailCells().length);
  check(cells > 2000, `hotspot-chain seafloor cells loaded (${cells})`);
  const misfit0 = await page.evaluate(() => window.__dragPlates.misfit().mean);

  await dragFrom(await centreOnScreen(701), -60, 40);
  const q1 = await state();
  check(!same(info.q, q1[701]), 'Africa moved');
  const misfit1 = await page.evaluate(() => window.__dragPlates.misfit().mean);
  check(misfit1 !== misfit0, `the misfit responds (${Math.round(misfit0)} -> ${Math.round(misfit1)} km)`);
  await page.screenshot({ path: path.join(out, '1-dragged.png') });
  const mid = 75;

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
