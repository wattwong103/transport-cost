#!/usr/bin/env python3
"""
Build a compact transit graph JSON for client-side Dijkstra.

Loads rail, bus, and boat networks, builds walking transfers between modes,
identifies bus-rail interchanges, and exports everything as a single JSON
file loadable by the browser.

Output: data/transit-graph.json
"""

import csv
import json
import math
import os
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TRAIN_STATIONS_PATH = os.path.join(REPO, 'data', 'train-stations.json')
TRAIN_EDGES_PATH = os.path.join(REPO, 'data', 'train-edges.json')
GTFS_STOPS_PATH = os.path.join(REPO, 'longdo data', 'longdo-share', 'stops.txt')
GTFS_STOP_TIMES_PATH = os.path.join(REPO, 'longdo data', 'longdo-share', 'stop_times.txt')
BUS_STOPS_GEOJSON_PATH = os.path.join(REPO, 'longdo data', 'longdomap-bus-gtfs', 'stops.geojson')
BOAT_GEOJSON_PATH = os.path.join(REPO, 'data', 'osm-boat-routes.geojson')
MOTO_CSV_PATH = os.path.join(REPO, 'other', 'win data.csv')
OUTPUT_PATH = os.path.join(REPO, 'data', 'transit-graph.json')

WALK_TRANSFER_MAX_M = 500
INTERCHANGE_RADIUS_M = 300
GRID_ROWS = 60
GRID_COLS = 60
GRID_BOUNDS = {
    'minLat': 13.45, 'maxLat': 14.10,
    'minLng': 100.30, 'maxLng': 100.90
}

LINE_TO_MODE = {
    'blue': 'mrt_blue',
    'purple': 'mrt_purple',
    'green_sukhumvit': 'bts',
    'green_silom': 'bts',
    'airport': 'arl',
    'yellow': 'mrt_yellow',
    'pink': 'mrt_pink',
    'red_north': 'srt_red',
    'red_west': 'srt_red',
    'gold': 'gold',
}


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    dLat = math.radians(lat2 - lat1)
    dLng = math.radians(lng2 - lng1)
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def haversine_km(lat1, lng1, lat2, lng2):
    return haversine_m(lat1, lng1, lat2, lng2) / 1000.0


# ============================================================
# Load networks
# ============================================================

def load_rail():
    with open(TRAIN_STATIONS_PATH) as f:
        data = json.load(f)
    nodes = {}
    node_meta = {}
    for sid, s in data['stations'].items():
        nid = f'rail_{sid}'
        nodes[nid] = (s['lat'], s['lng'])
        node_meta[nid] = {
            'name': s.get('name', ''),
            'nameTh': s.get('nameTh', ''),
            'line': s['line'],
            'mode': LINE_TO_MODE.get(s['line'], 'rail'),
        }

    with open(TRAIN_EDGES_PATH) as f:
        edges_raw = json.load(f)
    edges = []
    for e in edges_raw:
        fid, tid = f"rail_{e['from']}", f"rail_{e['to']}"
        if fid not in nodes or tid not in nodes:
            continue
        km = haversine_km(*nodes[fid], *nodes[tid])
        etype = 'connection' if e['type'] == 'connection' else 'link'
        penalty = 0.3 if etype == 'connection' else 0.0
        edges.append((fid, tid, km + penalty, etype))

    print(f"Rail: {len(nodes)} stations, {len(edges)} edges")
    return nodes, node_meta, edges


