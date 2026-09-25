"""
Build data/satlantic.json for the "Opening the South Atlantic" chapter: fracture zones,
conjugate isochrons and flowline seeds between South America (201) and Africa (701).

    conda run -n pygmt17 python prep/build_satlantic.py [--figure out.png]

Sources:

- Fracture zones: the Global Seafloor Fabric and Magnetic Lineation compilation
  (Wessel et al. 2015, GSFML), the KM set of fracture-zone traces, from the gprm cache.
- Isochrons: Seton et al. (2012), the South and Central Atlantic picks, which come in
  conjugate pairs (one on each plate, the other plate as conjugate) from anomaly 5 to M4.
- The ridge and plates: Muller et al. (2019) topologies resolved at 0 Ma. The ridge is the
  boundary the South America and Africa plates share.

Fracture-zone vertices are assigned to the plate they are on today (the 0 Ma resolved
plates), and a trace is split where it crosses from one plate to another; only the parts
on 201 and 701 are kept.

Flowline seeds are where fracture zones are born: the transform offsets of today's
ridge, i.e. ridge segments at least MIN_TRANSFORM_KM long running within
TRANSFORM_TOLERANCE_DEG of the present spreading direction (a small circle about the
0-10 Ma stage pole). Each seed is the transform's midpoint. A fracture zone is then
assigned to the seed whose Muller 2019 flowline it follows most closely, if its mean
distance is under MAX_ASSIGN_KM; fracture zones that follow none (margin structures,
traces of other ridges) are dropped. The model is used only to pair a fracture zone with
its transform, never to place anything. Only transforms whose fracture zones add up to
MIN_RECORD_KM (both flanks together) are kept: the major fracture zones, for a page that
should stay readable.

Flowlines are the synthetic counterpart of a fracture zone. For a seed x on today's ridge
and the relative rotation R(t) of South America to Africa, symmetric spreading puts the
seafloor formed at age t at H(t) x on Africa and H(t)^-1 x on South America, where H(t) is
half of R(t) (GPlates builds the same from half-stage rotations; for one steady pole they
are the same thing). The figure draws pygplates' own flowlines from Muller 2019 against
the fracture zones, as a check of the data and of the flowline convention before any of
it reaches the page.
"""
import argparse
import glob
import json
import os
import re

import numpy as np
import pygplates

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CACHE = os.path.expanduser('~/Library/Caches/gprm')
FZ_FILE = os.path.join(CACHE, 'SeafloorFabric/GMT/GSFML_SF_FZ_KM.gmt')
ISOCHRONS = os.path.join(CACHE, 'Seton2012/SETON2012/Seton_etal_ESR2012_Isochrons_2012.1.gpmlz')
MODEL = os.path.join(CACHE, 'Muller2019/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics')
TOPOLOGIES = ['Global_Mesozoic-Cenozoic_PlateBoundaries_2019_v2.gpml',
              'Western_Tethys_Tectonic_Boundary_Topologies_2019_v2.gpml',
              'Andes_Flat_Slabs_Topologies_2019_v2.gpml', 'Coral_Sea_Topologies_2019_v2.gpml']
SA, AF = 201, 701
R_KM = 6371.0
MIN_FZ_KM = 150      # fracture-zone pieces shorter than this are dropped
MIN_TRANSFORM_KM = 40
TRANSFORM_TOLERANCE_DEG = 25
MAX_ASSIGN_KM = 60
MIN_RECORD_KM = 2000  # a transform is kept if its fracture zones add up to this, both flanks
MAX_AGE = 130
FLOW_TIMES = [float(t) for t in range(0, 121)]


def read_gmt_lines(path):
    lines, cur = [], None
    for raw in open(path):
        if raw.startswith('>'):
            cur = []
            lines.append(cur)
        elif raw.startswith('#') or not raw.strip():
            continue
        elif cur is not None:
            lon, lat = map(float, raw.split()[:2])
            cur.append((lon, lat))
    return [l for l in lines if len(l) > 1]


