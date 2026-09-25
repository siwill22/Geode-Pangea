/*
 * Robinson: a second reference projector, and the projection tables behind it.
 *
 * ---- Why this is here ------------------------------------------------------
 *
 * Orthographic is a camera: it has a horizon, half the sphere is hidden, and a
 * point either faces you or it doesn't. Robinson is a whole-world map. Every
 * (lon, lat) lands somewhere, nothing is occluded, and instead of a horizon it
 * has an EDGE -- a seam at the antimeridian where the map is cut open and
 * flattened. Layers that were only ever run against a camera tend to assume the
 * first kind, so the seam is the interesting part of this file, not the table.
 *
 * It lives here rather than in a consumer because it is expressible entirely in
 * sphere geometry plus the host contract (docs/adr/0001's rule 1): no WebGL, no
 * three.js, no consumer manifest format. Two consumers had independently grown
 * their own copy of the same 19-entry table before it was written down once.
 *
 * ---- What a consumer with its own renderer takes ---------------------------
 *
 * A consumer projecting onto its OWN surface (a WebGL plane, say) does not want
 * this class -- it wants `robinsonForward`/`robinsonInverse` and the raw tables,
 * so its shader and this module read the same numbers rather than two
 * transcriptions of them. Those are exported for exactly that reason. Geode does
 * this: it keeps its own GLSL and world-space plane handling, which genuinely
 * need its pipeline, and imports the arithmetic.
 */

import { DEG, lonLatToVec3, vec3ToLonLat } from './sphere.js';

/** Degrees of latitude per table entry. */
export const ROBINSON_STEP = 5;

/** Parallel-length factor, lat 0..90 at 5 deg steps. */
export const ROBINSON_X = [
  1.0000, 0.9986, 0.9954, 0.9900, 0.9822, 0.9730, 0.9600, 0.9427, 0.9216,
  0.8962, 0.8679, 0.8350, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722,
  0.5322,
];

/** Parallel-spacing factor, lat 0..90 at 5 deg steps. Strictly increasing,
 *  which is the property that makes the inverse a table bracket rather than a
 *  root-find -- see robinsonInverse. */
export const ROBINSON_Y = [
  0.0000, 0.0620, 0.1240, 0.1860, 0.2480, 0.3100, 0.3720, 0.4340, 0.4958,
  0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761,
  1.0000,
];

export const ROBINSON_KX = 0.8487;
export const ROBINSON_KY = 1.3523;

/** Table index and interpolation fraction for |lat| in degrees. */
function bracket(absLat) {
  const t = Math.min(absLat, 90) / ROBINSON_STEP;
  let i = Math.floor(t);
  if (i >= ROBINSON_X.length - 1) i = ROBINSON_X.length - 2;
  return [i, t - i];
}

/**
 * (lon, lat) degrees -> projection units, where x spans +-KX*pi and y +-KY.
 *
 * Deliberately unscaled and uncentred: a consumer multiplies by whatever radius
 * its own surface uses. `lon` is expected to be a DELTA from the central
 * meridian already wrapped into (-180, 180] -- see Robinson.project, which is
 * where that wrapping belongs, since only a projector knows its own centre.
 */
export function robinsonForward(lon, lat) {
  const [i, f] = bracket(Math.abs(lat));
  const xf = ROBINSON_X[i] + (ROBINSON_X[i + 1] - ROBINSON_X[i]) * f;
  const yf = ROBINSON_Y[i] + (ROBINSON_Y[i + 1] - ROBINSON_Y[i]) * f;
  return [ROBINSON_KX * lon * DEG * xf, ROBINSON_KY * (lat < 0 ? -yf : yf)];
}

/**
 * Projection units -> (lon, lat) degrees, or null outside the map outline.
 *
 * Null is not an edge case to smooth over. Robinson's boundary is a curve, so
 * any rectangle big enough to hold the map necessarily has corners that are not
 * on the Earth at all; a consumer must discard there rather than clamp, or the
 * map grows rectangular ears of stretched polar data.
 */
