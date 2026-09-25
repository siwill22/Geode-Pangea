/*
 * Pangea: six continents on an orthographic globe, each a rigid plate you can drag.
 *
 * Every plate carries ONE quaternion -- its total rotation from present-day position --
 * and petrify's PolygonLayer rotates its geometry by it. A drag never edits vertices; it
 * composes a new rotation onto the one the plate had when the drag began:
 *
 *     move:   q = (rotation carrying the grabbed point onto the cursor) * q_at_start
 *     twist:  q = (rotation about the plate's centre by the cursor's sweep) * q_at_start
 *
 * Recomputing from the start of the drag, rather than adding up small steps, is what keeps
 * a long drag free of drift, and it means the grabbed point stays exactly under the
 * cursor. The move rotation's pole is perpendicular to the great circle through the two
 * points, so a straight drag slides the plate along a great circle -- the whole thing
 * lives on the sphere, and nothing here is planar except the final projection to pixels.
 *
 * The rotation shown for each plate, and exported, is that total quaternion read back as
 * an Euler pole and angle: the single finite rotation GPlates would apply to the
 * present-day geometry, regardless of how many drags produced it.
 */

import { PolygonLayer } from '../vendor/petrify/polygons.js';
import { Orthographic } from '../vendor/petrify/orthographic.js';
import { tracePolyline } from '../vendor/petrify/polyline.js';
import {
  DEG, lonLatToVec3, tangentFrame, ringSignedArea, ringContains, ringCentroid,
  ringBoundingCap,
} from '../vendor/petrify/sphere.js';
import {
  quatToMat3, mat3Apply, quatMultiply, quatConjugate, quatFromAxisAngle, quatSlerp,
  quatBetween, quatToPoleAngle,
} from '../vendor/petrify/rotations.js';

const IDENTITY = [0, 0, 0, 1];

const canvas = document.getElementById('globe');
const ctx = canvas.getContext('2d');
const projector = new Orthographic();
const view = { lon: 10, lat: 15 };

/** @type {{name: string, id: number, colour: string, layer: PolygonLayer,
 *          ghost: PolygonLayer, count: number, centre: number[], q: number[]}[]} */
let plates = [];           // in draw order: last is on top
let active = null;         // the plate most recently touched
let showGhosts = true;
let showCrust = false;     // set by the chapter
const undoStack = [];      // { plate, q } as it was before each drag

/*
 * Time. Each plate's `q` is its SAVED rotation: where the student put it, at the
 * reconstruction age. What is drawn is `shown`, the rotation at the displayed age --
 * the saved one scaled down about the same Euler pole, i.e. a slerp from the identity
 * (present day) to `q`. That is how GPlates interpolates between the 0 Ma and the
 * reconstruction-age lines of the exported file, so playing here shows exactly the
 * motion the .rot file describes. Playing never touches `q`, which is why scrubbing
 * back returns to the reconstruction exactly.
 */
let reconAge = 200;        // the age the saved rotations stand for (set by the chapter)
let shownAge = 100;        // the age being displayed, reconAge .. 0
let playing = null;        // { from, to, start } while animating

const rotate = (q, v) => mat3Apply(quatToMat3(q), v);

// ---- Loading ------------------------------------------------------------------------

/**
 * A chapter names a plate set (built by prep/build_chapters.py from a published plate
 * model) and says what to show of it. Each plate in the set is a group of the model's
 * blocks: `land` rings (coastlines) and `crust` rings (continental crust, much of it
 * under the sea).
 */
async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** Pack lon/lat rings into one xyz buffer, each ring wound counter-clockwise. */
function packRings(rings) {
  const out = [];
  for (const xy of rings) {
    const n = xy.length / 2;
    const buf = new Float64Array(n * 3);
    for (let k = 0; k < n; k++) lonLatToVec3(xy[2 * k], xy[2 * k + 1], buf.subarray(3 * k, 3 * k + 3));
    // Interior on the left is the convention ringContains() and the fill both rely on.
    // Every block here is far smaller than a hemisphere, so a ring that comes out
    // clockwise was simply digitised the other way round.
    const area = ringSignedArea(buf, 0, n);
    if (area < 0) {
      const rev = new Array(xy.length);
      for (let k = 0; k < n; k++) { rev[2 * k] = xy[2 * (n - 1 - k)]; rev[2 * k + 1] = xy[2 * (n - 1 - k) + 1]; }
      out.push({ xy: rev, area: -area });
    } else {
      out.push({ xy, area });
    }
  }
  return out;
}

