/*
 * Spherical geometry.
 *
 * Everything here treats the Earth as a sphere and works in 3-D unit vectors. Nothing
 * interpolates lon/lat pairs directly -- that is a flat-plane operation which misbehaves
 * near the poles and across the antimeridian, and plate reconstructions spend a lot of
 * their time in both places.
 */

export const DEG = Math.PI / 180;

/** Unit vector for a lon/lat in degrees. Writes into `out` if given. */
export function lonLatToVec3(lonDeg, latDeg, out) {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const cosLat = Math.cos(lat);
  out = out || [0, 0, 0];
  out[0] = cosLat * Math.cos(lon);
  out[1] = cosLat * Math.sin(lon);
  out[2] = Math.sin(lat);
  return out;
}

export function vec3ToLonLat(v) {
  return [
    Math.atan2(v[1], v[0]) / DEG,
    Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG,
  ];
}

/**
 * The local east and north unit vectors at a point, in world coordinates.
 *
 * This is the tangent frame used to turn (east, north) velocity components into a
 * direction on the sphere. It is the same basis an orthographic camera uses for its
 * first two rows, which is not a coincidence -- both are "the plane tangent at this
 * point".
 */
export function tangentFrame(lonDeg, latDeg, east, north) {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);

  east[0] = -sinLon;
  east[1] = cosLon;
  east[2] = 0;

  north[0] = -sinLat * cosLon;
  north[1] = -sinLat * sinLon;
  north[2] = cosLat;
}

/** a × b, written into `out`. */
export function cross(a, b, out) {
  out = out || [0, 0, 0];
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Normalise in place. Returns the original length. */
export function normalise(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n > 0) { v[0] /= n; v[1] /= n; v[2] /= n; }
  return n;
}

/**
 * Unit tangent at `a` pointing towards `b`: the component of b perpendicular to a.
 *
 * This is the direction of travel along the great circle from a to b. Returns false if
 * the two points coincide, where the tangent is undefined.
 */
export function tangentTowards(a, b, out) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  out[0] = b[0] - dot * a[0];
  out[1] = b[1] - dot * a[1];
  out[2] = b[2] - dot * a[2];
  return normalise(out) > 1e-12;
}

/**
 * The point an angular distance `theta` from `base` in the direction of unit tangent
 * `dir`:  base·cos θ + dir·sin θ.
 *
 * This is the great circle the point is actually travelling along, which is what makes
 * it correct to use for velocity arrows and for offsetting a decoration off a boundary.
 */
export function travel(base, dir, theta, out) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  out[0] = base[0] * c + dir[0] * s;
  out[1] = base[1] * c + dir[1] * s;
  out[2] = base[2] * c + dir[2] * s;
  return out;
}

/**
 * The "left of travel" direction on the sphere at `a`, heading along `tangent`.
 *
 * a × tangent. Sanity check: at a point on the equator heading north, this points west.
 * Defined on the sphere, so it is independent of any projection -- which is the whole
 * point, since the projected left/right depends on the projection's handedness.
 */
export function leftOfTravel(a, tangent, out) {
  return cross(a, tangent, out);
}

/*
 * ---- Rings on the sphere -------------------------------------------------------------
 *
 * A ring is `count` unit vectors packed as xyz triples in `buf` from vertex `offset` --
 * the same packing PolygonLayer keeps its geometry in, so these run on its buffers
 * directly. Consecutive vertices are joined by great-circle arcs, and a repeated closing
 * vertex is harmless (it is a zero-length edge, and contributes nothing).
 *
 * On a sphere every closed ring splits the surface in two, and neither half is "the
 * inside" by geometry alone. The convention here is the usual one: the interior is on
 * the LEFT, walking the ring as seen from outside the sphere -- counter-clockwise. A
 * ring digitised the other way round describes the rest of the world. ringSignedArea
 * says which a ring is, so a caller that knows its shapes are small (continents, say)
 * can reverse any that come out negative.
 */

/**
 * Signed area of a ring, in steradians (multiply by R^2 for an area): positive when the
 * ring is counter-clockwise, i.e. its interior as defined above is the region it
 * encloses.
 *
 * Summed as a fan of triangles from the ring's mean direction, each one's solid angle by
 * Van Oosterom & Strackee (1983). Valid while the ring does not enclose the antipode of
 * its own mean direction -- true of anything smaller than a hemisphere or so, which is
 * every landmass. A planar shoelace on lon/lat is NOT a substitute: it is wrong in
 * proportion to latitude and meaningless across the antimeridian or a pole.
 */
