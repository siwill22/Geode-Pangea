"""
Check the "Plates over plumes" chapter against pygplates, from the exported file alone.

test/check_plumes.cjs writes the page's hierarchical rotation file (anchor to 000, every
other plate to the anchor), the vertices the page drew at the reconstruction age and at
a mid age, and the page's hotspot misfit. This script loads the same file into pygplates
and checks:

- vertices at both ages. At the mid age this tests that the page interpolates the
  hierarchy the way GPlates does: each line of the file slerped separately, then composed.
- the misfit per hotspot: the distance from each sample to R_P(age)^-1 h, with pygplates
  doing the rotation.

    conda run -n pygmt17 python prep/check_plumes_parity.py <dir written by check_plumes.cjs>
"""
import json
import os
import sys

import numpy as np
import pygplates

out_dir = sys.argv[1]
d = json.load(open(os.path.join(out_dir, 'plumes.json')))
model = pygplates.RotationModel(os.path.join(out_dir, 'plumes.rot'))
R = 6371.0
failed = False

for label, age, plates in (('reconstruction age', d['recon'], d['atRecon']),
                           ('mid age', d['mid'], d['atMid'])):
    worst = 0.0
    for p in plates:
        rot = model.get_rotation(float(age), p['id'], anchor_plate_id=0)
        home = np.array(p['home']).reshape(-1, 3)
        page = np.array(p['xyz']).reshape(-1, 3)
        # Only live rings are rotated by the page (an oceanic plate hides seafloor that did
        # not yet exist), so compare those.
        idx = np.concatenate([np.arange(o, o + n) for (o, n), live in zip(p['rings'], p['live']) if live]
                             or [np.array([], int)])
        if not len(idx):
            continue
        ours = np.array([(rot * pygplates.PointOnSphere(*v)).to_xyz() for v in home[idx]])
        err = np.degrees(np.arccos(np.clip(np.sum(ours * page[idx], axis=1), -1, 1))).max()
        worst = max(worst, err)
    print(f'{label} ({age:g} Ma): worst vertex difference {worst:.2e} deg')
    failed |= worst > 1e-3

print('misfit, page vs pygplates (km):')
page_misfit = {r['name']: r['km'] for r in d['misfit']['per']}
for hs in d['samples']:
    h = pygplates.PointOnSphere(*hs['h'])
    dist = []
    for s in hs['samples']:
        rot = model.get_rotation(float(s['age']), s['plate'], anchor_plate_id=0)
        dist.append(pygplates.GeometryOnSphere.distance(rot.get_inverse() * h,
                                                        pygplates.PointOnSphere(*s['v'])) * R)
    ours = float(np.mean(dist))
    diff = abs(ours - page_misfit[hs['name']])
    print(f'  {hs["name"]:12s} page {page_misfit[hs["name"]]:8.1f}  pygplates {ours:8.1f}  diff {diff:.2f}')
    failed |= diff > 1.0
sys.exit(1 if failed else 0)