function layerFor(id, rings, options) {
  const layer = new PolygonLayer({
    times: [0],
    rotations: {},
    features: rings.map((r) => ({ p: id, b: Infinity, e: 0, xy: r.xy })),
  }, options);
  layer.setRotations({ [id]: IDENTITY });
  return layer;
}

async function loadPlates(chapter) {
  const set = await loadJSON(`data/${chapter.set}`);
  showCrust = !!chapter.show?.crust;

  return set.groups.map((g) => {
    const id = g.principal;
    const crust = packRings(g.crust);
    const land = packRings(g.land.map((i) => set.land[i]));

    // Land is Natural Earth, shared by every plate; each plate draws it clipped to its
    // own continental crust (see drawPlate). Crust and land turn together, so the clip is
    // exactly this block's land wherever the block goes.
    const crustLayer = layerFor(id, crust, { fill: hexWithAlpha(g.colour, 0.4), stroke: null });
    const landLayer = layerFor(id, land, {
      fill: hexWithAlpha(g.colour, 0.92), stroke: 'rgba(7, 12, 22, 0.5)', lineWidth: 0.8,
    });
    const ghostStyle = { outline: true, stroke: hexWithAlpha(g.colour, 0.6), lineWidth: 1 };

    // What you can grab: crust where it is shown, since that is the block's real extent;
    // otherwise land that lies on the block's crust. Each ring gets a bounding cap so a
    // click far away is rejected with one dot product instead of a walk round the ring.
    const caps = (layer) => layer.rings.map((r) => ({
      offset: r.offset, count: r.count, ...ringBoundingCap(layer.home, r.offset, r.count),
    }));

    // Area-weighted centre of the block's crust -- the axis a twist turns about.
    const c = [0, 0, 0];
    crust.forEach((r, k) => {
      const ring = crustLayer.rings[k];
      const v = ringCentroid(crustLayer.home, ring.offset, ring.count);
      c[0] += r.area * v[0]; c[1] += r.area * v[1]; c[2] += r.area * v[2];
    });
    const n = Math.hypot(...c);

    return {
      name: g.name, id, colour: g.colour,
      crustLayer, landLayer, layers: [crustLayer, landLayer],
      ghostCrust: layerFor(id, crust, ghostStyle), ghostLand: layerFor(id, land, ghostStyle),
      pickLayer: crustLayer, crustCaps: caps(crustLayer), landCaps: caps(landLayer),
      centre: [c[0] / n, c[1] / n, c[2] / n],
      q: IDENTITY,
    };
  });
}

function hexWithAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ---- Screen <-> sphere --------------------------------------------------------------

const east = [0, 0, 0];
const north = [0, 0, 0];

/**
 * The point on the sphere under a screen position: the orthographic projection run
 * backwards. Off the disc it returns null -- or, with `clamp`, the nearest point on the
 * limb, so a drag that runs past the edge of the globe keeps pulling in that direction
 * instead of freezing.
 */
