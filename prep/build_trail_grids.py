"""
Residual topography and interpolated ages along four African hotspot chains, after
Maher et al. (2015, GJI 201, 1743-1764), Figs 3 and 4.

    conda run -n pygmt17 python prep/build_trail_grids.py --figure out.png

Fig. 3, residual topography (paper section 5.1):
- relief: GMT earth_relief_10m (the paper used ETOPO2);
- background: a 700 km diameter spatial median filter (grdfilter, great-circle
  distances), subtracted from the relief;
- cut-off: residual above 700 m.
- The paper then keeps only what lies inside a hand-drawn envelope per chain. Those
  envelopes are not published as data, so here the envelope is a corridor: cells
  within CORRIDOR_KM (great-circle) of the line through the hotspot and the chain's dated
  samples in age order. This is the main departure from the paper, and the figure is
  there to compare the result with its Fig. 3.

Fig. 4, ages (paper section 5.2): the paper splines the sample ages over each chain.
Here each chain's ages (Table 2, plus age 0 at the hotspot, Table 3) are gridded
with GMT surface (tension 0.5) over the chain's lon-lat box and read at the kept cells,
clipped to the chain's age range. surface works on the lon-lat plane, not the sphere;
over boxes this size (at most about 30 degrees, at low latitude) that distortion is small
next to the spread of the samples, and the result only colours the page.

Reunion follows the paper's model A inset: the Mascarene Plateau ODP and well ages on
Africa, without the Chagos-Laccadive sample rotated from India.
"""
import argparse
import json
import os

import numpy as np
import pygmt
import xarray as xr

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
RELIEF = os.path.expanduser('~/GIT/raster-reconstruction/earth_relief_10m.nc')
REGION = [-45, 85, -60, 50]           # Africa and its oceans, with room for the filter
FILTER_KM = 700
CUTOFF_M = 700
CORRIDOR_KM = {'Tristan': 250, 'St Helena': 300, 'Canary': 200, 'Réunion': 200}
R_KM = 6371.0

# Maher et al. (2015) Table 3: hotspot positions used for the fit (lon, lat).
HOTSPOTS = {'Réunion': (54.7, -21.5), 'Tristan': (-12, -38.5),
            'St Helena': (-8.5, -16), 'Canary': (-17.25, 28)}

# Maher et al. (2015) Table 2: lon, lat, age (Ma). Reunion without ODP 115-713 (rotated
# from the India plate for model A) and without the Chagos-Laccadive Ridge.
SAMPLES = {
    'Réunion': [(55.71, -21.24, 2.1), (57.47, -20.4, 7.5), (60.3, -15.0, 31.5),
                (60.0, -9.5, 47.5), (61.37, -13.11, 32.9), (59.02, -7.55, 64.1)],
    'Tristan': [(9.33, -19.37, 114.1), (9.33, -19.37, 108.3), (9.02, -19.85, 112.8),
                (9.02, -19.85, 112.4), (9.02, -19.85, 112.6), (2.99, -29.07, 71.3),
                (2.99, -29.07, 72.0), (2.32, -28.53, 66.9), (-5.03, -34.29, 36.1),
                (-4.98, -34.35, 33.4), (-7.73, -36.42, 27.0), (2.55, -32.79, 47.0),
                (0.55, -34.93, 45.6), (-1.57, -34.34, 49.4), (-2.43, -37.48, 37.1),
                (-2.43, -37.48, 36.9), (-7.78, -37.1, 28.4), (-7.78, -37.1, 30.8),
                (-3.63, -34.5, 38.0), (-3.48, -34.5, 35.6), (-0.02, -32.97, 62.0),
                (1.12, -32.63, 50.0), (2.39, -31.99, 60.2), (2.39, -31.99, 59.9),
                (2.32, -28.53, 79.1), (-12.28, -37.12, 0.64), (-8.55, -40.17, 8.1),
                (-6.22, -39.47, 18.7)],
    'St Helena': [(4.77, -2.32, 80.2), (4.47, -4.28, 77.5), (1.55, -8.42, 52.3),
                  (4.77, -2.32, 79.0), (4.77, -2.32, 80.1), (-8.35, -15.14, 10.3),
                  (-8.52, -16.2, 7.5), (-9.01, -16.27, 2.6), (-7.1, -15.6, 15.3),
                  (-7.1, -15.6, 15.1), (-7.1, -15.6, 14.9), (-7.1, -15.6, 14.2),
                  (-6.95, -15.8, 14.5), (-7.01, -15.64, 15.1), (-6.56, -15.38, 17.9),
                  (-6.49, -15.41, 18.0), (-6.47, -15.42, 18.8), (-6.46, -15.44, 18.9)],
    'Canary': [(-12.66, 29.82, 16.8), (-12.66, 29.82, 18.1), (-13.29, 32.8, 68.2),
               (-16.61, 28.27, 11.29), (-18.0, 27.75, 1.12), (-17.87, 28.67, 2.0),
               (-17.13, 28.1, 15.5), (-15.6, 27.97, 14.64), (-14.02, 28.33, 20.4),
               (-13.63, 29.04, 15.5)],
}


def xyz(lon, lat):
    lon, lat = np.radians(lon), np.radians(lat)
    return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], -1)