export function robinsonInverse(x, y) {
  const ay = Math.abs(y) / ROBINSON_KY;
  if (ay > ROBINSON_Y[ROBINSON_Y.length - 1]) return null;

  let i = ROBINSON_Y.length - 2;
  for (let k = 0; k < ROBINSON_Y.length - 1; k++) {
    if (ay <= ROBINSON_Y[k + 1]) { i = k; break; }
  }
  const span = ROBINSON_Y[i + 1] - ROBINSON_Y[i];
  const f = span === 0 ? 0 : (ay - ROBINSON_Y[i]) / span;

  const lat = (i + f) * ROBINSON_STEP * (y < 0 ? -1 : 1);
  const xf = ROBINSON_X[i] + (ROBINSON_X[i + 1] - ROBINSON_X[i]) * f;
  const lon = x / (ROBINSON_KX * xf) / DEG;
  if (lon < -180 || lon > 180) return null;
  return { lon, lat };
}

/**
 * Wrap a longitude delta in degrees into (-180, 180].
 *
 * The half-open end is deliberate and matters here: the seam sits at exactly
 * +-180, and a bare modulo sends that to -180, so a vertex landing precisely on
 * the cut would be read as being on the far side of it. Naming it `wrapLonDelta`
 * follows Geode's function of the same name, which normalises identically;
 * StoryMaps' `wrapLon` closes the other end, and two functions with one name and
 * opposite edge behaviour is exactly the trap worth not setting.
 */
