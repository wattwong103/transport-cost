#!/usr/bin/env python3
"""
Fetch Bangkok transit station coordinates from Wikidata SPARQL.
Cross-check source for OSM data. Output: data/wikidata-stations.json.
"""

import json, os, sys
import urllib.request, urllib.parse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(REPO, 'data', 'wikidata-stations.json')

SPARQL = """
SELECT ?station ?stationLabel ?stationLabel_th ?coord ?code ?line ?lineLabel WHERE {
  ?station wdt:P17 wd:Q869 ;      # country = Thailand
           wdt:P625 ?coord .      # has coordinates
  {
    ?station wdt:P31/wdt:P279* wd:Q55488 .   # subclass of railway station
  } UNION {
    ?station wdt:P31/wdt:P279* wd:Q928830 .  # metro station
  } UNION {
    ?station wdt:P31/wdt:P279* wd:Q18516847 .  # rapid transit station
  }
  OPTIONAL { ?station wdt:P296 ?code. }
  OPTIONAL { ?station wdt:P81 ?line. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,th" . }
}
"""

WD_URL = 'https://query.wikidata.org/sparql'


def parse_point(p):
    # format: "Point(lng lat)"
    p = p.replace('Point(', '').rstrip(')')
    lng, lat = p.split()
    return float(lat), float(lng)


def main():
    print("Querying Wikidata SPARQL for Thailand railway stations...")
    q = urllib.parse.urlencode({'query': SPARQL, 'format': 'json'})
    url = f'{WD_URL}?{q}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'transport-cost-bot/1.0 (research; contact github.com/wattwong103/transport-cost)',
        'Accept': 'application/sparql-results+json',
    })
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.loads(r.read().decode('utf-8'))

    bindings = data.get('results', {}).get('bindings', [])
    print(f"Got {len(bindings)} raw bindings")

    # Deduplicate by station QID
    seen = {}
    for b in bindings:
        qid = b['station']['value'].rsplit('/', 1)[-1]
        lat, lng = parse_point(b['coord']['value'])
        entry = seen.get(qid, {
            'qid': qid,
            'name': b.get('stationLabel', {}).get('value', ''),
            'lat': lat,
            'lng': lng,
            'codes': set(),
            'lines': set(),
        })
        if 'code' in b:
            entry['codes'].add(b['code']['value'])
        if 'lineLabel' in b:
            entry['lines'].add(b['lineLabel']['value'])
        seen[qid] = entry

    stations = []
    for qid, e in seen.items():
        e['codes'] = sorted(e['codes'])
        e['lines'] = sorted(e['lines'])
        stations.append(e)

    print(f"After dedup: {len(stations)} unique stations")

    # Summary
    with_code = sum(1 for s in stations if s['codes'])
    print(f"  with station code (P296): {with_code}")

    # Filter to Bangkok bbox
    bkk = [s for s in stations if 13.5 <= s['lat'] <= 14.0 and 100.3 <= s['lng'] <= 100.9]
    print(f"  within Bangkok bbox: {len(bkk)}")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w') as f:
        json.dump({'stations': bkk, 'count': len(bkk)}, f,
                  indent=2, ensure_ascii=False)
    print(f"\nSaved to {OUT_PATH}")


if __name__ == '__main__':
    main()