def distance_to_polyline_km(points, line):
    """Great-circle distance from each point (N,3) to a polyline of unit vectors (M,3)."""
    best = np.full(len(points), np.inf)
    for a, b in zip(line[:-1], line[1:]):
        n = np.cross(a, b)
        norm = np.linalg.norm(n)
        # Endpoint distances always count; the arc interior only where the foot of the
        # perpendicular falls between a and b.
        d = np.minimum(np.arccos(np.clip(points @ a, -1, 1)), np.arccos(np.clip(points @ b, -1, 1)))
        if norm > 1e-12:
            n = n / norm
            foot = points - np.outer(points @ n, n)
            foot /= np.linalg.norm(foot, axis=1, keepdims=True)
            inside = (np.cross(a, foot) @ n >= 0) & (np.cross(foot, b) @ n >= 0)
            perp = np.abs(np.arcsin(np.clip(points @ n, -1, 1)))
            d = np.where(inside, np.minimum(d, perp), d)
        best = np.minimum(best, d)
    return best * R_KM


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--figure')
    args = ap.parse_args()

    relief = pygmt.grdcut(RELIEF, region=REGION)
    background = pygmt.grdfilter(relief, filter=f'm{FILTER_KM}', distance='4')
    residual = relief - background
    lon, lat = np.meshgrid(residual.lon.values, residual.lat.values)
    keep = residual.values > CUTOFF_M
    pts = xyz(lon[keep], lat[keep])
    res = residual.values[keep]
    z = relief.values[keep]

    cells = []
    for name, samples in SAMPLES.items():
        hs = HOTSPOTS[name]
        ordered = sorted(samples, key=lambda s: s[2])
        line = xyz(np.array([hs[0]] + [s[0] for s in ordered]),
                   np.array([hs[1]] + [s[1] for s in ordered]))
        near = distance_to_polyline_km(pts, line) <= CORRIDOR_KM[name]
        # Ages: surface over the chain's box, hotspot at age 0.
        data = np.array([(hs[0], hs[1], 0.0)] + samples)
        lo, la = lon[keep][near], lat[keep][near]
        box = [np.floor(min(lo.min(), data[:, 0].min())) - 1, np.ceil(max(lo.max(), data[:, 0].max())) + 1,
               np.floor(min(la.min(), data[:, 1].min())) - 1, np.ceil(max(la.max(), data[:, 1].max())) + 1]
        mean = pygmt.blockmean(data=data, region=box, spacing='10m')
        grid = pygmt.surface(data=mean, region=box, spacing='10m', tension=0.5)
        age = grid.interp(lon=xr.DataArray(lo), lat=xr.DataArray(la)).values
        age = np.clip(age, 0, data[:, 2].max())
        for x, y, r, a, h in zip(lo, la, res[near], age, z[near]):
            cells.append(dict(hotspot=name, lon=round(float(x), 3), lat=round(float(y), 3),
                              residual=int(round(float(r))), age=round(float(a), 1),
                              land=bool(h > 0)))
        print(f'{name:9s} {near.sum():5d} cells, ages 0-{data[:, 2].max():.0f} Ma')

    path = os.path.join(REPO, 'data', 'trail_grids.json')
    with open(path, 'w') as f:
        json.dump(dict(source='After Maher et al. (2015) Figs 3-4: earth_relief_10m minus a '
                              f'{FILTER_KM} km median, > {CUTOFF_M} m, within a corridor of '
                              'each chain; ages from their Table 2',
                       cellDeg=1 / 6, cells=cells), f, separators=(',', ':'))
    print(f'wrote {os.path.relpath(path, REPO)} ({os.path.getsize(path) / 1e3:.0f} kB)')
    if args.figure:
        figure(residual, cells, args.figure)


def figure(residual, cells, out):
    """Two panels like the paper: residual elevation (Fig. 3) and age (Fig. 4)."""
    x = [c['lon'] for c in cells]
    y = [c['lat'] for c in cells]
    fig = pygmt.Figure()
    proj = 'M11c'
    reg = [-30, 75, -50, 42]
    for panel, (key, cmap, series, label) in enumerate([
            ('residual', 'turbo', [700, 4000], 'Residual elevation of hotspot chains (m)'),
            ('age', 'turbo', [0, 120], 'Interpolated age (Ma)')]):
        if panel:
            fig.shift_origin(xshift='12.5c')
        fig.coast(region=reg, projection=proj, land='brown', water='gray85',
                  frame=['af', f'+t{"Fig. 3" if not panel else "Fig. 4"} after Maher et al. 2015'])
        pygmt.makecpt(cmap=cmap, series=series)
        fig.plot(x=x, y=y, style='s0.07c', fill=[c[key] for c in cells], cmap=True)
        if panel:
            for name, s in SAMPLES.items():
                a = np.array(s)
                fig.plot(x=a[:, 0], y=a[:, 1], style='t0.22c', fill=a[:, 2], cmap=True, pen='0.4p,black')
        for name, (hx, hy) in HOTSPOTS.items():
            fig.plot(x=hx, y=hy, style='a0.35c', fill='yellow', pen='0.5p,black')
        fig.colorbar(frame=f'af+l{label}', position='JBC+o0/0.8c+w9c/0.3c+h')
    fig.savefig(out)
    print('wrote', out)


if __name__ == '__main__':
    main()
