/*
 * The spreading-rate plot with Muller 2019's rotations loaded as the fitted stages.
 *
 *   conda run -n pygmt17 python prep/check_satlantic_rates.py keys OUT
 *   NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_satlantic_rates.cjs OUT
 *   conda run -n pygmt17 python prep/check_satlantic_rates.py check OUT
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = (process.env.URL || 'http://127.0.0.1:8765/') + '?chapter=satlantic&projection=globe';
const out = process.argv[2] || path.join(__dirname, 'out-satlantic');
const keys = JSON.parse(fs.readFileSync(path.join(out, 'muller_keys.json')));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => window.__dragPlates?.plates.length > 0);
  await page.evaluate((k) => window.__dragPlates.setKeys(201, k), keys);
  await page.click('#stage-row button:has-text("C34")');
  const box = await page.$('#rates-plot').then((e) => e.boundingBox());
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(out, 'rates-muller.png') });
  const dump = await page.evaluate(() => {
    const d = window.__dragPlates, s = d.spreading();
    const ll = (v) => [Math.atan2(v[1], v[0]) * 180 / Math.PI, Math.asin(v[2]) * 180 / Math.PI];
    return { labels: s.rateLabels, seeds: s.rateSeeds.map((i) => ll(s.seeds[i])), rates: d.spreadingRates(),
      paths: document.querySelectorAll('#rates-plot path').length };
  });
  fs.writeFileSync(path.join(out, 'page_rates.json'), JSON.stringify(dump));
  console.log(`${dump.paths} curves (${dump.labels.join(', ')}); errors: ${errors.length ? errors.join('; ') : 'none'}`);
  await browser.close();
  process.exit(errors.length || dump.paths !== 4 ? 1 : 0);
})();