function screenToSphere(clientX, clientY, clamp = false) {
  const rect = canvas.getBoundingClientRect();
  let dx = (clientX - rect.left - projector.cx) / projector.radius;
  let dy = -(clientY - rect.top - projector.cy) / projector.radius;
  let rho2 = dx * dx + dy * dy;
  if (rho2 > 1) {
    if (!clamp) return null;
    const s = 1 / Math.sqrt(rho2);
    dx *= s; dy *= s; rho2 = 1;
  }
  tangentFrame(projector.lon, projector.lat, east, north);
  const out = projector.axis;
  const h = Math.sqrt(Math.max(0, 1 - rho2));
  const v = [
    dx * east[0] + dy * north[0] + h * out[0],
    dx * east[1] + dy * north[1] + h * out[1],
    dx * east[2] + dy * north[2] + h * out[2],
  ];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * The topmost plate containing point `p`. Each plate's geometry is kept at its
 * present-day position, so rather than test the rotated ring, `p` is rotated BACK by the
 * plate's inverse rotation and tested against the original -- one rotation per plate
 * instead of one per vertex. The test itself is on the sphere (a winding number), so the
 * pole inside Antarctica and plates straddling the antimeridian need no special cases.
 */
function inRings(layer, caps, v) {
  for (const r of caps) {
    const { centre: c } = r;
    if (v[0] * c[0] + v[1] * c[1] + v[2] * c[2] < r.cosRadius) continue;
    if (ringContains(layer.home, r.offset, r.count, v)) return true;
  }
  return false;
}

function pick(p) {
  if (!p) return null;
  for (let k = plates.length - 1; k >= 0; k--) {
    const plate = plates[k];
    const home = rotate(quatConjugate(plate.shown), p);
    if (!inRings(plate.crustLayer, plate.crustCaps, home)) continue;
    if (showCrust || inRings(plate.landLayer, plate.landCaps, home)) return plate;
  }
  return null;
}

function setPlateRotation(plate, q) {
  plate.q = q;
  showPlate(plate);
}

/** The rotation to draw a plate with at the displayed age. */
function shownRotation(q) {
  if (shownAge >= reconAge) return q;
  if (shownAge <= 0) return IDENTITY;
  return quatSlerp(IDENTITY, q, shownAge / reconAge);
}

function showPlate(plate) {
  plate.shown = shownRotation(plate.q);
  for (const layer of plate.layers) layer.setRotations({ [plate.id]: plate.shown });
}

function setShownAge(age) {
  shownAge = Math.max(0, Math.min(reconAge, age));
  for (const p of plates) showPlate(p);
  const scrub = document.getElementById('scrub');
  scrub.max = String(reconAge);
  scrub.value = String(reconAge - shownAge);
  document.getElementById('shown-age').textContent = `${shownAge.toFixed(shownAge < 10 ? 1 : 0)} Ma`;
  const play = document.getElementById('play');
  if (playing) {
    play.innerHTML = '&#10074;&#10074; Pause';
    play.setAttribute('aria-label', 'Pause');
  } else if (shownAge <= 0) {
    play.innerHTML = '&#9664; Back';
    play.setAttribute('aria-label', `Play back to the reconstruction at ${reconAge} Ma`);
  } else {
    play.innerHTML = '&#9654; Play';
    play.setAttribute('aria-label', 'Play to present day');
  }
  requestDraw();
}

/** Animate the displayed age to `to`, over a time proportional to the distance. */
const FULL_PLAY_SECONDS = 5;
function playTo(to) {
  playing = { from: shownAge, to, start: performance.now() };
  const seconds = FULL_PLAY_SECONDS * Math.abs(to - shownAge) / reconAge;
  const step = (now) => {
    if (!playing) return;
    const t = seconds > 0 ? Math.min(1, (now - playing.start) / 1000 / seconds) : 1;
    const age = playing.from + (playing.to - playing.from) * t;
    if (t >= 1) playing = null;
    setShownAge(age);
    if (playing) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function stopPlaying() {
  playing = null;
  setShownAge(shownAge);
}

function bringToTop(plate) {
  plates = [...plates.filter((p) => p !== plate), plate];
}

// ---- Drawing ------------------------------------------------------------------------

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Keep the globe clear of the panel on a wide screen; centre it on a narrow one.
  const panel = document.getElementById('panel').getBoundingClientRect();
  const wide = innerWidth > 900;
  const left = wide ? panel.right : 0;
  projector.cx = (left + innerWidth) / 2;
  projector.cy = wide ? innerHeight / 2 : innerHeight * 0.6;
  projector.radius = Math.min(innerWidth - left, innerHeight) * 0.44;
}

/** Stroke a run of unit vectors, lifting the pen behind the horizon. */
function strokeSphereLine(points, style, width, dash = []) {
  const xyz = Float64Array.from(points.flat());
  ctx.save();
  ctx.beginPath();
  tracePolyline(ctx, (v) => projector.project(v), xyz, 0, points.length);
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.restore();
}

function drawGraticule() {
  const style = 'rgba(143, 212, 240, 0.1)';
  for (let lon = -180; lon < 180; lon += 30) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 2) pts.push(lonLatToVec3(lon, lat));
    strokeSphereLine(pts, style, 0.7);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push(lonLatToVec3(lon, lat));
    strokeSphereLine(pts, style, 0.7);
  }
}

