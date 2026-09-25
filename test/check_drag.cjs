/*
 * End-to-end check with real pointer events.
 *
 *   python3 -m http.server 8765 --bind 127.0.0.1      (from the repo root)
 *   CHAPTER=fit NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_drag.cjs [outDir]
 *
 * Asserts: a plate drag moves only that plate and keeps the grabbed point under the
 * cursor; an ocean drag turns the globe and moves no plate; a twist leaves the plate's
 * centre where it was. Writes screenshots, and the rotation file plus rotated vertices
 * for prep/check_parity.py to compare against pygplates.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CHAPTER = process.env.CHAPTER || 'fit';
const URL = (process.env.URL || 'http://127.0.0.1:8765/') + `?chapter=${CHAPTER}`;
const out = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

let failures = 0;
function check(ok, msg) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.__dragPlates?.plates.length > 0);
  console.log(`chapter ${CHAPTER}`);
  await page.screenshot({ path: path.join(out, '0-start.png') });

  // Screen position of a plate's current centre, and a snapshot of every rotation.
  const centreOnScreen = (id) => page.evaluate((id) => {
    const d = window.__dragPlates;
    const p = d.plates.find((x) => x.id === id);
    const s = d.projector.project(d.rotateByPlate(id, p.centre));
    return s && [s[0], s[1]];
  }, id);
  const state = () => page.evaluate(() => ({
    view: { ...window.__dragPlates.view },
    q: Object.fromEntries(window.__dragPlates.plates.map((p) => [p.id, [...p.q]])),
  }));
  const moved = (a, b, id) => a.q[id].some((x, i) => Math.abs(x - b.q[id][i]) > 1e-9);

  async function dragPath(from, to, { shift = false, steps = 25 } = {}) {
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps });
    await page.mouse.up();
    if (shift) await page.keyboard.up('Shift');
  }

  // 1. Drag Africa east and north.
  const AFRICA = 701;
  const start = await centreOnScreen(AFRICA);
  check(!!start, `Africa's centre is on screen at ${start}`);
  const grabHome = await page.evaluate(([x, y]) => {
    const d = window.__dragPlates;
    return d.screenToSphere(x, y);    // identity rotation, so home == current
  }, start);
  const before = await state();
  const end = [start[0] + 180, start[1] - 90];
  await dragPath(start, end);
  const after = await state();
  check(moved(before, after, AFRICA), 'Africa moved');
  check(Object.keys(after.q).filter((id) => +id !== AFRICA)
    .every((id) => !moved(before, after, id)), 'no other plate moved');
  check(after.view.lon === before.view.lon && after.view.lat === before.view.lat,
    'the globe did not turn during a plate drag');
  const slip = await page.evaluate(([g, [x, y]]) => {
    const d = window.__dragPlates;
    const nowAt = d.rotateByPlate(701, g);
    const under = d.screenToSphere(x, y);
    const dot = nowAt[0] * under[0] + nowAt[1] * under[1] + nowAt[2] * under[2];
    return Math.acos(Math.min(1, dot)) * 180 / Math.PI;
  }, [grabHome, end]);
  check(slip < 0.05, `grabbed point stays under the cursor (off by ${slip.toFixed(4)} deg)`);
  await page.screenshot({ path: path.join(out, '1-africa-dragged.png') });

  // 2. Drag open ocean well off to the side of the continents -> the globe turns.
  const pr = await page.evaluate(() => {
    const { cx, cy, radius } = window.__dragPlates.projector;
    return { cx, cy, radius };
  });
  let ocean = null;
  for (let a = 0; a < 360 && !ocean; a += 10) {
    const x = pr.cx + Math.cos(a * Math.PI / 180) * pr.radius * 0.85;
    const y = pr.cy + Math.sin(a * Math.PI / 180) * pr.radius * 0.85;
    const hit = await page.evaluate(([x, y]) => {
      const d = window.__dragPlates;
      return !!d.pick(d.screenToSphere(x, y));
    }, [x, y]);
    if (!hit) ocean = [x, y];
  }
  const b2 = await state();
  await dragPath(ocean, [ocean[0] - 120, ocean[1] + 40]);
  const a2 = await state();
  check(a2.view.lon !== b2.view.lon, `ocean drag turned the globe (lon ${b2.view.lon} -> ${a2.view.lon.toFixed(1)})`);
  check(Object.keys(a2.q).every((id) => !moved(b2, a2, id)), 'ocean drag moved no plate');
  await page.screenshot({ path: path.join(out, '2-globe-turned.png') });

  // 3. Shift-twist Australia (or whichever plate is nearest the middle if it is hidden).
  const AUS = 801;
  let c = await centreOnScreen(AUS);
  if (!c) {
    await page.evaluate(() => {
      Object.assign(window.__dragPlates.view, { lon: 135, lat: -25 });
      window.__dragPlates.draw();
    });
    c = await centreOnScreen(AUS);
  }
  const cBefore = await page.evaluate(() => {
    const d = window.__dragPlates, p = d.plates.find((x) => x.id === 801);
    return d.rotateByPlate(801, p.centre);
  });
  const grab = [c[0] + 30, c[1]];
  await dragPath(grab, [c[0], c[1] - 30], { shift: true, steps: 15 });
  const twist = await page.evaluate((c0) => {
    const d = window.__dragPlates, p = d.plates.find((x) => x.id === 801);
    const c1 = d.rotateByPlate(801, p.centre);
    const dot = c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2];
    const q = p.q;
    return { drift: Math.acos(Math.min(1, dot)) * 180 / Math.PI,
      angle: 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3])) * 180 / Math.PI };
  }, cBefore);
  check(twist.angle > 20, `Australia twisted by ${twist.angle.toFixed(1)} deg`);
  // acos near 1 resolves ~1.5e-8 rad (8.5e-7 deg), so this is the measurement floor.
  check(twist.drift < 1e-5, `its centre did not move (${twist.drift.toExponential(1)} deg)`);
  await page.screenshot({ path: path.join(out, '3-australia-twisted.png') });

  // 4. Play to present day and back, with the real buttons and slider.
  const poleAngle = (q) => {
    let [x, y, z, w] = q; if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
    const sn = Math.hypot(x, y, z);
    return { axis: sn > 1e-12 ? [x / sn, y / sn, z / sn] : [0, 0, 1], angle: 2 * Math.atan2(sn, w) * 180 / Math.PI };
  };
  const saved = await page.evaluate(() => window.__dragPlates.plates.map((p) => ({ id: p.id, q: [...p.q] })));
  const recon = await page.evaluate(() => window.__dragPlates.shownAge);
  await page.click('#play');
  await page.waitForTimeout(1500);
  const mid = await page.evaluate(() => ({ age: window.__dragPlates.shownAge,
    shown: window.__dragPlates.plates.map((p) => ({ id: p.id, q: [...p.shown] })) }));
  check(mid.age > 0 && mid.age < recon, `mid-play the display is at ${mid.age.toFixed(1)} Ma`);
  let midOk = true;
  for (const { id, q } of saved) {
    const a = poleAngle(q), b = poleAngle(mid.shown.find((x) => x.id === id).q);
    if (a.angle < 1e-6) { midOk = midOk && b.angle < 1e-6; continue; }
    const sameAxis = a.axis.reduce((s, v, i) => s + v * b.axis[i], 0) > 1 - 1e-9;
    midOk = midOk && sameAxis && Math.abs(b.angle - a.angle * mid.age / recon) < 1e-6;
  }
  check(midOk, 'mid-play every plate is turned about its own saved pole, by age/recon of its angle');
  await page.screenshot({ path: path.join(out, '4-playing.png') });
  await page.waitForFunction(() => window.__dragPlates.shownAge === 0, null, { timeout: 15000 });
  const atZero = await page.evaluate(() => window.__dragPlates.plates.every((p) => {
    const [x, y, z] = p.shown; return Math.hypot(x, y, z) < 1e-12; }));
  check(atZero, 'at 0 Ma every plate is back at its present-day position');
  check((await page.textContent('#play')).includes('Back'), 'the button now offers Back');
  await page.screenshot({ path: path.join(out, '5-present.png') });
  await page.click('#play');
  await page.waitForFunction((r) => window.__dragPlates.shownAge === r, recon, { timeout: 15000 });
  const restored = await page.evaluate(() => window.__dragPlates.plates.map((p) => ({ id: p.id, q: [...p.shown] })));
  check(saved.every(({ id, q }) => q.every((v, i) => v === restored.find((x) => x.id === id).q[i])),
    'Back returns every plate exactly to its saved rotation');

  // Scrub part-way with the keyboard (right arrow = toward the present), then grab a plate:
  // editing happens at the reconstruction age, so the display must snap back there.
  await page.focus('#scrub');
  for (let i = 0; i < 300; i++) await page.keyboard.press('ArrowRight');
  const scrubbed = await page.evaluate(() => window.__dragPlates.shownAge);
  check(scrubbed < recon, `right arrow moves toward the present (${recon} -> ${scrubbed.toFixed(1)} Ma)`);
  const target = await page.evaluate(() => {
    const d = window.__dragPlates, p = d.plates.find((x) => x.id === 801);
    const s = d.projector.project(d.rotateByPlateShown(801, p.centre));
    return s && [s[0], s[1]];
  });
  await page.mouse.move(target[0], target[1]);
  await page.mouse.down();
  const snapped = await page.evaluate(() => window.__dragPlates.shownAge);
  await page.mouse.up();
  check(snapped === recon, `grabbing a plate while scrubbed returns to ${recon} Ma (got ${snapped})`);

  // 5. For the pygplates parity check: the rotation file, and every plate's rotated vertices.
  const dump = await page.evaluate(() => {
    const d = window.__dragPlates;
    return {
      rot: d.rotationFile(100),
      plates: d.plates.map((p) => ({ id: p.id, name: p.name,
        home: Array.from(p.pickLayer.home), xyz: Array.from(p.pickLayer.xyz) })),
    };
  });
  fs.writeFileSync(path.join(out, 'drag.rot'), dump.rot);
  fs.writeFileSync(path.join(out, 'rotated.json'), JSON.stringify(dump.plates));

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
