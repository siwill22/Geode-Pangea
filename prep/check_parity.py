"""
Check the viewer's rotations against pygplates.

test/check_drag.cjs drags some plates in a real browser, then writes the rotation file the
page exports (drag.rot) and every plate's rotated vertices as the page drew them
(rotated.json). This reconstructs data/plates.geojson with pygplates from that rotation
file alone, and reports the largest angular distance between the two -- which should be
rounding error, since both apply the same finite rotation to the same vertices.

It also draws both, overlaid, with PyGMT, so the agreement can be checked by eye.

    conda run -n pygmt17 python prep/check_parity.py <dir written by check_drag.cjs>
"""
import json
import os
import sys

import numpy as np
import pygplates
import pygmt

AGE = 100.0
out_dir = sys.argv[1]
here = os.path.dirname(__file__)

rotation_model = pygplates.RotationModel(os.path.join(out_dir, 'drag.rot'))
page = {p['id']: np.array(p['xyz']).reshape(-1, 3) for p in
        json.load(open(os.path.join(out_dir, 'rotated.json')))}
features = json.load(open(os.path.join(here, '..', 'data', 'plates.geojson')))['features']

fig = pygmt.Figure()
fig.coast(region='g', projection='G20/10/15c', frame='g30', land='gray95', water='white',
          shorelines='0.2p,gray70')
worst = 0.0
for f in features:
    pid, name = f['properties']['plateId'], f['properties']['name']
    rot = rotation_model.get_rotation(AGE, pid, anchor_plate_id=0)
    ring = f['geometry']['coordinates'][0]
    ours = []
    for lon, lat in ring:
        p = rot * pygplates.PointOnSphere(lat, lon)
        ours.append(p.to_xyz())
    ours = np.array(ours)

    # The page may have reversed a ring to wind it counter-clockwise. Rings are closed
    # (first vertex repeated), so a reversed ring still STARTS at the same vertex; compare
    # in both orders and keep whichever matches.
    def max_err(a, b):
        return np.degrees(np.arccos(np.clip(np.sum(a * b, axis=1), -1, 1))).max()
    theirs = min((page[pid], page[pid][::-1]), key=lambda t: max_err(ours, t))
    err = max_err(ours, theirs)
    worst = max(worst, err)
    pole_lat, pole_lon, angle = rot.get_lat_lon_euler_pole_and_angle_degrees()
    print(f'{name:14s} pole ({pole_lat:7.2f}, {pole_lon:8.2f}) angle {angle:7.2f}  '
          f'max vertex difference {err:.2e} deg')

    ll_ours = np.array([pygplates.PointOnSphere(*v).to_lat_lon() for v in ours])
    ll_page = np.array([pygplates.PointOnSphere(*v / np.linalg.norm(v)).to_lat_lon()
                        for v in theirs])
    fig.plot(x=ll_page[:, 1], y=ll_page[:, 0], pen='2.5p,orange')
    fig.plot(x=ll_ours[:, 1], y=ll_ours[:, 0], pen='0.6p,black')

fig.text(position='BC', text='orange: page (browser)   black: pygplates from exported .rot',
         offset='0/-0.6c', no_clip=True, font='9p')
png = os.path.join(out_dir, 'parity.png')
fig.savefig(png)
print(f'worst vertex difference: {worst:.2e} deg -> {png}')
sys.exit(0 if worst < 1e-3 else 1)
