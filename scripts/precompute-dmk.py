#!/usr/bin/env python3
"""
Pre-compute multi-modal transit reachability from DMK airport.

Builds a unified graph from:
  - Rail network (train-stations.json + train-edges.json)
  - Bus network (GTFS stops.txt + stop_times.txt)
  - Boat network (osm-boat-routes.geojson piers + routes)
  - Walking transfers between modes (500m threshold)

Runs Dijkstra from DMK entry points to compute distance and time
to every reachable node. Also computes motorcycle taxi density grid.

Output: data/dmk-transit-reach.json
"""

import csv
import json
import math
import heapq
import os

# ============================================================
# Config
# ============================================================

DMK_LAT = 13.9133
DMK_LNG = 100.5957
DMK_STATION = 'rdn6'

# Grid for motorcycle density
GRID_ROWS = 60
GRID_COLS = 60
GRID_BOUNDS = {
    'minLat': 13.45, 'maxLat': 14.10,
    'minLng': 100.30, 'maxLng': 100.90
}

# Walking parameters
WALK_TRANSFER_MAX_M = 500  # max walking transfer between modes
BUS_ENTRY_RADIUS_KM = 2.0  # bus stops near DMK to seed
WALK_SPEED_KMH = 5.0

# Transit speeds (km/h)
RAIL_SPEED = 35.0
BUS_SPEED = 12.0
BOAT_SPEED = 15.0

# Paths (relative to repo root)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TRAIN_STATIONS_PATH = os.path.join(REPO_ROOT, 'data', 'train-stations.json')
TRAIN_EDGES_PATH = os.path.join(REPO_ROOT, 'data', 'train-edges.json')
GTFS_STOPS_PATH = os.path.join(REPO_ROOT, 'longdo data', 'longdo-share', 'stops.txt')
GTFS_STOP_TIMES_PATH = os.path.join(REPO_ROOT, 'longdo data', 'longdo-share', 'stop_times.txt')
BOAT_GEOJSON_PATH = os.path.join(REPO_ROOT, 'data', 'osm-boat-routes.geojson')
MOTO_CSV_PATH = os.path.join(REPO_ROOT, 'other', 'win data.csv')
OUTPUT_PATH = os.path.join(REPO_ROOT, 'data', 'dmk-transit-reach.json')


# ============================================================
# Geo utilities
# ============================================================

def haversine_km(lat1, lng1, lat2, lng2):
    R = 6371.0
    dLat = math.radians(lat2 - lat1)
    dLng = math.radians(lng2 - lng1)
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def haversine_m(lat1, lng1, lat2, lng2):
    return haversine_km(lat1, lng1, lat2, lng2) * 1000


# ============================================================
# 1. Load rail network
# ============================================================

def load_rail():
    """Returns nodes dict {id: (lat, lng)} and edges list [(from, to, km)]."""
    with open(TRAIN_STATIONS_PATH) as f:
        data = json.load(f)

    nodes = {}
    for sid, s in data['stations'].items():
        nodes[f'rail_{sid}'] = (s['lat'], s['lng'])

    with open(TRAIN_EDGES_PATH) as f:
        edges_raw = json.load(f)

    edges = []
    for e in edges_raw:
        fid = f"rail_{e['from']}"
        tid = f"rail_{e['to']}"
        if fid not in nodes or tid not in nodes:
            continue
        km = haversine_km(nodes[fid][0], nodes[fid][1],
                          nodes[tid][0], nodes[tid][1])
        # Interchange penalty (walking between stations)
        penalty = 0.3 if e['type'] == 'connection' else 0.0
        edges.append((fid, tid, km + penalty))

    print(f"Rail: {len(nodes)} stations, {len(edges)} edges")
    return nodes, edges


# ============================================================
# 2. Load bus network from GTFS
# ============================================================

