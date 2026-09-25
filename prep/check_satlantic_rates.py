"""
Spreading rates on the page against Muller et al. (2019), independently.

    conda run -n pygmt17 python prep/check_satlantic_rates.py keys  OUT   # writes OUT/muller_keys.json
    (test/check_satlantic_rates.cjs OUT loads those keys and writes OUT/page_rates.json)
    conda run -n pygmt17 python prep/check_satlantic_rates.py check OUT

'keys': Muller 2019's South America (201) rotation relative to Africa (701) at the nine
isochron ages, as the student's fitted stages.

'check': for each of the page's four seeds and each stage, the full spreading rate from
the stage rotation directly: stage angle / dt * sin(distance from the stage pole to the
ridge point) * R. The ridge point is the seed carried back to the stage's mid age on
Africa's flank by half the relative rotation -- the page instead sums flowline arc
lengths, so the two agree only as well as that midpoint stands in for the arc.
"""
import glob
import json
import os
import sys

import numpy as np
import pygplates

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MODEL = os.path.expanduser('~/Library/Caches/gprm/Muller2019/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics')
SA, AF, R = 201, 701, 6371.0
mode, out = sys.argv[1], sys.argv[2]
model = pygplates.RotationModel(glob.glob(os.path.join(MODEL, '*.rot')))
data = json.load(open(os.path.join(REPO, 'data', 'satlantic.json')))
ages = sorted({i['age'] for i in data['isochrons'] if i['age'] <= 121.4})

if mode == 'keys':
    rows = []
    for a in ages:
        lat, lon, ang = model.get_rotation(a, SA, 0, AF).get_lat_lon_euler_pole_and_angle_degrees()
        rows.append([a, lon, lat, ang])
    json.dump(rows, open(os.path.join(out, 'muller_keys.json'), 'w'))
    print('wrote', len(rows), 'stages:', ', '.join(f'{a:g}' for a in ages))
    sys.exit()

page = json.load(open(os.path.join(out, 'page_rates.json')))
stages = [0.0] + ages
print('seed   stage (Ma)       page  pygplates  mm/yr')
worst = 0
for label, seed, steps in zip(page['labels'], page['seeds'], page['rates']):
    # Muller's own flowline for this seed, sampled at the stage ages: the Africa-side
    # points are where the ridge was at each age (Africa held fixed).
    feat = pygplates.Feature.create_flowline(pygplates.PointOnSphere(seed[1], seed[0]), stages,
                                             valid_time=(stages[-1], 0), left_plate=SA, right_plate=AF)
    rec = []
    pygplates.reconstruct(feat, model, rec, 0, anchor_plate_id=AF, reconstruct_type=pygplates.ReconstructType.flowline)
    ridge = [np.array(p.to_xyz()) for p in rec[0].get_right_flowline().get_points()]
    for k, (t0, t1) in enumerate(zip(stages[:-1], stages[1:])):
        # South America's motion over the stage, in Africa's frame.
        stage = model.get_rotation(t0, SA, 0, AF) * model.get_rotation(t1, SA, 0, AF).get_inverse()
        pole, ang = stage.get_euler_pole_and_angle()
        mid = ridge[k] + ridge[k + 1]
        d = np.arccos(np.clip(np.array(pole.to_xyz()) @ (mid / np.linalg.norm(mid)), -1, 1))
        want = abs(ang) / (t1 - t0) * np.sin(d) * R   # the sign is only the sense of turn
        got = np.mean([s['rate'] for s in steps if s['from'] >= t0 - 1e-9 and s['to'] <= t1 + 1e-9])
        worst = max(worst, abs(got - want) / want)
        print(f'{label:5s} {t0:6.1f}-{t1:6.1f}   {got:7.1f}   {want:7.1f}')
print(f'worst relative difference {100 * worst:.1f}%')
