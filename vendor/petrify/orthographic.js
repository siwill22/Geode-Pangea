/*
 * A reference projector.
 *
 * Every layer in this library talks to its host through one method:
 *
 *     project(vec3) -> [x, y, depth] | null
 *
 * where `vec3` is a unit vector on the sphere, `x`/`y` are canvas pixels, and `depth`
 * is positive for points on the visible side. Returning null means "behind the horizon,
 * do not draw". A host with its own camera (a WebGL globe, a D3 projection) implements
 * that method and passes itself in; this class exists so the library is usable, and
 * demonstrable, without one.
 *
 * Nothing else about the host is assumed. In particular the layers do NOT assume the
 * projection preserves orientation -- see boundaries.js, where the decoration side is
 * resolved on the sphere rather than in screen space for exactly that reason.
 */

import { DEG } from './sphere.js';

export class Orthographic {
  /**
   * @param cx,cy    canvas coordinates of the globe centre, in CSS pixels
   * @param radius   globe radius in CSS pixels
   * @param lon,lat  the point the camera looks at, in degrees
   */
  constructor({ cx = 0, cy = 0, radius = 300, lon = 0, lat = 0 } = {}) {
    this.cx = cx;
    this.cy = cy;
    this.radius = radius;
    this._m = new Float64Array(9);
    this.lookAt(lon, lat);
  }

  /**
   * Point the camera. The matrix rows are the east, north and outward unit vectors at
   * the centre, so multiplying a point's unit vector by it yields
   * [screen x, screen y, depth] directly, and depth > 0 is an exact horizon test with
   * no planar approximation anywhere.
   */
  lookAt(lonDeg, latDeg) {
    // Exactly at a pole, east and north are undefined; nudge inside.
    latDeg = Math.max(-89.999, Math.min(89.999, latDeg));

    const lon = lonDeg * DEG;
    const lat = latDeg * DEG;
    const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    const m = this._m;

    m[0] = -sinLon;          m[1] = cosLon;           m[2] = 0;             // east
    m[3] = -sinLat * cosLon; m[4] = -sinLat * sinLon; m[5] = cosLat;        // north
    m[6] = cosLat * cosLon;  m[7] = cosLat * sinLon;  m[8] = sinLat;        // outward

    this.lon = lonDeg;
    this.lat = latDeg;
    return this;
  }

  /**
   * The outward unit vector at the centre of the view -- the axis the visible hemisphere
   * is defined around.
   *
   * Optional part of the projector contract, needed only by layers that FILL a shape.
   * Lines can simply lift the pen at the horizon, but a filled polygon crossing the limb
   * has to be closed along it, which means knowing where the limb is. A projector without
   * this can still draw every other layer.
   */
  get axis() {
    const m = this._m;
    return [m[6], m[7], m[8]];
  }

  project(v) {
    const m = this._m;
    const depth = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
    if (depth <= 0) return null;
    return [
      this.cx + (m[0] * v[0] + m[1] * v[1] + m[2] * v[2]) * this.radius,
      // Canvas y points down, so north is subtracted rather than added.
      this.cy - (m[3] * v[0] + m[4] * v[1] + m[5] * v[2]) * this.radius,
      depth,
    ];
  }
}
