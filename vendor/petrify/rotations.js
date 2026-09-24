/*
 * Finite rotations, as quaternions.
 *
 * Plate reconstructions arrive as an Euler pole and an angle -- a rotation about an axis
 * through the centre of the Earth. To place a rigid body (a coastline, an ore deposit) at
 * some time, you take its present-day position and apply its plate's finite rotation for
 * that time.
 *
 * Between the sampled times the rotation is interpolated by slerp rather than by
 * interpolating the pole and angle separately, or worse the resulting lon/lat. Slerping
 * the rotation follows the great circle the plate actually turns through; interpolating
 * positions cuts across it, and interpolating a pole across the antimeridian is simply
 * wrong.
 *
 * Lifted from the StoryMaps globe, which has used this path for coastlines since before
 * this library existed.
 */

import { DEG, lonLatToVec3 } from './sphere.js';

/**
 * Quaternion for a finite rotation given as an Euler pole and angle -- the form plate
 * reconstructions come in.
 */
export function quatFromPoleAngle(poleLonDeg, poleLatDeg, angleDeg) {
  const axis = lonLatToVec3(poleLonDeg, poleLatDeg);
  const half = angleDeg * DEG * 0.5;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/**
 * Spherical linear interpolation. This is what makes motion between the 1 Myr
 * reconstruction steps follow a great circle rather than cutting across it.
 */
export function quatSlerp(a, b, t, out) {
  out = out || [0, 0, 0, 1];
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

  // q and -q are the same rotation; pick the nearer one so we take the short way. This
  // is why the exporter needs no sign-continuity pass of its own.
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (dot < 0) {
    dot = -dot;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }

  let s0, s1;
  if (dot > 0.9995) {
    // Nearly parallel: slerp is numerically unstable, and lerp is indistinguishable.
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sinTheta;
    s1 = Math.sin(t * theta) / sinTheta;
  }

  out[0] = s0 * a[0] + s1 * bx;
  out[1] = s0 * a[1] + s1 * by;
  out[2] = s0 * a[2] + s1 * bz;
  out[3] = s0 * a[3] + s1 * bw;

  const n = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  out[0] /= n; out[1] /= n; out[2] /= n; out[3] /= n;
  return out;
}

/** Row-major 3x3 rotation matrix from a unit quaternion. */
export function quatToMat3(q, out) {
  out = out || new Float64Array(9);
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  out[0] = 1 - (yy + zz); out[1] = xy - wz;       out[2] = xz + wy;
  out[3] = xy + wz;       out[4] = 1 - (xx + zz); out[5] = yz - wx;
  out[6] = xz - wy;       out[7] = yz + wx;       out[8] = 1 - (xx + yy);
  return out;
}

export function mat3Multiply(a, b, out) {
  out = out || new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Apply a row-major 3x3 to a vec3, writing into `out`. */
export function mat3Apply(m, v, out) {
  out = out || [0, 0, 0];
  const x = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
  const y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
  const z = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/*
 * ---- Composing rotations interactively ----------------------------------------------
 *
 * The functions above read rotations out of a table. The ones below build them from
 * gestures -- "the point I grabbed is now under the cursor" -- and turn the result back
 * into the Euler pole and angle a rotation file stores. Quaternions are [x, y, z, w],
 * as everywhere else in this file.
 */

/** Product a * b: the rotation that applies b FIRST, then a. Writes into `out`. */
export function quatMultiply(a, b, out) {
  out = out || [0, 0, 0, 1];
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** The inverse of a unit quaternion. */
export function quatConjugate(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotation by `angleRad` (right-handed) about `axis`, which need not be unit length. */
export function quatFromAxisAngle(axis, angleRad) {
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  if (n < 1e-15) return [0, 0, 0, 1];
  const s = Math.sin(angleRad / 2) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angleRad / 2)];
}

/**
 * The smallest rotation carrying unit vector `a` onto unit vector `b`: about the pole of
 * the great circle through them, by the angle between them. This is a drag -- a point
 * grabbed at `a` and let go at `b` travels along that great circle.
 *
 * Identity when a and b coincide. Undefined when they are antipodal (every great circle
 * through them qualifies); a drag cannot get there in one move, so that case is left to
 * the caller rather than resolved arbitrarily here.
 */
export function quatBetween(a, b) {
  const axis = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const sin = Math.hypot(axis[0], axis[1], axis[2]);
  const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (sin < 1e-12) return [0, 0, 0, 1];
  return quatFromAxisAngle(axis, Math.atan2(sin, cos));
}

/**
 * Euler pole and angle for a unit quaternion -- the inverse of quatFromPoleAngle, and the
 * form a GPlates rotation file wants.
 *
 * q and -q are the same rotation, so the pole is taken in whichever hemisphere gives a
 * POSITIVE angle in [0, 180]. The identity has no pole; it is reported as the north pole
 * with a zero angle, which is what rotation files conventionally write for it.
 */
export function quatToPoleAngle(q) {
  let [x, y, z, w] = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return { lon: 0, lat: 90, angle: 0 };
  const angle = 2 * Math.atan2(s, w) / DEG;
  return {
    lon: Math.atan2(y, x) / DEG,
    lat: Math.asin(Math.max(-1, Math.min(1, z / s))) / DEG,
    angle,
  };
}