def load_bus():
    stops = {}
    with open(GTFS_STOPS_PATH, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            sid = row['stop_id'].strip('"')
            lat = float(row['stop_lat'].strip('"'))
            lng = float(row['stop_lon'].strip('"'))
            name = row.get('stop_name', '').strip('"')
            stops[sid] = (lat, lng, name)

    trips = {}
    with open(GTFS_STOP_TIMES_PATH, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            trip_id = row['trip_id'].strip('"')
            stop_id = row['stop_id'].strip('"')
            seq = int(row['stop_sequence'].strip('"'))
            if trip_id not in trips:
                trips[trip_id] = []
            trips[trip_id].append((seq, stop_id))

    edge_set = set()
    for trip_id, stop_list in trips.items():
        stop_list.sort(key=lambda x: x[0])
        for i in range(len(stop_list) - 1):
            s1, s2 = stop_list[i][1], stop_list[i + 1][1]
            if s1 in stops and s2 in stops:
                edge_set.add((s1, s2))

    nodes = {}
    node_meta = {}
    used_stops = set()
    edges = []

    for s1, s2 in edge_set:
        used_stops.add(s1)
        used_stops.add(s2)
        n1, n2 = f'bus_{s1}', f'bus_{s2}'
        km = haversine_km(stops[s1][0], stops[s1][1], stops[s2][0], stops[s2][1])
        edges.append((n1, n2, km, 'bus'))

    for sid in used_stops:
        nid = f'bus_{sid}'
        nodes[nid] = (stops[sid][0], stops[sid][1])
        node_meta[nid] = {'name': stops[sid][2], 'mode': 'bus'}

    print(f"Bus: {len(nodes)} stops, {len(edges)} edges")
    return nodes, node_meta, edges


def load_bus_route_ids():
    """Load bus stop → route_ids mapping from stops.geojson for interchange data."""
    route_ids_by_stop = {}
    try:
        with open(BUS_STOPS_GEOJSON_PATH) as f:
            data = json.load(f)
        for feat in data['features']:
            props = feat['properties']
            sid = props.get('stop_id', '')
            rids = props.get('route_ids', [])
            if sid and rids:
                route_ids_by_stop[f'bus_{sid}'] = rids
    except FileNotFoundError:
        print("  Warning: stops.geojson not found, skipping route_ids")
    return route_ids_by_stop


def load_boat():
    with open(BOAT_GEOJSON_PATH) as f:
        data = json.load(f)

    piers = []
    routes = []
    for feat in data['features']:
        geom = feat['geometry']
        props = feat['properties']
        if geom['type'] == 'Point':
            lng, lat = geom['coordinates']
            piers.append({'lat': lat, 'lng': lng, 'name': props.get('name', '')})
        elif geom['type'] == 'LineString':
            route_id = props.get('routeId', 'unknown')
            coords = [(c[1], c[0]) for c in geom['coordinates']]
            routes.append({'routeId': route_id, 'coords': coords, 'name': props.get('name', '')})

    nodes = {}
    node_meta = {}
    edges = []
    pier_id = 0

    for route in routes:
        route_coords = route['coords']
        nearby_piers = []
        for pier in piers:
            min_dist = float('inf')
            best_pos = 0
            cum_dist = 0
            for i in range(len(route_coords)):
                d = haversine_m(pier['lat'], pier['lng'],
                                route_coords[i][0], route_coords[i][1])
                if d < min_dist:
                    min_dist = d
                    best_pos = cum_dist
                if i > 0:
                    cum_dist += haversine_m(route_coords[i-1][0], route_coords[i-1][1],
                                            route_coords[i][0], route_coords[i][1])
            if min_dist < 300:
                nearby_piers.append({'pier': pier, 'dist_to_route': min_dist, 'pos': best_pos})

        nearby_piers.sort(key=lambda x: x['pos'])
        route_node_ids = []
        for np_item in nearby_piers:
            p = np_item['pier']
            nid = f"boat_{pier_id}"
            pier_id += 1
            nodes[nid] = (p['lat'], p['lng'])
            node_meta[nid] = {'name': p['name'], 'mode': 'boat'}
            route_node_ids.append(nid)

        for i in range(len(route_node_ids) - 1):
            n1, n2 = route_node_ids[i], route_node_ids[i + 1]
            km = haversine_km(*nodes[n1], *nodes[n2])
            edges.append((n1, n2, km, 'boat'))

    print(f"Boat: {len(nodes)} pier-nodes, {len(edges)} edges across {len(routes)} routes")
    return nodes, node_meta, edges


# ============================================================
# Walking transfers + spatial index
# ============================================================

def build_spatial_grid(all_nodes, cell_size=0.005):
    grid = defaultdict(list)
    for nid, (lat, lng) in all_nodes.items():
        r = int(lat / cell_size)
        c = int(lng / cell_size)
        grid[(r, c)].append(nid)
    return grid


def build_walking_transfers(all_nodes, spatial_grid):
    edges = []
    seen = set()
    for nid, (lat, lng) in all_nodes.items():
        mode = nid.split('_')[0]
        r = int(lat / 0.005)
        c = int(lng / 0.005)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                for other_id in spatial_grid.get((r + dr, c + dc), []):
                    if other_id == nid:
                        continue
                    other_mode = other_id.split('_')[0]
                    if mode == other_mode and mode != 'bus':
                        continue
                    pair = tuple(sorted([nid, other_id]))
                    if pair in seen:
                        continue
                    dist_m = haversine_m(lat, lng, *all_nodes[other_id])
                    if dist_m <= WALK_TRANSFER_MAX_M:
                        seen.add(pair)
                        edges.append((nid, other_id, dist_m / 1000.0, 'walk'))
    print(f"Walking transfers: {len(edges)} edges")
    return edges


# ============================================================
# Bus-rail interchanges
# ============================================================

def identify_interchanges(all_nodes, node_meta, spatial_grid, bus_route_ids):
    interchanges = []
    rail_nodes = {nid for nid in all_nodes if nid.startswith('rail_')}

    for rail_nid in sorted(rail_nodes):
        lat, lng = all_nodes[rail_nid]
        meta = node_meta[rail_nid]
        name = meta.get('name', '')
        if not name:
            continue

        r = int(lat / 0.005)
        c = int(lng / 0.005)
        nearby_bus = []
        bus_routes = set()
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                for other_id in spatial_grid.get((r + dr, c + dc), []):
                    if not other_id.startswith('bus_'):
                        continue
                    dist_m = haversine_m(lat, lng, *all_nodes[other_id])
                    if dist_m <= INTERCHANGE_RADIUS_M:
                        nearby_bus.append(other_id)
                        rids = bus_route_ids.get(other_id, [])
                        bus_routes.update(rids)

        if len(nearby_bus) >= 1:
            # Find other rail stations at this interchange
            rail_ids_here = [rail_nid]
            for other_rail in rail_nodes:
                if other_rail == rail_nid:
                    continue
                dist_m = haversine_m(lat, lng, *all_nodes[other_rail])
                if dist_m <= INTERCHANGE_RADIUS_M:
                    rail_ids_here.append(other_rail)

            interchanges.append({
                'name': name,
                'nameTh': meta.get('nameTh', ''),
                'lat': round(lat, 5),
                'lng': round(lng, 5),
                'railIds': rail_ids_here,
                'busStops': len(nearby_bus),
                'busRoutes': len(bus_routes),
                'line': meta.get('line', ''),
            })

    # Deduplicate by location (multiple rail stations at same interchange)
    deduped = {}
    for ix in interchanges:
        key = (round(ix['lat'], 3), round(ix['lng'], 3))
        if key not in deduped or ix['busRoutes'] > deduped[key]['busRoutes']:
            if key in deduped:
                # Merge rail IDs
                existing_rail = set(deduped[key]['railIds'])
                existing_rail.update(ix['railIds'])
                ix['railIds'] = sorted(existing_rail)
                ix['busStops'] = max(ix['busStops'], deduped[key]['busStops'])
                ix['busRoutes'] = max(ix['busRoutes'], deduped[key]['busRoutes'])
            deduped[key] = ix

    result = sorted(deduped.values(), key=lambda x: -x['busRoutes'])
    print(f"\nBus-rail interchanges: {len(result)}")
    for ix in result[:20]:
        print(f"  {ix['name']:25s} | {ix['busStops']:3d} bus stops | {ix['busRoutes']:3d} routes | rail: {', '.join(ix['railIds'])}")

    return result


# ============================================================
# Motorcycle density grid
# ============================================================

def compute_moto_density():
    stands = []
    try:
        with open(MOTO_CSV_PATH, encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    lat = float(row['ycoord'])
                    lng = float(row['xcoord'])
                    drivers = int(row['num_driver'])
                    stands.append((lat, lng, drivers))
                except (ValueError, KeyError):
                    continue
    except FileNotFoundError:
        print("Warning: motorcycle data not found, using empty grid")
        return [[0] * GRID_COLS for _ in range(GRID_ROWS)]

    print(f"Motorcycle stands: {len(stands)}")
    lat_step = (GRID_BOUNDS['maxLat'] - GRID_BOUNDS['minLat']) / GRID_ROWS
    lng_step = (GRID_BOUNDS['maxLng'] - GRID_BOUNDS['minLng']) / GRID_COLS

    grid = []
    max_density = 0
    for r in range(GRID_ROWS):
        row = []
        lat = GRID_BOUNDS['minLat'] + (r + 0.5) * lat_step
        for c in range(GRID_COLS):
            lng = GRID_BOUNDS['minLng'] + (c + 0.5) * lng_step
            density = 0
            for slat, slng, drivers in stands:
                if haversine_m(lat, lng, slat, slng) <= 500:
                    density += drivers
            row.append(density)
            if density > max_density:
                max_density = density
        grid.append(row)

    if max_density > 0:
        for r in range(GRID_ROWS):
            for c in range(GRID_COLS):
                grid[r][c] = round(grid[r][c] / max_density, 3)

    return grid


# ============================================================
# Graph connectivity check
# ============================================================

def check_connectivity(nodes, edges):
    adj = defaultdict(set)
    for a, b, km, etype in edges:
        if a in nodes and b in nodes:
            adj[a].add(b)
            adj[b].add(a)

    rail_nodes = [n for n in nodes if n.startswith('rail_')]
    if not rail_nodes:
        return

    visited = set()
    stack = [rail_nodes[0]]
    while stack:
        n = stack.pop()
        if n in visited:
            continue
        visited.add(n)
        for nb in adj[n]:
            if nb not in visited:
                stack.append(nb)

    rail_visited = [n for n in rail_nodes if n in visited]
    rail_unreachable = [n for n in rail_nodes if n not in visited]
    print(f"\nConnectivity: {len(rail_visited)}/{len(rail_nodes)} rail stations reachable from {rail_nodes[0]}")
    if rail_unreachable:
        print(f"  Unreachable: {rail_unreachable[:10]}")


# ============================================================
# Export
# ============================================================

def export_graph(all_nodes, node_meta, all_edges, interchanges, moto_density):
    node_ids = sorted(all_nodes.keys())
    id_to_idx = {nid: i for i, nid in enumerate(node_ids)}

    # Mode codes: r=rail, b=bus, o=boat
    MODE_SHORT = {'rail': 'r', 'bus': 'b', 'boat': 'o',
                  'mrt_blue': 'r', 'mrt_purple': 'r', 'bts': 'r',
                  'arl': 'r', 'mrt_yellow': 'r', 'mrt_pink': 'r',
                  'srt_red': 'r', 'gold': 'r'}
    # Edge type codes
    ETYPE_SHORT = {'link': 'l', 'connection': 'c', 'bus': 'b', 'boat': 'o', 'walk': 'w'}

    # Compact nodes: [lat, lng, mode_short]  for bus/boat
    #                [lat, lng, mode_short, name, line] for rail
    nodes_out = []
    for nid in node_ids:
        lat, lng = all_nodes[nid]
        meta = node_meta.get(nid, {})
        raw_mode = meta.get('mode', nid.split('_')[0])
        ms = MODE_SHORT.get(raw_mode, raw_mode[0])
        if ms == 'r':
            name = meta.get('name', '') or ''
            line = meta.get('line', '') or ''
            nodes_out.append([round(lat, 5), round(lng, 5), ms, name, line])
        else:
            nodes_out.append([round(lat, 5), round(lng, 5), ms])

    # Compact edges: [from_idx, to_idx, km_x1000, type_short]
    # Store km as integer millimeters to save space
    edges_out = []
    for a, b, km, etype in all_edges:
        ai = id_to_idx.get(a)
        bi = id_to_idx.get(b)
        if ai is not None and bi is not None:
            es = ETYPE_SHORT.get(etype, etype[0])
            edges_out.append([ai, bi, round(km * 1000), es])

    interchanges_out = []
    for ix in interchanges:
        rail_indices = [id_to_idx[rid] for rid in ix['railIds'] if rid in id_to_idx]
        interchanges_out.append({
            'name': ix['name'],
            'nameTh': ix['nameTh'],
            'lat': ix['lat'],
            'lng': ix['lng'],
            'railIds': rail_indices,
            'busStops': ix['busStops'],
            'busRoutes': ix['busRoutes'],
        })

    output = {
        'nodes': nodes_out,
        'edges': edges_out,
        'interchanges': interchanges_out,
        'motoDensity': moto_density,
        'gridBounds': GRID_BOUNDS,
    }

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, separators=(',', ':'), ensure_ascii=False)

    file_size = os.path.getsize(OUTPUT_PATH)
    print(f"\nExported: {len(nodes_out)} nodes, {len(edges_out)} edges")
    print(f"Interchanges: {len(interchanges_out)}")
    print(f"File size: {file_size / 1024:.1f} KB")
    print(f"Output: {OUTPUT_PATH}")
    return output


def main():
    print("=" * 60)
    print("Building transit graph for client-side routing")
    print("=" * 60)

    rail_nodes, rail_meta, rail_edges = load_rail()
    bus_nodes, bus_meta, bus_edges = load_bus()
    boat_nodes, boat_meta, boat_edges = load_boat()
    bus_route_ids = load_bus_route_ids()

    all_nodes = {}
    all_nodes.update(rail_nodes)
    all_nodes.update(bus_nodes)
    all_nodes.update(boat_nodes)

    all_meta = {}
    all_meta.update(rail_meta)
    all_meta.update(bus_meta)
    all_meta.update(boat_meta)

    print(f"\nTotal nodes: {len(all_nodes)}")

    spatial_grid = build_spatial_grid(all_nodes)
    walk_edges = build_walking_transfers(all_nodes, spatial_grid)

    all_edges = rail_edges + bus_edges + boat_edges + walk_edges
    print(f"Total edges: {len(all_edges)}")

    check_connectivity(all_nodes, all_edges)

    interchanges = identify_interchanges(all_nodes, all_meta, spatial_grid, bus_route_ids)

    print("\nComputing motorcycle density grid...")
    moto = compute_moto_density()

    export_graph(all_nodes, all_meta, all_edges, interchanges, moto)
    print("\nDone!")


if __name__ == '__main__':
    main()
