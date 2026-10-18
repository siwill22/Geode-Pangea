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
import { RobinsonMap } from './flatmap.js';
import {
  DEG, lonLatToVec3, tangentFrame, ringSignedArea, ringContains, ringCentroid,
  ringBoundingCap,
} from '../vendor/petrify/sphere.js';
import {
  quatToMat3, mat3Apply, quatMultiply, quatConjugate, quatFromAxisAngle, quatSlerp,
  quatBetween, quatToPoleAngle, quatFromPoleAngle,
} from '../vendor/petrify/rotations.js';

const IDENTITY = [0, 0, 0, 1];

const canvas = document.getElementById('globe');
const ctx = canvas.getContext('2d');
// Two views of the same sphere: a globe (Orthographic) and a whole-world map (Robinson).
// `projector` is whichever is showing; everything that edits plates works on the sphere,
// so only drawing and the screen -> sphere step depend on it.
const globe = new Orthographic();
const worldMap = new RobinsonMap();
let projector = globe;
const flat = () => projector === worldMap;
const view = { lon: 10, lat: 15 };

/** @type {{name: string, id: number, colour: string, layer: PolygonLayer,
 *          ghost: PolygonLayer, count: number, centre: number[], q: number[]}[]} */
let plates = [];           // in draw order: last is on top
let active = null;         // the plate most recently touched
let showGhosts = true;
let showFlow = true;        // the synthetic flowlines (spreading chapters)
let showCrust = false;     // set by the chapter
const undoStack = [];      // Map(plate -> q) of every plate, as it was before each change
let initialQ = new Map();  // the chapter's starting rotations, for Reset
let mother = null;         // the root of the rotation tree, in chapters that build one (else null)
let linking = false;       // "Link plates" mode: clicks make links instead of moving plates
let pending = null;        // in that mode, the plate picked first, waiting for its parent
let cursorOnSphere = null; // where the pointer is, for the rubber band from `pending`
let spreading = null;      // { fzs, isochrons, seeds, left, right } in the South Atlantic chapter
let fixedPlates = new Set(); // plates a chapter holds still (not picked)
let trailCells = [];       // [{ v, age, colour, plate }]: dated hotspot-chain seafloor, where shown
let trailCellDeg = 1 / 6;
let hotspots = [];         // [{ name, h, samples: [{ v, age, plate }] }] in chapters that show them

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

function layerFor(id, rings, options, begins = null) {
  const layer = new PolygonLayer({
    times: [0],
    rotations: {},
    features: rings.map((r, k) => ({ p: id, b: begins ? begins[k] : Infinity, e: 0, xy: r.xy })),
  }, options);
  layer.setRotations({ [id]: IDENTITY });
  return layer;
}

