#!/usr/bin/env python3
"""
Build data/transit-network.json — the compact, route-level network the
browser uses for journey planning and isolines (js/graph.js).

Unlike a flat stop-to-stop graph, every bus route, boat service and rail
line keeps its identity, so the client can charge a fare each time a
passenger boards a vehicle and apply distance/station based fare tables
per leg.

Inputs
  data/rail-network.json                 (scripts/build-rail-network.py)
  longdo data/longdo-share/*.txt         BMTA GTFS (stops, routes, stop_times)
  data/osm-boat-routes.geojson           boat routes + piers (OSM)

Output schema
  stops:   [[lat, lng, kind, name]]       kind: r=rail station, b=bus stop, o=pier
  codes:   {stopIdx: "BL13"}              official code for rail stations
  routes:  [{k, f, n, c?, s:[stopIdx]}]   k=kind, f=fare id (transport-modes.json)
  railTransfers: [[a, b, walk_m]]          interchanges between rail stations
  interchanges: [{name, nameTh, lat, lng, codes, busRoutes}]
"""

import csv
import json
import math
import os
import re
from collections import defaultdict
from datetime import date

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAIL_PATH = os.path.join(REPO, 'data', 'rail-network.json')
GTFS = os.path.join(REPO, 'longdo data', 'longdo-share')
BOAT_PATH = os.path.join(REPO, 'data', 'osm-boat-routes.geojson')
OUT_PATH = os.path.join(REPO, 'data', 'transit-network.json')

PIER_TO_ROUTE_M = 250        # pier must be this close to a boat route line
PIER_MERGE_M = 60            # pier points closer than this are one pier
INTERCHANGE_RADIUS_M = 300   # bus stops counted as serving a rail station

# Boat services: (regex on OSM route name, fare id, display name)
BOAT_SERVICES = [
    (r'ธงส้ม', 'cp_orange', 'Chao Phraya Express — Orange Flag'),
    (r'ธงเหลือง', 'cp_yellow', 'Chao Phraya Express — Yellow Flag'),
    (r'ธงเขียว', 'cp_green', 'Chao Phraya Express — Green-Yellow Flag'),
    (r'ไม่มีธง', 'cp_local', 'Chao Phraya Express — Local (no flag)'),
    (r'ท่องเที่ยว', 'cp_tourist', 'Chao Phraya Tourist Boat (blue flag)'),
    (r'Urban Line|City Line', 'smart_ferry', 'Chao Phraya Smart Ferry'),
    (r'ประตูน้ำ|ศรีบุญเรือง|ผ่นฟ้า|ผ่านฟ้า', 'khlong', 'Khlong Saen Saep Boat'),
    (r'ผดุงกรุงเกษม', 'khlong_padung', 'Khlong Phadung Krung Kasem Boat'),
    (r'บางกอกใหญ่', 'khlong_bangkok_yai', 'Khlong Bangkok Yai Boat'),
    (r'ข้ามฟาก', 'ferry', 'Cross-river Ferry'),
]


