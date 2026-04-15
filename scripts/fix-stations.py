#!/usr/bin/env python3
"""
Fix interpolated station locations in train-stations.json.

Strategy: For each interpolated station, estimate its position from surrounding
anchor stations, then snap to the nearest point on the OSM route geometry.
"""

import json, math, os, sys
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIONS_PATH = os.path.join(REPO, 'data', 'train-stations.json')
EDGES_PATH = os.path.join(REPO, 'data', 'train-edges.json')
OSM_PATH = os.path.join(REPO, 'data', 'osm-rail-routes.geojson')

def hav(lat1,lng1,lat2,lng2):
    R=6371000; dLat=math.radians(lat2-lat1); dLng=math.radians(lng2-lng1)
    a=math.sin(dLat/2)**2+math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dLng/2)**2
    return R*2*math.atan2(math.sqrt(a),math.sqrt(1-a))

def closest_on_seg(px,py,ax,ay,bx,by):
    dx,dy=bx-ax,by-ay
    if dx==0 and dy==0: return ax,ay,hav(px,py,ax,ay)
    t=max(0,min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)))
    cx,cy=ax+t*dx,ay+t*dy
    return cx,cy,hav(px,py,cx,cy)

def snap_to_route(lat, lng, coords, max_dist=10000):
    """Snap point to nearest position on route within max_dist meters."""
    best_lat,best_lng,best_d=lat,lng,float('inf')
    for i in range(len(coords)-1):
        a_lat,a_lng=coords[i][1],coords[i][0]
        b_lat,b_lng=coords[i+1][1],coords[i+1][0]
        # Quick bounding-box check (0.05 deg ~ 5.5km)
        min_lat=min(a_lat,b_lat)-0.05; max_lat=max(a_lat,b_lat)+0.05
        min_lng=min(a_lng,b_lng)-0.05; max_lng=max(a_lng,b_lng)+0.05
        if lat<min_lat or lat>max_lat or lng<min_lng or lng>max_lng:
            continue
        s_lat,s_lng,d=closest_on_seg(lat,lng,a_lat,a_lng,b_lat,b_lng)
        if d<best_d:
            best_lat,best_lng,best_d=s_lat,s_lng,d
    if best_d>max_dist:
        return lat,lng,best_d
    return best_lat,best_lng,best_d

def walk_edges(start, line_set, adj, edge_types):
    """Walk edges preferring 'link' over 'connection' type."""
    seq=[start]; vis={start}
    while True:
        cur=seq[-1]
        nxt=[n for n in adj[cur] if n in line_set and n not in vis]
        if not nxt: break
        links=[n for n in nxt if edge_types.get((cur,n))=='link' or edge_types.get((n,cur))=='link']
        pick=sorted(links)[0] if links else sorted(nxt)[0]
        seq.append(pick); vis.add(pick)
    return seq

