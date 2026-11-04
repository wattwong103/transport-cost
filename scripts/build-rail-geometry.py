#!/usr/bin/env python3
"""
Build data/rail-geometry.geojson — drawable rail lines that follow the
track between consecutive stations.

data/osm-rail-routes.raw.geojson flattens each OSM route relation into one
LineString, so way ends are joined in the wrong order and long "chords" cut
across the city. Instead of trusting vertex order, for every consecutive
station pair on a line (data/rail-network.json) we take the run of raw
vertices between the vertex nearest station A and the vertex nearest
station B, and keep it only if it is a plausible track (near both stations,
no jumps, not much longer than the straight line). Otherwise the pair is
drawn as a straight segment.
"""

import json
import math
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(REPO, 'data', 'osm-rail-routes.raw.geojson')
RAIL = os.path.join(REPO, 'data', 'rail-network.json')
OUT = os.path.join(REPO, 'data', 'rail-geometry.geojson')

LEGACY_IDS = {
    'green_sukhumvit': 'bts_sukhumvit', 'green_silom': 'bts_silom', 'blue': 'mrt_blue',
    'purple': 'mrt_purple', 'pink': 'mrt_pink', 'yellow': 'mrt_yellow', 'airport': 'arl',
    'red_north': 'srt_dark_red', 'red_west': 'srt_light_red', 'gold': 'gold',
}
SNAP_M = 300        # station must be this close to the track
MAX_JUMP_M = 2500   # no two consecutive vertices further apart
MAX_STRETCH = 1.8   # path length / straight distance


def hav(a, b):
    R = 6371000
    dlat = math.radians(b[0] - a[0])
    dlng = math.radians(b[1] - a[1])
    h = (math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[0])) *
         math.cos(math.radians(b[0])) * math.sin(dlng / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def main():
    raw = json.load(open(RAW, encoding='utf-8'))
    rail = json.load(open(RAIL, encoding='utf-8'))
    verts = {}
    for f in raw['features']:
        lid = LEGACY_IDS.get(f['properties']['lineId'])
        verts.setdefault(lid, []).extend((c[1], c[0]) for c in f['geometry']['coordinates'])
    verts['mrt_pink_mt'] = verts.get('mrt_pink', [])

    features = []
    for line in rail['lines']:
        vs = verts.get(line['id'], [])
        segs, traced = [], 0
        for a, b in zip(line['stations'], line['stations'][1:]):
            pa = (rail['stations'][a]['lat'], rail['stations'][a]['lng'])
            pb = (rail['stations'][b]['lat'], rail['stations'][b]['lng'])
            seg = [pa, pb]
            if vs:
                ia = min(range(len(vs)), key=lambda i: hav(vs[i], pa))
                ib = min(range(len(vs)), key=lambda i: hav(vs[i], pb))
                if hav(vs[ia], pa) < SNAP_M and hav(vs[ib], pb) < SNAP_M and ia != ib:
                    lo, hi = sorted((ia, ib))
                    run = vs[lo:hi + 1]
                    if ia > ib:
                        run = run[::-1]
                    length = sum(hav(p, q) for p, q in zip(run, run[1:]))
                    jumps = max((hav(p, q) for p, q in zip(run, run[1:])), default=0)
                    if jumps <= MAX_JUMP_M and length <= MAX_STRETCH * hav(pa, pb) + 200:
                        seg = [pa] + run + [pb]
                        traced += 1
            segs.append(seg)
        # merge consecutive segments into one polyline where they connect
        coords = []
        for s in segs:
            if coords and coords[-1][-1] == s[0]:
                coords[-1].extend(s[1:])
            else:
                coords.append(list(s))
        features.append({
            'type': 'Feature',
            'properties': {'lineId': line['id'], 'name': line['name'], 'color': line['color']},
            'geometry': {'type': 'MultiLineString',
                         'coordinates': [[[round(p[1], 6), round(p[0], 6)] for p in part] for part in coords]},
        })
        print(f"{line['id']:15s} {traced}/{len(segs)} station pairs traced along OSM track")

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'type': 'FeatureCollection',
                   'properties': {'source': 'OpenStreetMap contributors (ODbL)'},
                   'features': features}, f, ensure_ascii=False, separators=(',', ':'))
    print(f'wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
