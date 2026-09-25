# Geode-Pangea

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
- **Play** runs the reconstruction forward to present day. Each plate turns about its
  own Euler pole, just as GPlates interpolates the exported file. At 0 Ma the button
  becomes **Back**. The slider scrubs anywhere in between, with present day at the right.
  Your rotations are never changed, and grabbing a plate returns to the reconstruction
  age to edit it.
- **Export .rot** writes, for each plate, the identity at 0 Ma and the dragged rotation
  at the chapter's reconstruction age (200 Ma in chapters 1–3), relative to plate 000.

Plain static site with no build step: serve the folder and open `index.html`.

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

## Chapters

Each chapter is a small file in `data/chapters/` that names a plate set and says what to
show. Pick one from the menu, or link it directly with `?chapter=<id>`.

| id | Chapter |
|---|---|
| `fit` | 1. Fit the continents: six continents, coastlines only |
| `blocks` | 2. More than six: plus India, Iberia, Madagascar, Greenland and Mexico |
| `shelves` | 3. Beneath the waves: the chapter-2 plates with their submerged continental crust, plus Zealandia |

## Data

Plate sets (`data/<model>/<set>.json`) are built from a published plate model by
`prep/build_chapters.py`. Plates come from Müller et al. (2019): continental polygons and
rotations, read from the gprm cache. Land is Natural Earth 1:110m, drawn clipped to each
plate's continental crust. The model's own coastline file isn't used, because it joins
islands to their mainland with long spokes that fill as giant triangles. Each continent
is a group of the model's blocks:

- **Seeds:** each group starts from a few plate ids, named as the model's own
  continental-polygon file names them (`prep/groups/<model>.json`). A seed whose name
  doesn't match stops the build.
- **Growth:** every other continental plate joins the group of its nearest neighbour.
- **Dropped:** island arcs, crust the model says appeared after 100 Ma, and a named list
  of LIPs.
- **Simplification:** outlines are simplified on the sphere. Boundaries shared between
  blocks are simplified identically on both sides, so no cracks open between them.

Each group is exported under its principal plate id from the model (Africa 701,
Eurasia 301, …).

```sh
conda run -n pygmt17 python prep/build_chapters.py --figures out/   # --lip-report to list LIP overlaps
```

## Checks

```sh
CHAPTER=fit NODE_PATH=~/GIT/Geode/viewer/node_modules node test/check_drag.cjs out/
conda run -n pygmt17 python prep/check_parity.py out/
```

The first runs the page in Chromium with real pointer events. It checks four things:

- A plate drag moves only that plate, keeps the grabbed point under the cursor, and
  doesn't turn the globe.
- An ocean drag turns the globe and moves no plate.
- A twist leaves the plate's centre fixed.

The second rotates each plate's present-day vertices in pygplates, using only the
exported `.rot` file, compares them vertex by vertex with what the page drew, and writes
an overlay figure.
The two agree to about 1e-4° (the rounding in the `.rot` file).

## Vendored code

`vendor/petrify/` is a copy of five modules from
[petrify](https://github.com/siwill22/petrify) (`polygons`, `orthographic`, `sphere`,
`rotations`, `polyline`). This viewer needs its `PolygonLayer.setRotations()`, the
`quat*` gesture helpers and the spherical ring functions (petrify v0.16.0), plus
`ringBoundingCap` (not yet released).
