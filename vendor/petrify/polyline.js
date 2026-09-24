/*
 * Projecting a polyline onto a canvas path, with horizon handling.
 *
 * This is the loop every vector layer on a globe needs: walk a run of pre-computed unit
 * vectors, project each one, and lift the pen wherever the line passes behind the
 * horizon rather than clamping it -- clamping smears lines across the disc as the globe
 * turns. It was written twice (coastlines and plate boundaries) before being pulled out
 * here.
 *
 * Vertices are stored as a flat Float64Array of xyz triples so a whole layer is one
 * allocation, and so the per-frame cost is a projection per point and nothing else.
 */

/**
 * Add one polyline to `path`.
 *
 * The options object carries `closed` (repeat the first vertex, for rings),
 * `projected` (an array to receive the projected points, nulls included, so the
 * caller can reuse them without projecting twice) and `seam` (from a projector
 * whose map has an EDGE rather than a horizon -- see below).
 *
 * Every parameter is typed explicitly because this repo ships no .d.ts:
 * TypeScript consumers get their types by inference from this source, and an
 * inferred `seam = null` default narrows to exactly `null`, which rejects the
 * very function the parameter exists to take.
 *
 * @param {{moveTo: Function, lineTo: Function}} path a CanvasRenderingContext2D or Path2D
 * @param {(v: ArrayLike<number>) => (number[]|null)} project
 * @param {ArrayLike<number>} xyz flat array of unit vectors
 * @param {number} offset index of the first vertex (in vertices, not floats)
 * @param {number} count number of vertices
 * @param {{
 *   closed?: boolean,
 *   projected?: ((number[]|null)[])|null,
 *   seam?: ((a: ArrayLike<number>, b: ArrayLike<number>) => (number[][]|null))|null,
 * }} [options]
 * @returns {number} the number of points actually drawn
 */
export function tracePolyline(path, project, xyz, offset, count,
                              { closed = false, projected = null, seam = null } = {}) {
  if (projected) projected.length = 0;

  const v = [0, 0, 0];
  const prev = [0, 0, 0];
  let havePrev = false;
  let pen = false;
  let drawn = 0;

  const limit = closed ? count + 1 : count;
  for (let k = 0; k < limit; k++) {
    const i = (offset + (k % count)) * 3;
    v[0] = xyz[i]; v[1] = xyz[i + 1]; v[2] = xyz[i + 2];

    /*
     * A whole-world flat map is cut open somewhere, and a segment spanning that
     * cut is a single step on the sphere but a leap from one side of the canvas
     * to the other. Drawn as-is it streaks across the entire map.
     *
     * The projector, which is the only thing that knows where its own cut is,
     * hands back the two points to break at: run the pen out to the edge it was
     * heading for, lift, and resume from the matching point on the opposite
     * edge. Both are the same place on the sphere.
     *
     * Note this is driven from the SEGMENT, not from a vertex -- which is why it
     * cannot live inside project(). A projector sees one vertex at a time and
     * has no way to tell "the line just wrapped" from "a new feature started
     * somewhere else"; only the caller walking a run knows that, and it is the
     * caller that has the previous vertex to hand.
     */
    if (seam && havePrev && pen) {
      const cut = seam(prev, v);
      if (cut) {
        const out = project(cut[0]);
        if (out) { path.lineTo(out[0], out[1]); drawn++; }
        const back = project(cut[1]);
        if (back) { path.moveTo(back[0], back[1]); pen = true; drawn++; } else { pen = false; }
        // The real vertex still gets drawn below, continuing from the far edge.
      }
    }

    const p = project(v);
    if (projected) projected.push(p);
    prev[0] = v[0]; prev[1] = v[1]; prev[2] = v[2];
    havePrev = true;

    if (!p) { pen = false; continue; }
    if (pen) path.lineTo(p[0], p[1]);
    else { path.moveTo(p[0], p[1]); pen = true; }
    drawn++;
  }
  return drawn;
}

/**
 * Pack an array of [lon, lat] rings into one flat unit-vector buffer.
 *
 * Returns { xyz, runs } where each run is { offset, count }, matching the argument
 * order tracePolyline expects.
 */
export function packLonLat(rings, lonLatToVec3) {
  let total = 0;
  for (const r of rings) total += r.length;

  const xyz = new Float64Array(total * 3);
  const runs = [];
  const tmp = [0, 0, 0];
  let o = 0;

  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      lonLatToVec3(ring[i][0], ring[i][1], tmp);
      xyz[(o + i) * 3] = tmp[0];
      xyz[(o + i) * 3 + 1] = tmp[1];
      xyz[(o + i) * 3 + 2] = tmp[2];
    }
    runs.push({ offset: o, count: ring.length });
    o += ring.length;
  }
  return { xyz, runs };
}
