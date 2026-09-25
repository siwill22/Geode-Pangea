"""
Build data/hotspots.json: fixed hotspot positions and dated trail samples for the
"Plates over plumes" chapters.

    conda run -n pygmt17 python prep/build_hotspots.py

Sources, both from the optAPM project (Tetley et al. 2019):

- ~/GIT/optAPM/data/HotspotCatalogue2.geojson gives present-day hotspot positions.
- ~/GIT/optAPM/data/HotspotTrails.geojson gives dated volcanic samples along each
  chain, with the plate id each sample sits on.

The chains are chosen, not all taken. Each one needs a hotspot position in the
catalogue, samples on plates the chapters show, and ages within the chapter range.
Hawaii and Louisville appear in the trails file twice, from Wessel and from Doubrovine
et al. (2012). The Doubrovine versions are used, the same compilation as Tristan,
Reunion and New England.

Canary is left out: its samples here (0-142 Ma) cluster round the present hotspot rather
than running away from it, and fit better with no plate motion at all (308 km mean)
than with the model's (1404 km), so it would teach nothing about plate motion.

The trail maths is checked against the plate model here too. For a sample of age a on
plate P, the point of P that sat over the hotspot h at time a has present-day position
R_P(a)^-1 h, where R_P(a) is P's rotation (relative to plate 000, the model's absolute
frame) at a. The distance from the sample to that point is the misfit. With the model's
own rotations, it should be modest for a hotspot-based frame. The viewer computes exactly
the same quantity from the student's rotations.
"""
import glob
import json
import os

import numpy as np
import pygplates

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
EARTH_RADIUS_KM = 6371.0
OPTAPM = os.path.expanduser('~/GIT/optAPM/data')
MODEL_ROOT = os.path.expanduser(
    '~/Library/Caches/gprm/Muller2019/Muller_etal_2019_PlateMotionModel_v2.0_Tectonics')
MAX_AGE = 150.0

# trail-file Chain -> catalogue NAME, and the display name.
CHAINS = {
    'Tristan':        ('Tristan', 'Tristan'),
    'Reunion':        ('Reunion', 'Réunion'),
    'Kerguelen':      ('Kerguelen', 'Kerguelen'),
    'St_Helena':      ('St_Helena', 'St Helena'),
    'New_England':    ('New_England', 'New England'),
    'Tasmantid':      ('Tasmantid', 'Tasmantid'),
    'DoubHawaii':     ('Hawaii', 'Hawaii'),
    'DoubLouisville': ('Louisville', 'Louisville'),
}


def main():
    catalogue = {f['properties']['NAME']: f['properties']
                 for f in json.load(open(os.path.join(OPTAPM, 'HotspotCatalogue2.geojson')))['features']}
    trails = json.load(open(os.path.join(OPTAPM, 'HotspotTrails.geojson')))['features']
    rotation_model = pygplates.RotationModel(sorted(glob.glob(os.path.join(MODEL_ROOT, '*.rot'))))

    out = []
    print(f'{"chain":12s} {"n":>3s}  {"ages":>11s}  {"plates":22s} model misfit mean/max km')
    for chain, (hotspot, label) in CHAINS.items():
        h = catalogue[hotspot]
        hp = pygplates.PointOnSphere(h['Lat'], h['Long'])
        samples = []
        for f in trails:
            p = f['properties']
            if p['Chain'] != chain or p['Age'] is None or p['Age'] > MAX_AGE:
                continue
            lon, lat = f['geometry']['coordinates'][:2]
            samples.append(dict(lon=round(lon, 3), lat=round(lat, 3), age=round(p['Age'], 2),
                                plate=int(p['PLATEID1'])))
        samples.sort(key=lambda s: s['age'])

        misfit = []
        for s in samples:
            rot = rotation_model.get_rotation(s['age'], s['plate'], anchor_plate_id=0)
            predicted = rot.get_inverse() * hp
            d = pygplates.GeometryOnSphere.distance(predicted, pygplates.PointOnSphere(s['lat'], s['lon']))
            misfit.append(d * EARTH_RADIUS_KM)
        plates = sorted({s['plate'] for s in samples})
        ages = [s['age'] for s in samples]
        print(f'{label:12s} {len(samples):3d}  {min(ages):5.1f}-{max(ages):5.1f}  {str(plates):22s} '
              f'{np.mean(misfit):6.0f} / {np.max(misfit):6.0f}')
        out.append(dict(name=label, lon=h['Long'], lat=h['Lat'], samples=samples,
                        modelMisfitKm=round(float(np.mean(misfit)))))

    path = os.path.join(REPO, 'data', 'hotspots.json')
    with open(path, 'w') as f:
        json.dump(dict(source='optAPM (Tetley et al. 2019): HotspotCatalogue2 and HotspotTrails; '
                              'Hawaii and Louisville samples from Doubrovine et al. (2012)',
                       maxAge=MAX_AGE, hotspots=out), f, separators=(',', ':'))
    print('wrote', os.path.relpath(path, REPO))


if __name__ == '__main__':
    main()
