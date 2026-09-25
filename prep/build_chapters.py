"""
Build the plate sets the Pangea chapters draw, from a published plate model.

    conda run -n pygmt17 python prep/build_chapters.py [--model Muller2019] [--figures DIR]

For each set in prep/groups/<model>.json this writes data/<model>/<set>.json. The file
holds one global list of land rings (Natural Earth 1:110m), and, per group:

- `crust`: continental-polygon rings, including submerged continental crust.
- `land`: indices of the land rings that may overlap this group's crust. The page draws
  land clipped to each group's crust, so each block shows exactly its own land.
- `members`: the model plate ids the group contains, with their names.
- `reference`: the principal plate's rotation relative to plate 000, every 5 Myr, as
  [lat, lon, angle].

A group is defined by a few SEED plate ids. Each seed carries the name the model's own
continental-polygon file gives it, and a seed whose name doesn't match stops the build.
Every other plate id joins the group of its nearest seed, measured as great-circle
distance between the two plates' polygons, if that is within the set's maxDistanceKm.
Otherwise it's left out. So the grouping comes from the model's geometry plus a short
list of named seeds, not from a hand-written table of plate ids.

Rings are simplified on the sphere (Douglas-Peucker with an angular tolerance), and
small ones are dropped. Boundaries shared between neighbouring blocks are simplified
once and identically on both sides (simplify_rings_shared), so neighbours still meet
and no slivers of ocean open inside a continent. The build stops if any continent's
total area changes by more than MAX_GROUP_AREA_CHANGE.

Everything is lon/lat WGS84 on a spherical Earth.
"""
import argparse
import collections
import glob
import json
import os

import numpy as np
import pygplates

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
EARTH_RADIUS_KM = 6371.0

MODELS = {
    'Muller2019': dict(
        root='~/Library/Caches/gprm/Muller2019/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics',
        crust='StaticGeometries/ContinentalPolygons/'
              'Global_EarthByte_GPlates_PresentDay_ContinentalPolygons_2019_v1.shp',
        rotations='*.rot',
        max_age=250,
    ),
}

# Simplification. Angular tolerance on the sphere, and a floor on ring area -- islands
# smaller than this are not worth dragging, and they are most of the vertex count.
# Deliberately coarse: the look is slightly cartoony, and a student fitting continents
# is not helped by fjords.
TOLERANCE_DEG = {'land': 0.3, 'crust': 0.15}
MIN_AREA_KM2 = {'land': 15000.0, 'crust': 20000.0}
MAX_AREA_CHANGE = 0.08          # per isolated ring (islands)
MAX_GROUP_AREA_CHANGE = 0.03    # per continent, all its rings together
# Land comes from Natural Earth, not the model's own coastline file: that file stitches
# islands and lakes onto their mainland with long spokes (Baltica's ring runs from 28E 71N
# to 15E 59N to 44E 49N), which fill as giant triangles. Which block owns which land is
# decided in the browser instead, by clipping land to each block's continental polygons.
NE_LAND = '~/.local/share/cartopy/shapefiles/natural_earth/physical/ne_110m_land.shp'
LIPS = '~/data/LIPs/Shapefiles/Earthbyte_LIPs_20121121/EarthByte_LIPs_20121121.shp'
REFERENCE_STEP = 5


# ---- Geometry on the sphere ----------------------------------------------------------

def to_xyz(latlon):
    lat, lon = np.radians(latlon[:, 0]), np.radians(latlon[:, 1])
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def clean_ring(latlon):
    """Drop pole spurs and repeated vertices, and cut out slit-joined holes.

    Shapefiles close polar polygons by running down a meridian to the pole and back. On
    a sphere that spur is a zero-width slit, so the pole vertices are dropped and the ring
    closes across the antimeridian, as the great-circle edge it really is. A hole joined
    to the ring by a slit (an edge a->b later retraced as b->a) is cut out the same way.
    """
    ll = latlon[np.abs(latlon[:, 0]) < 89.9]
    if len(ll) < 3:
        return ll
    if np.allclose(ll[0], ll[-1]):
        ll = ll[:-1]
    keep = [0] + [i for i in range(1, len(ll)) if not np.allclose(ll[i], ll[i - 1], atol=1e-9)]
    ll = ll[keep]
    pts = [tuple(np.round(p, 6)) for p in ll]
    n = len(pts)
    edge_at = {}
    for k in range(n):
        edge_at.setdefault((pts[k], pts[(k + 1) % n]), k)
    for k in range(n):
        m = edge_at.get((pts[(k + 1) % n], pts[k]))
        if m is not None and m > k:
            return clean_ring(ll[list(range(0, k + 1)) + list(range(m + 1, n))])
    return ll


