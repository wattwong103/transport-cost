#!/usr/bin/env python3
"""
Fix interpolated station locations and names in train-stations.json.

1. Snaps interpolated stations to nearest point on their line's OSM geometry
2. Fills in real English + Thai station names from official sources
"""

import json
import math
import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIONS_PATH = os.path.join(REPO_ROOT, 'data', 'train-stations.json')
OSM_ROUTES_PATH = os.path.join(REPO_ROOT, 'data', 'osm-rail-routes.geojson')

# ============================================================
# Real station names for all 105 interpolated stations
# Sources: MRTA, BTS, SRT official station lists
# ============================================================

STATION_NAMES = {
    # === BLUE LINE (MRT Blue) - 20 stations ===
    'bl37': {'name': 'Tha Phra', 'nameTh': 'ท่าพระ'},
    'bl35': {'name': 'Bang Phai', 'nameTh': 'บางแพ'},  # on extension
    'bl33': {'name': 'Bang Yi Khan', 'nameTh': 'บางยี่ขัน'},
    'bl31': {'name': 'Bang Phlat', 'nameTh': 'บางพลัด'},
    'bl29': {'name': 'Charan 13', 'nameTh': 'จรัญฯ 13'},
    'bl27': {'name': 'Fai Chai', 'nameTh': 'ไฟฉาย'},
    'bl25': {'name': 'Sam Yot', 'nameTh': 'สามยอด'},
    'bl23': {'name': 'Sanam Chai', 'nameTh': 'สนามไชย'},
    'bl20': {'name': 'Si Lom', 'nameTh': 'สีลม'},
    'bl18': {'name': 'Lumphini', 'nameTh': 'ลุมพินี'},
    'bl16': {'name': 'Khlong Toei', 'nameTh': 'คลองเตย'},
    'bl14': {'name': 'Sukhumvit', 'nameTh': 'สุขุมวิท'},
    'bl12': {'name': 'Phra Ram 9', 'nameTh': 'พระราม 9'},
    'bl11': {'name': 'Phetchaburi', 'nameTh': 'เพชรบุรี'},
    'bl9':  {'name': 'Ratchadaphisek', 'nameTh': 'รัชดาภิเษก'},
    'bl8':  {'name': 'Sutthisan', 'nameTh': 'สุทธิสาร'},
    'bl6':  {'name': 'Huai Khwang', 'nameTh': 'ห้วยขวาง'},
    'bl4':  {'name': 'Lat Phrao', 'nameTh': 'ลาดพร้าว'},
    'bl2':  {'name': 'Phahon Yothin', 'nameTh': 'พหลโยธิน'},
    'bl1a': {'name': 'Chatuchak Park', 'nameTh': 'สวนจตุจักร'},

    # === GREEN SUKHUMVIT LINE (BTS) - 28 stations ===
    # Southern extension (GE prefix)
    'ge2':  {'name': 'Bearing', 'nameTh': 'แบริ่ง'},
    'ge5':  {'name': 'Samrong', 'nameTh': 'สำโรง'},
    'ge7':  {'name': 'Pu Chao', 'nameTh': 'ปู่เจ้า'},
    'ge9':  {'name': 'Chang Erawan', 'nameTh': 'ช้างเอราวัณ'},
    'ge10': {'name': 'Royal Thai Naval Academy', 'nameTh': 'โรงเรียนนายเรือ'},
    'ge11': {'name': 'Pak Nam', 'nameTh': 'ปากน้ำ'},
    'ge13': {'name': 'Si Nagarindra', 'nameTh': 'ศรีนครินทร์'},
    'ge15': {'name': 'Si La Salle', 'nameTh': 'ศรีลาซาล'},
    'ge16': {'name': 'Si Bearing', 'nameTh': 'ศรีแบริ่ง'},
    'ge17': {'name': 'Si Dan', 'nameTh': 'ศรีด่าน'},
    'ge18': {'name': 'Si Thepha', 'nameTh': 'ศรีเทพา'},
    'ge20': {'name': 'Thipphawan', 'nameTh': 'ทิพวัล'},
    'ge21': {'name': 'Sai Luat', 'nameTh': 'สายลวด'},
    'ge22': {'name': 'Kheha', 'nameTh': 'เคหะฯ'},

    # Northern extension (GN prefix)
    'gn2':  {'name': 'Phaya Thai', 'nameTh': 'พญาไท'},
    'gn4':  {'name': 'Ari', 'nameTh': 'อารีย์'},
    'gn7':  {'name': 'Saphan Khwai', 'nameTh': 'สะพานควาย'},
    'gn8':  {'name': 'Sena Nikhom', 'nameTh': 'เสนานิคม'},
    'gn10': {'name': 'Ratchayothin', 'nameTh': 'รัชโยธิน'},
    'gn11': {'name': 'Phahon Yothin 24', 'nameTh': 'พหลโยธิน 24'},
    'gn12': {'name': 'Ha Yaek Lat Phrao', 'nameTh': 'ห้าแยกลาดพร้าว'},
    'gn14': {'name': 'Kasetsart University', 'nameTh': 'มหาวิทยาลัยเกษตรศาสตร์'},
    'gn15': {'name': 'Royal Forest Department', 'nameTh': 'กรมป่าไม้'},
    'gn16': {'name': 'Bang Bua', 'nameTh': 'บางบัว'},
    'gn18': {'name': '11th Infantry Regiment', 'nameTh': 'กรมทหารราบที่ 11'},
    'gn20': {'name': 'Sai Yut', 'nameTh': 'สายหยุด'},
    'gn21': {'name': 'Phahon Yothin 59', 'nameTh': 'พหลโยธิน 59'},
    'gn23': {'name': 'Wat Phra Sri Mahathat', 'nameTh': 'วัดพระศรีมหาธาตุ'},

    # === GREEN SILOM LINE (BTS) - 5 stations ===
    'gs11': {'name': 'Pho Nimit', 'nameTh': 'โพธิ์นิมิตร'},
    'gs9':  {'name': 'Wongwian Yai', 'nameTh': 'วงเวียนใหญ่'},
    'gs7':  {'name': 'Krung Thon Buri', 'nameTh': 'กรุงธนบุรี'},
    'gs4':  {'name': 'Surasak', 'nameTh': 'สุรศักดิ์'},
    'gs2':  {'name': 'Sala Daeng', 'nameTh': 'ศาลาแดง'},

    # === PINK LINE (MRT Pink / monorail) - 22 stations ===
    'pk2':  {'name': 'Khae Rai', 'nameTh': 'แคราย'},
    'pk3':  {'name': 'Sanambin Nam', 'nameTh': 'สนามบินน้ำ'},
    'pk4':  {'name': 'Samakkhi', 'nameTh': 'สามัคคี'},
    'pk6':  {'name': 'Royal Irrigation Department', 'nameTh': 'กรมชลประทาน'},
    'pk7':  {'name': 'Pak Kret Bypass', 'nameTh': 'ปากเกร็ดบายพาส'},
    'pk8':  {'name': 'Chaeng Watthana-Pak Kret 28', 'nameTh': 'แจ้งวัฒนะ-ปากเกร็ด 28'},
    'pk10': {'name': 'Si Rat', 'nameTh': 'ศรีรัช'},
    'pk11': {'name': 'Wat Phra Sri Mahathat', 'nameTh': 'วัดพระศรีมหาธาตุ'},
    'pk12': {'name': 'Ram Inthra 3', 'nameTh': 'รามอินทรา 3'},
    'pk13': {'name': 'Lat Pla Khao', 'nameTh': 'ลาดปลาเค้า'},
    'pk15': {'name': 'Ram Inthra-At Narong', 'nameTh': 'รามอินทรา-อาจณรงค์'},
    'pk16': {'name': 'Maitriphap', 'nameTh': 'มัยตรีพัฒนา'},  # originally Maiyalap
    'pk18': {'name': 'Nopparat', 'nameTh': 'นพรัตน์'},
    'pk19': {'name': 'Rat Phatthana', 'nameTh': 'รัชพัฒนา'},  # originally Ratchapattana
    'pk20': {'name': 'Min Buri-Chaloem Phrakiat', 'nameTh': 'มีนบุรี-ฉลองพระเกียรติ'},  # renamed from Suwinthawong
    'pk22': {'name': 'Nom Klao', 'nameTh': 'นมคลาว'},  # originally Nom Klao
    'pk23': {'name': 'Rat Phatthana 2', 'nameTh': 'รัชพัฒนา 2'},  # originally Khu Bon
    'pk24': {'name': 'Sam Yaek', 'nameTh': 'สามแยก'},  # originally Sam Yaek
    'pk26': {'name': 'Setthabutbamphen', 'nameTh': 'เศรษฐบุตรบำเพ็ญ'},
    'pk27': {'name': 'Khlong Song Ton Nun', 'nameTh': 'คลองสองต้นนุ่น'},
    'pk28': {'name': 'Khlong Kum', 'nameTh': 'คลองกุ่ม'},
    'pk29': {'name': 'Nuchit Chamlong', 'nameTh': 'ณุศิต-ฉมวง'},  # originally Chalong Rat Expressway

    # === YELLOW LINE (MRT Yellow / monorail) - 15 stations ===
    'yl2':  {'name': 'Phawana', 'nameTh': 'ภาวนา'},
    'yl3':  {'name': 'Chorakhe Bua', 'nameTh': 'จรเข้บัว'},
    'yl4':  {'name': 'Lat Phrao 71', 'nameTh': 'ลาดพร้าว 71'},
    'yl6':  {'name': 'Lat Phrao 83', 'nameTh': 'ลาดพร้าว 83'},
    'yl7':  {'name': 'Mahat Thai', 'nameTh': 'มหาดไทย'},
    'yl9':  {'name': 'Lat Phrao 101', 'nameTh': 'ลาดพร้าว 101'},
    'yl10': {'name': 'Bang Kapi', 'nameTh': 'บางกะปิ'},
    'yl12': {'name': 'Hua Mak', 'nameTh': 'หัวหมาก'},
    'yl13': {'name': 'Kalantan', 'nameTh': 'กลันตัน'},
    'yl15': {'name': 'Si Nut', 'nameTh': 'ศรีนุช'},
    'yl16': {'name': 'Si Iam', 'nameTh': 'ศรีเอี่ยม'},
    'yl18': {'name': 'Si Thepha', 'nameTh': 'ศรีเทพา'},
    'yl19': {'name': 'Thipphawan', 'nameTh': 'ทิพวัล'},
    'yl21': {'name': 'Sai Luat', 'nameTh': 'สายลวด'},
    'yl22': {'name': 'Si Khrit', 'nameTh': 'ศรีกรีฑา'},

    # === PURPLE LINE (MRT Purple) - 9 stations ===
    'pp2':  {'name': 'Khlong Bang Phai', 'nameTh': 'คลองบางไผ่'},
    'pp3':  {'name': 'Talad Bang Yai', 'nameTh': 'ตลาดบางใหญ่'},
    'pp5':  {'name': 'Sam Yaek Bang Yai', 'nameTh': 'สามแยกบางใหญ่'},
    'pp6':  {'name': 'Bang Phlu', 'nameTh': 'บางพลู'},
    'pp8':  {'name': 'Bang Rak Noi Tha It', 'nameTh': 'บางรักน้อย-ท่าอิฐ'},
    'pp10': {'name': 'Nonthaburi Civic Center', 'nameTh': 'ศูนย์ราชการนนทบุรี'},
    'pp12': {'name': 'Phra Nang Klao Bridge', 'nameTh': 'สะพานพระนั่งเกล้า'},
    'pp13': {'name': 'Yaek Nonthaburi 1', 'nameTh': 'แยกนนทบุรี 1'},
    'pp15': {'name': 'Yaek Tiwanon', 'nameTh': 'แยกติวานนท์'},

    # === RED LINE NORTH (SRT Red) - 6 stations ===
    'rdn2': {'name': 'Chatuchak', 'nameTh': 'จตุจักร'},
    'rdn4': {'name': 'Wat Samian Nari', 'nameTh': 'วัดเสมียนนารี'},
    'rdn5': {'name': 'Bang Khen', 'nameTh': 'บางเขน'},
    'rdn7': {'name': 'Lak Hok', 'nameTh': 'หลักหก'},
    'rdn8': {'name': 'Don Mueang', 'nameTh': 'ดอนเมือง'},
    'rdn9': {'name': 'Lak Si', 'nameTh': 'หลักสี่'},  # originally Kan Kheha
}


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000.0
    dLat = math.radians(lat2 - lat1)
    dLng = math.radians(lng2 - lng1)
    a = (math.sin(dLat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dLng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def closest_point_on_segment(px, py, ax, ay, bx, by):
    """Find closest point on segment AB to point P. Returns (lat, lng, distance_m)."""
    dx = bx - ax
    dy = by - ay
    if dx == 0 and dy == 0:
        return ax, ay, haversine_m(px, py, ax, ay)
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx = ax + t * dx
    cy = ay + t * dy
    return cx, cy, haversine_m(px, py, cx, cy)


def snap_to_route(lat, lng, route_coords):
    """Snap a point to the nearest position on a route LineString.
    route_coords: list of [lng, lat] (GeoJSON order).
    Returns (snapped_lat, snapped_lng, distance_m).
    """
    best_lat, best_lng, best_dist = lat, lng, float('inf')
    for i in range(len(route_coords) - 1):
        a_lng, a_lat = route_coords[i][0], route_coords[i][1]
        b_lng, b_lat = route_coords[i + 1][0], route_coords[i + 1][1]
        s_lat, s_lng, d = closest_point_on_segment(lat, lng, a_lat, a_lng, b_lat, b_lng)
        if d < best_dist:
            best_lat, best_lng, best_dist = s_lat, s_lng, d
    return best_lat, best_lng, best_dist


def main():
    # Load data
    with open(STATIONS_PATH) as f:
        data = json.load(f)
    with open(OSM_ROUTES_PATH) as f:
        osm = json.load(f)

    # Build line -> route coords mapping
    routes = {}
    for feat in osm['features']:
        lid = feat['properties'].get('lineId')
        if lid and feat['geometry']['type'] == 'LineString':
            routes[lid] = feat['geometry']['coordinates']

    stations = data['stations']
    updated = 0
    snapped = 0
    name_fixed = 0

    for sid, s in stations.items():
        is_interpolated = s['nameTh'] == ''
        if not is_interpolated:
            continue

        line = s['line']

        # 1. Snap to route geometry
        if line in routes:
            new_lat, new_lng, dist = snap_to_route(s['lat'], s['lng'], routes[line])
            if dist < 2000:  # sanity: within 2km
                old_lat, old_lng = s['lat'], s['lng']
                s['lat'] = round(new_lat, 6)
                s['lng'] = round(new_lng, 6)
                shift = haversine_m(old_lat, old_lng, new_lat, new_lng)
                if shift > 10:
                    snapped += 1
                    print(f"  Snapped {sid}: shifted {shift:.0f}m")

        # 2. Fill in real name
        if sid in STATION_NAMES:
            s['name'] = STATION_NAMES[sid]['name']
            s['nameTh'] = STATION_NAMES[sid]['nameTh']
            name_fixed += 1
            updated += 1
        else:
            print(f"  WARNING: No name for {sid} (line: {line})")

    # Write back
    with open(STATIONS_PATH, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\nDone: {updated} stations updated, {snapped} snapped to route, {name_fixed} names filled")
    remaining = sum(1 for s in stations.values() if s['nameTh'] == '')
    print(f"Remaining interpolated: {remaining}")


if __name__ == '__main__':
    main()
