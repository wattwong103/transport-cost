#!/usr/bin/env python3
"""
Fetch Bangkok transit station coordinates from OpenStreetMap via Overpass API.
Caches raw response to data/osm-stations.json.
"""

import json, os, sys, time
import urllib.request, urllib.parse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(REPO, 'data', 'osm-stations.json')

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

QUERY = """
[out:json][timeout:90];
(
  node["railway"="station"](13.5,100.3,14.0,100.9);
  node["railway"="halt"](13.5,100.3,14.0,100.9);
  node["public_transport"="station"]["station"~"subway|light_rail|monorail"](13.5,100.3,14.0,100.9);
  node["station"="subway"](13.5,100.3,14.0,100.9);
  node["railway"="stop"]["network"~"BTS|MRT|SRT|ARL|Airport",i](13.5,100.3,14.0,100.9);
);
out body;
"""

# Endpoints to try in order
ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
]


def fetch(endpoint, query):
    data = urllib.parse.urlencode({'data': query}).encode('utf-8')
    req = urllib.request.Request(endpoint, data=data,
                                 headers={'User-Agent': 'transport-cost-research/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    print("Querying Overpass API for Bangkok transit stations...")
    result = None
    for ep in ENDPOINTS:
        try:
            print(f"  Trying {ep} ...")
            result = fetch(ep, QUERY)
            print(f"  Success")
            break
        except Exception as e:
            print(f"  Failed: {e}")
            time.sleep(2)

    if result is None:
        print("All Overpass endpoints failed!")
        sys.exit(1)

    elements = result.get('elements', [])
    print(f"Fetched {len(elements)} raw elements")

    # Normalize into a simpler list
    stations = []
    for el in elements:
        if el['type'] != 'node':
            continue
        tags = el.get('tags', {})
        stations.append({
            'osm_id': el['id'],
            'lat': el['lat'],
            'lon': el['lon'],
            'name': tags.get('name', ''),
            'name_en': tags.get('name:en', ''),
            'name_th': tags.get('name:th', ''),
            'ref': tags.get('ref', ''),
            'network': tags.get('network', ''),
            'line': tags.get('line', ''),
            'operator': tags.get('operator', ''),
            'railway': tags.get('railway', ''),
            'public_transport': tags.get('public_transport', ''),
            'station': tags.get('station', ''),
        })

    # Filter to transit-relevant: has a name + is in a transit network OR has station tag
    def is_transit(s):
        net = (s.get('network') or '').upper()
        op = (s.get('operator') or '').upper()
        if any(k in net for k in ['BTS', 'MRT', 'SRT', 'ARL', 'AIRPORT RAIL']):
            return True
        if any(k in op for k in ['BMCL', 'BEM', 'MRTA', 'BTSC', 'SRT', 'ARL']):
            return True
        if s.get('station') in ('subway', 'light_rail', 'monorail'):
            return True
        if s.get('railway') in ('station', 'halt', 'stop'):
            return True
        return False

    filtered = [s for s in stations if is_transit(s) and (s['name'] or s['name_en'])]
    print(f"Filtered to {len(filtered)} transit stations with names")

    # Deduplicate by name+rough coordinate (multiple mappers may add duplicate platforms)
    seen = {}
    unique = []
    for s in filtered:
        key = (s['name'] or s['name_en'], round(s['lat'], 3), round(s['lon'], 3))
        if key in seen:
            continue
        seen[key] = True
        unique.append(s)
    print(f"After dedup: {len(unique)} unique stations")

    # Summary by network
    from collections import Counter
    by_net = Counter(s.get('network', '(unknown)') for s in unique)
    for net, n in by_net.most_common(20):
        print(f"  {net or '(no network)':30s}: {n}")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        json.dump({'stations': unique, 'count': len(unique)}, f,
                  indent=2, ensure_ascii=False)
    print(f"\nSaved to {OUT_PATH}")


if __name__ == '__main__':
    main()