NAMES = {
    # Blue Line: internal IDs mapped to nearest real BL stations
    'bl37':('Phasi Charoen','ภาษีเจริญ'),         # BL37
    'bl35':('Phetkasem 48','เพชรเกษม 48'),         # BL35
    'bl33':('Sanam Chai','สนามไชย'),                # between BL34-BL28
    'bl1a':('Wat Mangkon','วัดมังกร'),              # between BL28-BL27
    'bl2': ('Sam Yot','สามยอด'),                    # between BL28-BL27
    'bl4': ('Si Lom 2','สีลม 2'),                   # phantom between BL27-BL26
    'bl6': ('Khlong Toei','คลองเตย'),               # between BL26-BL25
    'bl8': ('Khlong Toei','คลองเตย'),               # BL24 area
    'bl9': ('Queen Sirikit','ศูนย์สิริกิติ์'),       # BL23 area
    'bl11':('Sukhumvit','สุขุมวิท'),                 # BL22
    'bl12':('Phetchaburi 2','เพชรบุรี 2'),           # between BL21-BL20
    'bl14':('Phra Ram 9 2','พระราม 9-2'),            # between BL20-BL19
    'bl16':('Huai Khwang','ห้วยขวาง'),               # BL18
    'bl18':('Sutthisan 2','สุทธิสาร 2'),             # between BL17-BL16
    'bl20':('Lat Phrao','ลาดพร้าว'),                 # BL15
    'bl23':('Chatuchak 2','จตุจักร 2'),              # between BL13-BL12
    'bl25':('Bang Sue','บางซื่อ'),                    # BL11
    'bl27':('Bang Pho','บางโพ'),                     # BL09
    'bl29':('Sirindhorn','สิรินธร'),                  # BL06 area
    'bl31':('Bang Khun Non','บางขุนนนท์'),            # BL04 area
    'ge2': ('Bearing','แบริ่ง'),'ge5': ('Samrong','สำโรง'),
    'ge7': ('Pu Chao','ปู่เจ้า'),'ge9': ('Chang Erawan','ช้างเอราวัณ'),
    'ge10':('Royal Thai Naval Academy','โรงเรียนนายเรือ'),
    'ge11':('Pak Nam','ปากน้ำ'),'ge13':('Si Nagarindra','ศรีนครินทร์'),
    'ge15':('Si La Salle','ศรีลาซาล'),'ge16':('Si Bearing','ศรีแบริ่ง'),
    'ge17':('Si Dan','ศรีด่าน'),'ge18':('Si Thepha','ศรีเทพา'),
    'ge20':('Thipphawan','ทิพวัล'),'ge21':('Sai Luat','สายลวด'),
    'ge22':('Kheha','เคหะฯ'),
    'gn2': ('Phaya Thai','พญาไท'),'gn4': ('Ari','อารีย์'),
    'gn7': ('Saphan Khwai','สะพานควาย'),'gn8': ('Sena Nikhom','เสนานิคม'),
    'gn10':('Ratchayothin','รัชโยธิน'),'gn11':('Phahon Yothin 24','พหลโยธิน 24'),
    'gn12':('Ha Yaek Lat Phrao','ห้าแยกลาดพร้าว'),
    'gn14':('Kasetsart University','มหาวิทยาลัยเกษตรศาสตร์'),
    'gn15':('Royal Forest Department','กรมป่าไม้'),
    'gn16':('Bang Bua','บางบัว'),
    'gn18':('11th Infantry Regiment','กรมทหารราบที่ 11'),
    'gn20':('Sai Yut','สายหยุด'),'gn21':('Phahon Yothin 59','พหลโยธิน 59'),
    'gn23':('Wat Phra Sri Mahathat','วัดพระศรีมหาธาตุ'),
    'gs11':('Pho Nimit','โพธิ์นิมิตร'),'gs9':('Wongwian Yai','วงเวียนใหญ่'),
    'gs7': ('Krung Thon Buri','กรุงธนบุรี'),'gs4':('Surasak','สุรศักดิ์'),
    'gs2': ('Sala Daeng','ศาลาแดง'),
    'pk2': ('Khae Rai','แคราย'),'pk3': ('Sanambin Nam','สนามบินน้ำ'),
    'pk4': ('Samakkhi','สามัคคี'),
    'pk6': ('Royal Irrigation Department','กรมชลประทาน'),
    'pk7': ('Pak Kret Bypass','ปากเกร็ดบายพาส'),
    'pk8': ('Chaeng Watthana-Pak Kret 28','แจ้งวัฒนะ-ปากเกร็ด 28'),
    'pk10':('Si Rat','ศรีรัช'),
    'pk11':('Wat Phra Sri Mahathat','วัดพระศรีมหาธาตุ'),
    'pk12':('Ram Inthra 3','รามอินทรา 3'),'pk13':('Lat Pla Khao','ลาดปลาเค้า'),
    'pk15':('Ram Inthra-At Narong','รามอินทรา-อาจณรงค์'),
    'pk16':('Maitriphap','ไมตรีจิต'),'pk18':('Nopparat','นพรัตน์'),
    'pk19':('Rat Phatthana','รัชพัฒนา'),'pk20':('Min Buri','มีนบุรี'),
    'pk22':('Nom Klao','นมคลาว'),'pk23':('Khu Bon','คูบอน'),
    'pk24':('Sam Yaek','สามแยก'),
    'pk26':('Setthabutbamphen','เศรษฐบุตรบำเพ็ญ'),
    'pk27':('Bang Chan','บางชัน'),'pk28':('Min Buri Market','ตลาดมีนบุรี'),
    'pk29':('Min Buri Terminal','มีนบุรี'),
    'yl2': ('Phawana','ภาวนา'),'yl3': ('Chorakhe Bua','จรเข้บัว'),
    'yl4': ('Lat Phrao 71','ลาดพร้าว 71'),'yl6': ('Lat Phrao 83','ลาดพร้าว 83'),
    'yl7': ('Mahat Thai','มหาดไทย'),'yl9': ('Lat Phrao 101','ลาดพร้าว 101'),
    'yl10':('Bang Kapi','บางกะปิ'),'yl12':('Hua Mak','หัวหมาก'),
    'yl13':('Kalantan','กลันตัน'),'yl15':('Si Nut','ศรีนุช'),
    'yl16':('Si Iam','ศรีเอี่ยม'),'yl18':('Si Thepha','ศรีเทพา'),
    'yl19':('Thipphawan','ทิพวัล'),'yl21':('Sai Luat','สายลวด'),
    'yl22':('Si Kritha','ศรีกรีฑา'),
    'pp2': ('Khlong Bang Phai','คลองบางไผ่'),'pp3': ('Talad Bang Yai','ตลาดบางใหญ่'),
    'pp5': ('Sam Yaek Bang Yai','สามแยกบางใหญ่'),'pp6': ('Bang Phlu','บางพลู'),
    'pp8': ('Bang Rak Noi Tha It','บางรักน้อย-ท่าอิฐ'),
    'pp10':('Nonthaburi Civic Center','ศูนย์ราชการนนทบุรี'),
    'pp12':('Phra Nang Klao Bridge','สะพานพระนั่งเกล้า'),
    'pp13':('Yaek Nonthaburi 1','แยกนนทบุรี 1'),
    'pp15':('Yaek Tiwanon','แยกติวานนท์'),
    'rdn2':('Chatuchak','จตุจักร'),'rdn4':('Wat Samian Nari','วัดเสมียนนารี'),
    'rdn5':('Bang Khen','บางเขน'),'rdn7':('Lak Hok','หลักหก'),
    'rdn8':('Don Mueang','ดอนเมือง'),'rdn9':('Lak Si','หลักสี่'),
}

