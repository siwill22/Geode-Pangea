/*
 * "Opening the South Atlantic", with real pointer events.
 *
 *   NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_satlantic.cjs [outDir]
 *   conda run -n pygmt17 python prep/check_satlantic_parity.py [outDir]
 *
 * Asserts: only Africa and South America load, at present day; Africa cannot be moved
 * (a drag on it turns the globe); dragging South America changes the flowlines and the
 * misfit; the two flowline branches of every seed meet at the displayed age. Writes the exported .rot, the page's
 * flowlines (present-day positions, both branches) and its misfit rows, for pygplates.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = (process.env.URL || 'http://127.0.0.1:8765/') + '?chapter=satlantic&projection=globe';
const out = process.argv[2] || path.join(__dirname, 'out-satlantic');
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
  await page.click('#misfit-toggle');   // folded, so it covers nothing

  const q = () => page.evaluate(() => Object.fromEntries(window.__dragPlates.plates.map((p) => [p.id, [...p.q]])));
  const centre = (id) => page.evaluate((id) => {
    const d = window.__dragPlates, p = d.plates.find((x) => x.id === id);
    const s = d.projector.project(d.rotateByPlateShown(id, p.centre)); return [s[0], s[1]]; }, id);
  async function dragFrom(c, dx, dy) {
    await page.mouse.move(c[0], c[1]); await page.mouse.down();
    await page.mouse.move(c[0] + dx, c[1] + dy, { steps: 20 }); await page.mouse.up();
  }
  const info = await page.evaluate(() => { const d = window.__dragPlates, s = d.spreading();
    return { plates: d.plates.map((p) => p.name).sort().join(), fzs: s.fzs.length, seeds: s.seeds.length,
      chrons: [...new Set(s.isochrons.map((i) => i.chron))].join(' ') }; });
  check(info.plates === 'Africa,South America', `two plates (${info.plates})`);
  check(info.fzs > 50 && info.seeds > 10, `${info.fzs} fracture zones on ${info.seeds} flowlines`);
  check(/M0/.test(info.chrons) && /34/.test(info.chrons), `isochrons ${info.chrons}`);
  const q0 = await q();
  const stageBtn = (label) => page.click(`#stage-row button:has-text("${label}")`);
  check(Math.abs(await page.evaluate(() => window.__dragPlates.editAge) - 10.9) < 1e-6
    && Math.abs(await page.evaluate(() => window.__dragPlates.shownAge) - 10.9) < 1e-6,
    'opens fitting the youngest isochron, C5, shown at its age');

  // Africa is fixed: a drag starting on it turns the globe instead.
  const v0 = await page.evaluate(() => ({ ...window.__dragPlates.view }));
  await dragFrom(await centre(701), 40, 0);
  const q1 = await q(), v1 = await page.evaluate(() => ({ ...window.__dragPlates.view }));
  check(q1[701].every((x, i) => x === q0[701][i]) && v1.lon !== v0.lon, 'Africa does not move; the globe turned');

  // Fit C34 with the real button, then M0.
  await stageBtn('C34');
  check(Math.abs(await page.evaluate(() => window.__dragPlates.shownAge) - 83.5) < 1e-6, 'C34 button shows 83.5 Ma');
  await dragFrom(await centre(201), 120, 0);
  await stageBtn('M0');
  await dragFrom(await centre(201), 60, 10);
  const keys = await page.evaluate(() => window.__dragPlates.plates.find((p) => p.id === 201).keys.map((k) => k.age));
  check(JSON.stringify(keys) === '[83.5,120.4]', `two fitted stages (${keys})`);
  check((await page.$$('#stage-row button.fitted')).length === 2, 'both marked as fitted');

  // At each fitted age, every flowline's two branches meet at the ridge.
  const meet = await page.evaluate(() => {
    const d = window.__dragPlates; let worst = 0;
    for (const age of [83.5, 120.4]) {
      d.setShownAge(age); d.spreadingMisfit();
      const s = d.spreading(), i = s.flowAges.indexOf(age), rot = d.rotateByPlateShown;
      for (const fl of s.flow) {
        const a = rot(701, fl[701][i]), b = rot(201, fl[201][i]);
        worst = Math.max(worst, Math.acos(Math.min(1, a[0]*b[0]+a[1]*b[1]+a[2]*b[2])) * 180 / Math.PI);
      }
    }
    return worst;
  });
  check(meet < 1e-5, `at both fitted ages the two branches of every flowline meet (worst ${meet.toExponential(1)} deg)`);

  // Back to C34: the plate is where it was fitted there.
  await stageBtn('C34');
  await page.screenshot({ path: path.join(out, '1-C34.png') });
  const m = await page.evaluate(() => window.__dragPlates.spreadingMisfit().per);
  check(m.length === 10 && m[0].km > 0, 'misfit: fracture zones and nine isochrons');
  await stageBtn('Present');
  check((await page.evaluate(() => window.__dragPlates.shownAge)) === 0, 'Present shows today');
  await page.screenshot({ path: path.join(out, '2-present.png') });

  // The pressed button changes only when the student clicks one: not by playing, and not
  // by grabbing South America while Present is chosen (that press turns the globe).
  const pressed = () => page.evaluate(() => [...document.querySelectorAll('#stage-row button[aria-pressed="true"]')].map((b) => b.dataset.age).join());
  await page.click('#play');
  await page.waitForFunction(() => window.__dragPlates.shownAge > 40, null, { timeout: 10000 });
  await page.click('#play');   // pause part way
  check(await pressed() === '0', `Present stays pressed while playing (${await pressed()})`);
  await stageBtn('Present');
  const qBefore = (await q())[201], keysBefore = await page.evaluate(() => JSON.stringify(window.__dragPlates.plates.find((p) => p.id === 201).keys));
  await dragFrom(await centre(201), 50, 0);
  check(await pressed() === '0', `Present stays pressed after a press on South America (${await pressed()})`);
  check((await q())[201].every((x, i) => x === qBefore[i])
    && keysBefore === await page.evaluate(() => JSON.stringify(window.__dragPlates.plates.find((p) => p.id === 201).keys))
    && (await page.evaluate(() => window.__dragPlates.shownAge)) === 0, 'South America does not move at Present');

  // A third stage, so the finite poles make a path; shown on the map.
  await stageBtn('C21');
  await dragFrom(await centre(201), 40, -20);
  await page.evaluate(() => window.__dragPlates.setProjection('map'));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, '3-poles-map.png') });
  await page.evaluate(() => window.__dragPlates.setProjection('globe'));
  await stageBtn('C34');
  await dragFrom(await centre(201), 3, 0);
  await page.screenshot({ path: path.join(out, '4-poles-globe.png') });

  // Dump for pygplates.
  const dump = await page.evaluate(() => {
    const d = window.__dragPlates; d.setShownAge(1e9);
    const m = d.spreadingMisfit(), s = d.spreading();
    const ll = (v) => [Math.atan2(v[1], v[0]) * 180 / Math.PI, Math.asin(v[2]) * 180 / Math.PI];
    return { rot: d.rotationFile(), recon: d.shownAge, misfit: m.per, flowAges: s.flowAges,
      seeds: s.seeds.map(ll), flow: s.flow.map((f) => ({ 701: f[701].map(ll), 201: f[201].map(ll) })) };
  });
  fs.writeFileSync(path.join(out, 'satlantic.rot'), dump.rot);
  fs.writeFileSync(path.join(out, 'satlantic.json'), JSON.stringify(dump));

  check(await page.evaluate(() => !document.getElementById('rates').hidden
    && document.querySelectorAll('#rates-plot path').length === 4), 'spreading-rate plot: four curves');
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