def simplify_ring(latlon, tol_deg):
    """Douglas-Peucker on the sphere: distances are angles to great-circle arcs."""
    xyz = to_xyz(latlon)
    n = len(xyz)
    if n < 5:
        return latlon
    tol = np.radians(tol_deg)
    keep = np.zeros(n, bool)

    # A closed ring has no natural endpoints; split it at vertex 0 and the vertex
    # farthest from it, and simplify the two halves as open runs.
    far = int(np.argmin(xyz @ xyz[0]))
    keep[[0, far]] = True

    def arc_distance(p, a, b):
        nrm = np.cross(a, b)
        s = np.linalg.norm(nrm)
        if s < 1e-12:
            return np.arccos(np.clip(p @ a, -1, 1))
        nrm = nrm / s
        d = np.abs(np.arcsin(np.clip(p @ nrm, -1, 1)))
        # Beyond the arc's ends, the nearest point is an endpoint, not the great circle.
        proj = p - np.outer(p @ nrm, nrm)
        on_arc = (np.cross(a, proj) @ nrm >= 0) & (np.cross(proj, b) @ nrm >= 0)
        ends = np.minimum(np.arccos(np.clip(p @ a, -1, 1)), np.arccos(np.clip(p @ b, -1, 1)))
        return np.where(on_arc, d, ends)

    stack = [(0, far), (far, n)]
    while stack:
        i, j = stack.pop()
        jj = j % n
        if j - i < 2:
            continue
        idx = np.arange(i + 1, j)
        d = arc_distance(xyz[idx], xyz[i], xyz[jj])
        k = int(np.argmax(d))
        if d[k] > tol:
            m = int(idx[k])
            keep[m] = True
            stack += [(i, m), (m, j)]
    return latlon[keep]


def simplify_rings_shared(rings, tol_deg):
    """Simplify many rings at once without opening gaps between neighbours.

    Neighbouring blocks in the model share boundary vertices exactly. Simplifying each
    ring on its own would thin those shared boundaries differently on either side and
    leave slivers of ocean inside a continent. So vertices where the set of rings passing
    through them changes (junctions, and the ends of every shared stretch) are pinned, and
    each run between pinned vertices is simplified as an open line. A stretch shared by two
    rings is the same run in both (walked in opposite directions), so it simplifies to
    the same vertices in both. Rings with no pinned vertex fall back to simplify_ring.
    """
    keys = [[tuple(np.round(v, 6)) for v in ll] for ll in rings]
    users = collections.defaultdict(set)
    for r, ks in enumerate(keys):
        for k in ks:
            users[k].add(r)

    out = []
    for r, (ll, ks) in enumerate(zip(rings, keys)):
        n = len(ll)
        sets = [frozenset(users[k]) for k in ks]
        pinned = [k for k in range(n)
                  if len(sets[k]) > 1 and (sets[k] != sets[k - 1] or sets[k] != sets[(k + 1) % n])]
        if not pinned:
            out.append(None)          # caller simplifies it on its own
            continue
        keep = np.zeros(n, bool)
        keep[pinned] = True
        xyz = to_xyz(ll)
        for a, b in zip(pinned, pinned[1:] + [pinned[0] + n]):
            idx = np.arange(a, b + 1) % n
            sub = simplify_open(xyz[idx], np.radians(tol_deg))
            keep[idx[sub]] = True
        out.append(ll[keep])
    return out


def simplify_open(xyz, tol):
    """Douglas-Peucker on an open run of unit vectors; returns a keep mask. Endpoints kept."""
    n = len(xyz)
    keep = np.zeros(n, bool)
    keep[[0, n - 1]] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        idx = np.arange(i + 1, j)
        d = arc_distance(xyz[idx], xyz[i], xyz[j])
        k = int(np.argmax(d))
        if d[k] > tol:
            m = int(idx[k])
            keep[m] = True
            stack += [(i, m), (m, j)]
    return keep


