/*
 * Reconstructed polygons: continents, terranes, coastlines.
 *
 * Rigid bodies, so the geometry arrives ONCE at its present-day position with an Euler
 * pole and angle per plate per time, and this rotates it. Shipping reconstructed geometry
 * per frame would mean tens of thousands of vertices times hundreds of frames; here it is
 * one matrix per plate per frame and a matrix multiply per vertex.
 *
 * ---- Why filling does not use tracePolyline -------------------------------------------
 *
 * tracePolyline lifts the pen where a line passes behind the horizon, which is right for a
 * line and wrong for a filled shape: an open path closes itself with a straight chord, so
 * a continent straddling the limb would fill as a lens across the globe.
 *
 * It IS used for the one case that cannot be filled at all -- a ring straddling a flat
 * map's seam, which is outlined instead. That is not an exception to the reasoning above
 * so much as a consequence of it: where a closed path is guaranteed wrong, a line is the
 * honest thing to draw, and then tracePolyline is exactly the right tool.
 *
 * Instead, a vertex behind the horizon is CLAMPED onto the limb -- the component of the
 * vertex perpendicular to the view axis, nudged just inside the visible side. The ring
 * stays continuous, the fill closes along the limb where it should, and nothing can spill
 * off the disc because every clamped point lands exactly on it.
 *
 * This costs the projector one extra capability, `axis`. Without it the layer draws
 * outlines only, since there is no way to know where the limb is.
 */

import { lonLatToVec3 } from './sphere.js';
import { quatFromPoleAngle, quatSlerp, quatToMat3 } from './rotations.js';
import { tracePolyline } from './polyline.js';

// How far inside the horizon a clamped vertex is placed. Large enough to survive float
// noise in the depth test, small enough to be invisible: at a 400 px radius this is well
// under a hundredth of a pixel.
const LIMB_EPSILON = 1e-6;

export const DEFAULT_OPTIONS = {
  fill: 'rgba(122, 138, 122, 0.55)',
  stroke: 'rgba(214, 228, 214, 0.42)',
  lineWidth: 0.7,
  // Outlines only. Useful over a raster, where a fill would hide the map underneath.
  outline: false,
};

export class PolygonLayer {
  constructor(data, options = {}) {
    this.meta = data;
    this.times = data.times;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.visible = true;

    const features = data.features;
    let total = 0;
    for (const f of features) total += f.xy.length / 2;

    // One flat buffer of present-day unit vectors for the whole layer, and one of rotated
    // ones to write into each frame. Two allocations, not one per ring per frame.
    this.home = new Float64Array(total * 3);
    this.xyz = new Float64Array(total * 3);
    this.rings = [];

    const tmp = [0, 0, 0];
    let o = 0;
    for (const f of features) {
      const n = f.xy.length / 2;
      for (let i = 0; i < n; i++) {
        lonLatToVec3(f.xy[i * 2], f.xy[i * 2 + 1], tmp);
        this.home[(o + i) * 3] = tmp[0];
        this.home[(o + i) * 3 + 1] = tmp[1];
        this.home[(o + i) * 3 + 2] = tmp[2];
      }
      this.rings.push({
        plate: String(f.p),
        begin: f.b,          // older end of validity, Ma
        end: f.e,            // younger end, Ma
        name: f.n || '',
        offset: o,
        count: n,
      });
      o += n;
    }

    this.quats = new Map();
    for (const [plate, series] of Object.entries(data.rotations)) {
      this.quats.set(plate, series.map(
        ([lon, lat, ang]) => quatFromPoleAngle(lon, lat, ang)));
    }

    this.currentTime = null;
    // One matrix per plate, allocated once and written into each frame. Allocating 425
    // Float64Arrays per time change was pure garbage for the collector to sweep.
    this._mats = new Map();
    for (const plate of this.quats.keys()) this._mats.set(plate, new Float64Array(9));
    this._q = [0, 0, 0, 1];
    this._v = [0, 0, 0];
    this._c = [0, 0, 0];
  }

