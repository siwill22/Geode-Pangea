"""
Build data/hotspot_features.json: volcanic features from the Johansson et al. (2018) large
igneous and volcanic provinces database that are clearly part of a hotspot trail, drawn
as filled polygons in the "Plates over plumes" chapter.

    conda run -n pygmt17 python prep/build_hotspot_features.py [--figure out.png]

Selection is by the feature's own name or description (many features have an empty name
and carry it in the description, e.g. "2000 METERS REUNION ISLAND"), matched per hotspot
below, and only features on plates that move with Africa. Each feature keeps its
begin age from the database, so the page can show it faint before it formed.

What the database gives, for the chapter's five hotspots:

- Tristan: Tristan da Cunha and Gough seamounts, Walvis Ridge and seamounts near it.
- Reunion: Reunion, Mauritius, Rodrigues, and the "Seychells LIP" pieces of the Mascarene
  Plateau dated by Duncan and Hargraves (1990). These are on plate 704 (Seychelles),
  which Muller 2019 fixes to Somalia (709) from 64 Ma; none is older than 65 Ma.
- Canary: the Canary Islands (on 714, Northwest Africa, fixed to 701 since 120 Ma).
- St Helena: nothing in the database.
- Azores: only on plates 304 (Iberia) and 101 (North America), so not on Africa.

Left out although on Africa: Great Meteor, Cruiser, Plato and Atlantis seamounts (Great
Meteor hotspot), Madeira Rise, Discovery seamounts, Cape Verde, Sierra Leone Rise,
Agulhas and Mozambique ridges, and the continental flood basalts.
"""
import argparse
import json
import os
import re

import pygplates

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LIPS = os.path.expanduser(
    '~/Library/Caches/gprm/LIPs/LargeIgneousProvinces_VolcanicProvinces/'
    'Johansson_etal_2018_VolcanicProvinces/Johansson_etal_2018_VolcanicProvinces_v2.gpmlz')

# hotspot -> pattern on "name | description"
HOTSPOTS = {
    'Tristan': r'TRISTAN DA CUNHA|WALVIS RIDGE',
    'Réunion': r'REUNION ISLAND|MAURITIUS ISLAND|RODRIGUEZ|Seychells LIP',
    'Canary': r'CANARY ISLANDS',
}
# Plates that move with Africa over the features' ages, and the plate each is drawn on.
PLATE = {701: 701, 714: 714, 709: 709, 704: 709}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--figure')
    args = ap.parse_args()

    out = []
    for f in pygplates.FeatureCollection(LIPS):
        text = f'{f.get_name() or ""} | {f.get_description() or ""}'
        hotspot = next((h for h, pat in HOTSPOTS.items() if re.search(pat, text)), None)
        plate = f.get_reconstruction_plate_id()
        if hotspot is None or plate not in PLATE:
            continue
        for g in f.get_geometries():
            if not isinstance(g, pygplates.PolygonOnSphere) or g.get_area() == 0:
                continue
            # Exterior ring only, anticlockwise (interior on the left) seen from outside.
            ring = [p.to_lat_lon() for p in g.get_exterior_ring_points()]
            if g.get_orientation() == pygplates.PolygonOnSphere.Orientation.clockwise:
                ring.reverse()
            out.append(dict(hotspot=hotspot, name=(f.get_name() or f.get_description()).strip(),
                            age=round(f.get_valid_time()[0], 1), plate=PLATE[plate],
                            ring=[[round(lon, 3), round(lat, 3)] for lat, lon in ring]))

    for h in HOTSPOTS:
        mine = [o for o in out if o['hotspot'] == h]
        area_note = sorted({o['name'] for o in mine})
        print(f'{h:8s} {len(mine):3d} polygons, ages {min(o["age"] for o in mine)}-'
              f'{max(o["age"] for o in mine)} Ma: {area_note}')
    path = os.path.join(REPO, 'data', 'hotspot_features.json')
    with open(path, 'w') as fh:
        json.dump(dict(source='Johansson et al. (2018) large igneous and volcanic provinces, v2',
                       features=out), fh, separators=(',', ':'))
    print(f'wrote {os.path.relpath(path, REPO)} ({os.path.getsize(path) / 1e3:.0f} kB)')
    if args.figure:
        figure(out, args.figure)


def figure(out, path):
    import pygmt
    hs = {h['name']: h for h in json.load(open(os.path.join(REPO, 'data', 'hotspots.json')))['hotspots']}
    colours = {'Tristan': 'orange', 'Réunion': 'purple', 'Canary': 'darkgreen'}
    fig = pygmt.Figure()
    fig.coast(region=[-40, 75, -50, 42], projection='M16c', land='gray80', water='white',
              frame=['af', '+tJohansson 2018 features kept, by hotspot'])
    for o in out:
        x, y = zip(*(o['ring'] + o['ring'][:1]))
        fig.plot(x=x, y=y, fill=colours[o['hotspot']], pen='0.2p,black', close=True)
    for name in ('Tristan', 'St Helena', 'Réunion', 'Canary', 'Azores'):
        h = hs[name]
        fig.plot(x=h['lon'], y=h['lat'], style='c0.35c', pen='1.5p,red')
        if h['samples']:
            fig.plot(x=[s['lon'] for s in h['samples']], y=[s['lat'] for s in h['samples']],
                     style='s0.12c', fill='black')
    fig.savefig(path)
    print('wrote', path)


if __name__ == '__main__':
    main()
