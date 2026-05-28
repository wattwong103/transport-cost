#!/usr/bin/env python3
"""
Co-locate interchange stations that represent the same physical place.

Strategy: only co-locate when we have HIGH CONFIDENCE that two internal IDs
refer to the same physical station. We confirm this by either:
  (a) Their English names match exactly (e.g. arl1 'Phaya Thai' / gn2 'Phaya Thai')
  (b) Both names match a known interchange group definition
  (c) They are already within 300m of each other (suggesting same place)

When co-locating, use OSM data as the canonical source for the coordinate.

After co-location, regenerate connection edges by proximity (≤300m).
"""

import json, math, os, re
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIONS_PATH = os.path.join(REPO, 'data', 'train-stations.json')
EDGES_PATH = os.path.join(REPO, 'data', 'train-edges.json')
OSM_PATH = os.path.join(REPO, 'data', 'osm-stations.json')

INTERCHANGE_RADIUS_M = 300

# Known interchanges keyed by canonical English name.
# Lists the OSM ref codes and the expected internal IDs.
# We use this only when the name match is unambiguous.
KNOWN_INTERCHANGES = {
    'Phaya Thai':           {'osm_refs': ['A8', 'N1'], 'osm_name': 'Phaya Thai'},
    'Bang Sue':             {'osm_refs': ['BL11'],    'osm_name': 'Bang Sue'},
    'Krung Thep Aphiwat':   {'osm_refs': ['กภ.'],     'osm_name': 'Krung Thep Aphiwat'},
    'Tao Poon':             {'osm_refs': ['BL10;PP16'], 'osm_name': 'Tao Poon'},
    'Mo Chit':              {'osm_refs': ['N8'],      'osm_name': 'Mo Chit'},
    'Siam':                 {'osm_refs': ['CEN'],     'osm_name': 'Siam'},
    'Asok':                 {'osm_refs': ['E4'],      'osm_name': 'Asok'},
    'Sukhumvit':            {'osm_refs': ['BL22'],    'osm_name': 'Sukhumvit'},
    'Lat Phrao':            {'osm_refs': ['BL15'],    'osm_name': 'Lat Phrao'},
    'Wat Phra Sri Mahathat':{'osm_refs': ['N17', 'PK16'], 'osm_name': 'Wat Phra Sri Mahathat'},
    'Bang Wa':              {'osm_refs': ['BL36'],    'osm_name': 'Bang Wa'},
    'Samrong':              {'osm_refs': ['E15'],     'osm_name': 'Samrong'},
    'Chatuchak Park':       {'osm_refs': ['BL13'],    'osm_name': 'Chatuchak Park'},
    'Bang Sue Junction':    {'osm_refs': ['บซ.'],     'osm_name': 'Bang Sue Junction'},
    'Krung Thon Buri':      {'osm_refs': ['S8'],      'osm_name': 'Krung Thon Buri'},
    'Hua Mak':              {'osm_refs': ['A5'],      'osm_name': 'Hua Mak'},
    'Phra Khanong':         {'osm_refs': ['E8'],      'osm_name': 'Phra Khanong'},
    'Makkasan':             {'osm_refs': ['A6'],      'osm_name': 'Makkasan'},
    'Phetchaburi':          {'osm_refs': ['BL21'],    'osm_name': 'Phetchaburi'},
    'Sala Daeng':           {'osm_refs': ['S2'],      'osm_name': 'Sala Daeng'},
    'Si Lom':               {'osm_refs': ['BL26'],    'osm_name': 'Si Lom'},
    'National Stadium':     {'osm_refs': ['W1'],      'osm_name': 'National Stadium'},
}


def hav_m(a, b):
    R = 6371000
    dLat = math.radians(b[0] - a[0])
    dLng = math.radians(b[1] - a[1])
    d = (math.sin(dLat/2)**2 +
         math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) *
         math.sin(dLng/2)**2)
    return R * 2 * math.atan2(math.sqrt(d), math.sqrt(1-d))


def normalize(name):
    return re.sub(r'\s+', ' ', (name or '').strip().lower())


