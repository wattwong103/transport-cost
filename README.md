# Bangkok Fares

A static site (GitHub Pages) that shows what it really costs to get around Bangkok.

- **Trip planner** (`index.html`, the home page) — door-to-door routes by rail, BMTA bus, boat and walking, with the fare for every leg, plus the same trip by taxi, Grab, motorcycle taxi and tuk-tuk. Shareable URLs (`#o=lat,lng&d=lat,lng`).
- **Reach map** (`isoline.html`) — the fare or travel time to every part of the city from any starting point, by public transport (all, rail, bus, boat) or by road.
- **Compare modes** (`compare.html`) — what a trip of a given length costs on each mode, with every fare table and its source.

Everything runs in the browser; there is no server.

## How routing works

`js/graph.js` expands the network into "stop" nodes and "on board route r at stop j" nodes, so each bus route, boat service and rail line keeps its identity. A fare leg starts every time you board, and its fare is recomputed from that mode's table (by stations or km) as you ride. Three generalized-cost profiles (cheapest, recommended, fastest) weigh fare against minutes and walking. Platform changes inside one fare system (BTS Siam, the Blue Line loop at Tha Phra, SRT Krung Thep Aphiwat) are free; the MRT Blue/Purple entry-fee discount is applied afterwards.

## Fares

`data/transport-modes.json` holds every fare table with its source and date. Fares were last checked **2026-11-04**. Values that could not be confirmed from a 2025–2026 source are marked `accuracy` / "estimate" and shown as such in the UI. Not modelled per trip: the 40 THB/day Red+Purple EMV cap (until 30 Nov 2026), concession fares, and the 45 THB common-fare scheme for Thai nationals starting 1 Jan 2027.

## Data pipeline

```
scripts/fetch-osm-stations.py     -> data/osm-stations.json        (Overpass API)
scripts/fetch-osm-data.sh         -> data/osm-rail-routes.raw.geojson, data/osm-boat-routes.geojson
scripts/build-rail-network.py     -> data/rail-network.json        (stations keyed by official codes: BL01, N8, E4 …)
scripts/build-rail-geometry.py    -> data/rail-geometry.geojson    (track between consecutive stations)
scripts/build-transit-network.py  -> data/transit-network.json     (rail + BMTA GTFS + boats, route level)
```

Run them in that order after changing station or route data (Python 3, no extra packages).

## Data sources

- Rail stations, rail and boat routes: © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)
- Bus routes and stops: BMTA GTFS via Longdo Map (`longdo data/`)
- Fares: operator announcements and Thai news reports, listed per mode in `data/transport-modes.json`