def arc_distance(p, a, b):
    """Angular distance from points p to the great-circle arc a-b."""
    nrm = np.cross(a, b)
    s = np.linalg.norm(nrm)
    if s < 1e-12:
        return np.arccos(np.clip(p @ a, -1, 1))
    nrm = nrm / s
    d = np.abs(np.arcsin(np.clip(p @ nrm, -1, 1)))
    # Beyond the arc's ends, the nearest point is an endpoint, not the great circle.
    proj = p - np.outer(p @ nrm, nrm)
    on_arc = (np.cross(a, proj) @ nrm >= 0) & (np.cross(proj, b) @ nrm >= 0)
    ends = np.minimum(np.arccos(np.clip(p @ a, -1, 1)), np.arccos(np.clip(p @ b, -1, 1)))
    return np.where(on_arc, d, ends)


def cap(xyz):
    """(centre, angular radius) of a cap about the ring's mean direction holding every vertex."""
    c = xyz.mean(axis=0)
    c = c / np.linalg.norm(c)
    return c, float(np.arccos(np.clip((xyz @ c).min(), -1, 1)))


def load_land():
    """Natural Earth land, cleaned, small islands dropped, simplified and densified."""
    rings = []
    for ft in pygplates.FeatureCollection(os.path.expanduser(NE_LAND)):
        for g in ft.get_geometries():
            ring = clean_ring(g.to_lat_lon_array())
            if len(ring) < 3:
                continue
            area = ring_area_km2(ring)
            if area < MIN_AREA_KM2['land']:
                continue
            tol = TOLERANCE_DEG['land']
            while True:
                simple = simplify_ring(ring, tol)
                change = abs(ring_area_km2(simple) - area) / area if len(simple) >= 3 else 1
                if change <= MAX_AREA_CHANGE or tol < 0.005:
                    break
                tol /= 2
            rings.append(densify_ring(simple))
    print(f'land: {len(rings)} Natural Earth rings, {sum(len(r) for r in rings)} vertices')
    return rings


def ring_area_km2(latlon):
    return pygplates.PolygonOnSphere(latlon.tolist()).get_area() * EARTH_RADIUS_KM ** 2


# ---- Model ---------------------------------------------------------------------------

def load_polygons(path):
    """[(plate_id, name, latlon ring, feature type, appearance age)] for every polygon."""
    out = []
    for ft in pygplates.FeatureCollection(path):
        pid = ft.get_reconstruction_plate_id()
        for g in ft.get_geometries():
            if isinstance(g, pygplates.PolygonOnSphere):
                # Exterior ring only: the viewer fills with nonzero winding, so holes
                # would not survive anyway.
                out.append((pid, ft.get_name(), g.to_lat_lon_array(),
                            str(ft.get_feature_type()), ft.get_valid_time()[0]))
    return out


def plate_names(crust):
    """The name each plate id carries most, by area, in the continental polygons."""
    by = collections.defaultdict(collections.Counter)
    for pid, name, ll, *_ in crust:
        by[pid][name or ''] += ring_area_km2(ll)
    return {pid: c.most_common(1)[0][0] for pid, c in by.items()}


