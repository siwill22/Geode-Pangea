"""
Build data/plates.geojson: six continents to drag around, from Natural Earth 110m land.

Natural Earth joins Africa to Eurasia at Suez and North to South America at Panama, so
those two landmasses are cut across their isthmuses first. Each cut is a great-circle
chord between two coastline vertices, chosen by eye from the 110m geometry and pinned
here by index -- they are specific to this file, and the script checks that the vertices
are still where they were when chosen.

Natural Earth also keeps some lakes as holes joined to the coast by a zero-width slit --
the Caspian hangs off the Taymyr coast by a 43 degree one. The viewer draws exterior rings
only, so each such slit and the hole behind it are cut out (the Caspian is filled as land).

Every ring is then tessellated to <= 1 degree along great circles, so its edges stay on
the sphere once the viewer rotates it. Output is lon/lat WGS84.

    conda run -n pygmt17 python prep/make_plates.py
"""
import json
import os

import numpy as np
import pygplates

SRC = os.path.expanduser(
    '~/.local/share/cartopy/shapefiles/natural_earth/physical/ne_110m_land.shp')
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'plates.geojson')
EARTH_RADIUS_KM = 6371.0

# (vertex index, expected lat, expected lon) at each end of a cut.
SUEZ = [(498, 29.85, 32.42), (837, 31.26, 32.19)]      # Gulf of Suez head -> Port Said
PANAMA = [(322, 8.67, -77.35), (566, 7.22, -77.88)]    # Caribbean -> Pacific, Darien

# Plate ids are arbitrary, and in the 900s so they cannot be mistaken for any real
# model's ids. Colours are only a default; the viewer draws each plate in its own.
PLATES = [
    # name, plate id, colour, test for the piece's centroid (lat, lon)
    ('Africa',        901, '#d9a55b', lambda la, lo: -35 < la < 30 and -20 < lo < 50),
    ('Eurasia',       902, '#8fb573', lambda la, lo: la > 30 and 20 < lo < 140),
    ('North America', 903, '#c97b63', lambda la, lo: la > 15 and -140 < lo < -60),
    ('South America', 904, '#b38fd1', lambda la, lo: la < 10 and -80 < lo < -35),
    ('Antarctica',    905, '#9ec3d6', lambda la, lo: la < -60),
    ('Australia',     906, '#e0c270', lambda la, lo: -45 < la < -10 and 110 < lo < 155),
]


def remove_slits(ll):
    """Drop any hole joined to the ring by a slit: an edge a->b later retraced as b->a.

    The loop between the two traversals (the slit and the hole it leads to) is removed,
    leaving the exterior ring alone.
    """
    pts = [tuple(np.round(p, 6)) for p in ll]
    n = len(pts)
    for k in range(n):
        a, b = pts[k], pts[(k + 1) % n]
        for m in range(k + 1, n):
            if pts[m] == b and pts[(m + 1) % n] == a:
                lat, lon = b
                print(f'  removed a {m - k}-vertex hole hanging off a slit to ({lat:.1f}, {lon:.1f})')
                keep = list(range(0, k + 1)) + list(range(m + 1, n))
                return remove_slits(ll[keep])
    return ll


def split(ll, cut):
    """Two rings from one, divided along the chord between the cut's two vertices."""
    for i, la, lo in cut:
        assert abs(ll[i, 0] - la) < 0.01 and abs(ll[i, 1] - lo) < 0.01, (i, ll[i], la, lo)
    i, j = sorted(c[0] for c in cut)
    return ll[i:j + 1], np.concatenate([ll[j:], ll[:i + 1]])


def main():
    fc = pygplates.FeatureCollection(SRC)
    polys = sorted((g for f in fc for g in f.get_geometries()), key=lambda p: -p.get_area())
    afro_eurasia, americas, antarctica, australia = (p.to_lat_lon_array() for p in polys[:4])
    # Before the isthmus cuts, which are pinned by vertex index -- the Caspian's vertices
    # come after both Suez cut vertices in this ring, so removing them shifts neither.
    afro_eurasia = remove_slits(afro_eurasia)

    # Natural Earth closes Antarctica by running down the antimeridian to the pole and back.
    # On a sphere that spur is a zero-width slit; drop the pole vertices and let the ring
    # close across the antimeridian as the great-circle edge it really is.
    antarctica = antarctica[antarctica[:, 0] > -89.9]

    pieces = [*split(afro_eurasia, SUEZ), *split(americas, PANAMA), antarctica, australia]

    features = []
    for name, pid, colour, where in PLATES:
        matches = []
        for ll in pieces:
            poly = pygplates.PolygonOnSphere(ll.tolist())
            la, lo = poly.get_interior_centroid().to_lat_lon()
            if where(la, lo):
                matches.append(poly)
        assert len(matches) == 1, (name, len(matches))
        poly = matches[0]
        ring = poly.to_tessellated(np.radians(1.0)).to_lat_lon_array()
        area_km2 = poly.get_area() * EARTH_RADIUS_KM ** 2
        print(f'{name:14s} {pid}  {len(ring):4d} vertices  {area_km2 / 1e6:6.2f} Mkm2')
        coords = [[round(float(lo), 4), round(float(la), 4)] for la, lo in ring]
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        features.append({
            'type': 'Feature',
            'properties': {
                'name': name, 'plateId': pid, 'colour': colour,
                'areaKm2': round(area_km2),
            },
            'geometry': {'type': 'Polygon', 'coordinates': [coords]},
        })

    with open(OUT, 'w') as f:
        json.dump({
            'type': 'FeatureCollection',
            'source': 'Natural Earth 1:110m land (public domain), split at Suez and Panama',
            'features': features,
        }, f, separators=(',', ':'))
    print('wrote', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
