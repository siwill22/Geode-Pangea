# Drag Plates

Six continents on a globe. Drag one and it moves as a rigid plate on the sphere, by a
finite rotation about an Euler pole. The rotations can be exported as a GPlates `.rot`
file.

- **Drag a continent** to slide it. The point you grabbed stays under the cursor, and
  the plate travels along a great circle.
- **Shift-drag** (or switch on *Twist*) to spin a plate about its own centre.
- **Drag the ocean** to turn the globe.
- The table gives each plate's *total* rotation from its present-day position (pole
  lat/lon and angle). The active plate's pole is marked on the globe, with the small
  circle its centre travelled along.
- **Export .rot** writes, for each plate, the identity at 0 Ma and the dragged rotation
  at the chosen age, relative to plate 000.

Plain static site with no build step: serve the folder and open `index.html`.

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

## Data

`data/plates.geojson` (lon/lat, WGS84) is built by `prep/make_plates.py` from Natural
Earth 1:110m land (public domain):

- Africa is split from Eurasia at Suez, and North from South America at Panama.
- The Caspian (a hole in the source, joined to the coast by a slit) is filled.
- Rings are tessellated to 1° great-circle segments.

Plate ids 901–906 are arbitrary and don't correspond to any real plate model.

```sh
conda run -n pygmt17 python prep/make_plates.py
```

## Checks

```sh
NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_drag.cjs out/
conda run -n pygmt17 python prep/check_parity.py out/
```

The first runs the page in Chromium with real pointer events. It checks four things:

- A plate drag moves only that plate, keeps the grabbed point under the cursor, and
  doesn't turn the globe.
- An ocean drag turns the globe and moves no plate.
- A twist leaves the plate's centre fixed.

The second reconstructs the same polygons in pygplates from the exported `.rot` file,
compares them vertex by vertex with what the page drew, and writes an overlay figure.
The two agree to about 5e-5° (the rounding in the `.rot` file).

## Vendored code

`vendor/petrify/` is a copy of five modules from
[petrify](https://github.com/siwill22/petrify) (`polygons`, `orthographic`, `sphere`,
`rotations`, `polyline`). This viewer needs its `PolygonLayer.setRotations()`, the
`quat*` gesture helpers and the spherical ring functions, all added in petrify v0.16.0.
