#!/usr/bin/env python3
"""
Regenerate rail interchange (connection) edges based on geographic proximity.

The pre-existing connection edges in train-edges.json were defined symbolically
but never validated against station coordinates. Many of them now connect
stations that are kilometres apart, which is incorrect for routing.

This script:
1. Keeps all 'link' edges (sequential same-line stations)
2. Discards the existing 'connection' edges
3. Finds station pairs of different lines within INTERCHANGE_RADIUS_M metres
4. Adds those as new 'connection' edges
5. Validates that no link edge is unreasonably long or short

Output: rewrites data/train-edges.json
"""

import json, math, os
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIONS_PATH = os.path.join(REPO, 'data', 'train-stations.json')
EDGES_PATH = os.path.join(REPO, 'data', 'train-edges.json')

INTERCHANGE_RADIUS_M = 250   # distance for "same physical station" interchanges
WALKABLE_RADIUS_M = 600       # broader interchange (walkable connection)


def hav(a, b):
    R = 6371000
    dLat = math.radians(b['lat'] - a['lat'])
    dLng = math.radians(b['lng'] - a['lng'])
    d = (math.sin(dLat/2)**2 +
         math.cos(math.radians(a['lat'])) * math.cos(math.radians(b['lat'])) *
         math.sin(dLng/2)**2)
    return R * 2 * math.atan2(math.sqrt(d), math.sqrt(1-d))


def main():
    with open(STATIONS_PATH) as f:
        data = json.load(f)
    stations = data['stations']

    with open(EDGES_PATH) as f:
        edges = json.load(f)

    # Keep link edges, drop connection edges
    link_edges = [e for e in edges if e.get('type') == 'link']
    old_conn_count = sum(1 for e in edges if e.get('type') == 'connection')
    print(f"Existing edges: {len(link_edges)} link + {old_conn_count} connection")

    # Build set of existing link-edge pairs (don't duplicate)
    link_pairs = set()
    for e in link_edges:
        link_pairs.add(tuple(sorted([e['from'], e['to']])))

    # Find new interchange pairs by proximity, across different lines
    sids = list(stations.keys())
    new_connections = []
    same_node_pairs = []  # 0m apart - same physical station

    for i, a in enumerate(sids):
        sa = stations[a]
        for b in sids[i+1:]:
            sb = stations[b]
            if sa['line'] == sb['line']:
                continue
            pair = tuple(sorted([a, b]))
            if pair in link_pairs:
                continue
            d = hav(sa, sb)
            if d <= INTERCHANGE_RADIUS_M:
                new_connections.append({
                    'from': a, 'to': b, 'type': 'connection',
                    'walk_m': round(d, 1),
                })
                if d < 50:
                    same_node_pairs.append((a, b, d))

    # Print summary
    print(f"\nNew interchange edges (within {INTERCHANGE_RADIUS_M}m): {len(new_connections)}")
    print("\nCo-located interchanges (<50m):")
    for a, b, d in same_node_pairs[:30]:
        sa, sb = stations[a], stations[b]
        print(f"  {d:5.1f}m  {a:8s}({sa['name']:30s} {sa['line']:18s}) ↔ "
              f"{b:8s}({sb['name']:30s} {sb['line']:18s})")

    # Audit final link edges for sanity
    print("\nLink edges with suspicious distances (>4km or <100m):")
    bad_links = []
    for e in link_edges:
        a, b = stations[e['from']], stations[e['to']]
        d = hav(a, b)
        if d > 4000 or d < 100:
            bad_links.append((d, e, a, b))
    bad_links.sort(reverse=True)
    for d, e, a, b in bad_links[:15]:
        print(f"  {d:5.0f}m  {e['from']:8s}({a['name']:25s}) ↔ {e['to']:8s}({b['name']:25s}) line={a['line']}")
    print(f"  ({len(bad_links)} total suspicious link edges - kept as-is)")

    # Write back
    new_edges = link_edges + new_connections
    with open(EDGES_PATH, 'w') as f:
        json.dump(new_edges, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {len(new_edges)} edges to {EDGES_PATH}")
    print(f"  ({len(link_edges)} link + {len(new_connections)} connection)")


if __name__ == '__main__':
    main()