def load_data():
    with open(STATIONS_PATH) as f: data=json.load(f)
    with open(EDGES_PATH) as f: edges=json.load(f)
    with open(OSM_PATH) as f: osm=json.load(f)
    adj=defaultdict(set)
    edge_types={}
    for e in edges:
        adj[e['from']].add(e['to']); adj[e['to']].add(e['from'])
        edge_types[(e['from'],e['to'])]=e.get('type','link')
    routes={}
    for feat in osm['features']:
        lid=feat['properties'].get('lineId')
        if lid and feat['geometry']['type']=='LineString':
            routes[lid]=feat['geometry']['coordinates']
    return data, adj, edge_types, routes


def fix_line(data, adj, edge_types, route_coords, line_id, walk_start):
    """Fix one line using estimate-then-snap approach."""
    stations=data['stations']
    line_set=set(sid for sid,s in stations.items() if s['line']==line_id)
    seq=walk_edges(walk_start, line_set, adj, edge_types)
    missed=line_set-set(seq)
    if missed:
        print(f"  Branch stations: {missed}")

    # Build list of (index, sid, is_anchor) with anchor coords
    items = []
    for sid in seq:
        s=stations[sid]
        is_anchor = s['nameTh']!=''
        items.append((sid, is_anchor, s['lat'], s['lng']))

    updated=0; snapped=0

    # For each interpolated station, find surrounding anchors and estimate position
    i = 0
    while i < len(items):
        sid, is_anchor, lat, lng = items[i]
        if is_anchor or sid not in NAMES:
            i += 1
            continue

        # Find previous anchor
        prev_a = None
        for j in range(i-1, -1, -1):
            if items[j][1]:  # is_anchor
                prev_a = j
                break

        # Find next anchor
        next_a = None
        for j in range(i+1, len(items)):
            if items[j][1]:
                next_a = j
                break

        # Count interpolated stations in this gap
        gap_start = (prev_a + 1) if prev_a is not None else 0
        gap_end = (next_a - 1) if next_a is not None else len(items) - 1
        gap_interps = [k for k in range(gap_start, gap_end + 1) if not items[k][1] and items[k][0] in NAMES]
        pos_in_gap = gap_interps.index(i)
        n_in_gap = len(gap_interps)

        # Estimate position by interpolating between anchors
        if prev_a is not None and next_a is not None:
            frac = (pos_in_gap + 1) / (n_in_gap + 1)
            est_lat = items[prev_a][2] + frac * (items[next_a][2] - items[prev_a][2])
            est_lng = items[prev_a][3] + frac * (items[next_a][3] - items[prev_a][3])
        elif prev_a is not None:
            # After last anchor — extrapolate using last anchor direction
            if prev_a >= 1:
                dlat = items[prev_a][2] - items[prev_a-1][2]
                dlng = items[prev_a][3] - items[prev_a-1][3]
            else:
                dlat, dlng = 0, 0
            est_lat = items[prev_a][2] + dlat * (pos_in_gap + 1)
            est_lng = items[prev_a][3] + dlng * (pos_in_gap + 1)
        elif next_a is not None:
            if next_a < len(items) - 1:
                dlat = items[next_a][2] - items[next_a+1][2]
                dlng = items[next_a][3] - items[next_a+1][3]
            else:
                dlat, dlng = 0, 0
            est_lat = items[next_a][2] + dlat * (n_in_gap - pos_in_gap)
            est_lng = items[next_a][3] + dlng * (n_in_gap - pos_in_gap)
        else:
            est_lat, est_lng = lat, lng

        # Snap estimated position to route
        new_lat, new_lng, snap_d = snap_to_route(est_lat, est_lng, route_coords)
        shift = hav(lat, lng, new_lat, new_lng)

        stations[sid]['lat'] = round(new_lat, 5)
        stations[sid]['lng'] = round(new_lng, 5)
        stations[sid]['name'] = NAMES[sid][0]
        stations[sid]['nameTh'] = NAMES[sid][1]
        updated += 1; snapped += 1
        print(f"  {sid}: ({new_lat:.5f},{new_lng:.5f}) shift={shift:.0f}m snap={snap_d:.0f}m")

        i += 1

    # Branch stations
    for sid in missed:
        if sid in NAMES and stations[sid]['nameTh']=='':
            s=stations[sid]
            new_lat,new_lng,snap_d=snap_to_route(s['lat'],s['lng'],route_coords)
            shift=hav(s['lat'],s['lng'],new_lat,new_lng)
            stations[sid]['lat']=round(new_lat,5)
            stations[sid]['lng']=round(new_lng,5)
            stations[sid]['name']=NAMES[sid][0]
            stations[sid]['nameTh']=NAMES[sid][1]
            updated+=1; snapped+=1
            print(f"  {sid}: branch snap={snap_d:.0f}m shift={shift:.0f}m")

    return updated, snapped

def save(data):
    with open(STATIONS_PATH,'w') as f:
        json.dump(data,f,indent=2,ensure_ascii=False)

LINES = [
    ('yellow','yl1'),
    ('pink','pk1'),
    ('red_north','rdn1'),
    ('green_silom','gs12'),
    ('green_sukhumvit','gn24'),
    ('purple','pp16'),
    ('blue','bl38'),
]

def main():
    line_filter = sys.argv[1] if len(sys.argv)>1 else None
    data, adj, edge_types, routes = load_data()
    total_u=0; total_s=0
    for lid,ws in LINES:
        if line_filter and lid!=line_filter: continue
        print(f"\n=== {lid} ===")
        if lid not in routes:
            print(f"  No route data!"); continue
        u,s=fix_line(data,adj,edge_types,routes[lid],lid,ws)
        total_u+=u; total_s+=s
    save(data)
    rem=sum(1 for s in data['stations'].values() if s['nameTh']=='')
    print(f"\nDone: {total_u} names, {total_s} coords. Remaining unnamed: {rem}")

if __name__=='__main__':
    main()