def length_km(pts):
    return sum(pygplates.GeometryOnSphere.distance(pygplates.PointOnSphere(a[1], a[0]),
                                                   pygplates.PointOnSphere(b[1], b[0]))
               for a, b in zip(pts[:-1], pts[1:])) * R_KM


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--figure')
    args = ap.parse_args()

    rotation_model = pygplates.RotationModel(glob.glob(os.path.join(MODEL, '*.rot')))
    resolved, sections = [], []
    pygplates.resolve_topologies([os.path.join(MODEL, t) for t in TOPOLOGIES], rotation_model,
                                 resolved, 0, sections,
                                 resolve_topology_types=pygplates.ResolveTopologyType.boundary)
    partitioner = pygplates.PlatePartitioner(resolved, rotation_model)

    # The ridge: sub-segments shared by exactly the two plates.
    ridge = []
    for s in sections:
        for ss in s.get_shared_sub_segments():
            ids = sorted(t.get_resolved_feature().get_reconstruction_plate_id()
                         for t in ss.get_sharing_resolved_topologies())
            if ids == [SA, AF]:
                ridge.append(ss.get_resolved_geometry())
    ridge_pts = [p for g in ridge for p in g.get_points()]
    print(f'ridge: {len(ridge)} pieces, {len(ridge_pts)} points')

    def plate_of(lon, lat):
        poly = partitioner.partition_point(pygplates.PointOnSphere(lat, lon))
        return poly.get_feature().get_reconstruction_plate_id() if poly else None

    # Fracture zones, split by plate, near the ridge's latitude range only.
    fzs = []
    for line in read_gmt_lines(FZ_FILE):
        lats = [p[1] for p in line]
        lons = [p[0] for p in line]
        if max(lats) < -62 or min(lats) > 22 or max(lons) < -60 or min(lons) > 25:
            continue
        piece, piece_plate = [], None
        for lon, lat in line:
            pl = plate_of(lon, lat)
            if pl != piece_plate and piece:
                fzs.append((piece_plate, piece))
                piece = []
            piece_plate = pl
            piece.append((lon, lat))
        if piece:
            fzs.append((piece_plate, piece))
    fzs = [(pl, pts) for pl, pts in fzs if pl in (SA, AF) and len(pts) > 1 and length_km(pts) >= MIN_FZ_KM]
    print(f'fracture zones kept: {sum(p == SA for p, _ in fzs)} on South America, '
          f'{sum(p == AF for p, _ in fzs)} on Africa')

    # Seeds: midpoints of transform segments of the ridge.
    stage = rotation_model.get_rotation(10, SA, 0, AF)
    pole = stage.get_euler_pole_and_angle()[0].to_xyz()
    seeds = []
    for g in ridge:
        pts = [np.array(p.to_xyz()) for p in g.get_points()]
        for a, b in zip(pts[:-1], pts[1:]):
            seg_km = np.arccos(np.clip(a @ b, -1, 1)) * R_KM
            if seg_km < MIN_TRANSFORM_KM:
                continue
            mid = (a + b) / np.linalg.norm(a + b)
            along = np.cross(pole, mid)          # small-circle direction about the pole
            d = b - a
            d -= (d @ mid) * mid
            cosang = abs(d @ along) / (np.linalg.norm(d) * np.linalg.norm(along))
            if np.degrees(np.arccos(min(1, cosang))) <= TRANSFORM_TOLERANCE_DEG:
                seeds.append(pygplates.PointOnSphere(mid))
    print(f'transform seeds on the ridge: {len(seeds)}')

    # The model's own flowlines from each seed, to pair fracture zones with transforms.
    model_flow = {}
    for i, s in enumerate(seeds):
        feat = pygplates.Feature.create_flowline(s, FLOW_TIMES, valid_time=(max(FLOW_TIMES), 0),
                                                 left_plate=SA, right_plate=AF)
        rec = []
        pygplates.reconstruct(feat, rotation_model, rec, 0, anchor_plate_id=AF,
                              reconstruct_type=pygplates.ReconstructType.flowline)
        model_flow[i] = {SA: rec[0].get_left_flowline(), AF: rec[0].get_right_flowline()}

    fz_out, dists = [], []
    for pl, pts in fzs:
        best = None
        for i, fl in model_flow.items():
            d = np.mean([pygplates.GeometryOnSphere.distance(pygplates.PointOnSphere(lat, lon), fl[pl])
                         for lon, lat in pts]) * R_KM
            if best is None or d < best[0]:
                best = (d, i)
        if best and best[0] <= MAX_ASSIGN_KM:
            fz_out.append(dict(plate=pl, seed=best[1],
                               line=[[round(lon, 3), round(lat, 3)] for lon, lat in pts]))
            dists.append(best[0])
    record = {}
    for f in fz_out:
        record[f['seed']] = record.get(f['seed'], 0) + length_km(f['line'])
    fz_out = [f for f in fz_out if record[f['seed']] >= MIN_RECORD_KM]
    dists = None
    used = sorted({f['seed'] for f in fz_out})
    remap = {old: new for new, old in enumerate(used)}
    for f in fz_out:
        f['seed'] = remap[f['seed']]
    seeds = [seeds[i] for i in used]
    model_flow = {remap[i]: model_flow[i] for i in used}
    print(f'fracture zones kept: {len(fz_out)} ({sum(f["plate"] == SA for f in fz_out)} South America, '
          f'{sum(f["plate"] == AF for f in fz_out)} Africa) on {len(seeds)} major transforms')

    # Conjugate isochrons.
    isochrons = []
    for f in pygplates.FeatureCollection(ISOCHRONS):
        name = f.get_name() or ''
        pl = f.get_reconstruction_plate_id()
        if pl not in (SA, AF) or 'ATLANTIC' not in name or ('AFRICA' not in name or 'SOUTH AMERICA' not in name):
            continue
        m = re.search(r'ANOMALY (\w+)', name)
        age = float(f.get_valid_time()[0])
        if age > MAX_AGE:
            continue
        for g in f.get_geometries():
            pts = [(lon, lat) for lat, lon in g.to_lat_lon_list()]
            isochrons.append(dict(plate=pl, age=round(age, 1), chron=m.group(1) if m else '',
                                  line=[[round(lon, 3), round(lat, 3)] for lon, lat in pts]))
    chrons = sorted({(i['age'], i['chron']) for i in isochrons})
    print('isochrons:', ', '.join(f'{c} {a:g} Ma' for a, c in chrons))

    out = dict(source='Fracture zones: GSFML (Wessel et al. 2015), KM traces. Isochrons: Seton et '
                      'al. (2012). Ridge and plates: Muller et al. (2019) at 0 Ma.',
               plates=[SA, AF], fractureZones=fz_out, isochrons=isochrons,
               seeds=[[round(s.to_lat_lon()[1], 3), round(s.to_lat_lon()[0], 3)] for s in seeds],
               ridge=[[[round(lon, 3), round(lat, 3)] for lat, lon in g.to_lat_lon_list()] for g in ridge])
    path = os.path.join(REPO, 'data', 'satlantic.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'wrote {os.path.relpath(path, REPO)} ({os.path.getsize(path) / 1e3:.0f} kB)')

    if args.figure:
        figure(out, model_flow, args.figure)


def figure(out, model_flow, path):
    import pygmt
    fig = pygmt.Figure()
    pygmt.config(FONT_TITLE='12p')
    fig.coast(region=[-60, 25, -62, 22], projection='M14c', land='gray85', water='white',
              frame=['af', '+tFracture zones (black), Muller 2019 flowlines (red), isochrons by age'])
    pygmt.makecpt(cmap='magma', series=[0, 130], reverse=True, truncate=[0, 0.8])
    for iso in out['isochrons']:
        x, y = zip(*iso['line'])
        fig.plot(x=x, y=y, pen='1p,+z', zvalue=iso['age'], cmap=True)
    for f in out['fractureZones']:
        x, y = zip(*f['line'])
        fig.plot(x=x, y=y, pen='1.4p,black')
    for i, fl in model_flow.items():
        for side in fl.values():
            pts = side.to_lat_lon_list()
            fig.plot(x=[p[1] for p in pts], y=[p[0] for p in pts], pen='0.6p,red')
    for g in out['ridge']:
        x, y = zip(*g)
        fig.plot(x=x, y=y, pen='1.6p,blue')
    x, y = zip(*out['seeds'])
    fig.plot(x=x, y=y, style='c0.12c', fill='blue')
    fig.colorbar(cmap=True, frame='af+lIsochron age (Ma)')
    fig.savefig(path)
    print('wrote', path)


if __name__ == '__main__':
    main()
