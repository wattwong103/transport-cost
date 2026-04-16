#!/usr/bin/env python3
"""
Match internal station IDs to OSM stations using proximity-within-line.

The internal IDs (bl1..bl38, gn1..gn24, etc.) don't directly correspond to
official station codes (BL01..BL38, N1..N24). They follow a walk-order
scheme with phantom stations inserted between real ones.

Strategy: For each internal station, find the nearest OSM station on the
same line within a reasonable threshold. If no OSM station is within threshold,
treat as phantom (no change).

Input: data/train-stations.json (current coords from fix-stations.py)
       data/osm-stations.json (ground truth from OSM)
Output: data/station-match.json
"""

import json, math, os, re
from collections import defaultdict
import numpy as np
from scipy.optimize import linear_sum_assignment

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIONS_PATH = os.path.join(REPO, 'data', 'train-stations.json')
OSM_PATH = os.path.join(REPO, 'data', 'osm-stations.json')
OUT_PATH = os.path.join(REPO, 'data', 'station-match.json')


def hav(lat1, lng1, lat2, lng2):
    R = 6371000
    dLat = math.radians(lat2 - lat1)
    dLng = math.radians(lng2 - lng1)
    a = (math.sin(dLat/2)**2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLng/2)**2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))


# Map internal line -> set of OSM ref code prefixes for that line
LINE_REF_PREFIXES = {
    'blue':            [r'^BL\d+$'],
    'purple':          [r'^PP\d+$'],
    'pink':            [r'^PK\d+$'],
    'yellow':          [r'^YL\d+$'],
    'green_sukhumvit': [r'^N\d+$', r'^E\d+$', r'^CEN$'],
    'green_silom':     [r'^S\d+$', r'^W\d+$', r'^CEN$'],
    'airport':         [r'^A\d+$'],
    'red_north':       [r'^RN\d+$', r'^กภ\.?$'],   # SRT Bang Sue Grand
    'red_west':        [r'^RW\d+$', r'^ซอ\.?;?.*$', r'^บำ\.?;?.*$', r'^ตช\.?;?.*$'],
    'gold':            [r'^G\d+$'],
}

# Names that identify stations even without ref (e.g., YL01 shares location with BL15)
LINE_NAME_HINTS = {
    'yellow':    ['Lat Phrao', 'Si Thepha'],
    'red_north': ['Don Mueang', 'Krung Thep Aphiwat'],
    'gold':      ['ICONSIAM', 'Khlong San', 'Charoen Nakhon'],
}


def osm_matches_line(osm_station, line_id):
    """Check if an OSM station belongs to the given internal line."""
    prefixes = LINE_REF_PREFIXES.get(line_id, [])
    ref = osm_station.get('ref', '')
    for r in ref.split(';'):
        r = r.strip()
        for pat in prefixes:
            if re.match(pat, r):
                return True
    # Fallback: name-based hint match for stations without refs
    hints = LINE_NAME_HINTS.get(line_id, [])
    name = (osm_station.get('name_en') or '').strip()
    if name and name in hints and not osm_station.get('ref'):
        return True
    return False