/**
 * The active plate's finite rotation, drawn: its Euler pole, and the small circle about
 * that pole which the plate's centre travels along from present-day to where it is now.
 */
function drawActiveRotation() {
  if (!active) return;
  const { lon, lat, angle } = quatToPoleAngle(active.q);
  if (angle < 1e-6) return;

  const pole = lonLatToVec3(lon, lat);
  const path = [];
  const steps = Math.max(2, Math.ceil(angle / 1));
  for (let i = 0; i <= steps; i++) {
    path.push(rotate(quatFromAxisAngle(pole, (angle * DEG * i) / steps), active.centre));
  }
  strokeSphereLine(path, 'rgba(255, 255, 255, 0.75)', 1.5, [4, 4]);

  for (const [v, filled] of [[pole, true], [pole.map((x) => -x), false]]) {
    const p = projector.project(v);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 5, 0, 2 * Math.PI);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = active.colour;
    if (filled) ctx.fill();
    ctx.stroke();
  }
}

function draw() {
  projector.lookAt(view.lon, view.lat);
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  ctx.beginPath();
  ctx.arc(projector.cx, projector.cy, projector.radius, 0, 2 * Math.PI);
  ctx.fillStyle = '#0d1b2e';
  ctx.fill();
  ctx.strokeStyle = 'rgba(143, 212, 240, 0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  drawGraticule();
  if (showGhosts) {
    for (const p of plates) {
      if (p.q === IDENTITY) continue;
      if (showCrust) p.ghostCrust.draw(ctx, projector);
      else clipTo(p.ghostCrust, () => p.ghostLand.draw(ctx, projector));
    }
  }
  for (const p of plates) drawPlate(p);
  drawActiveRotation();
}

/** Draw a plate: its crust (in chapters that show it), then its land, clipped to its crust. */
function drawPlate(p) {
  if (showCrust) p.crustLayer.draw(ctx, projector);
  clipTo(p.crustLayer, () => p.landLayer.draw(ctx, projector));
}

/** Run `fn` with the canvas clipped to a layer's filled rings, as currently projected. */
function clipTo(layer, fn) {
  const { fillable } = layer.projectRings(projector);
  ctx.save();
  ctx.beginPath();
  for (const buf of fillable) {
    ctx.moveTo(buf[0], buf[1]);
    for (let i = 2; i < buf.length; i += 2) ctx.lineTo(buf[i], buf[i + 1]);
  }
  ctx.clip('nonzero');
  fn();
  ctx.restore();
}

let frameQueued = false;
function requestDraw() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; draw(); });
}

// ---- Readout ------------------------------------------------------------------------

const fmt = (x, d = 1) => (Math.abs(x) < 0.05 ? 0 : x).toFixed(d);

function updateTable() {
  const rows = [...plates].sort((a, b) => a.id - b.id).map((p) => {
    const r = quatToPoleAngle(p.q);
    const moved = r.angle > 1e-6;
    const cls = [p === active ? 'active' : '', moved ? 'moved' : ''].join(' ').trim();
    return `<tr class="${cls}">`
      + `<td><span class="swatch" style="background:${p.colour}"></span></td>`
      + `<td>${p.name}</td>`
      + `<td>${moved ? fmt(r.lat) : '&ndash;'}</td>`
      + `<td>${moved ? fmt(r.lon) : '&ndash;'}</td>`
      + `<td>${fmt(r.angle)}&deg;</td></tr>`;
  });
  document.querySelector('#plates tbody').innerHTML = rows.join('');
  document.getElementById('undo').disabled = undoStack.length === 0;
}

