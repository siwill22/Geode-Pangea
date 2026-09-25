"""
Check the viewer's rotations against pygplates.

test/check_drag.cjs drags some plates in a real browser, then writes two files:

- `drag.rot`: the rotation file the page exports.
- `rotated.json`: each plate's present-day vertices and the rotated vertices the page
  drew.

This script rotates the same present-day vertices with pygplates, using only that
rotation file, and reports the largest angular difference. Both apply the same finite
rotation to the same points, so the difference should be rounding error. It also draws
both, overlaid, with PyGMT, so the agreement can be checked by eye.

    conda run -n pygmt17 python prep/check_parity.py <dir written by check_drag.cjs>
"""
import json
import os
import sys

import numpy as np
import pygplates
import pygmt

out_dir = sys.argv[1]
rot_text = open(os.path.join(out_dir, 'drag.rot')).read()
age = float(rot_text.splitlines()[1].split()[1])
rotation_model = pygplates.RotationModel(os.path.join(out_dir, 'drag.rot'))
plates = json.load(open(os.path.join(out_dir, 'rotated.json')))

fig = pygmt.Figure()
fig.coast(region='g', projection='G20/10/15c', frame='g30', land='gray95', water='white',
          shorelines='0.2p,gray70')
worst = 0.0
for p in plates:
    home = np.array(p['home']).reshape(-1, 3)
    page = np.array(p['xyz']).reshape(-1, 3)
    rot = rotation_model.get_rotation(age, p['id'], anchor_plate_id=0)
    ours = np.array([(rot * pygplates.PointOnSphere(*v)).to_xyz() for v in home])
    err = np.degrees(np.arccos(np.clip(np.sum(ours * page, axis=1), -1, 1))).max()
    worst = max(worst, err)
    lat, lon, ang = rot.get_lat_lon_euler_pole_and_angle_degrees()
    print(f'{p["name"]:14s} {p["id"]:4d} pole ({lat:7.2f}, {lon:8.2f}) angle {ang:7.2f}  '
          f'max vertex difference {err:.2e} deg')
    for pts, pen in ((page, '2.5p,orange'), (ours, '0.6p,black')):
        lat_ = np.degrees(np.arcsin(np.clip(pts[:, 2], -1, 1)))
        lon_ = np.degrees(np.arctan2(pts[:, 1], pts[:, 0]))
        fig.plot(x=lon_, y=lat_, style='c0.03c', fill=pen.split(',')[1])

fig.text(position='BC', text='orange: page (browser)   black: pygplates from exported .rot',
         offset='0/-0.6c', no_clip=True, font='9p')
png = os.path.join(out_dir, 'parity.png')
fig.savefig(png)
print(f'worst vertex difference: {worst:.2e} deg -> {png}')
sys.exit(0 if worst < 1e-3 else 1)