async function loadPlates(chapter) {
  const set = await loadJSON(`data/${chapter.set}`);
  showCrust = !!chapter.show?.crust;
  // A chapter can show only some of the set's plates, by name.
  const only = chapter.plates && new Set(chapter.plates);

  return set.groups.filter((g) => !only || only.has(g.name)).map((g) => {
    const id = g.principal;
    const crust = packRings(g.crust);
    const land = packRings(g.land.map((i) => set.land[i]));

    // Land is Natural Earth, shared by every plate; each plate draws it clipped to its
    // own continental crust (see drawPlate). Crust and land turn together, so the clip is
    // exactly this block's land wherever the block goes.
    const crustLayer = layerFor(id, crust, {
      fill: hexWithAlpha(g.colour, g.oceanic ? 0.22 : 0.4), stroke: null,
    }, g.crustBegin);
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
      name: g.name, id, colour: g.colour, oceanic: !!g.oceanic,
      members: new Set(g.members.map((m) => m[0])),
      reference: g.reference, referenceStep: set.referenceStep,
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
  if (flat()) return worldMap.unproject(clientX - rect.left, clientY - rect.top, clamp);
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
  for (const [k, r] of caps.entries()) {
    if (!layer.isLive(layer.rings[k], layer.currentTime)) continue;
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
    if (fixedPlates.has(plate)) continue;
    const home = rotate(quatConjugate(plate.shown), p);
    if (!inRings(plate.crustLayer, plate.crustCaps, home)) continue;
    if (showCrust || plate.oceanic || inRings(plate.landLayer, plate.landCaps, home)) return plate;
  }
  return null;
}

function setPlateRotation(plate, q) {
  plate.q = q;
  if (plate.keys) setKey(plate, editAge, q);
  showPlate(plate);
}

/*
 * Stages. In a chapter that fits the plates one age at a time, a plate holds a rotation
 * for each age the student has fitted ("keys", total rotations, oldest last), and its
 * rotation at any other age is interpolated between the two keys either side of it, with
 * the identity at present day -- exactly how GPlates reads the lines of a rotation file.
 * Older than the oldest key, the plate stays where that key puts it. `editAge` is the age
 * being fitted: dragging sets the key there. In every other chapter editAge is simply the
 * reconstruction age.
 */
let editAge = null;
// Which stage button is pressed: an isochron's age, or 0 for Present. Only a click on a
// button changes it -- playing or scrubbing the time bar does not.
let stageChoice = null;

function keyedAt(plate, age) {
  let prevAge = 0, prevQ = IDENTITY;
  for (const k of plate.keys) {
    if (age <= k.age) return age <= prevAge ? prevQ : quatSlerp(prevQ, k.q, (age - prevAge) / (k.age - prevAge));
    prevAge = k.age; prevQ = k.q;
  }
  return prevQ;
}

function setKey(plate, age, q) {
  const k = plate.keys.find((x) => Math.abs(x.age - age) < 1e-9);
  if (k) k.q = q;
  else { plate.keys.push({ age, q }); plate.keys.sort((a, b) => a.age - b.age); }
}

/*
 * The rotation tree. Every plate has a parent (another plate) or none, in which case it
 * is fixed to the mantle (plate 000). Its saved rotation q is always its total rotation
 * at the reconstruction age; its rotation RELATIVE to its parent is
 *
 *     r_P = q_parent^-1 q_P
 *
 * and that, not q, is what a line of the rotation file holds and what the table shows.
 */
function relativeQ(plate) {
  return plate.parent ? quatMultiply(quatConjugate(plate.parent.q), plate.q) : plate.q;
}

/** Plates carried by `plate`: its children, their children, and so on. */
function descendants(plate) {
  return plates.filter((p) => { for (let a = p.parent; a; a = a.parent) if (a === plate) return true; return false; });
}

/** Parents before children, so a file lists every plate after the plate it moves with. */
function treeOrder() {
  const depth = (p) => (p.parent ? 1 + depth(p.parent) : 0);
  return [...plates].sort((a, b) => depth(a) - depth(b) || (b === mother) - (a === mother) || a.id - b.id);
}

/*
 * A plate's rotation at any age between present day and the reconstruction age.
 *
 * Each plate turns about its own pole relative to its parent -- a slerp from the
 * identity to r_P -- while being carried along by its parent's rotation at that age:
 *
 *     R_P(t) = R_parent(t) * slerp(I, r_P, f),     f = age / reconAge
 *
 * and so on up the tree. That is how GPlates interpolates a rotation hierarchy (each line
 * of the file separately, then composed), so what plays here is what the exported file
 * describes. At the reconstruction age every plate is at q whatever the tree; in between,
 * the tree decides the path -- and so the shape of every hotspot trail.
 */
function rotationAt(plate, age) {
  if (plate.keys) return keyedAt(plate, age);
  if (age >= reconAge) return plate.q;
  if (age <= 0) return IDENTITY;
  const own = quatSlerp(IDENTITY, relativeQ(plate), age / reconAge);
  return plate.parent ? quatMultiply(rotationAt(plate.parent, age), own) : own;
}

/**
 * Link `plate` to a new parent (or to none). Nothing moves at the reconstruction age --
 * q stays, and the relative rotation is re-expressed -- but every path in between may.
 * Refused, returning false, if it would make a loop.
 */
function setParent(plate, parent) {
  if (plate === mother && parent) return false;
  if (parent && (parent === plate || descendants(plate).includes(parent))) return false;
  plate.parent = parent;
  for (const p of plates) showPlate(p);
  return true;
}

function showPlate(plate) {
  plate.shown = rotationAt(plate, shownAge);
  // The displayed age also decides which rings exist: an oceanic plate shows only the
  // seafloor that had formed by then.
  for (const layer of plate.layers) layer.setRotations({ [plate.id]: plate.shown }, shownAge);
}

/** Every plate's saved rotation and parent, for undo. */
function snapshot() {
  return new Map(plates.map((p) => [p, { q: p.q, parent: p.parent,
    keys: p.keys && p.keys.map((k) => ({ ...k })) }]));
}

function restore(snap) {
  for (const [p, s] of snap) {
    p.q = s.q; p.parent = s.parent;
    if (s.keys) { p.keys = s.keys.map((k) => ({ ...k })); p.q = keyedAt(p, editAge); }
  }
  for (const p of plates) showPlate(p);
  updateStageButtons();
}

function setShownAge(age) {
  shownAge = Math.max(0, Math.min(reconAge, age));
  for (const p of plates) showPlate(p);
  const scrub = document.getElementById('scrub');
  scrub.max = String(reconAge);
  scrub.value = String(reconAge - shownAge);
  document.getElementById('shown-age').textContent = `${shownAge.toFixed(shownAge < 10 ? 1 : 0)} Ma`;
  if (spreading?.stages) updateStageButtons();
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
  globe.cx = (left + innerWidth) / 2;
  globe.cy = wide ? innerHeight / 2 : innerHeight * 0.6;
  globe.radius = Math.min(innerWidth - left, innerHeight) * 0.44;

  // The map at one fixed scale: as large as fits beside the panel and above the time
  // bar. Robinson is 2 KX pi wide by 2 KY tall at unit radius.
  const bar = document.getElementById('timebar').getBoundingClientRect();
  const top = wide ? 16 : innerHeight * 0.3, bottom = (bar.top || innerHeight) - 16;
  const w = innerWidth - left - 32, h = bottom - top;
  worldMap.radius = Math.max(40, Math.min(w / (2 * 0.8487 * Math.PI), h / (2 * 1.3523)));
  worldMap.cx = (left + innerWidth) / 2;
  worldMap.cy = (top + bottom) / 2;
}

/** Stroke a run of unit vectors, lifting the pen behind the horizon. */
function strokeSphereLine(points, style, width, dash = []) {
  const xyz = Float64Array.from(points.flat());
  ctx.save();
  ctx.beginPath();
  tracePolyline(ctx, (v) => projector.project(v), xyz, 0, points.length,
    { seam: projector.seamSplit ? (a, b) => projector.seamSplit(a, b) : null });
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
 * The active plate's motion, drawn: the path its centre takes from present day to the
 * reconstruction age, and the pole of its saved rotation. For a plate that moves with
 * nothing the path is a small circle about that pole; otherwise it is whatever the
 * rotation tree makes it.
 */
function drawActiveRotation() {
  if (!active) return;
  const { lon, lat, angle } = quatToPoleAngle(active.q);
  if (angle < 1e-6) return;

  const path = [];
  const steps = Math.max(2, Math.ceil(reconAge / 2));
  for (let i = 0; i <= steps; i++) path.push(rotate(rotationAt(active, (reconAge * i) / steps), active.centre));
  strokeSphereLine(path, 'rgba(255, 255, 255, 0.75)', 1.5, [4, 4]);

  const pole = lonLatToVec3(lon, lat);
  drawPolePath(pole);
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

/**
 * The finite poles of the active plate from present day to the reconstruction age: the
 * pole of its total rotation at each age, joined into a path, as papers plot them. A
 * single steady rotation keeps one pole, so the path is a point; stages, or a parent that
 * moves, make it wander. Each pole is taken in whichever hemisphere continues the path
 * from `near`, the pole drawn now, so the path never jumps to an antipode. Discs mark the
 * fitted ages where there are any, otherwise every 10 Myr, coloured by age; the
 * antipodal path is drawn hollow.
 */
function drawPolePath(near) {
  const ages = [];
  for (let t = 1; t < reconAge; t++) ages.push(t);
  ages.push(reconAge);
  const marks = active.keys?.length ? active.keys.map((k) => k.age)
    : ages.filter((t) => t % 10 === 0 || t === reconAge);
  const all = [...new Set([...ages, ...marks])].sort((a, b) => a - b);
  const poles = [];
  let ref = near;
  for (let i = all.length - 1; i >= 0; i--) {
    const r = quatToPoleAngle(rotationAt(active, all[i]));
    if (r.angle < 1e-6) continue;
    let v = lonLatToVec3(r.lon, r.lat);
    if (v[0] * ref[0] + v[1] * ref[1] + v[2] * ref[2] < 0) v = v.map((x) => -x);
    poles.unshift({ age: all[i], v });
    ref = v;
  }
  if (poles.length < 2) return;
  const markSet = new Set(marks);
  for (const sign of [1, -1]) {
    const pts = poles.map((q) => q.v.map((x) => x * sign));
    strokeSphereLine(pts, sign > 0 ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.4)', 1.5);
    for (const [i, q] of poles.entries()) {
      if (!markSet.has(q.age)) continue;
      const p = projector.project(pts[i]);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 4, 0, 2 * Math.PI);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = sign > 0 ? MARKER_EDGE : ageColour(q.age);
      if (sign > 0) { ctx.fillStyle = ageColour(q.age); ctx.fill(); }
      ctx.stroke();
      if (sign > 0 && active.keys?.length) {
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(240, 246, 252, 0.85)';
        ctx.fillText(`${Math.round(q.age)}`, p[0] + 7, p[1] - 5);
      }
    }
  }
}

// ---- Hotspots -----------------------------------------------------------------------

/*
 * Hotspots are fixed in the frame the globe is drawn in -- that is the assumption this
 * chapter tests. The point of plate P that sat over hotspot h at age tau has present-day
 * position R_P(tau)^-1 h; at the displayed age t it is carried to R_P(t) R_P(tau)^-1 h.
 * Sweeping tau from t back to the reconstruction age draws the trail P would have left.
 * A dated sample on P is drawn where P has carried it, and only once it exists (its age
 * is at least t). The misfit is how far each sample lies from where the rotations put
 * the trail at the sample's own age.
 */
// Magma, young (pale yellow) to old (purple), cut at 0.4 of the full map: its darker end
// all but vanishes on the navy globe. Interpolated continuously, so every age has its own
// shade and a trail dot can be matched against the seafloor under it.
const AGE_RAMP = ['#fcfdbf', '#fecf92', '#fe9f6d', '#f7705c', '#de4968', '#b73779', '#8c2981'];
const AGE_RGB = AGE_RAMP.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
function ageColour(age) {
  const x = Math.max(0, Math.min(1, age / reconAge)) * (AGE_RGB.length - 1);
  const i = Math.min(AGE_RGB.length - 2, Math.floor(x)), f = x - i;
  const c = AGE_RGB[i].map((v, k) => Math.round(v + f * (AGE_RGB[i + 1][k] - v)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
const MARKER_EDGE = 'rgba(240, 246, 252, 0.9)';

/**
 * Opacity for something that forms at `age`. At the reconstruction age, where the
 * student drags, everything is drawn at full strength -- it is what they are matching.
 * Only once played or scrubbed toward the present does what has not formed yet fade.
 */
function formedAlpha(age, faint) {
  return shownAge >= reconAge || age >= shownAge ? 1 : faint;
}

function trailPoint(plate, tau, h, carry) {
  return rotate(carry, rotate(quatConjugate(rotationAt(plate, tau)), h));
}

function drawHotspots() {
  // The whole predicted trail and every sample are drawn at every age: they ride rigidly
  // on their plate, so the fit can be judged (and edited) at the reconstruction age. The
  // part that has not formed yet by the displayed age is drawn faint, and those samples
  // hollow; Play shows the trail being laid down.
  for (const hs of hotspots) {
    for (const plate of hs.plates) {
      const carry = plate.shown;
      const at = (tau) => trailPoint(plate, tau, hs.h, carry);
      const formed = [], future = [];
      for (let tau = 0; tau <= reconAge + 1e-9; tau += 1) (tau >= shownAge ? formed : future).push(at(tau));
      if (formed.length && future.length) future.push(formed[0]);
      strokeSphereLine(future, 'rgba(255, 255, 255, 0.22)', 1.2, [3, 4]);
      strokeSphereLine(formed, 'rgba(255, 255, 255, 0.6)', 1.5);
      // A disc every 10 Myr in the colour of its age, bigger every 50 Myr and labelled:
      // where Africa's rotation says the hotspot was under the plate at that age.
      for (let tau = 10; tau <= reconAge; tau += 10) {
        const p = projector.project(at(tau));
        if (!p) continue;
        const major = tau % 50 === 0;
        ctx.globalAlpha = formedAlpha(tau, 0.4);
        ctx.beginPath();
        ctx.arc(p[0], p[1], major ? 7.5 : 5.5, 0, 2 * Math.PI);
        ctx.fillStyle = ageColour(tau);
        ctx.fill();
        ctx.lineWidth = major ? 1.8 : 1.2;
        ctx.strokeStyle = MARKER_EDGE;
        ctx.stroke();
        if (major && tau < reconAge) {
          ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
          ctx.fillStyle = '#f0f6fc';
          ctx.fillText(`${tau}`, p[0] + 10, p[1] + 4);
        }
        ctx.globalAlpha = 1;
      }
    }
    for (const s of hs.samples) {
      const p = projector.project(rotate(s.plate.shown, s.v));
      if (!p) continue;
      // Squares, so a sample never reads as a trail disc; faint until it has formed.
      ctx.beginPath();
      ctx.rect(p[0] - 4, p[1] - 4, 8, 8);
      ctx.globalAlpha = formedAlpha(s.age, 0.35);
      ctx.fillStyle = ageColour(s.age);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#0d1b2e';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const p = projector.project(hs.h);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 7, 0, 2 * Math.PI);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ff5a5a';
    ctx.stroke();
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#e8f0f8';
    ctx.fillText(hs.name, p[0] + 10, p[1] - 8);
  }
}

/**
 * The hotspot chains' raised seafloor, coloured by interpolated age (after Maher et al.
 * 2015, Figs 3-4; prep/build_trail_grids.py), one small patch per cell, riding on its
 * plate. Bright once formed by the age shown, faint before. A visual reference: the
 * predicted trail's age dots should run over seafloor of the same colour.
 */
function drawTrailCells() {
  const half = Math.max(1, projector.radius * trailCellDeg * DEG * 0.75);
  for (const c of trailCells) {
    const p = projector.project(rotate(c.plate.shown, c.v));
    if (!p) continue;
    ctx.globalAlpha = 0.85 * formedAlpha(c.age, 0.2);
    ctx.fillStyle = c.colour;
    ctx.fillRect(p[0] - half, p[1] - half, 2 * half, 2 * half);
  }
  ctx.globalAlpha = 1;
}

// ---- Seafloor spreading: flowlines, fracture zones, isochrons -------------------------

/*
 * Two plates spread about a ridge. With `right` (Africa) and `left` (South America), the
 * relative rotation R(t) = R_right(t)^-1 R_left(t) carries South America's seafloor of age
 * t back to where it formed against Africa. Symmetric spreading splits that in two: with
 * H(t) = half of R(t), the seafloor formed at the seed x (a point of today's ridge) at age
 * t lies today at H(t) x on Africa and H(t)^-1 x on South America. That is a flowline, and
 * a fracture zone should follow it. (GPlates builds flowlines from half-stage rotations;
 * for one steady rotation, as here, that is the same thing -- checked in
 * prep/check_satlantic_parity.py.)
 */
function relativeAt(age) {
  const { left, right } = spreading;
  return quatMultiply(quatConjugate(rotationAt(right, age)), rotationAt(left, age));
}

/*
 * Present-day flowline points of one seed, per branch, at spreading.flowAges. Symmetric
 * spreading, integrated step by step in Africa's frame: over each step the ridge moves by
 * half of South America's motion in that step, R(older) R(younger)^-1, so the point of
 * Africa's seafloor formed at age t is C(t) x, with C accumulating those half-steps, and
 * the matching point on South America is R(t)^-1 C(t) x. Within one fitted stage every
 * step turns about the same axis, so this is exact provided the fitted ages are among the
 * sample ages -- it matches pygplates' flowline features (prep/check_satlantic_parity.py).
 */
function flowline(seed) {
  const ages = spreading.flowAges;
  const onRight = [seed], onLeft = [seed];
  let c = IDENTITY, young = relativeAt(0);
  for (let k = 1; k < ages.length; k++) {
    const old = relativeAt(ages[k]);
    c = quatMultiply(quatSlerp(IDENTITY, quatMultiply(old, quatConjugate(young)), 0.5), c);
    const r = rotate(c, seed);
    onRight.push(r);
    onLeft.push(rotate(quatConjugate(old), r));
    young = old;
  }
  return { [spreading.right.id]: onRight, [spreading.left.id]: onLeft };
}

/** Sample ages for flowlines: every Myr, plus every age that has been fitted. */
function updateFlowAges() {
  const set = new Set();
  for (let t = 0; t <= reconAge; t += 1) set.add(t);
  set.add(reconAge);
  for (const p of plates) for (const k of p.keys || []) set.add(k.age);
  spreading.flowAges = [...set].sort((a, b) => a - b);
}

/** Great-circle distance, radians, from p to the polyline pts (unit vectors). Hot: no allocation. */
function distanceToPolyline(p, pts) {
  const px = p[0], py = p[1], pz = p[2];
  let bestDot = -1;          // cos of the best distance so far, for the vertices
  let bestPerp = Math.PI;    // best perpendicular distance onto an arc interior
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const d = px * a[0] + py * a[1] + pz * a[2];
    if (d > bestDot) bestDot = d;
    if (i === 0) continue;
    const b = pts[i - 1];
    // The arc b -> a, its pole n = b x a; the foot of p lies on the arc when
    // (b x p) . n >= 0 and (p x a) . n >= 0.
    let nx = b[1] * a[2] - b[2] * a[1], ny = b[2] * a[0] - b[0] * a[2], nz = b[0] * a[1] - b[1] * a[0];
    const ln = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (ln < 1e-12) continue;
    nx /= ln; ny /= ln; nz /= ln;
    const s1 = (b[1] * pz - b[2] * py) * nx + (b[2] * px - b[0] * pz) * ny + (b[0] * py - b[1] * px) * nz;
    const s2 = (py * a[2] - pz * a[1]) * nx + (pz * a[0] - px * a[2]) * ny + (px * a[1] - py * a[0]) * nz;
    if (s1 >= 0 && s2 >= 0) {
      const perp = Math.abs(Math.asin(Math.max(-1, Math.min(1, px * nx + py * ny + pz * nz))));
      if (perp < bestPerp) bestPerp = perp;
    }
  }
  return Math.min(Math.acos(Math.max(-1, Math.min(1, bestDot))), bestPerp);
}

/*
 * The ocean as it was at the displayed age t: isochrons, fracture zones (by the age of
 * the seafloor under each vertex) and flowlines older than t, each riding on its plate.
 * The isochron pair of the age being fitted is drawn bold; the others thin. At present
 * day all of it shows: the flowlines of every fitted stage against the fracture zones.
 */
function drawSpreading() {
  if (!spreading) return;
  const t = shownAge - 0.05;
  for (const iso of spreading.isochrons) {
    if (iso.age < t) continue;
    const target = Math.abs(iso.age - editAge) < 1e-6 && shownAge > 0;
    ctx.globalAlpha = target || shownAge <= 0 ? 1 : 0.55;
    strokeSphereLine(iso.pts.map((v) => rotate(iso.plate.shown, v)), ageColour(iso.age), target ? 4 : 1.8);
  }
  ctx.globalAlpha = 1;
  for (const fz of spreading.fzs) {
    const run = [];
    const flush = () => { if (run.length > 1) strokeSphereLine(run, 'rgba(236, 242, 250, 0.9)', 1.8); run.length = 0; };
    fz.pts.forEach((v, i) => { if (fz.ages[i] == null || fz.ages[i] >= t) run.push(rotate(fz.plate.shown, v)); else flush(); });
    flush();
  }
  const ages = spreading.flowAges;
  const first = ages.findIndex((a) => a >= t);
  for (const fl of showFlow ? spreading.flow : []) {
    for (const plate of [spreading.left, spreading.right]) {
      const pts = fl[plate.id].slice(first).map((v) => rotate(plate.shown, v));
      if (pts.length > 1) strokeSphereLine(pts, 'rgba(255, 255, 255, 0.35)', 1, [2, 3]);
      pts.forEach((v, j) => {
        const tau = ages[first + j];
        if (tau === 0 || tau % 10 !== 0) return;
        const p = projector.project(v);
        if (!p) return;
        ctx.beginPath();
        ctx.arc(p[0], p[1], tau % 50 === 0 ? 4.5 : 3.2, 0, 2 * Math.PI);
        ctx.fillStyle = ageColour(tau);
        ctx.fill();
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = MARKER_EDGE;
        ctx.stroke();
      });
    }
  }
  // The rate curves' seeds, where the ridge is at the age shown, ringed in their colours.
  spreading.rateSeeds.forEach((k, j) => {
    const p = projector.project(rotate(spreading.right.shown, spreading.flow[k][spreading.right.id][first]));
    if (!p) return;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 7, 0, 2 * Math.PI);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = RATE_COLOURS[j];
    ctx.stroke();
  });
}

/*
 * Spreading rates. Between two sample ages a flowline's point on each flank moves apart
 * by a great-circle distance; with rigid plates those present-day distances are the half
 * spreading on each side, so their sum over the time step is the full rate (km/Myr =
 * mm/yr). Within one fitted stage the rate is constant, so each curve is a step. Four
 * seeds, spaced along the ridge from north to south, each marked on the globe.
 */
const RATE_COLOURS = ['#3987e5', '#199e70', '#9085e9', '#c98500'];   // validated on the dark panel
const RATE_LATS = [10, -10, -30, -45];

function spreadingRates() {
  const ages = spreading.flowAges, R = 6371;
  const arc = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  return spreading.rateSeeds.map((k) => {
    const fl = spreading.flow[k], L = fl[spreading.left.id], Rt = fl[spreading.right.id];
    const steps = [];
    for (let i = 1; i < ages.length; i++) {
      const dt = ages[i] - ages[i - 1];
      if (dt <= 0) continue;
      steps.push({ from: ages[i - 1], to: ages[i], rate: (arc(L[i - 1], L[i]) + arc(Rt[i - 1], Rt[i])) * R / dt });
    }
    return steps;
  });
}

let rateHover = null;
function updateRates() {
  const box = document.getElementById('rates');
  if (!spreading?.rateSeeds) { box.hidden = true; return; }
  box.hidden = false;
  if (box.classList.contains('collapsed')) return;
  const rates = spreadingRates();
  const svg = document.getElementById('rates-plot');
  const W = svg.clientWidth || 280, H = 150, ml = 26, mr = 6, mt = 6, mb = 18;
  const top = Math.max(20, Math.ceil(Math.max(...rates.flat().map((s) => s.rate)) / 20) * 20);
  const x = (a) => ml + (a / reconAge) * (W - ml - mr), y = (r) => H - mb - (r / top) * (H - mt - mb);
  let out = '';
  const yStep = top > 100 ? 40 : 20;
  for (let r = 0; r <= top; r += yStep) {
    out += `<line class="grid" x1="${ml}" x2="${W - mr}" y1="${y(r)}" y2="${y(r)}"/>`
      + `<text x="${ml - 4}" y="${y(r) + 3}" text-anchor="end">${r}</text>`;
  }
  for (let a = 0; a <= reconAge; a += 20) out += `<text x="${x(a)}" y="${H - 4}" text-anchor="middle">${a}</text>`;
  out += `<line class="axis" x1="${ml}" x2="${W - mr}" y1="${y(0)}" y2="${y(0)}"/>`;
  // The age being fitted, and the age shown if it differs.
  if (shownAge > 0) out += `<line x1="${x(editAge)}" x2="${x(editAge)}" y1="${mt}" y2="${y(0)}" stroke="rgba(240,246,252,0.5)" stroke-dasharray="3 3"/>`;
  rates.forEach((steps, k) => {
    let d = '';
    for (const s of steps) d += `${d ? 'L' : 'M'}${x(s.from).toFixed(1)},${y(s.rate).toFixed(1)}L${x(s.to).toFixed(1)},${y(s.rate).toFixed(1)}`;
    out += `<path d="${d}" fill="none" stroke="${RATE_COLOURS[k]}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  if (rateHover != null) {
    const a = rateHover;
    out += `<line x1="${x(a)}" x2="${x(a)}" y1="${mt}" y2="${y(0)}" stroke="rgba(240,246,252,0.8)"/>`;
    const at = rates.map((steps) => steps.find((s) => a >= s.from && a < s.to) || steps[steps.length - 1]);
    at.forEach((s, k) => { out += `<circle cx="${x(a)}" cy="${y(s.rate)}" r="3.5" fill="${RATE_COLOURS[k]}" stroke="#0b1422" stroke-width="1.5"/>`; });
    document.getElementById('rates-readout').textContent = `${a.toFixed(0)} Ma: `
      + at.map((s, k) => `${spreading.rateLabels[k]} ${Math.round(s.rate)}`).join(' · ') + ' mm/yr';
  } else {
    document.getElementById('rates-readout').textContent = 'Hover the plot to read the rates at an age.';
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  spreading.rateGeom = { ml, mr, W };
}

document.getElementById('rates-plot').addEventListener('pointermove', (e) => {
  const g = spreading?.rateGeom;
  if (!g) return;
  const r = e.currentTarget.getBoundingClientRect();
  const f = (e.clientX - r.left - g.ml) / (r.width - g.ml - g.mr);
  rateHover = Math.max(0, Math.min(reconAge - 0.001, f * reconAge));
  updateRates();
});
document.getElementById('rates-plot').addEventListener('pointerleave', () => { rateHover = null; updateRates(); });
document.getElementById('rates-toggle').addEventListener('click', () => {
  const box = document.getElementById('rates'), open = box.classList.toggle('collapsed') === false;
  document.getElementById('rates-toggle').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('pangea:rates-open', open ? '1' : '0'); } catch { /* not available */ }
  updateRates();
});
try {
  if (localStorage.getItem('pangea:rates-open') === '0') {
    document.getElementById('rates').classList.add('collapsed');
    document.getElementById('rates-toggle').setAttribute('aria-expanded', 'false');
  }
} catch { /* not available */ }

/** Recompute the synthetic flowlines (after any change to the rotations). */
function updateFlowlines() {
  if (!spreading) return;
  updateFlowAges();
  spreading.flow = spreading.seeds.map(flowline);
}

/*
 * Two scores. Fracture zones: mean distance from each fracture-zone vertex to its own
 * flowline branch. Isochrons, one row per chron: bring South America's isochron of age t
 * back by R(t) against Africa and take the mean distance of its vertices to Africa's
 * conjugate isochron -- zero when the two flanks of that age close up.
 */
function spreadingMisfit() {
  updateFlowlines();
  const R = 6371;
  let sum = 0, n = 0;
  for (const fz of spreading.fzs) {
    const line = spreading.flow[fz.seed][fz.plate.id];
    for (const v of fz.pts) { sum += distanceToPolyline(v, line) * R; n++; }
  }
  const rows = [{ name: 'Fracture zones', n: spreading.fzs.length, km: n ? sum / n : null }];
  const byChron = new Map();
  for (const iso of spreading.isochrons) {
    if (!byChron.has(iso.chron)) byChron.set(iso.chron, { age: iso.age, [spreading.left.id]: [], [spreading.right.id]: [] });
    byChron.get(iso.chron)[iso.plate.id].push(iso.pts);
  }
  for (const [chron, c] of [...byChron].sort((a, b) => a[1].age - b[1].age)) {
    const leftLines = c[spreading.left.id], rightLines = c[spreading.right.id];
    if (!leftLines.length || !rightLines.length) continue;
    const r = relativeAt(c.age);
    let s = 0, k = 0;
    for (const line of leftLines) for (const v of line) {
      const w = rotate(r, v);
      s += Math.min(...rightLines.map((l) => distanceToPolyline(w, l))) * R; k++;
    }
    rows.push({ name: `${/^\d/.test(chron) ? 'C' : ''}${chron} (${Math.round(c.age)} Ma)`, n: k, km: s / k, age: c.age,
      fitting: Math.abs(c.age - editAge) < 1e-6 });
  }
  return { per: rows, mean: rows[0].km ?? 0 };
}

/** Mean and per-hotspot distance, km, from each sample to the predicted trail at its age. */
function misfit() {
  const R = 6371;
  let total = 0, n = 0;
  const per = hotspots.map((hs) => {
    let sum = 0;
    for (const s of hs.samples) {
      const pred = rotate(quatConjugate(rotationAt(s.plate, s.age)), hs.h);
      const d = Math.acos(Math.max(-1, Math.min(1, pred[0] * s.v[0] + pred[1] * s.v[1] + pred[2] * s.v[2]))) * R;
      sum += d;
    }
    total += sum; n += hs.samples.length;
    return { name: hs.name, n: hs.samples.length, km: hs.samples.length ? sum / hs.samples.length : null };
  });
  return { per, mean: n ? total / n : 0 };
}

let lastMisfitAt = 0;
function updateMisfit() {
  const box = document.getElementById('misfit');
  if (!hotspots.length && !spreading) { box.hidden = true; return; }
  box.hidden = false;
  // During a drag the flowlines follow every move, but the seafloor misfit (tens of ms)
  // is refreshed at most five times a second; it is recomputed in full on release.
  if (spreading) {
    updateFlowlines();
    updateRates();
    const now = performance.now();
    if (drag && now - lastMisfitAt < 200) return;
    lastMisfitAt = now;
  }
  const m = spreading ? spreadingMisfit() : misfit();
  box.querySelector('tbody').innerHTML = m.per.map((r) =>
    `<tr${r.fitting ? ' class="active"' : ''}><td>${r.name}</td><td>${r.n}</td><td>${r.km === null ? '&ndash;' : Math.round(r.km)}</td></tr>`).join('');
  document.getElementById('misfit-mean').textContent = `${Math.round(m.mean)} km`;
}

function draw() {
  projector.lookAt(view.lon, view.lat);
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  ctx.beginPath();
  if (flat()) worldMap.traceOutline(ctx);
  else ctx.arc(projector.cx, projector.cy, projector.radius, 0, 2 * Math.PI);
  ctx.fillStyle = '#0d1b2e';
  ctx.fill();
  ctx.strokeStyle = 'rgba(143, 212, 240, 0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // On the map, nothing is drawn outside its outline.
  ctx.save();
  if (flat()) { ctx.beginPath(); worldMap.traceOutline(ctx); ctx.clip(); }

  drawGraticule();
  if (showGhosts) {
    for (const p of plates) {
      if (p.q === (initialQ.get(p) ?? IDENTITY)) continue;
      if (showCrust || p.oceanic) drawLayer(p.ghostCrust);
      else clipTo(p.ghostCrust, () => drawLayer(p.ghostLand));
    }
  }
  drawTrailCells();
  for (const p of plates) drawPlate(p);
  drawSpreading();   // seafloor lines on top: a flank must never hide under a shelf
  drawHotspots();
  drawTree();
  drawActiveRotation();
  ctx.restore();
}

// ---- The rotation tree, drawn ----------------------------------------------------------

// The Plate Tree viewer's look: links in orange along great circles between plate centres,
// the mother plate a gold star, every other plate a light dot.
const TREE_STYLE = { link: '#e8663c', mother: '#ffd34d', node: '#f0f6fc', pending: '#6fe3ff' };

/** Points along the great circle from a to b, so a long link follows the sphere. */
function greatCircle(a, b) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return [a, b];
  const steps = Math.max(2, Math.ceil(omega / DEG / 2)), sin = Math.sin(omega), out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, s0 = Math.sin((1 - t) * omega) / sin, s1 = Math.sin(t * omega) / sin;
    out.push([a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1]);
  }
  return out;
}

/** A plate's node: the centre of its crust, where the plate is drawn now. */
const nodeOf = (p) => rotate(p.shown, p.centre);

function traceStar(x, y, rOuter, rInner) {
  let a = -Math.PI / 2;
  ctx.moveTo(x + Math.cos(a) * rOuter, y + Math.sin(a) * rOuter);
  for (let i = 0; i < 5; i++) {
    a += Math.PI / 5; ctx.lineTo(x + Math.cos(a) * rInner, y + Math.sin(a) * rInner);
    a += Math.PI / 5; ctx.lineTo(x + Math.cos(a) * rOuter, y + Math.sin(a) * rOuter);
  }
  ctx.closePath();
}

function drawTree() {
  if (!mother) return;
  for (const p of plates) {
    if (p.parent) strokeSphereLine(greatCircle(nodeOf(p), nodeOf(p.parent)), TREE_STYLE.link, 2.4);
  }
  if (pending && cursorOnSphere) {
    strokeSphereLine(greatCircle(nodeOf(pending), cursorOnSphere), TREE_STYLE.pending, 2, [5, 4]);
  }
  for (const p of plates) {
    const s = projector.project(nodeOf(p));
    if (!s) continue;
    // Light nodes with a dark edge, so they read on any plate's fill.
    ctx.beginPath();
    if (p === mother) traceStar(s[0], s[1], 13, 5.5);
    else ctx.arc(s[0], s[1], 5.5, 0, 2 * Math.PI);
    ctx.fillStyle = p === mother ? TREE_STYLE.mother : TREE_STYLE.node;
    ctx.fill();
    ctx.lineWidth = p === mother ? 2 : 1.6;
    ctx.strokeStyle = '#0d1b2e';
    ctx.stroke();
    if (p === pending) {
      ctx.beginPath();
      ctx.arc(s[0], s[1], 10, 0, 2 * Math.PI);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = TREE_STYLE.pending;
      ctx.stroke();
    }
  }
}

/** Link `child` to `parent` (null: the mantle) from a click, saying why if it cannot. */
function linkByClick(child, parent) {
  const note = document.getElementById('link-note');
  if (child === mother && parent) {
    note.textContent = `${mother.name} is the mother plate: it moves with nothing.`;
    return;
  }
  const before = snapshot();
  if (parent && descendants(child).includes(parent)) {
    note.textContent = `That would make a loop: ${parent.name} already moves with ${child.name}.`;
    return;
  }
  if (child.parent === parent) { note.textContent = ''; return; }
  setParent(child, parent);
  undoStack.push(before);
  note.textContent = parent ? `${child.name} now moves with ${parent.name}.`
    : `${child.name} now moves with the mantle.`;
  updateTable();
}

function setPending(p) {
  pending = p;
  document.getElementById('link-note').textContent = p
    ? `${p.name}: now click the plate it moves with, or the ocean for the mantle.`
    : linking ? 'Click a plate, then the plate it moves with, or drag one onto the other. Click the ocean to set a plate free.'
      : 'Drag a plate to move it, with everything linked to it.';
  requestDraw();
}

/** Draw a plate: its crust (in chapters that show it), then its land, clipped to its crust. */
function drawPlate(p) {
  if (showCrust || p.oceanic) drawLayer(p.crustLayer);
  clipTo(p.crustLayer, () => drawLayer(p.landLayer));
}

/** Live rings of a layer, as [offset, count]. */
function liveRings(layer) {
  return layer.rings.filter((r) => layer.isLive(r, layer.currentTime));
}

/**
 * Draw a layer. On the globe, petrify does it. On the map, rings are filled by
 * RobinsonMap.traceRingFill, which copes with a ring crossing the map's edge, and
 * outlined by tracePolyline with the seam split, so no outline is drawn along the cut.
 */
function drawLayer(layer) {
  if (!flat()) { layer.draw(ctx, projector); return; }
  if (!layer.visible || layer.currentTime == null) return;
  const { fill, stroke, lineWidth, outline } = layer.options;
  const rings = liveRings(layer);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (!outline && fill) {
    ctx.beginPath();
    for (const r of rings) worldMap.traceRingFill(ctx, layer.xyz, r.offset, r.count);
    ctx.fillStyle = fill;
    ctx.fill('nonzero');
  }
  if (stroke) {
    const seam = (a, b) => worldMap.seamSplit(a, b);
    ctx.beginPath();
    for (const r of rings) {
      tracePolyline(ctx, (w) => worldMap.project(w), layer.xyz, r.offset, r.count, { closed: true, seam });
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
  ctx.restore();
}

/** Run `fn` with the canvas clipped to a layer's filled rings, as currently projected. */
function clipTo(layer, fn) {
  ctx.save();
  ctx.beginPath();
  if (flat()) {
    for (const r of liveRings(layer)) worldMap.traceRingFill(ctx, layer.xyz, r.offset, r.count);
    ctx.clip('nonzero');
    fn();
    ctx.restore();
    return;
  }
  const { fillable } = layer.projectRings(projector);
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
  const tree = !!mother;
  const byName = [...plates].sort((a, b) => a.name.localeCompare(b.name));
  const rows = [...plates].sort((a, b) => a.id - b.id).map((p) => {
    // Each row is the plate's rotation relative to its parent, or to the mantle if none.
    const r = quatToPoleAngle(relativeQ(p));
    const moved = r.angle > 1e-6;
    const cls = [p === active ? 'active' : '', moved ? 'moved' : ''].join(' ').trim();
    let link = '';
    if (tree) {
      link = p === mother ? '<td><span class="tag">mother</span></td>'
        : `<td><select class="parent" data-id="${p.id}" aria-label="${p.name} moves with">`
          + `<option value="0"${p.parent ? '' : ' selected'}>mantle</option>`
          + byName.filter((x) => x !== p && !descendants(p).includes(x)).map((x) =>
            `<option value="${x.id}"${p.parent === x ? ' selected' : ''}>${x.name}</option>`).join('')
          + '</select></td>';
    }
    return `<tr class="${cls}">`
      + `<td><span class="swatch" style="background:${p.colour}"></span></td>`
      + `<td>${p.name}</td>${link}`
      + `<td>${moved ? fmt(r.lat) : '&ndash;'}</td>`
      + `<td>${moved ? fmt(r.lon) : '&ndash;'}</td>`
      + `<td>${fmt(r.angle)}&deg;</td></tr>`;
  });
  document.getElementById('th-parent').hidden = !tree;
  document.querySelector('#plates tbody').innerHTML = rows.join('');
  document.getElementById('undo').disabled = undoStack.length === 0;
  if (!drag) saveChapter();
  updateStageButtons();
  if (tree) {
    document.getElementById('table-note').textContent =
      'Each row: the plate\'s rotation relative to the plate it moves with (the mantle, '
      + `for ${mother.name} and any plate that moves with nothing).`;
  }
  updateMisfit();
}

// A "moves with" menu changed: relink, keeping every plate where it is now.
document.querySelector('#plates tbody').addEventListener('change', (e) => {
  if (!e.target.matches('select.parent')) return;
  const plate = plates.find((p) => p.id === Number(e.target.dataset.id));
  const parent = plates.find((p) => p.id === Number(e.target.value)) || null;
  const before = snapshot();
  if (setParent(plate, parent)) undoStack.push(before);
  updateTable();
  requestDraw();
});

// ---- Carrying work between chapters -----------------------------------------------------

/*
 * Every chapter keeps its plates' total rotations (relative to the mantle) in this
 * browser whenever an edit ends, so a later chapter can build on them. Storage may be
 * missing or blocked (a private window, cleared site data): then nothing is saved and
 * the later chapter starts from present day, with a .rot file as the way in instead.
 */
let chapterId = null;
const storeKey = (id) => `pangea:${id}`;

function saveChapter() {
  if (!chapterId) return;
  const data = { reconAge, savedAt: Date.now(),
    plates: Object.fromEntries(plates.map((p) => [p.id, [...p.q]])) };
  try { localStorage.setItem(storeKey(chapterId), JSON.stringify(data)); } catch { /* not available */ }
}

function loadSaved(id) {
  try { return JSON.parse(localStorage.getItem(storeKey(id)) || 'null'); } catch { return null; }
}

/**
 * Total rotations, relative to the mantle, at the file's oldest age, from a rotation
 * file of the kind Export writes (each plate: a line at 0 Ma and one at the
 * reconstruction age, relative to 000 or to another plate in the file).
 */
function parseRotationFile(text) {
  const lines = {};
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.split('!')[0].trim().split(/\s+/).map(Number);
    if (f.length < 6 || f.some(Number.isNaN)) continue;
    const [id, age, lat, lon, angle, fixed] = f;
    if (id === 999 || age <= 0) continue;
    if (!lines[id] || age > lines[id].age) lines[id] = { age, fixed, q: quatFromAxisAngle(lonLatToVec3(lon, lat), angle * DEG) };
  }
  const total = {};
  const resolve = (id, seen = new Set()) => {
    if (id === 0) return IDENTITY;
    if (total[id]) return total[id];
    const l = lines[id];
    if (!l || seen.has(id)) return null;
    seen.add(id);
    const up = resolve(l.fixed, seen);
    return up && (total[id] = quatMultiply(up, l.q));
  };
  const ages = Object.values(lines).map((l) => l.age);
  for (const id of Object.keys(lines)) resolve(Number(id));
  return { reconAge: ages.length ? Math.max(...ages) : null, plates: total };
}

/** Scale a rotation's angle, keeping its pole: the same steady motion, run for longer. */
function scaleRotation(q, k) {
  const { lat, lon, angle } = quatToPoleAngle(q);
  return angle < 1e-9 ? IDENTITY : quatFromAxisAngle(lonLatToVec3(lon, lat), angle * k * DEG);
}

/*
 * A chapter with `buildsOn` starts from earlier chapters' work:
 *   fit:    a chapter whose plates' positions RELATIVE to the mother plate are kept;
 *   motion: a chapter whose mother-plate rotation is kept, rescaled to this chapter's
 *           age if that chapter's differed -- the same pole at the same rate. With one
 *           steady rotation that is exact up to the older chapter's age; beyond it, an
 *           extrapolation.
 * Positions come out as  q_P = q_mother * (q3_mother^-1 q3_P).
 */
const sources = { fit: null, motion: null };

function composeStart(chapter) {
  const m = mother.id;
  let qm = IDENTITY;
  const motion = sources.motion?.plates[m];
  if (motion) qm = scaleRotation(motion, reconAge / sources.motion.reconAge);
  const fit = sources.fit?.plates;
  for (const p of plates) {
    const rel = fit && fit[p.id] && fit[m] ? quatMultiply(quatConjugate(fit[m]), fit[p.id]) : IDENTITY;
    p.q = p === mother ? qm : quatMultiply(qm, rel);
    initialQ.set(p, p.q);
    showPlate(p);
  }
  describeSources(chapter);
}

function describeSources(chapter) {
  const { fit, motion } = chapter.buildsOn;
  // "3. Beneath the waves" reads as "chapter 3, Beneath the waves".
  const title = (id) => (chapterTitles[id] || id).replace(/^(\d+)\.\s*/, 'chapter $1, ');
  const say = (src, id, what, none) => (src
    ? `${what} from ${title(id)}${src.file ? ` (file ${src.file})` : ''}.`
    : none);
  const k = sources.motion ? reconAge / sources.motion.reconAge : 1;
  document.getElementById('carry-note').textContent = [
    say(sources.fit, fit, 'Fit', `No fit from ${title(fit)} yet.`),
    say(sources.motion, motion, `${mother.name}'s motion`, `No ${mother.name} motion from ${title(motion)} yet.`),
    sources.motion && Math.abs(k - 1) > 1e-9
      ? `(Its ${sources.motion.reconAge} Ma rotation runs on, same pole and rate, to ${reconAge} Ma.)` : '',
  ].filter(Boolean).join(' ');
}

let chapterTitles = {};

function setUpCarry(chapter) {
  if (!chapter.buildsOn || !mother) return;
  document.getElementById('carry-row').hidden = false;
  sources.fit = loadSaved(chapter.buildsOn.fit);
  sources.motion = loadSaved(chapter.buildsOn.motion);
  composeStart(chapter);
  for (const [kind, input] of [['fit', 'load-fit'], ['motion', 'load-motion']]) {
    document.getElementById(input).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const parsed = parseRotationFile(await file.text());
      e.target.value = '';
      if (!parsed.reconAge || !parsed.plates[mother.id]) {
        document.getElementById('carry-note').textContent =
          `${file.name} has no rotation for ${mother.name} (plate ${mother.id}), so it cannot be used.`;
        return;
      }
      undoStack.push(snapshot());
      sources[kind] = { ...parsed, file: file.name };
      composeStart(chapter);
      updateTable();
      requestDraw();
    });
  }
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
  const line = (id, t, lat, lon, ang, fixed, name) => [
    String(id).padStart(3, '0'), t.toFixed(1).padStart(7), lat.toFixed(4).padStart(9),
    lon.toFixed(4).padStart(10), ang.toFixed(4).padStart(10), String(fixed).padStart(3, '0'),
    `! ${name}`,
  ].join(' ');
  const out = [];
  // The file is the rotation tree: each plate relative to its parent (000 if none), the
  // same lines rotationAt() interpolates, parents listed first.
  for (const p of treeOrder()) {
    const fixed = p.parent ? p.parent.id : 0;
    out.push(line(p.id, 0, 90, 0, 0, fixed, p.name));
    if (p.keys) {
      // One line per fitted age, as GPlates reads them: stages.
      for (const k of p.keys) {
        const r = quatToPoleAngle(k.q);
        out.push(line(p.id, k.age, r.lat, r.lon, r.angle, fixed, `${p.name} (Pangea, fitted)`));
      }
      continue;
    }
    const r = quatToPoleAngle(relativeQ(p));
    out.push(line(p.id, age, r.lat, r.lon, r.angle, fixed, `${p.name} (Pangea)`));
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

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 2) return;
  if (linking && e.button === 0 && !e.altKey) {
    // In link mode a press never moves a plate. What it does is decided at release:
    // a click picks a plate (or links the picked one), a press on one plate released on
    // another links them, and a drag that started on the ocean turns the globe.
    drag = { mode: 'link', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      from: pick(screenToSphere(e.clientX, e.clientY)), was: pending, orbiting: false };
    if (drag.from && !pending) setPending(drag.from);
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  const p = screenToSphere(e.clientX, e.clientY);
  // Right-drag or Alt-drag always turns the globe: an oceanic plate like the Pacific
  // covers so much of it that there may be little open ocean left to grab.
  let plate = e.button === 2 || e.altKey ? null : pick(p);
  if (plate && stageChoice === 0) {
    // Present is only for checking: nothing is fitted at present day. The press turns
    // the globe instead, and the note says how to get back to fitting.
    document.getElementById('stage-note').textContent =
      'Present is for checking. To move South America again, pick an isochron above.';
    plate = null;
  }
  if (plate && shownAge !== editAge) {
    // Plates are edited at the reconstruction age only: that is what the saved
    // rotations mean. Grabbing one while scrubbed or playing returns there first, and the
    // grab is taken again from the plate as it is drawn there.
    playing = null;
    setShownAge(editAge);
    draw();
  }
  const grabbed = plate && pick(screenToSphere(e.clientX, e.clientY));
  if (grabbed) {
    const plate = grabbed;
    const twist = e.shiftKey || document.getElementById('twist').checked;
    undoStack.push(snapshot());
    active = plate;
    bringToTop(plate);
    drag = {
      mode: twist ? 'twist' : 'move', plate, grab: p, q0: plate.q,
      // Every plate carried by this one keeps its rotation relative to it, as it was when
      // the drag began, so it comes along.
      rel: new Map(descendants(plate).map((x) => [x, quatMultiply(quatConjugate(plate.q), x.q)])),
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
  if (linking) {
    cursorOnSphere = screenToSphere(e.clientX, e.clientY);
    if (pending) requestDraw();
  }
  if (drag?.mode === 'link') {
    // A press on the ocean that moves becomes a turn of the globe.
    if (!drag.from && (drag.orbiting || Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4)) {
      drag.orbiting = true;
      turnView(e.clientX - drag.x, e.clientY - drag.y);
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    return;
  }
  if (!drag) {
    const over = pick(screenToSphere(e.clientX, e.clientY));
    canvas.classList.toggle('over-plate', !!over);
    return;
  }
  if (drag.mode === 'orbit') {
    turnView(e.clientX - drag.x, e.clientY - drag.y);
    drag.x = e.clientX;
    drag.y = e.clientY;
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
  for (const [x, r] of drag.rel) setPlateRotation(x, quatMultiply(drag.plate.q, r));
  updateTable();
  requestDraw();
});

/**
 * Turn the view by a pointer movement in px. The globe turns both ways; the map, at one
 * fixed scale, only slides its central meridian, so a sideways drag moves the map with
 * the pointer and a vertical one does nothing.
 */
function turnView(dx, dy) {
  if (flat()) {
    view.lon = wrapLon(view.lon - dx * 360 / (2 * 0.8487 * Math.PI * worldMap.radius));
  } else {
    const scale = 90 / projector.radius;
    view.lon -= dx * scale;
    view.lat = Math.max(-89.9, Math.min(89.9, view.lat + dy * scale));
  }
  requestDraw();
}
const wrapLon = (lon) => ((lon + 180) % 360 + 360) % 360 - 180;

// On the map, sideways scrolling (a trackpad swipe, Shift + wheel) slides the centre.
canvas.addEventListener('wheel', (e) => {
  if (!flat()) return;
  const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
  if (!dx) return;
  e.preventDefault();
  turnView(-dx, 0);
}, { passive: false });

/** Switch between globe and map; remembered in this browser, as a convenience. */
function setProjection(name) {
  projector = name === 'map' ? worldMap : globe;
  document.body.classList.toggle('flat', flat());
  for (const b of document.querySelectorAll('[data-projection]')) {
    b.setAttribute('aria-pressed', String(b.dataset.projection === name));
  }
  try { localStorage.setItem('pangea:projection', name); } catch { /* not available */ }
  document.getElementById('hint-view').textContent = flat()
    ? 'Drag the ocean or scroll sideways to slide the map.'
    : 'Drag the ocean to turn the globe.';
  canvas.setAttribute('aria-label', flat()
    ? 'World map. Drag a continent to move it; drag the ocean sideways to slide the map.'
    : 'Globe. Drag a continent to move it; drag the ocean to turn the globe.');
  resize();
  requestDraw();
}
for (const b of document.querySelectorAll('[data-projection]')) {
  b.addEventListener('click', () => setProjection(b.dataset.projection));
}

function endDrag(e) {
  if (drag?.mode === 'link') {
    const { from, was, orbiting } = drag;
    drag = null;
    canvas.releasePointerCapture?.(e.pointerId);
    if (orbiting || e.type === 'pointercancel') return;
    const to = pick(screenToSphere(e.clientX, e.clientY));
    if (from && to && to !== from) { linkByClick(from, to); setPending(null); }  // dragged A onto B
    else if (from && to === from) {                                             // clicked a plate
      if (was === from) setPending(null);                                       // ... again: cancel
      else if (was) { linkByClick(was, from); pending = null; requestDraw(); }
      // (no earlier pick: it was picked on the press)
    } else if (!from && was) { linkByClick(was, null); pending = null; requestDraw(); }  // ocean
    return;
  }
  if (!drag) return;
  // A click that did not move the plate is not worth an undo step.
  if (drag.plate && drag.plate.q === drag.q0) undoStack.pop();
  if (drag.plate) updateMisfit();
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
  restore(last);
  updateTable();
  requestDraw();
});

document.getElementById('reset').addEventListener('click', () => {
  undoStack.push(snapshot());
  // Positions go back to the start; the links the student drew stay.
  restore(new Map(plates.map((p) => [p, { q: initialQ.get(p) ?? IDENTITY, parent: p.parent,
    keys: p.keys ? [] : undefined }])));
  active = null;
  updateTable();
  requestDraw();
});

// Move plates or Link plates: what a press on a plate does in a rotation-tree chapter.
function setLinking(on) {
  linking = on;
  for (const b of document.querySelectorAll('#link-row button[data-mode]')) {
    b.setAttribute('aria-pressed', String((b.dataset.mode === 'link') === on));
  }
  canvas.classList.toggle('linking', on);
  setPending(null);
}
document.querySelector('#link-row .segmented').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setLinking(b.dataset.mode === 'link');
});

addEventListener('keydown', (e) => { if (e.key === 'Escape' && pending) setPending(null); });

// The misfit box folds down to its title and total, so it need not cover the globe.
// Remembered in this browser, as a convenience only.
function setMisfitOpen(open) {
  document.getElementById('misfit').classList.toggle('collapsed', !open);
  document.getElementById('misfit-toggle').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('pangea:misfit-open', open ? '1' : '0'); } catch { /* not available */ }
}
document.getElementById('misfit-toggle').addEventListener('click', () => {
  setMisfitOpen(document.getElementById('misfit').classList.contains('collapsed'));
});
try { if (localStorage.getItem('pangea:misfit-open') === '0') setMisfitOpen(false); } catch { /* not available */ }



document.getElementById('show-flow').addEventListener('change', (e) => {
  showFlow = e.target.checked;
  requestDraw();
});

document.getElementById('ghosts').addEventListener('change', (e) => {
  showGhosts = e.target.checked;
  requestDraw();
});

document.getElementById('play').addEventListener('click', () => {
  if (playing) stopPlaying();
  else playTo(shownAge > 0 ? 0 : editAge);
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

/**
 * A chapter that builds a rotation tree names its mother plate and, optionally, starting
 * links as [child id, parent id] pairs. Every other plate starts moving with nothing.
 */
function setUpTree(chapter) {
  if (!chapter.tree) return;
  mother = plates.find((p) => p.id === chapter.tree.mother);
  document.body.classList.add('tree');   // a wider panel, for the "moves with" column
  for (const id of ['key-mother', 'key-link', 'key-poles', 'key-age']) document.getElementById(id).hidden = false;
  document.getElementById('link-row').hidden = false;
  setLinking(true);   // the chapter's first job is linking
  for (const [child, parent] of chapter.tree.links || []) {
    setParent(plates.find((p) => p.id === child), plates.find((p) => p.id === parent));
  }
}

/** Hotspots and their dated samples, each sample on the plate whose blocks include it. */
async function loadHotspots(chapter) {
  const data = await loadJSON(`data/${chapter.hotspotData || 'hotspots.json'}`);
  const byMember = new Map();
  for (const p of plates) for (const id of p.members) byMember.set(id, p);
  const wanted = chapter.hotspots === true ? null : new Set(chapter.hotspots);
  hotspots = data.hotspots.filter((h) => !wanted || wanted.has(h.name)).map((h) => {
    const samples = h.samples
      .filter((s) => s.age <= reconAge && byMember.has(s.plate))
      .map((s) => ({ v: lonLatToVec3(s.lon, s.lat), age: s.age, plate: byMember.get(s.plate) }));
    // A trail is drawn on each plate that carries samples. A hotspot with no dated samples
    // (Azores) still gets its predicted trail when the chapter has only one plate.
    const on = [...new Set(samples.map((s) => s.plate))];
    return { name: h.name, h: lonLatToVec3(h.lon, h.lat), samples,
      plates: on.length || plates.length !== 1 ? on : [plates[0]] };
  }).filter((h) => h.plates.length);
  for (const id of ['key-age', 'key-hotspot', 'key-sample', 'key-trail', 'key-faint']) {
    document.getElementById(id).hidden = false;
  }
}

/** Which age is being fitted, which have been, and whether we are looking at today. */
function updateStageButtons() {
  if (!spreading?.stages) return;
  const fitted = new Set((spreading.left.keys || []).map((k) => k.age));
  for (const b of document.querySelectorAll('#stage-row button[data-age]')) {
    const age = Number(b.dataset.age);
    b.setAttribute('aria-pressed', String(Math.abs(age - stageChoice) < 1e-6));
    b.classList.toggle('fitted', fitted.has(age));
  }
  const name = spreading.stages.find((st) => Math.abs(st.age - editAge) < 1e-6);
  document.getElementById('stage-note').textContent = stageChoice === 0
    ? 'Today: every fitted stage\'s flowlines against the fracture zones.'
    : `Fitting ${/^\d/.test(name.chron) ? 'C' : ''}${name.chron} (${editAge} Ma): drag South America until the two bold isochrons meet.`;
}

/** Fracture zones, isochrons and flowline seeds between the chapter's two plates. */
async function loadSpreading(chapter) {
  const data = await loadJSON(`data/${chapter.spreading.data}`);
  const byMember = new Map();
  for (const p of plates) for (const id of p.members) byMember.set(id, p);
  const line = (pts) => pts.map(([lon, lat]) => lonLatToVec3(lon, lat));
  spreading = {
    left: plates.find((p) => p.id === chapter.spreading.left),
    right: plates.find((p) => p.id === chapter.spreading.right),
    fzs: data.fractureZones.filter((f) => byMember.has(f.plate))
      .map((f) => ({ plate: byMember.get(f.plate), seed: f.seed, pts: line(f.line), ages: f.ages })),
    // M0 is 120.4 Ma: keep an isochron within a Myr of the reconstruction age.
    isochrons: data.isochrons.filter((i) => byMember.has(i.plate) && i.age <= reconAge + 1)
      .map((i) => ({ plate: byMember.get(i.plate), age: i.age, chron: i.chron, pts: line(i.line) })),
    seeds: data.seeds.map(([lon, lat]) => lonLatToVec3(lon, lat)),
  };
  // The rate curves' seeds: the one nearest each of RATE_LATS.
  const lat = (v) => Math.asin(v[2]) * 180 / Math.PI;
  spreading.rateSeeds = RATE_LATS.map((target) => spreading.seeds.reduce((best, v, i) =>
    Math.abs(lat(v) - target) < Math.abs(lat(spreading.seeds[best]) - target) ? i : best, 0));
  spreading.rateLabels = spreading.rateSeeds.map((i) => {
    const l = Math.round(lat(spreading.seeds[i]));
    return `${Math.abs(l)}°${l >= 0 ? 'N' : 'S'}`;
  });
  document.getElementById('rates-legend').innerHTML = spreading.rateLabels.map((t, k) =>
    `<li><i style="background:${RATE_COLOURS[k]}"></i>${t}</li>`).join('');
  // Fitted one isochron at a time: the moving plate holds a key per fitted age.
  spreading.left.keys = [];
  const chrons = new Map();
  for (const iso of spreading.isochrons) chrons.set(iso.chron, iso.age);
  spreading.stages = [...chrons].map(([chron, age]) => ({ chron, age })).sort((a, b) => a.age - b.age);
  editAge = stageChoice = spreading.stages[0].age;
  const box = document.getElementById('stage-row');
  box.hidden = false;
  box.querySelector('.stages').innerHTML = spreading.stages.map((st) =>
    `<button type="button" data-age="${st.age}" aria-pressed="false">`
    + `${/^\d/.test(st.chron) ? 'C' : ''}${st.chron}<small>${Math.round(st.age)} Ma</small></button>`).join('')
    + '<button type="button" data-age="0" class="now" aria-pressed="false">Present<small>check</small></button>';
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-age]');
    if (!b) return;
    const age = Number(b.dataset.age);
    stopPlaying();
    stageChoice = age;
    if (age > 0) {
      editAge = age;
      spreading.left.q = keyedAt(spreading.left, editAge);
    }
    setShownAge(age);
    updateStageButtons();
    updateTable();
  });
  updateFlowlines();
  const t = chapter.spreading.labels;
  document.getElementById('misfit-title').textContent = t.title;
  document.getElementById('misfit-col').textContent = t.column;
  document.getElementById('misfit-note').textContent = t.note;
  for (const id of ['key-age', 'key-fz', 'key-flow', 'key-iso', 'key-poles', 'flow-toggle', 'source-spreading']) {
    document.getElementById(id).hidden = false;
  }
}

/** Hotspot-chain seafloor cells on the chapter's plates. Needs reconAge (for colours). */
async function loadTrailCells(chapter) {
  const data = await loadJSON(`data/${chapter.trailGrids}`);
  const byMember = new Map();
  for (const p of plates) for (const id of p.members) byMember.set(id, p);
  trailCellDeg = data.cellDeg;
  trailCells = data.cells.filter((c) => byMember.has(c.plate)).map((c) => ({
    v: lonLatToVec3(c.lon, c.lat), age: c.age, colour: ageColour(c.age), plate: byMember.get(c.plate),
  }));
  for (const id of ['key-seafloor', 'source-trail']) document.getElementById(id).hidden = false;
}

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

  chapterId = entry.id;
  chapterTitles = Object.fromEntries(index.map((c) => [c.id, c.title]));
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
  if (chapter.view) Object.assign(view, chapter.view);
  editAge = reconAge;
  document.getElementById('legend-max').textContent = reconAge;
  for (const p of plates) p.parent = null;
  setUpTree(chapter);
  setUpCarry(chapter);
  if (chapter.hotspots) await loadHotspots(chapter);
  if (chapter.trailGrids) await loadTrailCells(chapter);
  fixedPlates = new Set(plates.filter((p) => (chapter.fixed || []).includes(p.id)));
  if (chapter.spreading) await loadSpreading(chapter);
  for (const p of plates) showPlate(p);
  resize();
  addEventListener('resize', () => { resize(); draw(); });
  let saved = null;
  try { saved = localStorage.getItem('pangea:projection'); } catch { /* not available */ }
  setProjection(new URLSearchParams(location.search).get('projection') || saved || 'globe');
  updateTable();
  setShownAge(editAge);
  draw();

  // For automated checks: the same state and functions the gestures use, nothing more.
  window.__dragPlates = {
    get plates() { return plates; }, chapter, get projector() { return projector; }, view, setProjection, pick, screenToSphere,
    rotationFile, draw, setShownAge, get shownAge() { return shownAge; },
    get mother() { return mother; }, get pending() { return pending; }, nodeOf, setParent, relativeQ, misfit, rotationAt, hotspots: () => hotspots,
    spreading: () => spreading, spreadingMisfit, spreadingRates, get editAge() { return editAge; },
    // Set a plate's fitted stages directly, as (age, pole lon, pole lat, angle) rows.
    setKeys(id, rows) {
      const p = plates.find((x) => x.id === id);
      p.keys = rows.map(([age, lon, lat, angle]) => ({ age, q: quatFromPoleAngle(lon, lat, angle) }));
      p.q = keyedAt(p, editAge); showPlate(p); updateTable(); requestDraw();
    },
    trailCells: () => trailCells,
    rotateByPlate: (id, v) => rotate(plates.find((p) => p.id === id).q, v),
    rotateByPlateShown: (id, v) => rotate(plates.find((p) => p.id === id).shown, v),
  };
}

main().catch((err) => {
  document.getElementById('panel').insertAdjacentHTML('beforeend',
    `<p class="note" style="color:#ff9d9d">Could not load: ${err.message}</p>`);
  console.error(err);
});