  static async load(url, options) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return new PolygonLayer(await res.json(), options);
  }

  /** Bracketing sample indices and the fraction between them. */
  _bracket(time) {
    const times = this.times;
    const first = times[0];
    const last = times[times.length - 1];
    const t = Math.max(first, Math.min(last, time));
    const step = times.length > 1 ? (last - first) / (times.length - 1) : 1;
    let i = Math.floor((t - first) / step);
    if (i >= times.length - 1) i = times.length - 2;
    if (i < 0) i = 0;
    return [i, i + 1, (t - times[i]) / step];
  }

  setTime(time) {
    this.currentTime = time;
    const [ia, ib, f] = this._bracket(time);
    const q = this._q;

    // One slerp and one matrix per PLATE. 842 rings share 425 plates here, and a ring's
    // vertices all move together, so this is the whole cost of a frame's reconstruction.
    // The matrices are allocated once in the constructor and overwritten here.
    for (const [plate, series] of this.quats) {
      quatSlerp(series[ia], series[ib], f, q);
      quatToMat3(q, this._mats.get(plate));
    }

    this._transformRings(null);
    return this;
  }

  /**
   * Set plates' rotations directly, instead of looking them up in the rotation table --
   * for a host that computes rotations itself, e.g. from a user dragging a plate around.
   *
   * `rotations` maps plate id to a unit quaternion [x, y, z, w], as a Map or a plain
   * object. Only the plates named are touched; any others keep whatever setTime() or an
   * earlier call gave them. A plate need not appear in the rotation table at all, so a
   * layer built with `rotations: {}` is entirely driven from here.
   *
   * `time` only decides which rings are live (their begin/end validity). It defaults to
   * the current time, or 0 if setTime() has never been called -- a layer with no
   * rotation table has no other way to become drawable.
   */
  setRotations(rotations, time = this.currentTime ?? 0) {
    this.currentTime = time;
    const entries = rotations instanceof Map ? rotations : Object.entries(rotations);
    const touched = new Set();
    for (const [plate, q] of entries) {
      const key = String(plate);
      let m = this._mats.get(key);
      if (!m) {
        m = new Float64Array(9);
        this._mats.set(key, m);
      }
      quatToMat3(q, m);
      touched.add(key);
    }
    this._transformRings(touched);
    return this;
  }

  /** Rotate live rings' home vertices into `xyz`: every plate's, or only `plates`'. */
  _transformRings(plates) {
    const time = this.currentTime;
    const v = this._v;
    for (const ring of this.rings) {
      if (plates && !plates.has(ring.plate)) continue;
      if (!this.isLive(ring, time)) continue;
      const m = this._mats.get(ring.plate);
      if (!m) continue;
      const end = (ring.offset + ring.count) * 3;
      for (let i = ring.offset * 3; i < end; i += 3) {
        v[0] = this.home[i];
        v[1] = this.home[i + 1];
        v[2] = this.home[i + 2];
        this.xyz[i] = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
        this.xyz[i + 1] = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
        this.xyz[i + 2] = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
      }
    }
  }

  /** Validity runs from `begin` (older) down to `end` (younger), both in Ma. */
  isLive(ring, time) {
    return time <= ring.begin && time >= ring.end;
  }

  /** How many rings are valid at the current time. */
  liveCount() {
    let n = 0;
    for (const ring of this.rings) if (this.isLive(ring, this.currentTime)) n++;
    return n;
  }

  /**
   * Project every live ring onto `projector`, without drawing anything.
   *
   * Returns `{ fillable, seam }`. `fillable` holds flat [x, y, x, y, ...] arrays,
   * consistently wound and with the first vertex repeated at the end, each safe
   * to close and fill. `seam` holds the ring records that straddle a flat map's
   * seam and therefore may only be STROKED -- see the long note below; pass each
   * to `tracePolyline` with the projector's own `seamSplit`.
   *
   * This exists because "where do these continents land on screen" and "paint
   * them like so" are separable, and a consumer can want the first without the
   * second: Geode's Old Map viewer strokes the coastline repeatedly at growing
   * widths to build a graded wash, and to do that it needs the path rather than
   * a finished drawing. Reproducing this loop there would have meant copying the
   * limb clamping, the winding fix and the seam test -- the three parts of this
   * layer that are actually difficult.
   *
   * The arrays are freshly allocated per call, unlike draw()'s single reused
   * buffer, because the caller keeps them.
   *
   * Typed explicitly because this repo ships no .d.ts and TypeScript consumers
   * infer from this source: `{ fillable: [], seam: [] }` would otherwise infer
   * as `never[]` and reject every use.
   *
   * @returns {{
   *   fillable: number[][],
   *   seam: {plate: string, begin: number, end: number, name: string,
   *          offset: number, count: number}[],
   * }}
   */
  projectRings(projector) {
    /** @type {{fillable: number[][], seam: any[]}} */
    const out = { fillable: [], seam: [] };
    if (!this.visible || this.currentTime == null) return out;

    const axis = projector.axis;
    // Both optional, and both absent on a camera projector: a flat map has an
    // edge instead of a horizon. See the seam note in the ring loop below.
    const hasSeamSplit = !!projector.seamSplit;
    const halfWidth = projector.mapHalfWidth ?? 0;
    const time = this.currentTime;
    const v = this._v;
    const c = this._c;

    for (const ring of this.rings) {
      if (!this.isLive(ring, time)) continue;
      if (!this._mats.has(ring.plate)) continue;

      // A ring with nothing on the visible side must be skipped, not clamped. Clamping
      // every vertex of a hidden ring collapses it onto the limb, where it traces the
      // whole disc and fills it -- which then cancels against the real continents under
      // nonzero winding and inverts the map, ocean filled and land empty.
      if (axis) {
        let anyVisible = false;
        for (let k = 0; k < ring.count; k++) {
          const i = (ring.offset + k) * 3;
          if (this.xyz[i] * axis[0] + this.xyz[i + 1] * axis[1]
              + this.xyz[i + 2] * axis[2] > 0) { anyVisible = true; break; }
        }
        if (!anyVisible) continue;
      }

      const buf = [];
      let crossesSeam = false;
      // Rings repeat their first vertex, but not every source guarantees it, so close the
      // loop explicitly rather than trusting the data.
      for (let k = 0; k <= ring.count; k++) {
        const i = (ring.offset + (k % ring.count)) * 3;
        v[0] = this.xyz[i];
        v[1] = this.xyz[i + 1];
        v[2] = this.xyz[i + 2];

        let p = projector.project(v);
        if (!p && axis) {
          const limb = clampToLimb(v, axis, c);
          p = limb && projector.project(limb);
        }
        if (!p) continue;                        // no axis: behaves like a polyline
        // Spotted from the projected points we already have, not by asking the
        // projector about every vertex pair -- that would be two extra atan2 per
        // vertex on a path whose cost is documented below in microseconds.
        if (halfWidth && buf.length >= 2
            && Math.abs(p[0] - buf[buf.length - 2]) > halfWidth) crossesSeam = true;
        buf.push(p[0], p[1]);
      }
      if (buf.length < 6) continue;              // fewer than 3 points is not a ring

      /*
       * A ring straddling a flat map's seam cannot be filled: its vertices are
       * split between the two edges, so any single closed path through them
       * sweeps back across the whole map and fills the ocean. Cutting it into
       * per-side pieces and closing each along the map boundary is a real job
       * (and a different one from clamping to a limb) that this layer does not
       * do yet.
       *
       * So it is outlined instead -- drawn into a separate stroke-only path,
       * broken properly at the seam by tracePolyline. Continents that do not
       * touch the seam are unaffected and still fill. Showing a correct outline
       * beats both filling it wrongly and dropping it silently.
       */
      if (crossesSeam && hasSeamSplit) {
        out.seam.push(ring);
        continue;
      }

      // Wind every ring the same way. nonzero fill treats opposite windings as holes, so
      // two abutting terranes digitised in opposite senses would punch each other out.
      // Consistent winding makes nonzero a union, which is what "land" means here.
      if (signedArea(buf) < 0) reverseRing(buf);
      out.fillable.push(buf);
    }
    return out;
  }

  draw(ctx, projector) {
    if (!this.visible || this.currentTime == null) return;

    const seam = projector.seamSplit ? (a, b) => projector.seamSplit(a, b) : null;
    const { fill, stroke, lineWidth, outline } = this.options;
    const { fillable, seam: seamRings } = this.projectRings(projector);

    ctx.save();
    ctx.lineJoin = 'round';
    // Round caps, because the rings below are left OPEN -- see the note on closePath. The
    // seam is two coincident endpoints, and a round cap makes it read as a join.
    ctx.lineCap = 'round';
    ctx.beginPath();

    for (const buf of fillable) {
      ctx.moveTo(buf[0], buf[1]);
      for (let i = 2; i < buf.length; i += 2) ctx.lineTo(buf[i], buf[i + 1]);

      // NO ctx.closePath() here, deliberately, and it must stay that way.
      //
      // The loop above already emits the first vertex again, so the subpath returns to its
      // own start and closePath would add a zero-length segment -- the fill is identical
      // either way. But closePath is not O(1) in Blink when subpaths are being accumulated
      // into one large path: with 727 rings and ~19,500 points it goes quadratic. Measured
      // on this exact geometry, 727 rings filled and stroked:
      //
      //     with closePath per ring   13.2 ms      without   0.4 ms
      //
      // On the live page that was 75% of all main-thread time while scrubbing, and dropping
      // it took one slider step from 8.3 ms to 2.1 ms. A Path2D is no better (13.2 ms), so
      // this is closePath itself, not the path object.
    }

    if (!outline && fill) {
      ctx.fillStyle = fill;
      // nonzero, so overlapping rings read as one landmass rather than double-darkening
      // where terranes abut.
      ctx.fill('nonzero');
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();

      // The seam-crossing rings, outlined but never filled -- same pen, so they
      // read as part of the same map rather than a second layer. A fresh path
      // rather than a Path2D: that is a browser global, and this library is meant
      // to stay usable headlessly and in a worker (see index.js's own note).
      // `.length`, not truthiness: projectRings() always returns an array, and an
      // empty one is truthy -- which would open a second, empty path on every
      // projector that has no seam at all.
      if (seamRings.length) {
        ctx.beginPath();
        for (const r of seamRings) {
          tracePolyline(ctx, (w) => projector.project(w), this.xyz,
                        r.offset, r.count, { closed: true, seam });
        }
        ctx.stroke();
      }
    }

    ctx.restore();
  }
}