def assign(groups, polys_by_id, names, max_km):
    """Map every plate id to a group index (or None), growing groups out from their seeds.

    Each seed starts its group. Then, repeatedly, the unassigned plate nearest to ANY
    plate already in a group joins that group -- so a chain of blocks (Patagonia, then
    Tierra del Fuego, then the Falklands) follows its neighbours, rather than every block
    jumping independently to whichever seed happens to be closest across open water.
    Distance is great-circle distance between the plates' polygons. Growth stops at
    max_km; anything farther from every group is left out.
    """
    seeds = {}
    for gi, g in enumerate(groups):
        for sid, expect in g['seeds'].items():
            sid = int(sid)
            got = names.get(sid)
            if got is None or expect.lower() not in got.lower():
                raise SystemExit(f'seed {sid}: expected a name containing {expect!r}, '
                                 f'the model file says {got!r}')
            seeds[sid] = gi

    ids = sorted(polys_by_id)
    pts, owner = [], []
    for i, pid in enumerate(ids):
        p = np.vstack([to_xyz(ll) for ll in polys_by_id[pid]])
        p = p[:: max(1, len(p) // 80)]
        pts.append(p)
        owner.append(np.full(len(p), i))
    allpts = np.vstack(pts)
    owner = np.concatenate(owner)
    starts = np.r_[0, np.cumsum([len(p) for p in pts])[:-1]]

    # Pairwise plate-to-plate distance: the closest pair of sampled vertices.
    n = len(ids)
    D = np.empty((n, n))
    for i in range(n):
        best = np.maximum.reduceat((pts[i] @ allpts.T).max(axis=0), starts)
        D[i] = np.arccos(np.clip(best, -1, 1)) * EARTH_RADIUS_KM

    index = {pid: i for i, pid in enumerate(ids)}
    group = np.full(n, -1)
    dist = np.zeros(n)
    near = np.full((n, len(groups)), np.inf)    # distance from each plate to each group
    for pid, gi in seeds.items():
        if pid not in index:
            print(f'  note: seed {pid} ({names.get(pid)!r}) was removed by the drop rules')
            continue
        i = index[pid]
        group[i] = gi
        near[:, gi] = np.minimum(near[:, gi], D[i])
    while True:
        cand = np.where(group < 0)[0]
        if not len(cand):
            break
        sub = near[cand]
        k = np.unravel_index(np.argmin(sub), sub.shape)
        d = sub[k]
        if d > max_km:
            break
        i, gi = cand[k[0]], k[1]
        group[i], dist[i] = gi, d
        near[:, gi] = np.minimum(near[:, gi], D[i])

    out = {pid: (int(group[index[pid]]) if group[index[pid]] >= 0 else None) for pid in ids}
    far = {pid: float(dist[index[pid]]) if group[index[pid]] >= 0
           else float(near[index[pid]].min()) for pid in ids}
    return out, far


def densify_ring(latlon, max_deg=1.0):
    """Add vertices along each great-circle edge so none is longer than max_deg.

    The viewer draws straight screen segments between projected vertices, which is only
    faithful to the great circle when the edge is short.
    """
    xyz = to_xyz(latlon)
    out = []
    n = len(xyz)
    for k in range(n):
        a, b = xyz[k], xyz[(k + 1) % n]
        theta = np.arccos(np.clip(a @ b, -1, 1))
        steps = max(1, int(np.ceil(np.degrees(theta) / max_deg)))
        for s in range(steps):
            t = s / steps
            if theta < 1e-12:
                v = a
            else:
                v = (np.sin((1 - t) * theta) * a + np.sin(t * theta) * b) / np.sin(theta)
            out.append(v)
    out = np.array(out)
    return np.column_stack([np.degrees(np.arcsin(np.clip(out[:, 2], -1, 1))),
                            np.degrees(np.arctan2(out[:, 1], out[:, 0]))])


def reference_rotations(rotation_model, pid, max_age):
    out = []
    for age in range(0, max_age + 1, REFERENCE_STEP):
        lat, lon, ang = rotation_model.get_rotation(float(age), pid, anchor_plate_id=0) \
            .get_lat_lon_euler_pole_and_angle_degrees()
        out.append([round(lat, 5), round(lon, 5), round(ang, 5)])
    return out


# ---- Build ---------------------------------------------------------------------------

def build_set(model_name, set_name, spec, model, land, crust, names, rotation_model):
    """`land` is the global list of simplified Natural Earth rings (lat/lon arrays)."""
    groups = spec['groups']
    # Only plates the model itself calls continental -- ones with continental polygons --
    # can join a continent. Islands on oceanic plates (Hawaii, on the Pacific plate) have
    # coastlines but no continental crust, and would otherwise drag their whole plate in.
    polys_by_id = collections.defaultdict(list)
    drop_ids = {int(k) for k in spec.get('drop', {})}
    for k, expect in spec.get('drop', {}).items():
        if expect.lower() not in names.get(int(k), '').lower():
            raise SystemExit(f'drop {k}: expected {expect!r}, the model file says {names.get(int(k))!r}')

    keep_ids = {int(k) for k in spec.get('keep', {})}
    for k, expect in spec.get('keep', {}).items():
        if expect.lower() not in names.get(int(k), '').lower():
            raise SystemExit(f'keep {k}: expected {expect!r}, the model file says {names.get(int(k))!r}')

    def kept(pid, ftype, appear):
        if pid in drop_ids:
            return False
        if pid in keep_ids:
            return True
        return ftype not in spec.get('dropTypes', []) and appear >= spec.get('minAppearanceMa', 0)

    dropped = [(pid, name, ll) for pid, name, ll, ftype, appear in crust
               if not kept(pid, ftype, appear)]
    crust = [c for c in crust if kept(c[0], c[3], c[4])]
    for pid, _, ll, *_ in crust:
        polys_by_id[pid].append(ll)
    group_of, dist = assign(groups, polys_by_id, names, spec['maxDistanceKm'])

    out_groups = [dict(name=g['name'], colour=g.get('colour'), principal=g['principal'],
                       hidden=bool(g.get('hidden')), members=[], land=[], crust=[])
                  for g in groups]
    crust_xyz = [[] for _ in groups]      # simplified crust rings as unit vectors, per group
    stats = collections.Counter()
    before_area = [collections.Counter() for _ in groups]
    after_area = [collections.Counter() for _ in groups]
    for kind, polys in (('crust', crust),):
        todo = []                       # (group index, plate id, name, cleaned ring, area)
        for pid, name, ll, *_ in polys:
            gi = group_of.get(pid)
            if gi is None:
                stats[f'{kind} left out'] += 1
                continue
            ring = clean_ring(ll)
            if len(ring) < 3:
                continue
            area = ring_area_km2(ring)
            if area < MIN_AREA_KM2[kind]:
                stats[f'{kind} too small'] += 1
                continue
            todo.append((gi, pid, name, ring, area))

        shared = simplify_rings_shared([t[3] for t in todo], TOLERANCE_DEG[kind])
        for (gi, pid, name, ring, area), simple in zip(todo, shared):
            if simple is None:
                # A ring touching no other: small islands need a finer tolerance than
                # continents to keep their shape, so halve it until the area holds.
                tol = TOLERANCE_DEG[kind]
                while True:
                    simple = simplify_ring(ring, tol)
                    change = abs(ring_area_km2(simple) - area) / area if len(simple) >= 3 else 1
                    if change <= MAX_AREA_CHANGE or tol < 0.005:
                        break
                    tol /= 2
            if len(simple) < 3:
                stats[f'{kind} collapsed'] += 1
                continue
            # A block sharing its boundaries keeps meeting its neighbours however much its
            # own area changes, so what matters is the group total, checked below.
            before_area[gi][kind] += area
            after_area[gi][kind] += ring_area_km2(simple)
            simple = densify_ring(simple)
            stats[f'{kind} vertices before'] += len(ring)
            stats[f'{kind} vertices after'] += len(simple)
            out_groups[gi][kind].append(
                [round(float(v), 3) for lat, lon in simple for v in (lon, lat)])
            crust_xyz[gi].append(to_xyz(simple))

    # Land rings each group might own: those whose bounding cap meets one of the group's
    # crust caps. The browser clips land to the crust, so a generous match costs only
    # drawing time; a missed one would lose land.
    land_caps = [cap(to_xyz(ll)) for ll in land]
    for gi in range(len(groups)):
        caps = [cap(x) for x in crust_xyz[gi]]
        out_groups[gi]['land'] = [
            i for i, (lc, lr) in enumerate(land_caps)
            if any(np.arccos(np.clip(lc @ c, -1, 1)) <= lr + r for c, r in caps)]

    for gi, g in enumerate(groups):
        for kind in ('crust',):
            a, b = before_area[gi][kind], after_area[gi][kind]
            if a and abs(b - a) / a > MAX_GROUP_AREA_CHANGE:
                raise SystemExit(f'{set_name}: {g["name"]} {kind} area changed {abs(b - a) / a:.1%} '
                                 f'on simplification ({a / 1e6:.2f} -> {b / 1e6:.2f} Mkm2)')
            if a:
                stats[f'{kind} worst group area change %'] = max(
                    stats[f'{kind} worst group area change %'], round(100 * abs(b - a) / a, 2))

    for pid, gi in sorted(group_of.items()):
        if gi is not None:
            out_groups[gi]['members'].append([pid, names.get(pid, ''), round(dist[pid])])
    for g in out_groups:
        g['reference'] = reference_rotations(rotation_model, g['principal'], model['max_age'])

    print(f'{set_name}: ' + ', '.join(f'{k} {v}' for k, v in sorted(stats.items())))
    for g in out_groups:
        tag = ' (hidden)' if g['hidden'] else ''
        print(f'  {g["name"]:15s}{tag:9s} {len(g["members"]):3d} plate ids, '
              f'{len(g["crust"]):3d} crust rings, may own {len(g["land"]):3d} land rings')

    hidden = [g['name'] for g in out_groups if g['hidden']]
    shown = [{k: v for k, v in g.items() if k != 'hidden'} for g in out_groups if not g['hidden']]
    return dict(model=model_name, set=set_name, referenceStep=REFERENCE_STEP,
                land=[[round(float(v), 3) for lat, lon in ll for v in (lon, lat)] for ll in land],
                landSource='Natural Earth 1:110m land (public domain)',
                groups=shown, hiddenGroups=hidden,
                dropped=[[round(float(v), 2) for lat, lon in densify_ring(clean_ring(ll), 2.0) for v in (lon, lat)]
                         for _, _, ll in dropped if len(clean_ring(ll)) >= 3],
                leftOut=sorted([pid, names.get(pid, ''), round(dist[pid])]
                               for pid, gi in group_of.items() if gi is None))


def lip_report(crust):
    """Print continental polygons that fall mostly inside an EarthByte LIP outline.

    A report for a person to read, not a filter: the outlines also cover genuine
    continental fragments (the Seychelles, the Batavia and Gulden Draak knolls), so what
    to drop is decided by name in the groups file.
    """
    lips = [g for f in pygplates.FeatureCollection(os.path.expanduser(LIPS))
            for g in f.get_geometries() if isinstance(g, pygplates.PolygonOnSphere)]
    print('Continental polygons >= 50% inside a LIP outline:')
    for pid, name, ll, *_ in crust:
        poly = pygplates.PolygonOnSphere(ll.tolist())
        pts = list(poly.get_points())[:: max(1, len(ll) // 40)] + [poly.get_interior_centroid()]
        frac = sum(any(l.is_point_in_polygon(p) for l in lips) for p in pts) / len(pts)
        if frac >= 0.5:
            print(f'  {pid:6d} {name!r:40s} {frac:.0%}')


def figure(data, path):
    import pygmt
    fig = pygmt.Figure()
    fig.basemap(region='d', projection='N0/18c', frame='g30')
    for r in data.get('dropped', []):
        a = np.array(r).reshape(-1, 2)
        fig.plot(x=np.append(a[:, 0], a[0, 0]), y=np.append(a[:, 1], a[0, 1]), fill='gray60',
                 pen='0.3p,black')
    for g in data['groups']:
        for r in g['crust']:
            a = np.array(r).reshape(-1, 2)
            fig.plot(x=np.append(a[:, 0], a[0, 0]), y=np.append(a[:, 1], a[0, 1]), fill=g['colour'])
    for r in data['land']:
        a = np.array(r).reshape(-1, 2)
        fig.plot(x=np.append(a[:, 0], a[0, 0]), y=np.append(a[:, 1], a[0, 1]), pen='0.4p,black')
    y = -0.9
    for g in data['groups']:
        fig.text(position='BL', text=f'{g["name"]}: {len(g["members"])} plate ids',
                 offset=f'0/{y}c', no_clip=True, font=f'8p,Helvetica,{g["colour"]}')
        y -= 0.4
    fig.text(position='BL', text='grey: dropped (island arcs, appeared < minAppearanceMa, listed LIPs)',
             offset=f'0/{y}c', no_clip=True, font='8p,Helvetica,gray40')
    fig.savefig(path)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='Muller2019')
    ap.add_argument('--figures', default=None)
    ap.add_argument('--lip-report', action='store_true',
                    help='list continental polygons mostly inside an EarthByte LIP outline')
    args = ap.parse_args()

    model = MODELS[args.model]
    root = os.path.expanduser(model['root'])
    land = load_land()
    crust = load_polygons(os.path.join(root, model['crust']))
    names = plate_names(crust)
    if args.lip_report:
        lip_report(crust)
    rotation_model = pygplates.RotationModel(sorted(glob.glob(os.path.join(root, model['rotations']))))
    spec = json.load(open(os.path.join(HERE, 'groups', f'{args.model}.json')))

    out_dir = os.path.join(REPO, 'data', args.model)
    os.makedirs(out_dir, exist_ok=True)
    for set_name, set_spec in spec['sets'].items():
        data = build_set(args.model, set_name, set_spec, model, land, crust, names, rotation_model)
        path = os.path.join(out_dir, f'{set_name}.json')
        with open(path, 'w') as f:
            json.dump(data, f, separators=(',', ':'))
        print(f'  wrote {os.path.relpath(path, REPO)} ({os.path.getsize(path) / 1e3:.0f} kB)')
        if args.figures:
            os.makedirs(args.figures, exist_ok=True)
            figure(data, os.path.join(args.figures, f'{set_name}.png'))
