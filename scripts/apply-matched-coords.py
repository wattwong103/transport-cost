#!/usr/bin/env python3
"""
Apply OSM-matched coordinates to data/train-stations.json.
Also replaces station names with OSM name_en / name_th for matched stations
(OSM data is more authoritative than our internal NAMES dict).

For phantom stations, keep the current coordinates unchanged.
"""

import json, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIONS_PATH = os.path.join(REPO, 'data', 'train-stations.json')
MATCH_PATH = os.path.join(REPO, 'data', 'station-match.json')


def main():
    with open(STATIONS_PATH) as f:
        data = json.load(f)
    with open(MATCH_PATH) as f:
        match_data = json.load(f)

    matches = match_data['matches']
    stations = data['stations']

    updated = 0
    phantom_kept = 0
    name_updated = 0

    for sid, s in stations.items():
        m = matches.get(sid)
        if not m:
            continue
        status = m['status']
        if status in ('phantom', 'no_osm_line'):
            phantom_kept += 1
            continue

        # Apply OSM coordinates
        new_lat = round(m['osm_lat'], 5)
        new_lng = round(m['osm_lng'], 5)
        if s['lat'] != new_lat or s['lng'] != new_lng:
            s['lat'] = new_lat
            s['lng'] = new_lng
            updated += 1

        # Prefer OSM names (more authoritative) when non-empty
        new_name = m.get('osm_name_en') or s['name']
        new_th = m.get('osm_name_th') or s['nameTh']
        if new_name and new_name != s['name']:
            s['name'] = new_name
            name_updated += 1
        if new_th and new_th != s['nameTh']:
            s['nameTh'] = new_th

    print(f"Coordinates updated: {updated}")
    print(f"Names updated:       {name_updated}")
    print(f"Phantoms kept as-is: {phantom_kept}")
    print(f"Total stations:      {len(stations)}")

    # Verify: all stations still have required fields
    missing = []
    for sid, s in stations.items():
        if not s.get('name') or not s.get('nameTh') or \
           not isinstance(s.get('lat'), (int, float)) or \
           not isinstance(s.get('lng'), (int, float)):
            missing.append(sid)
    if missing:
        print(f"\nWARNING: stations with missing fields: {missing}")

    with open(STATIONS_PATH, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"\nSaved {STATIONS_PATH}")


if __name__ == '__main__':
    main()