// ---- Export -------------------------------------------------------------------------

/**
 * A GPlates rotation file: for each plate, the identity at 0 Ma and the dragged rotation
 * at the chosen age, both relative to plate 000 (the fixed reference). GPlates slerps
 * between the two, so the file also describes a path from present-day to the dragged
 * arrangement, not just its endpoint.
 *
 * Each plate is written under its principal plate id from the model the chapter was
 * built from (Africa is 701 in Muller et al. 2019, and so on), so the file can be used
 * with that model's own continental polygons -- though only the principal block of each
 * group carries that id there.
 */
function rotationFile(age = reconAge) {
  const line = (id, t, lat, lon, ang, name) => [
    String(id).padStart(3, '0'), t.toFixed(1).padStart(7), lat.toFixed(4).padStart(9),
    lon.toFixed(4).padStart(10), ang.toFixed(4).padStart(10), '000', `! ${name}`,
  ].join(' ');
  const out = [];
  for (const p of [...plates].sort((a, b) => a.id - b.id)) {
    const r = quatToPoleAngle(p.q);
    out.push(line(p.id, 0, 90, 0, 0, p.name));
    out.push(line(p.id, age, r.lat, r.lon, r.angle, `${p.name} (Pangea)`));
  }
  return out.join('\n') + '\n';
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Gestures -----------------------------------------------------------------------

/*
 * One pointer, three gestures, decided once at pointerdown by what is under it:
 * a plate -> move it (or twist it, with Shift or the Twist toggle); open ocean or off
 * the globe -> turn the globe. Deciding once is what stops a plate drag from also
 * spinning the camera, or a camera drag from snatching a plate it passes over.
 */
let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = screenToSphere(e.clientX, e.clientY);
  const plate = pick(p);
  if (plate && shownAge !== reconAge) {
    // Plates are edited at the reconstruction age only: that is what the saved
    // rotations mean. Grabbing one while scrubbed or playing returns there first, and the
    // grab is taken again from the plate as it is drawn there.
    playing = null;
    setShownAge(reconAge);
    draw();
  }
  const grabbed = plate && pick(screenToSphere(e.clientX, e.clientY));
  if (grabbed) {
    const plate = grabbed;
    const twist = e.shiftKey || document.getElementById('twist').checked;
    undoStack.push({ plate, q: plate.q });
    active = plate;
    bringToTop(plate);
    drag = {
      mode: twist ? 'twist' : 'move', plate, grab: p, q0: plate.q,
      // For a twist, the axis is the plate's centre where it is NOW, not at present day.
      axis: rotate(plate.q, plate.centre),
    };
    updateTable();
  } else {
    drag = { mode: 'orbit', x: e.clientX, y: e.clientY };
  }
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  e.preventDefault();
  requestDraw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    const over = pick(screenToSphere(e.clientX, e.clientY));
    canvas.classList.toggle('over-plate', !!over);
    return;
  }
  if (drag.mode === 'orbit') {
    const scale = 90 / projector.radius;
    view.lon -= (e.clientX - drag.x) * scale;
    view.lat = Math.max(-89.9, Math.min(89.9, view.lat + (e.clientY - drag.y) * scale));
    drag.x = e.clientX;
    drag.y = e.clientY;
    requestDraw();
    return;
  }

  const cur = screenToSphere(e.clientX, e.clientY, true);
  let delta;
  if (drag.mode === 'move') {
    delta = quatBetween(drag.grab, cur);
  } else {
    // The angle the cursor has swept around the plate's centre, measured in the tangent
    // plane there -- a twist about an axis through the plate itself.
    const c = drag.axis, g = drag.grab;
    const gx = [g[1] * cur[2] - g[2] * cur[1], g[2] * cur[0] - g[0] * cur[2],
      g[0] * cur[1] - g[1] * cur[0]];
    const sin = c[0] * gx[0] + c[1] * gx[1] + c[2] * gx[2];
    const cg = c[0] * g[0] + c[1] * g[1] + c[2] * g[2];
    const cc = c[0] * cur[0] + c[1] * cur[1] + c[2] * cur[2];
    const cos = (g[0] * cur[0] + g[1] * cur[1] + g[2] * cur[2]) - cg * cc;
    delta = quatFromAxisAngle(c, Math.atan2(sin, cos));
  }
  setPlateRotation(drag.plate, quatMultiply(delta, drag.q0));
  updateTable();
  requestDraw();
});