/** Twice the signed area of a flat [x, y, x, y, ...] ring; sign gives the winding. */
function signedArea(buf) {
  let sum = 0;
  for (let i = 0, n = buf.length; i < n; i += 2) {
    const j = (i + 2) % n;
    sum += buf[i] * buf[j + 1] - buf[j] * buf[i + 1];
  }
  return sum;
}

function reverseRing(buf) {
  for (let i = 0, j = buf.length - 2; i < j; i += 2, j -= 2) {
    const x = buf[i], y = buf[i + 1];
    buf[i] = buf[j]; buf[i + 1] = buf[j + 1];
    buf[j] = x; buf[j + 1] = y;
  }
}

/**
 * The point on the visible limb nearest `v`, nudged just inside.
 *
 * The component of v perpendicular to the view axis is the direction of the limb point;
 * tilting it a hair toward the axis makes the depth test pass so it can be projected.
 * Returns null where v is exactly antipodal to the axis and the perpendicular vanishes.
 */
function clampToLimb(v, axis, out) {
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  let x = v[0] - d * axis[0];
  let y = v[1] - d * axis[1];
  let z = v[2] - d * axis[2];
  const len = Math.hypot(x, y, z);
  if (len < 1e-12) return null;
  x /= len; y /= len; z /= len;

  out[0] = x + axis[0] * LIMB_EPSILON;
  out[1] = y + axis[1] * LIMB_EPSILON;
  out[2] = z + axis[2] * LIMB_EPSILON;
  return out;
}
