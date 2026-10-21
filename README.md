# Kalke · FPV route planner

Lay a sheet of tracing paper over satellite imagery and plan FPV routes, gaps and racing lines.

```
Kalke FPV/
├── Start Kalke.bat     double-click to run (Windows)
├── kalke-server.ps1    tiny local web server used by Start Kalke.bat
├── index.html          layout and sidebar
├── styles.css          dark sidebar, tracing-paper effect, map styling
├── app.js              map, drawing tools, flight estimate, import/export
├── manifest.webmanifest
└── icons/              these two let a phone add Kalke to its home screen as an app
```

No build step and nothing to install. Leaflet 1.9.4 and Leaflet-Geoman 2.20.2 load from the jsDelivr CDN, so you need an internet connection (the map tiles need one anyway).

## Run it

**Windows:** double-click `Start Kalke.bat`. A small console window starts a local web server (built into Windows PowerShell, nothing to install) and Kalke opens in your browser at <http://localhost:8765>. Keep that window open while you plan; close it to stop.

If Windows SmartScreen asks about the file, choose "More info" and "Run anyway". If the server can't start, the launcher opens `index.html` directly instead; everything works then except "Go to my location".

**Any other way:** double-click `index.html`, or serve the folder with any local web server, for example:

```bash
python -m http.server 8765        # Windows: py -m http.server 8765
```

Your plan autosaves per address: a plan made at `http://localhost:8765` is not visible when you open `index.html` directly, and the other way round. Stick to one way of starting it, or move plans with Export GeoJSON / Open file.

## On your phone

Open the web address (GitHub Pages) in Chrome on Android or Safari on iPhone, then add it to the home screen: in Chrome, menu ⋮ → "Add to Home screen"; in Safari, the share button → "Add to Home Screen". It then opens full screen like an app.

On a phone the tools sit in a dock at the bottom: Line, Freehand, Marker, Edit, Erase, Undo and More (search, base map, tracing paper, flight settings, list, export).

- **Line:** tap to add points. "Undo point" and "Finish" sit just above the dock.
- **Freehand:** draw with one finger; two fingers pan and zoom the map.
- **Edit:** drag a point to move it, drag a small midpoint to add one, tap a point to delete it.
- **The box in the top-right corner** shows total distance, flight time and battery per run. Tap it for the full estimate.
- **Locate (top left):** centres the map on you and keeps a live dot of your position while you walk the spot.
- **Export** opens the phone's share sheet when it can, so you can save the image to your photos or send it straight to someone.

Tap a tool again to put it down. Plans are saved on the phone itself, separately from your PC; move a plan between devices with Export GeoJSON and Open file.

## Using it

| Tool | Key | What it does |
|---|---|---|
| Line | `L` | Click point to point. Double-click or `Enter` finishes, `Backspace` removes the last point. Snaps to markers and other routes. |
| Freehand | `F` | Press and drag. The path is simplified and smoothed when you let go. Hold `Space` to pan. |
| Markers | `1`–`6` | Takeoff, landing, dive, gap, hazard, note |
| Edit points | `E` | Drag vertices, drag a midpoint to add one, right-click a vertex to delete it |
| Move | `M` | Drag whole routes or markers |
| Erase | `X` | Click a route or marker to remove it |
| Tracing paper | `K` | Lay or lift the paper. Adjust paper opacity and tint (vellum, frost, night) |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` | Every change is undoable |
| Stop | `Esc` | Puts the tool down (a line in progress is kept) |

Each route shows a start ring, an arrow at the end (direction of flight) and a length label. "Animate flight direction" makes the ink flow along the route. In the "On the sheet" list you can rename, recolour (click the dot), hide, reverse, zoom to or delete anything.

## Flight estimate

- **Total distance** sums every visible route. Hidden routes are left out, so you can compare alternatives.
- **Flight time** = distance ÷ your average speed. Climbs, wind, hovering and the flight out to the start are not included, so treat it as a lower bound.
- **Battery per run** compares that time with your flight time per pack; the hatched part of the bar is the reserve you keep.
- **Furthest from takeoff** is the straight-line distance from the nearest takeoff marker to the furthest route point or dive/gap marker, checked against your video/link range. The dashed ring around the takeoff shows that range.

## Export and import

- **GeoJSON**: all routes and markers with names, colours and lengths. Opens again in Kalke ("Open file"), and in QGIS, geojson.io and most GIS tools.
- **KML**: for Google Earth (desktop or web) with your colours and marker types.
- **Image (PNG)**: the current view with routes, markers, a legend (plan name, distance, time, battery), scale bar and north arrow. Zoom and frame the map first.

Your plan also autosaves in the browser (localStorage), so it is there when you come back on the same browser. Export a GeoJSON file to keep a copy or move it to another computer.

## Tweaks

Settings at the top of `app.js`:

- `imageryMaxNativeZoom` (default 19): if you see grey "Map data not yet available" tiles when zoomed right in, set it to 18.
- `defaultView`: where the map opens the very first time.
- `INKS` and `MARKER_TYPES`: route colours and marker types/icons.

## Credits and terms

- [Leaflet](https://leafletjs.com) (BSD-2-Clause) and [Leaflet-Geoman free](https://github.com/geoman-io/leaflet-geoman) (MIT)
- Satellite and topographic tiles: Esri World Imagery / World Topo Map. Keep the attribution visible; check Esri's terms before using the app commercially.
- Place search: [Nominatim](https://nominatim.org) (OpenStreetMap). It only searches when you press Enter, per its usage policy.
- Fonts: Barlow and Barlow Condensed (Google Fonts, SIL OFL)

Always check local drone rules, airspace restrictions and landowner permission before flying a planned route.
