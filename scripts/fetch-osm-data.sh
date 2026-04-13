#!/bin/bash
# Fetch Bangkok transit data from OpenStreetMap Overpass API
# Run this script to regenerate the GeoJSON files in data/
# Requires: curl, osmtogeojson (npm install -g osmtogeojson)

set -e

# Rail lines (subway + monorail + train)
echo "Fetching rail routes..."
curl -s --max-time 120 -X POST 'https://overpass-api.de/api/interpreter' \
  --data-urlencode 'data=[out:json][timeout:90];(relation["route"="subway"](13.5,100.3,14.1,100.9);relation["route"="light_rail"](13.5,100.3,14.1,100.9);relation["route"~"train|railway|monorail"](13.5,100.3,14.1,100.9););out body;>;out skel qt;' \
  -o /tmp/osm-rail-raw.json
echo "Rail data: $(wc -c < /tmp/osm-rail-raw.json) bytes"

# Boat routes and piers
echo "Fetching boat routes..."
curl -s --max-time 120 -X POST 'https://overpass-api.de/api/interpreter' \
  --data-urlencode 'data=[out:json][timeout:90];(node["amenity"="ferry_terminal"](13.5,100.4,13.9,100.7);relation["route"="ferry"](13.5,100.4,13.9,100.7);way["route"="ferry"](13.5,100.4,13.9,100.7););out body;>;out skel qt;' \
  -o /tmp/osm-boat-raw.json
echo "Boat data: $(wc -c < /tmp/osm-boat-raw.json) bytes"

echo "Done. Process with Python scripts to generate data/osm-rail-routes.geojson and data/osm-boat-routes.geojson"