def main():
    with open(STATIONS_PATH) as f:
        data = json.load(f)
    with open(OSM_PATH) as f:
        osm = json.load(f)

    stations = data['stations']
    osm_stations = osm['stations']

    # Index OSM by line
    osm_by_line = defaultdict(list)
    for o in osm_stations:
        for line_id in LINE_REF_PREFIXES:
            if osm_matches_line(o, line_id):
                osm_by_line[line_id].append(o)

    print("OSM stations per line:")
    for line_id, lst in sorted(osm_by_line.items()):
        print(f"  {line_id:20s}: {len(lst)}")

    matches = {}
    stats = defaultdict(int)

    # Matching strategy per line:
    # Pass 1: Exact name match (English or Thai). Highest confidence.
    # Pass 2: Hungarian algorithm on remaining internals ↔ OSM stations.
    # Max distance threshold 2000m.
    THRESHOLD = 2000
    HUGE = 1e9

    def norm(s):
        return re.sub(r'\s+', ' ', (s or '').strip().lower())

    def record(sid, s, o, d, method):
        if d <= 300:
            conf = 'high'
        elif d <= 800:
            conf = 'medium'
        elif d <= THRESHOLD:
            conf = 'low'
        else:
            conf = 'low'
        matches[sid] = {
            'status': conf,
            'method': method,
            'current_lat': s['lat'],
            'current_lng': s['lng'],
            'current_name': s['name'],
            'current_name_th': s['nameTh'],
            'line': s['line'],
            'osm_id': o['osm_id'],
            'osm_ref': o['ref'],
            'osm_name_en': o['name_en'],
            'osm_name_th': o['name_th'],
            'osm_lat': o['lat'],
            'osm_lng': o['lon'],
            'delta_m': round(float(d)),
        }
        stats[conf] += 1
        stats[f'method_{method}'] += 1

    for line, osm_list in osm_by_line.items():
        internals = [(sid, s) for sid, s in stations.items() if s['line'] == line]
        if not internals or not osm_list:
            continue

        matched_internals = set()
        matched_osm = set()

        # Pass 1: name match
        for sid, s in internals:
            if sid in matched_internals:
                continue
            cand = None
            cand_d = float('inf')
            for o in osm_list:
                if o['osm_id'] in matched_osm:
                    continue
                if (norm(s['name']) and norm(s['name']) == norm(o.get('name_en'))) or \
                   (norm(s['nameTh']) and norm(s['nameTh']) == norm(o.get('name_th'))):
                    d = hav(s['lat'], s['lng'], o['lat'], o['lon'])
                    if d < cand_d:
                        cand = o
                        cand_d = d
            if cand and cand_d <= THRESHOLD * 2:  # allow larger for name match
                record(sid, s, cand, cand_d, 'name')
                matched_internals.add(sid)
                matched_osm.add(cand['osm_id'])

        # Pass 2: Hungarian on remaining
        remain_int = [(sid, s) for sid, s in internals if sid not in matched_internals]
        remain_osm = [o for o in osm_list if o['osm_id'] not in matched_osm]
        if not remain_int or not remain_osm:
            continue

        n, m = len(remain_int), len(remain_osm)
        cost = np.full((n, m), HUGE)
        for i, (sid, s) in enumerate(remain_int):
            for j, o in enumerate(remain_osm):
                d = hav(s['lat'], s['lng'], o['lat'], o['lon'])
                cost[i, j] = d if d <= THRESHOLD else HUGE

        row_ind, col_ind = linear_sum_assignment(cost)
        for i, j in zip(row_ind, col_ind):
            d = cost[i, j]
            if d >= HUGE:
                continue
            sid, s = remain_int[i]
            o = remain_osm[j]
            record(sid, s, o, d, 'hungarian')

    # Anything unclaimed is phantom — keep current coords
    for sid, s in stations.items():
        if sid in matches:
            continue
        matches[sid] = {
            'status': 'phantom',
            'current_lat': s['lat'],
            'current_lng': s['lng'],
            'current_name': s['name'],
            'current_name_th': s['nameTh'],
            'line': s['line'],
        }
        stats['phantom'] += 1

    # Per-line breakdown
    per_line = defaultdict(lambda: defaultdict(int))
    for sid, m in matches.items():
        per_line[m.get('line', '?')][m.get('status')] += 1

    print("\nPer-line match quality:")
    for line, counts in sorted(per_line.items()):
        parts = [f'{k}={v}' for k, v in sorted(counts.items())]
        print(f"  {line:20s}: {', '.join(parts)}")

    # Print summary
    print("\nOverall match summary:")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")
    print(f"  total: {len(matches)}")

    # Show biggest deltas
    big = sorted(
        [(sid, m) for sid, m in matches.items() if m['status'] in ('high', 'medium', 'low')],
        key=lambda x: -x[1]['delta_m']
    )[:20]
    print("\nLargest corrections to be applied (top 20):")
    for sid, m in big:
        print(f"  {sid:6s} [{m['line']:20s}] delta={m['delta_m']:5d}m "
              f"'{m['current_name']}' -> '{m['osm_name_en']}' (ref {m['osm_ref']})")

    # Show phantoms (will keep current coords)
    phantoms = [(sid, m) for sid, m in matches.items()
                if m['status'] in ('phantom', 'phantom_duplicate')]
    print(f"\nPhantom stations (keep current): {len(phantoms)}")
    for sid, m in phantoms[:20]:
        extra = f" (duplicate of {m.get('winner')})" if m['status'] == 'phantom_duplicate' else ''
        print(f"  {sid:6s} [{m.get('line')}] '{m.get('current_name')}'{extra}")

    with open(OUT_PATH, 'w') as f:
        json.dump({'matches': matches, 'stats': dict(stats)}, f,
                  indent=2, ensure_ascii=False)
    print(f"\nSaved to {OUT_PATH}")


if __name__ == '__main__':
    main()
