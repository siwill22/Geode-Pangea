/*
 * The "rotation tree" chapter, with real pointer events and the real "moves with" menus.
 *
 *   NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_tree.cjs [outDir]
 *   conda run -n pygmt17 python prep/check_plumes_parity.py [outDir]   (reads tree.* too)
 *
 * Asserts:
 * - Linking by menu keeps every plate where it is at the reconstruction age.
 * - Dragging Africa carries its descendants, keeping their rotations relative to it, and
 *   leaves plates linked to the mantle alone.
 * - Dragging a child moves it and its own descendants only.
 * - Relinking a plate moves nothing at the reconstruction age but changes its path.
 * - A loop is not offered in the menus; Undo restores a link.
 * Writes the exported rotation tree and vertices at two ages for the pygplates check.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = (process.env.URL || 'http://127.0.0.1:8765/') + '?chapter=tree';
const out = process.argv[2] || path.join(__dirname, 'out-tree');
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
  const parents = () => page.evaluate(() => Object.fromEntries(
    window.__dragPlates.plates.map((p) => [p.id, p.parent ? p.parent.id : 0])));
  const relative = () => page.evaluate(() => Object.fromEntries(
    window.__dragPlates.plates.map((p) => [p.id, [...window.__dragPlates.relativeQ(p)]])));
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
  const link = (child, parent) => page.selectOption(`select.parent[data-id="${child}"]`, String(parent));

  check((await page.evaluate(() => window.__dragPlates.mother.name)) === 'Africa', 'Africa is the mother plate');
  check(Object.values(await parents()).every((x) => x === 0), 'every plate starts linked to the mantle');

  // Spread the plates out first, so relative rotations are not all the identity.
  for (const [id, dx, dy] of [[201, 40, -10], [101, -30, 20], [301, 20, 15]]) {
    const c = await centreOnScreen(id);
    if (c) await dragFrom(c, dx, dy);
  }

  // 1. Build a tree by menu: South America and Eurasia with Africa, North America with Eurasia.
  const q0 = await state();
  await link(201, 701); await link(301, 701); await link(101, 301);
  check(JSON.stringify(await parents()).length > 0 && (await parents())[101] === 301, 'links set by menu');
  const q1 = await state();
  check(Object.keys(q0).every((id) => same(q0[id], q1[id])), 'linking moved nothing at the reconstruction age');

  // 2. A loop is not offered: Eurasia's menu has no North America (its child).
  const eurasiaOptions = await page.$$eval('select.parent[data-id="301"] option', (os) => os.map((o) => +o.value));
  check(!eurasiaOptions.includes(101), 'no loop on offer (North America is not in Eurasia\'s menu)');

  // 3. Drag Africa: its descendants follow, keeping their relative rotations; others do not.
  const rel1 = await relative();
  await dragFrom(await centreOnScreen(701), -50, 30);
  const q2 = await state(), rel2 = await relative();
  for (const id of [201, 301, 101]) {
    check(!same(q1[id], q2[id]) && same(rel1[id], rel2[id]), `plate ${id} came along, relative rotation kept`);
  }
  check(same(q1[801], q2[801]), 'Australia, linked to the mantle, stayed put');

  // 4. Drag Eurasia: it and North America move; Africa and South America do not.
  await dragFrom(await centreOnScreen(301), 25, -15);
  const q3 = await state();
  check(!same(q2[301], q3[301]) && !same(q2[101], q3[101]), 'Eurasia moved, carrying North America');
  check(same(q2[701], q3[701]) && same(q2[201], q3[201]), 'Africa and South America did not');

  // 5. Relink North America from Eurasia to Africa: same place at 200 Ma, different path.
  const at = (age) => page.evaluate((age) => {
    const d = window.__dragPlates; d.setShownAge(age);
    return Object.fromEntries(d.plates.map((p) => [p.id, [...p.shown]]));
  }, age);
  const midBefore = await at(100);
  await page.evaluate(() => window.__dragPlates.setShownAge(1e9));
  await link(101, 701);
  const q4 = await state();
  check(same(q3[101], q4[101]), 'relinking North America moved nothing at 200 Ma');
  const midAfter = await at(100);
  check(!same(midBefore[101], midAfter[101]), 'but at 100 Ma it is elsewhere: the path depends on the tree');
  await page.evaluate(() => window.__dragPlates.setShownAge(1e9));

  // 6. Undo restores the link.
  await page.click('#undo');
  check((await parents())[101] === 301, 'Undo put North America back with Eurasia');
  await page.screenshot({ path: path.join(out, '1-tree.png') });

  // 7. Dump for pygplates.
  const dump = await page.evaluate(() => {
    const d = window.__dragPlates;
    const verts = (age) => { d.setShownAge(age);
      return d.plates.map((p) => ({ id: p.id, name: p.name,
        home: Array.from(p.pickLayer.home), xyz: Array.from(p.pickLayer.xyz),
        live: p.pickLayer.rings.map((r) => p.pickLayer.isLive(r, age)),
        rings: p.pickLayer.rings.map((r) => [r.offset, r.count]) })); };
    const recon = d.shownAge;
    const o = { rot: d.rotationFile(), recon, mid: 100, atRecon: verts(recon), atMid: verts(100),
      misfit: { per: [] }, samples: [] };
    d.setShownAge(recon);
    return o;
  });
  fs.writeFileSync(path.join(out, 'plumes.rot'), dump.rot);
  fs.writeFileSync(path.join(out, 'plumes.json'), JSON.stringify(dump));
  console.log(dump.rot.split('\n').filter((l) => /^(101|301|201|701)/.test(l)).join('\n'));

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
