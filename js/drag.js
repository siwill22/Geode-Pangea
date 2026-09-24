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
} from '../vendor/petrify/sphere.js';
import {
  quatToMat3, mat3Apply, quatMultiply, quatConjugate, quatFromAxisAngle,
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
const undoStack = [];      // { plate, q } as it was before each drag

const rotate = (q, v) => mat3Apply(quatToMat3(q), v);

// ---- Loading ------------------------------------------------------------------------

async function loadPlates() {
  const res = await fetch('data/plates.geojson');
  if (!res.ok) throw new Error(`data/plates.geojson: ${res.status}`);
  const fc = await res.json();

  return fc.features.map((f) => {
    const { name, plateId, colour } = f.properties;
    let ring = f.geometry.coordinates[0];

    // Interior on the left is the convention ringContains() and the fill both rely on.
    // Every plate here is far smaller than a hemisphere, so a ring that comes out
    // clockwise was simply digitised the other way round.
    const buf = new Float64Array(ring.length * 3);
    ring.forEach(([lon, lat], k) => lonLatToVec3(lon, lat, buf.subarray(k * 3, k * 3 + 3)));
    if (ringSignedArea(buf, 0, ring.length) < 0) ring = [...ring].reverse();

    const data = {
      times: [0],
      rotations: {},
      features: [{ p: plateId, b: Infinity, e: 0, n: name, xy: ring.flat() }],
    };
    const layer = new PolygonLayer(data, {
      fill: hexWithAlpha(colour, 0.82), stroke: 'rgba(7, 12, 22, 0.9)', lineWidth: 1,
    });
    const ghost = new PolygonLayer(data, {
      outline: true, stroke: hexWithAlpha(colour, 0.55), lineWidth: 1,
    });
    layer.setRotations({ [plateId]: IDENTITY });
    ghost.setRotations({ [plateId]: IDENTITY });

    return {
      name, id: plateId, colour, layer, ghost,
      count: ring.length,
      centre: ringCentroid(layer.home, 0, ring.length),
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
function pick(p) {
  if (!p) return null;
  for (let k = plates.length - 1; k >= 0; k--) {
    const plate = plates[k];
    const home = rotate(quatConjugate(plate.q), p);
    if (ringContains(plate.layer.home, 0, plate.count, home)) return plate;
  }
  return null;
}

function setPlateRotation(plate, q) {
  plate.q = q;
  plate.layer.setRotations({ [plate.id]: q });
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
  if (showGhosts) for (const p of plates) if (p.q !== IDENTITY) p.ghost.draw(ctx, projector);
  for (const p of plates) p.layer.draw(ctx, projector);
  drawActiveRotation();
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
 */
function rotationFile(age) {
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
  if (plate) {
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

document.getElementById('export').addEventListener('click', () => {
  const age = Math.max(0, Number(document.getElementById('age').value) || 0);
  download(rotationFile(age), `pangea-${age}Ma.rot`);
});

// ---- Start --------------------------------------------------------------------------

async function main() {
  plates = await loadPlates();
  resize();
  addEventListener('resize', () => { resize(); draw(); });
  updateTable();
  draw();

  // For automated checks: the same state and functions the gestures use, nothing more.
  window.__dragPlates = {
    get plates() { return plates; }, projector, view, pick, screenToSphere, rotationFile, draw,
    rotateByPlate: (id, v) => rotate(plates.find((p) => p.id === id).q, v),
  };
}

main().catch((err) => {
  document.getElementById('panel').insertAdjacentHTML('beforeend',
    `<p class="note" style="color:#ff9d9d">Could not load: ${err.message}</p>`);
  console.error(err);
});
