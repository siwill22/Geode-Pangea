/*
 * The whole-world map view: petrify's Robinson projector, plus the two things this page
 * needs from it that petrify leaves out.
 *
 * 1. Going back from the screen to the sphere, so a plate can be picked and dragged on
 *    the map exactly as on the globe (drags are still rotations on the sphere).
 *
 * 2. Filling a ring that crosses the map's edge. petrify only outlines those, which is
 *    fine for a static map but not here: a dragged plate crosses the edge all the time.
 *    Robinson's x is linear in longitude along each parallel, so the forward formula
 *    holds for longitudes beyond +-180 too. A ring is therefore drawn with its
 *    longitudes UNWRAPPED (each vertex continuing from the last, never jumping by 360),
 *    once as it is and once shifted a full turn each way, and the whole lot is clipped
 *    to the map outline. Whatever runs off one edge is the shifted copy coming in at the
 *    other. A ring round a pole (Antarctica) unwraps to a full 360 degrees of longitude
 *    and is closed along that pole's line, the map's top or bottom edge.
 */
import { Robinson, robinsonForward, robinsonInverse, wrapLonDelta } from '../vendor/petrify/robinson.js';
import { lonLatToVec3, vec3ToLonLat } from '../vendor/petrify/sphere.js';

export class RobinsonMap extends Robinson {
  /** Map point for longitude relative to the centre (any value) and latitude, in px. */
  px(dLon, lat) {
    const [x, y] = robinsonForward(dLon, lat);
    return [this.cx + x * this.radius, this.cy - y * this.radius];
  }

  /**
   * Screen px -> unit vector, or null off the map. With `clamp`, a point off the map is
   * pulled in to the nearest edge along its parallel, so a drag that leaves the map
   * keeps working, as a drag past the globe's limb does.
   */
  unproject(x, y, clamp = false) {
    let mx = (x - this.cx) / this.radius;
    let my = -(y - this.cy) / this.radius;
    let ll = robinsonInverse(mx, my);
    if (!ll) {
      if (!clamp) return null;
      my = Math.max(-1.3523 * 0.9999, Math.min(1.3523 * 0.9999, my));
      const lat = robinsonInverse(0, my).lat;
      const xmax = robinsonForward(180, lat)[0] * 0.9999;
      mx = Math.max(-xmax, Math.min(xmax, mx));
      ll = robinsonInverse(mx, my);
      if (!ll) return null;
    }
    return lonLatToVec3(wrapLonDelta(ll.lon + this.lon), ll.lat, [0, 0, 0]);
  }

  /** The map's outline, as a closed subpath: the -180 edge up, the +180 edge down. */
  traceOutline(path) {
    for (let lat = -90; lat <= 90; lat += 2) {
      const [x, y] = this.px(-180, lat);
      lat === -90 ? path.moveTo(x, y) : path.lineTo(x, y);
    }
    for (let lat = 90; lat >= -90; lat -= 2) {
      const [x, y] = this.px(180, lat);
      path.lineTo(x, y);
    }
    path.closePath();
  }

  /**
   * Add one ring (from a flat xyz array of unit vectors) to `path` for filling, in
   * three copies a turn apart. Clip to traceOutline() before filling.
   */
  traceRingFill(path, xyz, offset, count) {
    if (count < 3) return;
    const lons = new Float64Array(count), lats = new Float64Array(count);
    const v = [0, 0, 0];
    let prev = 0;
    for (let k = 0; k < count; k++) {
      const i = (offset + k) * 3;
      v[0] = xyz[i]; v[1] = xyz[i + 1]; v[2] = xyz[i + 2];
      const [lon, lat] = vec3ToLonLat(v);
      const rel = wrapLonDelta(lon - this.lon);
      lons[k] = k === 0 ? rel : prev + wrapLonDelta(rel - prev);
      lats[k] = lat;
      prev = lons[k];
    }
    // Longitude swept going once round the ring: 0 for an ordinary ring, +-360 for one
    // round a pole. Going east (+360) the inside is on the left, i.e. north.
    const net = lons[count - 1] + wrapLonDelta(lons[0] - lons[count - 1]) - lons[0];
    const polar = Math.abs(net) > 180 ? Math.sign(net) : 0;

    for (const shift of [-360, 0, 360]) {
      let [x, y] = this.px(lons[0] + shift, lats[0]);
      path.moveTo(x, y);
      for (let k = 1; k < count; k++) {
        [x, y] = this.px(lons[k] + shift, lats[k]);
        path.lineTo(x, y);
      }
      if (polar) {
        const pole = polar > 0 ? 90 : -90, end = lons[0] + net + shift;
        [x, y] = this.px(end, lats[0]); path.lineTo(x, y);
        [x, y] = this.px(end, pole); path.lineTo(x, y);
        [x, y] = this.px(lons[0] + shift, pole); path.lineTo(x, y);
      }
      [x, y] = this.px(lons[0] + shift, lats[0]);
      path.lineTo(x, y);
    }
  }
}