def hav_m(a, b):
    R = 6371000
    dlat = math.radians(b[0] - a[0])
    dlng = math.radians(b[1] - a[1])
    h = (math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[0])) *
         math.cos(math.radians(b[0])) * math.sin(dlng / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def read_csv(name):
    with open(os.path.join(GTFS, name), encoding='utf-8') as f:
        return [{k: v.strip('"') for k, v in row.items()} for row in csv.DictReader(f)]


class Stops:
    def __init__(self):
        self.rows = []

    def add(self, lat, lng, kind, name):
        self.rows.append([round(lat, 6), round(lng, 6), kind, name or ''])
        return len(self.rows) - 1


def main():
    stops = Stops()
    routes = []

    # ---------------- rail ----------------
    rail = json.load(open(RAIL_PATH, encoding='utf-8'))
    code_idx = {}
    for code, s in rail['stations'].items():
        code_idx[code] = stops.add(s['lat'], s['lng'], 'r', s['name'])
    codes = {i: c for c, i in code_idx.items()}
    names_th = {code_idx[c]: s['nameTh'] for c, s in rail['stations'].items()}
    for line in rail['lines']:
        routes.append({'k': 'r', 'f': line['fare'], 'id': line['id'], 'n': line['name'],
                       'c': line['color'], 's': [code_idx[c] for c in line['stations']]})
    rail_transfers = [[code_idx[t['a']], code_idx[t['b']], t['walk_m']] for t in rail['transfers']]
    print(f"rail: {len(code_idx)} stations, {len(rail['lines'])} lines, {len(rail_transfers)} transfers")

    # ---------------- bus (GTFS) ----------------
    gtfs_stops = {r['stop_id']: r for r in read_csv('stops.txt')}
    route_meta = {r['route_id']: r for r in read_csv('routes.txt')}
    trips = defaultdict(list)
    for r in read_csv('stop_times.txt'):
        trips[r['trip_id']].append((int(r['stop_sequence']), r['stop_id']))
    bus_idx = {}
    for sid, r in gtfs_stops.items():
        name = re.sub(r'^ป้ายรถประจำทาง\s*', '', r['stop_name']).strip()
        bus_idx[sid] = stops.add(float(r['stop_lat']), float(r['stop_lon']), 'b', name)
    n_bus_routes = 0
    for trip_id, seqs in trips.items():
        seqs.sort()
        s = [bus_idx[sid] for _, sid in seqs if sid in bus_idx]
        s = [x for i, x in enumerate(s) if i == 0 or x != s[i - 1]]
        if len(s) < 2:
            continue
        meta = route_meta.get(trip_id, {})
        long_name = meta.get('route_long_name', '')
        m = re.search(r'\((.*)\)', long_name)
        routes.append({'k': 'b', 'f': 'bus', 'id': f'bus{trip_id}',
                       'n': meta.get('route_short_name', trip_id),
                       'd': m.group(1) if m else '', 's': s})
        n_bus_routes += 1
    print(f"bus: {len(bus_idx)} stops, {n_bus_routes} route-directions")

    # ---------------- boat (OSM) ----------------
    boat = json.load(open(BOAT_PATH, encoding='utf-8'))
    pier_pts = [f for f in boat['features'] if f['geometry']['type'] == 'Point']
    piers = []   # merged piers: [lat, lng, name]
    for f in pier_pts:
        lng, lat = f['geometry']['coordinates']
        name = f['properties'].get('name', '')
        for p in piers:
            if hav_m((lat, lng), (p[0], p[1])) < PIER_MERGE_M:
                p[2] = p[2] or name
                break
        else:
            piers.append([lat, lng, name])
    pier_idx = [None] * len(piers)
    unmatched = []
    for f in boat['features']:
        g = f['geometry']
        if g['type'] == 'Point':
            continue
        name = f['properties'].get('name', '')
        svc = next(((fid, disp) for pat, fid, disp in BOAT_SERVICES if re.search(pat, name)), None)
        if not svc:
            unmatched.append(name)
            continue
        parts = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        line = [(c[1], c[0]) for part in parts for c in part]
        cum = [0.0]
        for a, b in zip(line, line[1:]):
            cum.append(cum[-1] + hav_m(a, b))
        hits = []
        for i, p in enumerate(piers):
            best, pos = min((hav_m((p[0], p[1]), q), cum[j]) for j, q in enumerate(line))
            if best <= PIER_TO_ROUTE_M:
                hits.append((pos, i))
        hits.sort()
        seq = []
        for _, i in hits:
            if pier_idx[i] is None:
                pier_idx[i] = stops.add(piers[i][0], piers[i][1], 'o', piers[i][2])
            seq.append(pier_idx[i])
        if len(seq) >= 2:
            routes.append({'k': 'o', 'f': svc[0], 'id': f'boat{len(routes)}', 'n': svc[1],
                           'd': name, 's': seq})
            print(f"  boat {svc[0]:18s} {len(seq):3d} piers  {name}")
    if unmatched:
        print('  unclassified boat routes (skipped):', unmatched)

    # ---------------- interchanges ----------------
    bus_routes_at = defaultdict(set)
    for r in routes:
        if r['k'] == 'b':
            for s in r['s']:
                bus_routes_at[s].add(r['n'])
    bus_stop_ids = [i for i, row in enumerate(stops.rows) if row[2] == 'b']
    cell = defaultdict(list)
    for i in bus_stop_ids:
        cell[(int(stops.rows[i][0] / 0.005), int(stops.rows[i][1] / 0.005))].append(i)
    groups = {}
    for code, i in code_idx.items():
        lat, lng, _, name = stops.rows[i]
        served = set()
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                for b in cell[(int(lat / 0.005) + dr, int(lng / 0.005) + dc)]:
                    if hav_m((lat, lng), stops.rows[b][:2]) <= INTERCHANGE_RADIUS_M:
                        served |= bus_routes_at[b]
        g = groups.setdefault(name, {'name': name, 'nameTh': names_th[i], 'lat': lat, 'lng': lng,
                                     'codes': [], 'busRoutes': set()})
        g['codes'].append(code)
        g['busRoutes'] |= served
    interchanges = []
    for g in groups.values():
        if not g['busRoutes']:
            continue
        g['busRoutes'] = sorted(g['busRoutes'], key=lambda x: (len(x), x))
        interchanges.append(g)
    interchanges.sort(key=lambda g: -len(g['busRoutes']))
    print(f"interchanges: {len(interchanges)}; top: " +
          ', '.join(f"{g['name']}({len(g['busRoutes'])})" for g in interchanges[:10]))

    out = {
        'meta': {
            'built': date.today().isoformat(),
            'sources': [
                'Rail stations: OpenStreetMap contributors (ODbL)',
                'Bus routes and stops: BMTA GTFS via Longdo Map',
                'Boat routes and piers: OpenStreetMap contributors (ODbL)',
            ],
        },
        'stops': stops.rows,
        'codes': codes,
        'routes': routes,
        'railTransfers': rail_transfers,
        'interchanges': interchanges,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f"wrote {OUT_PATH} ({os.path.getsize(OUT_PATH) / 1024:.0f} KB), "
          f"{len(stops.rows)} stops, {len(routes)} routes")


if __name__ == '__main__':
    main()