function endDrag(e) {
  if (!drag) return;
  // A click that did not move the plate is not worth an undo step.
  if (drag.plate && drag.plate.q === drag.q0) undoStack.pop();
  drag = null;
  canvas.classList.remove('dragging');
  canvas.releasePointerCapture?.(e.pointerId);
  updateTable();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---- Controls -----------------------------------------------------------------------

document.getElementById('undo').addEventListener('click', () => {
  const last = undoStack.pop();
  if (!last) return;
  setPlateRotation(last.plate, last.q);
  active = last.plate;
  updateTable();
  requestDraw();
});

document.getElementById('reset').addEventListener('click', () => {
  for (const p of plates) if (p.q !== IDENTITY) undoStack.push({ plate: p, q: p.q });
  for (const p of plates) setPlateRotation(p, IDENTITY);
  active = null;
  updateTable();
  requestDraw();
});

document.getElementById('ghosts').addEventListener('change', (e) => {
  showGhosts = e.target.checked;
  requestDraw();
});

document.getElementById('play').addEventListener('click', () => {
  if (playing) stopPlaying();
  else playTo(shownAge > 0 ? 0 : reconAge);
});

document.getElementById('scrub').addEventListener('input', (e) => {
  playing = null;
  setShownAge(reconAge - Number(e.target.value));
});

document.getElementById('export').addEventListener('click', () => {
  const age = reconAge;   // the same default rotationFile() uses
  download(rotationFile(age), `pangea-${age}Ma.rot`);
});

// ---- Start --------------------------------------------------------------------------

/** The chapter named by ?chapter=, or the first one. */
async function loadChapter() {
  const index = await loadJSON('data/chapters/index.json');
  const want = new URLSearchParams(location.search).get('chapter');
  const entry = index.find((c) => c.id === want) || index[0];
  const chapter = await loadJSON(`data/chapters/${entry.id}.json`);

  const menu = document.getElementById('chapter');
  menu.innerHTML = index.map((c) =>
    `<option value="${c.id}"${c.id === entry.id ? ' selected' : ''}>${c.title}</option>`).join('');
  // A new chapter is a new page: plates, rotations and undo history all start fresh.
  menu.addEventListener('change', () => { location.search = `?chapter=${menu.value}`; });

  document.getElementById('intro').textContent = chapter.intro;
  document.getElementById('questions').innerHTML =
    (chapter.questions || []).map((q) => `<li>${q}</li>`).join('');
  return chapter;
}

async function main() {
  const chapter = await loadChapter();
  plates = await loadPlates(chapter);
  // The age the student's arrangement stands for. Fixed per chapter: with one rotation per
  // plate it only labels the time bar and the exported file, so it is not a control.
  reconAge = chapter.reconstructionAge ?? 200;
  shownAge = reconAge;
  for (const p of plates) p.shown = p.q;
  resize();
  addEventListener('resize', () => { resize(); draw(); });
  updateTable();
  setShownAge(reconAge);
  draw();

  // For automated checks: the same state and functions the gestures use, nothing more.
  window.__dragPlates = {
    get plates() { return plates; }, chapter, projector, view, pick, screenToSphere,
    rotationFile, draw, setShownAge, get shownAge() { return shownAge; },
    rotateByPlate: (id, v) => rotate(plates.find((p) => p.id === id).q, v),
    rotateByPlateShown: (id, v) => rotate(plates.find((p) => p.id === id).shown, v),
  };
}

main().catch((err) => {
  document.getElementById('panel').insertAdjacentHTML('beforeend',
    `<p class="note" style="color:#ff9d9d">Could not load: ${err.message}</p>`);
  console.error(err);
});