export function ringSignedArea(buf, offset, count) {
  const o = ringMean(buf, offset, count);
  let total = 0;
  forEachEdge(buf, offset, count, (ax, ay, az, bx, by, bz) => {
    total += triangleSolidAngle(o[0], o[1], o[2], ax, ay, az, bx, by, bz);
  });
  return total;
}

/**
 * Whether unit vector `p` lies inside the ring (on its left -- see the convention above).
 *
 * Winding number on the sphere: the signed angle each edge subtends at p, measured in
 * p's own tangent plane, summed. A counter-clockwise ring around p totals +2 pi; one
 * that does not surround p totals 0. A ring surrounding p's ANTIPODE totals -2 pi -- seen
 * from p through the Earth it runs clockwise -- which is exactly how a click in the
 * Pacific is told apart from a click on the continent on the far side of the globe.
 */
export function ringContains(buf, offset, count, p) {
  let total = 0;
  const [px, py, pz] = p;
  forEachEdge(buf, offset, count, (ax, ay, az, bx, by, bz) => {
    // p . (a x b) is the sine side; a . b - (p . a)(p . b) the cosine side, both scaled
    // by the same positive factor, so atan2 needs no normalisation.
    const crossX = ay * bz - az * by;
    const crossY = az * bx - ax * bz;
    const crossZ = ax * by - ay * bx;
    const sin = px * crossX + py * crossY + pz * crossZ;
    const cos = (ax * bx + ay * by + az * bz)
      - (px * ax + py * ay + pz * az) * (px * bx + py * by + pz * bz);
    total += Math.atan2(sin, cos);
  });
  return total > Math.PI;
}

/**
 * Area-weighted centroid of a ring, as a unit vector -- the point a plate would spin about
 * if you twisted it in place. Not the mean of the lon/lats, which drifts toward the pole
 * and breaks across the antimeridian, and not the mean of the vertices either, which is
 * pulled toward wherever the digitiser happened to put more points.
 */
export function ringCentroid(buf, offset, count) {
  const o = ringMean(buf, offset, count);
  const c = [0, 0, 0];
  forEachEdge(buf, offset, count, (ax, ay, az, bx, by, bz) => {
    const w = triangleSolidAngle(o[0], o[1], o[2], ax, ay, az, bx, by, bz);
    const m = [o[0] + ax + bx, o[1] + ay + by, o[2] + az + bz];
    normalise(m);
    c[0] += w * m[0]; c[1] += w * m[1]; c[2] += w * m[2];
  });
  // A clockwise ring weights everything negatively; the direction is the same.
  if (normalise(c) === 0) return o;
  if (c[0] * o[0] + c[1] * o[1] + c[2] * o[2] < 0) { c[0] = -c[0]; c[1] = -c[1]; c[2] = -c[2]; }
  return c;
}

function ringMean(buf, offset, count) {
  const o = [0, 0, 0];
  for (let k = 0; k < count; k++) {
    const i = (offset + k) * 3;
    o[0] += buf[i]; o[1] += buf[i + 1]; o[2] += buf[i + 2];
  }
  normalise(o);
  return o;
}

function forEachEdge(buf, offset, count, fn) {
  for (let k = 0; k < count; k++) {
    const i = (offset + k) * 3;
    const j = (offset + ((k + 1) % count)) * 3;
    fn(buf[i], buf[i + 1], buf[i + 2], buf[j], buf[j + 1], buf[j + 2]);
  }
}

/** Signed solid angle of the spherical triangle o, a, b (Van Oosterom & Strackee). */
function triangleSolidAngle(ox, oy, oz, ax, ay, az, bx, by, bz) {
  const triple = ox * (ay * bz - az * by) + oy * (az * bx - ax * bz) + oz * (ax * by - ay * bx);
  const denom = 1 + (ox * ax + oy * ay + oz * az) + (ax * bx + ay * by + az * bz)
    + (bx * ox + by * oy + bz * oz);
  return 2 * Math.atan2(triple, denom);
}