def main():
    with open(STATIONS_PATH) as f:
        data = json.load(f)
    with open(OSM_PATH) as f:
        osm = json.load(f)
    stations = data['stations']

    # Find OSM canonical coord for each known interchange name
    osm_by_name = {}
    for o in osm['stations']:
        n = normalize(o.get('name_en'))
        if n not in osm_by_name:
            osm_by_name[n] = o

    # Group internal stations by normalized name
    by_name = defaultdict(list)
    for sid, s in stations.items():
        n = normalize(s.get('name'))
        if n:
            by_name[n].append(sid)

    # Co-locate stations that share a normalized name AND that name appears
    # in our known interchange list. Only co-locate ACROSS DIFFERENT LINES —
    # same-line same-name pairs are data quality issues that need separate
    # treatment, not co-location.
    def cross_line_members(member_sids):
        lines = {stations[m]['line'] for m in member_sids}
        if len(lines) >= 2:
            # Group members by line and keep the closest member per line to the canonical
            return True
        return False

    snap_log = []
    for known_name, info in KNOWN_INTERCHANGES.items():
        norm_known = normalize(known_name)
        members = by_name.get(norm_known, [])
        if len(members) < 2:
            continue
        if not cross_line_members(members):
            continue  # all on same line — skip
        # Get canonical coord from OSM
        osm_match = osm_by_name.get(norm_known)
        if osm_match:
            canonical = (osm_match['lat'], osm_match['lon'])
        else:
            coords = [(stations[m]['lat'], stations[m]['lng']) for m in members]
            best = 0
            best_sum = float('inf')
            for i, c in enumerate(coords):
                ss = sum(hav_m(c, c2) for c2 in coords if c2 != c)
                if ss < best_sum:
                    best_sum, best = ss, i
            canonical = coords[best]

        # For each line, pick the closest internal ID to canonical (so we
        # don't pull multiple same-line stations to the same point).
        by_line = defaultdict(list)
        for m in members:
            by_line[stations[m]['line']].append(m)
        for line, mems in by_line.items():
            mems_sorted = sorted(mems, key=lambda mm:
                hav_m((stations[mm]['lat'], stations[mm]['lng']), canonical))
            chosen = mems_sorted[0]
            old = (stations[chosen]['lat'], stations[chosen]['lng'])
            shift = hav_m(old, canonical)
            stations[chosen]['lat'] = round(canonical[0], 5)
            stations[chosen]['lng'] = round(canonical[1], 5)
            snap_log.append((known_name, chosen, shift))

    # Also co-locate name-twin pairs across different lines if they're
    # already within 300m of each other (likely same physical interchange).
    pair_log = []
    for name, members in by_name.items():
        if len(members) < 2:
            continue
        if name in [normalize(n) for n in KNOWN_INTERCHANGES]:
            continue
        if not cross_line_members(members):
            continue
        # Pick closest internal ID per line
        by_line = defaultdict(list)
        for m in members:
            by_line[stations[m]['line']].append(m)
        # Get one representative per line (closest to others)
        reps = []
        for line, mems in by_line.items():
            if len(mems) == 1:
                reps.append(mems[0])
            else:
                # Multiple same-line same-name — pick the one closest to other-line members
                other_coords = []
                for line2, mems2 in by_line.items():
                    if line2 != line:
                        for m2 in mems2:
                            other_coords.append((stations[m2]['lat'], stations[m2]['lng']))
                if not other_coords:
                    reps.append(mems[0])
                    continue
                best_m = min(mems, key=lambda m:
                    min(hav_m((stations[m]['lat'], stations[m]['lng']), oc)
                        for oc in other_coords))
                reps.append(best_m)

        if len(reps) < 2:
            continue
        coords = [(stations[m]['lat'], stations[m]['lng']) for m in reps]
        max_d = max(hav_m(coords[i], coords[j])
                    for i in range(len(coords))
                    for j in range(i+1, len(coords)))
        if max_d <= INTERCHANGE_RADIUS_M:
            avg_lat = sum(c[0] for c in coords) / len(coords)
            avg_lng = sum(c[1] for c in coords) / len(coords)
            canonical = (round(avg_lat, 5), round(avg_lng, 5))
            for m in reps:
                old = (stations[m]['lat'], stations[m]['lng'])
                shift = hav_m(old, canonical)
                stations[m]['lat'] = canonical[0]
                stations[m]['lng'] = canonical[1]
                if shift > 1:
                    pair_log.append((name, m, shift))

    print("Co-located by known-interchange name:")
    for name, m, shift in snap_log:
        print(f"  {m:8s} shifted {shift:6.0f}m -> {name}")
    print(f"\nCo-located by name-twin proximity:")
    for name, m, shift in pair_log:
        print(f"  {m:8s} shifted {shift:6.0f}m -> {name}")
    print(f"\nTotal co-located: {len(snap_log) + len(pair_log)}")

    with open(STATIONS_PATH, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {STATIONS_PATH}")

    # Regenerate interchange edges by proximity
    with open(EDGES_PATH) as f:
        edges = json.load(f)
    link_edges = [e for e in edges if e.get('type') == 'link']

    link_pairs = set()
    for e in link_edges:
        link_pairs.add(tuple(sorted([e['from'], e['to']])))

    sids = list(stations.keys())
    new_conns = []
    for i, a in enumerate(sids):
        sa = stations[a]
        for b in sids[i+1:]:
            sb = stations[b]
            pair = tuple(sorted([a, b]))
            if pair in link_pairs:
                continue
            d = hav_m((sa['lat'], sa['lng']), (sb['lat'], sb['lng']))
            if d <= INTERCHANGE_RADIUS_M:
                # Same-line connection only if very close (likely a single
                # physical station modeled as two nodes, e.g. airport gate).
                if sa['line'] == sb['line'] and d > 100:
                    continue
                new_conns.append({'from': a, 'to': b, 'type': 'connection',
                                  'walk_m': round(d, 1)})

    new_edges = link_edges + new_conns
    with open(EDGES_PATH, 'w') as f:
        json.dump(new_edges, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {len(new_edges)} edges ({len(link_edges)} link + {len(new_conns)} connection)")

    print("\nInterchange edges by distance:")
    for e in sorted(new_conns, key=lambda x: x['walk_m']):
        sa = stations[e['from']]
        sb = stations[e['to']]
        print(f"  {e['walk_m']:5.0f}m  {e['from']:8s}({sa['name']:30s} {sa['line']:18s}) "
              f"↔ {e['to']:8s}({sb['name']:30s} {sb['line']:18s})")


if __name__ == '__main__':
    main()