export function wrapLonDelta(d) {
  const x = ((d + 180) % 360 + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

/**
 * Where the great circle through `a` and `b` crosses the meridian at
 * `lonDeg`, as a unit vector -- or null if the shorter arc between them does
 * not reach it.
 *
 * Solved on the sphere, not by interpolating longitude in degrees. The two
 * agree to within a rounding error for the half-degree tessellation these
 * layers usually carry, and disagree visibly for a long segment at high
 * latitude, where a great circle's longitude is nowhere near linear in its
 * latitude. This library already resolves the subduction-triangle side on the
 * sphere for the same class of reason (see boundaries.js) -- doing the easy
 * approximation here and the exact thing there would be the inconsistency.
 */
export function meridianCrossing(a, b, lonDeg) {
  const l = lonDeg * DEG;
  // Normal of the plane containing the pole axis and that meridian.
  const nx = -Math.sin(l);
  const ny = Math.cos(l);

  // Normal of the great circle through a and b.
  const mx = a[1] * b[2] - a[2] * b[1];
  const my = a[2] * b[0] - a[0] * b[2];
  const mz = a[0] * b[1] - a[1] * b[0];

  // The two planes meet along n x m (and its negation): the two antipodal
  // points where the great circle crosses that meridian's full circle.
  let cx = ny * mz - 0 * my;
  let cy = 0 * mx - nx * mz;
  let cz = nx * my - ny * mx;
  const len = Math.hypot(cx, cy, cz);
  if (len < 1e-12) return null; // a, b and the meridian are coplanar; no single crossing
  cx /= len; cy /= len; cz /= len;

  // Of the two, take the one on the requested meridian rather than its
  // antipode, then confirm it lies on the SHORTER arc a->b rather than the
  // long way round the far side of the planet.
  const onMeridian = (cx * Math.cos(l) + cy * Math.sin(l)) >= 0;
  if (!onMeridian) { cx = -cx; cy = -cy; cz = -cz; }

  const dotA = cx * a[0] + cy * a[1] + cz * a[2];
  const dotB = cx * b[0] + cy * b[1] + cz * b[2];
  const dotAB = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dotA < dotAB || dotB < dotAB) return null;

  return [cx, cy, cz];
}

/**
 * A flat whole-world map with a seam.
 *
 * @param cx,cy      canvas coordinates of the map's centre, in CSS pixels
 * @param radius     the scale a unit sphere is drawn at; the map comes out
 *                   2*KX*pi*radius wide and 2*KY*radius tall
 * @param lon        central meridian, in degrees. The seam sits opposite it.
 *
 * Note what is NOT here: `axis`. That is the optional part of the projector
 * contract a layer uses to close a filled shape along the horizon, and this
 * projection has no horizon -- every point is visible. PolygonLayer reads its
 * absence and draws outlines rather than fills, which is the right answer for
 * now: a ring crossing the seam needs cutting into pieces and closing along the
 * map edge, which is a different and harder job than clipping to a limb. Lines
 * are handled, via seamSplit below.
 */
export class Robinson {
  constructor({ cx = 0, cy = 0, radius = 300, lon = 0 } = {}) {
    this.cx = cx;
    this.cy = cy;
    this.radius = radius;
    this.lon = lon;
  }

  /** Point the map at a new central meridian. The seam moves with it. */
  lookAt(lonDeg) {
    this.lon = lonDeg;
    return this;
  }

  /** Longitude of the seam -- the edge of the map, opposite the centre. */
  get seamLon() {
    return wrapLonDelta(this.lon + 180);
  }

  /**
   * Half the drawn width of the map, in the same pixels project() returns.
   *
   * Optional part of the contract, for a caller that needs to spot a seam
   * crossing from PROJECTED points it already has, rather than by asking
   * seamSplit about every vertex pair. PolygonLayer does exactly that: it
   * projects each ring into a buffer anyway, so a comparison per vertex is free
   * where a second trip through lon/lat per vertex is not.
   */
  get mapHalfWidth() {
    return ROBINSON_KX * Math.PI * this.radius;
  }

  project(v) {
    const [lon, lat] = vec3ToLonLat(v);
    const [x, y] = robinsonForward(wrapLonDelta(lon - this.lon), lat);
    // Depth is always positive: a flat world map hides nothing, so there is no
    // horizon test to fail. The contract still wants three numbers.
    return [this.cx + x * this.radius, this.cy - y * this.radius, 1];
  }

  /**
   * Optional part of the projector contract, for a projection with an EDGE
   * rather than a horizon.
   *
   * Returns the two unit vectors a segment should be cut at -- the last point
   * before the seam and the first point after it -- or null if it doesn't cross.
   * Both are the same point on the sphere; they differ only in which side of the
   * map they project to, which is the entire problem. tracePolyline draws up to
   * the first, lifts the pen, and resumes from the second, so a line that runs
   * off the left edge reappears at the right instead of being drawn back across
   * the whole map.
   *
   * Nudged a hair inside each side rather than placed exactly on the seam,
   * where the wrap is a coin toss between +180 and -180 and the line would
   * sometimes still jump.
   */
  seamSplit(a, b) {
    const seam = this.seamLon;
    const la = wrapLonDelta(vec3ToLonLat(a)[0] - this.lon);
    const lb = wrapLonDelta(vec3ToLonLat(b)[0] - this.lon);
    // A crossing shows up as a jump of more than half the world in a single
    // segment. Anything shorter is an ordinary step, however close to the edge.
    if (Math.abs(la - lb) <= 180) return null;

    const hit = meridianCrossing(a, b, seam);
    if (!hit) return null;
    const lat = vec3ToLonLat(hit)[1];

    // Named by which EDGE of the map each lands on, not by compass direction:
    // seam - EPS is a delta of +180-EPS from the centre, so it projects to the
    // far right, and seam + EPS wraps to -180+EPS and projects to the far left.
    const EPS = 1e-4;
    const rightEdge = lonLatToVec3(wrapLonDelta(seam - EPS), lat, [0, 0, 0]);
    const leftEdge = lonLatToVec3(wrapLonDelta(seam + EPS), lat, [0, 0, 0]);
    // Leave by the edge the segment was already heading for.
    return la > 0 ? [rightEdge, leftEdge] : [leftEdge, rightEdge];
  }
}
