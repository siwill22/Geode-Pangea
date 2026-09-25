"""
Check "Opening the South Atlantic" against pygplates, from the exported file alone.

test/check_satlantic.cjs writes the page's .rot, its flowlines (present-day positions of
both branches, 1 Myr steps, for every seed) and its misfit rows. Here pygplates builds
its own flowline features from the same seeds (South America left, Africa right) with
the same file, and computes the same misfit rows from the data file:

- flowlines: GPlates' half-stage construction against the page's half-rotation one;
- fracture zones: mean distance from each vertex to its own flowline branch;
- isochrons: South America's isochron of each age rotated back by the relative rotation
  at that age, mean distance to Africa's conjugate.

    conda run -n pygmt17 python prep/check_satlantic_parity.py [dir]
"""
import json
import os
import sys

import numpy as np
import pygplates

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, 'test', 'out-satlantic')
d = json.load(open(os.path.join(out_dir, 'satlantic.json')))
data = json.load(open(os.path.join(REPO, 'data', 'satlantic.json')))
model = pygplates.RotationModel(os.path.join(out_dir, 'satlantic.rot'))
SA, AF, R = 201, 701, 6371.0
T = float(d['recon'])
times = [float(t) for t in d['flowAges']]
failed = False


def pt(lonlat):
    return pygplates.PointOnSphere(lonlat[1], lonlat[0])


# Flowlines.
worst = 0.0
flow = []
for seed, page in zip(d['seeds'], d['flow']):
    feat = pygplates.Feature.create_flowline(pt(seed), times, valid_time=(T, 0), left_plate=SA, right_plate=AF)
    rec = []
    pygplates.reconstruct(feat, model, rec, 0, anchor_plate_id=AF, reconstruct_type=pygplates.ReconstructType.flowline)
    left, right = rec[0].get_left_flowline(), rec[0].get_right_flowline()
    flow.append({SA: left, AF: right})
    for plate, line in ((SA, left), (AF, right)):
        ours = [p.to_lat_lon() for p in line.get_points()]
        theirs = page[str(plate)]
        assert len(ours) == len(theirs) == len(times), (len(ours), len(theirs), len(times))
        # pygplates lists the flowline from the seed outwards, like the page.
        # Dot products, not GeometryOnSphere.distance: that rounds anything within its
        # own epsilon to exactly 0, which would hide a small real difference.
        for (la, lo), (plo, pla) in zip(ours, theirs):
            a = np.array(pygplates.PointOnSphere(la, lo).to_xyz())
            b = np.array(pygplates.PointOnSphere(pla, plo).to_xyz())
            worst = max(worst, np.degrees(np.arccos(np.clip(a @ b, -1, 1))))
print(f'flowlines: {len(flow)} seeds, worst point difference {worst:.2e} deg')
failed |= worst > 1e-3

# Misfit rows.
page_rows = {r['name']: r['km'] for r in d['misfit']}
dist = []
for fz in data['fractureZones']:
    line = flow[fz['seed']][fz['plate']]
    dist += [pygplates.GeometryOnSphere.distance(pt(v), line) * R for v in fz['line']]
ours = float(np.mean(dist))
print(f'fracture zones: page {page_rows["Fracture zones"]:.2f} km, pygplates {ours:.2f} km')
failed |= abs(ours - page_rows['Fracture zones']) > 1.0

chrons = {}
for iso in data['isochrons']:
    if iso['age'] > T + 1:
        continue
    chrons.setdefault(iso['chron'], {'age': iso['age'], SA: [], AF: []})[iso['plate']].append(
        pygplates.PolylineOnSphere([(la, lo) for lo, la in iso['line']]))
for chron, c in sorted(chrons.items(), key=lambda kv: kv[1]['age']):
    if not c[SA] or not c[AF]:
        continue
    rot = model.get_rotation(c['age'], SA, 0, AF)
    ds = []
    for line in c[SA]:
        for p in line.get_points():
            q = rot * p
            ds.append(min(pygplates.GeometryOnSphere.distance(q, l) for l in c[AF]) * R)
    name = f"{'C' if chron[0].isdigit() else ''}{chron} ({round(c['age'])} Ma)"
    diff = abs(np.mean(ds) - page_rows[name])
    print(f'  {name:14s} page {page_rows[name]:8.2f}  pygplates {np.mean(ds):8.2f}  diff {diff:.2f}')
    failed |= diff > 1.0
sys.exit(1 if failed else 0)