def load_bus():
    """Parse GTFS stops + stop_times to build bus network."""
    # Load stops
    stops = {}
    with open(GTFS_STOPS_PATH, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            sid = row['stop_id'].strip('"')
            lat = float(row['stop_lat'].strip('"'))
            lng = float(row['stop_lon'].strip('"'))
            stops[sid] = (lat, lng)

    # Load stop_times, group by trip_id
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

    # Build edges: consecutive stops on same trip
    edge_set = set()
    for trip_id, stop_list in trips.items():
        stop_list.sort(key=lambda x: x[0])
        for i in range(len(stop_list) - 1):
            s1 = stop_list[i][1]
            s2 = stop_list[i + 1][1]
            if s1 in stops and s2 in stops:
                # Deduplicate: use frozenset for undirected, but keep directed
                edge_set.add((s1, s2))

    # Build nodes and edges with distances
    nodes = {}
    edges = []
    used_stops = set()

    for s1, s2 in edge_set:
        used_stops.add(s1)
        used_stops.add(s2)
        km = haversine_km(stops[s1][0], stops[s1][1],
                          stops[s2][0], stops[s2][1])
        edges.append((f'bus_{s1}', f'bus_{s2}', km))

    for sid in used_stops:
        nodes[f'bus_{sid}'] = stops[sid]

    print(f"Bus: {len(nodes)} stops, {len(edges)} edges")
    return nodes, edges


# ============================================================
# 3. Load boat network
# ============================================================

def load_boat():
    """Parse boat piers and routes, create pier-to-pier edges along routes."""
    with open(BOAT_GEOJSON_PATH) as f:
        data = json.load(f)

    piers = []
    routes = []
    for feat in data['features']:
        geom = feat['geometry']
        props = feat['properties']
        if geom['type'] == 'Point':
            lng, lat = geom['coordinates']
            name = props.get('name', '')
            piers.append({'lat': lat, 'lng': lng, 'name': name})
        elif geom['type'] == 'LineString':
            route_id = props.get('routeId', 'unknown')
            coords = [(c[1], c[0]) for c in geom['coordinates']]  # lat, lng
            routes.append({'routeId': route_id, 'coords': coords, 'name': props.get('name', '')})

    # Assign piers to routes by proximity
    # For each route, find piers within 300m, then order by position along route
    nodes = {}
    edges = []
    pier_id = 0

    for route in routes:
        route_coords = route['coords']
        # Find piers near this route
        nearby_piers = []
        for pier in piers:
            # Find closest point on route
            min_dist = float('inf')
            best_pos = 0  # position along route (cumulative distance)
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

            if min_dist < 300:  # within 300m of route
                nearby_piers.append({
                    'pier': pier,
                    'dist_to_route': min_dist,
                    'pos': best_pos
                })

        # Sort by position along route
        nearby_piers.sort(key=lambda x: x['pos'])

        # Create sequential edges
        route_node_ids = []
        for np in nearby_piers:
            p = np['pier']
            nid = f"boat_{pier_id}"
            pier_id += 1
            nodes[nid] = (p['lat'], p['lng'])
            route_node_ids.append(nid)

        for i in range(len(route_node_ids) - 1):
            n1 = route_node_ids[i]
            n2 = route_node_ids[i + 1]
            km = haversine_km(nodes[n1][0], nodes[n1][1],
                              nodes[n2][0], nodes[n2][1])
            edges.append((n1, n2, km))

    # Deduplicate piers at same location (merge within 50m)
    # Simple approach: keep all, let walking transfers connect them
    print(f"Boat: {len(nodes)} pier-nodes, {len(edges)} edges across {len(routes)} routes")
    return nodes, edges


# ============================================================
# 4. Build unified graph with walking transfers
# ============================================================

def build_spatial_grid(all_nodes, cell_size_deg=0.005):
    """Spatial grid index for efficient proximity queries."""
    grid = {}
    for nid, (lat, lng) in all_nodes.items():
        r = int(lat / cell_size_deg)
        c = int(lng / cell_size_deg)
        key = (r, c)
        if key not in grid:
            grid[key] = []
        grid[key].append(nid)
    return grid


def find_nearby_nodes(grid, all_nodes, lat, lng, max_m, cell_size_deg=0.005):
    """Find nodes within max_m meters using spatial grid."""
    r = int(lat / cell_size_deg)
    c = int(lng / cell_size_deg)
    results = []
    # Check 3x3 neighborhood
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            key = (r + dr, c + dc)
            for nid in grid.get(key, []):
                nlat, nlng = all_nodes[nid]
                d = haversine_m(lat, lng, nlat, nlng)
                if d <= max_m:
                    results.append((nid, d))
    return results


def build_walking_transfers(all_nodes, spatial_grid):
    """Connect nodes from different modes within 500m walking distance."""
    edges = []
    seen = set()

    for nid, (lat, lng) in all_nodes.items():
        mode = nid.split('_')[0]
        nearby = find_nearby_nodes(spatial_grid, all_nodes, lat, lng,
                                   WALK_TRANSFER_MAX_M)
        for other_id, dist_m in nearby:
            if other_id == nid:
                continue
            other_mode = other_id.split('_')[0]
            # Only cross-mode transfers (bus-rail, bus-boat, rail-boat)
            # Also same-mode transfers for bus (different routes share stops)
            if mode == other_mode and mode != 'bus':
                continue
            pair = tuple(sorted([nid, other_id]))
            if pair in seen:
                continue
            seen.add(pair)
            km = dist_m / 1000.0
            edges.append((nid, other_id, km))

    print(f"Walking transfers: {len(edges)} edges")
    return edges


# ============================================================
# 5. Multi-modal Dijkstra
# ============================================================

def build_adjacency(all_edges):
    """Build adjacency list from edge list. Bidirectional."""
    adj = {}
    for a, b, km in all_edges:
        if a not in adj:
            adj[a] = []
        if b not in adj:
            adj[b] = []
        adj[a].append((b, km))
        adj[b].append((a, km))
    return adj


def get_speed(node_id):
    """Return speed in km/h based on node mode."""
    mode = node_id.split('_')[0]
    if mode == 'rail':
        return RAIL_SPEED
    elif mode == 'bus':
        return BUS_SPEED
    elif mode == 'boat':
        return BOAT_SPEED
    else:
        return WALK_SPEED_KMH


def dijkstra_multimodal(adj, all_nodes, start_entries):
    """
    Run Dijkstra from multiple start points.
    start_entries: list of (node_id, initial_km, initial_time_min)
    Returns: {node_id: (distance_km, time_min)}
    """
    # Track both distance and time
    dist = {}  # node_id -> (km, time_min)
    pq = []  # (km, node_id)  -- distance-based priority

    for nid, init_km, init_time in start_entries:
        if nid in adj or nid in all_nodes:
            dist[nid] = (init_km, init_time)
            heapq.heappush(pq, (init_km, nid))

    visited = set()

    while pq:
        d, u = heapq.heappop(pq)
        if u in visited:
            continue
        visited.add(u)

        for v, edge_km in adj.get(u, []):
            # Time for this edge depends on mode of the target node
            # For walking transfers, use walk speed
            u_mode = u.split('_')[0]
            v_mode = v.split('_')[0]

            if u_mode != v_mode:
                # Walking transfer
                edge_time = (edge_km / WALK_SPEED_KMH) * 60
            else:
                speed = get_speed(v)
                edge_time = (edge_km / speed) * 60

            new_km = dist[u][0] + edge_km
            new_time = dist[u][1] + edge_time

            if v not in dist or new_km < dist[v][0]:
                dist[v] = (new_km, new_time)
                heapq.heappush(pq, (new_km, v))

    return dist


# ============================================================
# 6. Motorcycle density grid
# ============================================================

def compute_moto_density():
    """Read motorcycle taxi stand data and compute density grid."""
    stands = []
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

    print(f"Motorcycle stands: {len(stands)}")

    lat_step = (GRID_BOUNDS['maxLat'] - GRID_BOUNDS['minLat']) / GRID_ROWS
    lng_step = (GRID_BOUNDS['maxLng'] - GRID_BOUNDS['minLng']) / GRID_COLS

    # Build spatial index for stands
    grid = []
    max_density = 0

    for r in range(GRID_ROWS):
        row = []
        lat = GRID_BOUNDS['minLat'] + (r + 0.5) * lat_step
        for c in range(GRID_COLS):
            lng = GRID_BOUNDS['minLng'] + (c + 0.5) * lng_step
            # Count stands within 500m and sum drivers
            density = 0
            for slat, slng, drivers in stands:
                d = haversine_m(lat, lng, slat, slng)
                if d <= 500:
                    density += drivers
            row.append(density)
            if density > max_density:
                max_density = density
        grid.append(row)

    # Normalize to 0-1
    if max_density > 0:
        for r in range(GRID_ROWS):
            for c in range(GRID_COLS):
                grid[r][c] = round(grid[r][c] / max_density, 3)

    return grid


# ============================================================
# 7. Main: build graph, run Dijkstra, output JSON
# ============================================================

def main():
    print("=" * 60)
    print("Pre-computing DMK multi-modal transit reachability")
    print("=" * 60)

    # Load networks
    rail_nodes, rail_edges = load_rail()
    bus_nodes, bus_edges = load_bus()
    boat_nodes, boat_edges = load_boat()

    # Merge all nodes
    all_nodes = {}
    all_nodes.update(rail_nodes)
    all_nodes.update(bus_nodes)
    all_nodes.update(boat_nodes)
    print(f"\nTotal nodes: {len(all_nodes)}")

    # Build spatial grid for transfer computation
    spatial_grid = build_spatial_grid(all_nodes)

    # Walking transfers
    walk_edges = build_walking_transfers(all_nodes, spatial_grid)

    # All edges
    all_edges = rail_edges + bus_edges + boat_edges + walk_edges
    print(f"Total edges: {len(all_edges)}")

    # Build adjacency
    adj = build_adjacency(all_edges)

    # --- Seed Dijkstra from DMK ---
    # Entry points:
    #   1) rail_rdn6 (Don Mueang station) with 0 km (airport is at station)
    #   2) Nearby bus stops within 2km walking radius of DMK
    start_entries = []

    # Rail entry
    rail_dmk = f'rail_{DMK_STATION}'
    if rail_dmk in all_nodes:
        start_entries.append((rail_dmk, 0.0, 0.0))
        print(f"\nRail entry: {rail_dmk}")

    # DMK node itself
    rail_dmk_node = 'rail_dmk'
    if rail_dmk_node in all_nodes:
        dmk_to_rdn6 = haversine_km(DMK_LAT, DMK_LNG,
                                     all_nodes[rail_dmk_node][0],
                                     all_nodes[rail_dmk_node][1])
        start_entries.append((rail_dmk_node, dmk_to_rdn6,
                              (dmk_to_rdn6 / WALK_SPEED_KMH) * 60))

    # Bus entries near DMK
    bus_entries = 0
    for nid, (lat, lng) in all_nodes.items():
        if not nid.startswith('bus_'):
            continue
        d = haversine_km(DMK_LAT, DMK_LNG, lat, lng)
        if d <= BUS_ENTRY_RADIUS_KM:
            walk_time = (d / WALK_SPEED_KMH) * 60
            start_entries.append((nid, d, walk_time))
            bus_entries += 1

    print(f"Bus entries near DMK: {bus_entries}")

    # Boat entries near DMK (unlikely but check)
    boat_entries = 0
    for nid, (lat, lng) in all_nodes.items():
        if not nid.startswith('boat_'):
            continue
        d = haversine_km(DMK_LAT, DMK_LNG, lat, lng)
        if d <= BUS_ENTRY_RADIUS_KM:
            walk_time = (d / WALK_SPEED_KMH) * 60
            start_entries.append((nid, d, walk_time))
            boat_entries += 1
    print(f"Boat entries near DMK: {boat_entries}")

    print(f"\nTotal Dijkstra start entries: {len(start_entries)}")
    print("Running Dijkstra...")

    results = dijkstra_multimodal(adj, all_nodes, start_entries)
    print(f"Reachable nodes: {len(results)}")

    # --- Separate results by mode ---
    bus_stops = []
    boat_piers = []
    rail_stations = []

    for nid, (km, time_min) in results.items():
        if km == float('inf'):
            continue
        lat, lng = all_nodes[nid]
        entry = [round(lat, 5), round(lng, 5), round(km, 2), round(time_min, 1)]
        if nid.startswith('bus_'):
            bus_stops.append(entry)
        elif nid.startswith('boat_'):
            boat_piers.append(entry)
        elif nid.startswith('rail_'):
            rail_stations.append(entry)

    print(f"\nReachable bus stops: {len(bus_stops)}")
    print(f"Reachable boat piers: {len(boat_piers)}")
    print(f"Reachable rail stations: {len(rail_stations)}")

    # --- Motorcycle density ---
    print("\nComputing motorcycle density grid...")
    moto_density = compute_moto_density()

    # --- Output ---
    output = {
        'bus_stops': bus_stops,
        'boat_piers': boat_piers,
        'rail_stations': rail_stations,
        'moto_density': moto_density,
        'metadata': {
            'origin': 'DMK Airport',
            'origin_lat': DMK_LAT,
            'origin_lng': DMK_LNG,
            'grid_bounds': GRID_BOUNDS,
            'grid_rows': GRID_ROWS,
            'grid_cols': GRID_COLS,
        }
    }

    with open(OUTPUT_PATH, 'w') as f:
        json.dump(output, f, separators=(',', ':'))

    file_size = os.path.getsize(OUTPUT_PATH)
    print(f"\nOutput: {OUTPUT_PATH}")
    print(f"File size: {file_size / 1024:.1f} KB")
    print("Done!")


if __name__ == '__main__':
    main()
