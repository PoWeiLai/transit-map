// 寄放行李：OpenStreetMap 上標記的置物櫃、行李寄放處（全台一份，一天抓一次）。
// 台鐵、捷運沒有公開置物櫃資料，OSM 只有部分地點，畫面另外提供 Google 地圖搜尋附近置物櫃
import { daily } from './tdx.js';
import { distance } from './geo.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const QUERY = `[out:json][timeout:60];area["ISO3166-1"="TW"]->.a;(
  nwr["amenity"="luggage_locker"](area.a);
  nwr["amenity"="locker"](area.a);
  nwr["amenity"="luggage_storage"](area.a);
  nwr["luggage_storage"="yes"](area.a);
);out center tags;`;
const NEAR_M = 1500; // 車站、目的地多遠內的置物櫃
const LIMIT = 5;

const lockers = () => daily('lockers', async () => {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'transit-map' },
    body: new URLSearchParams({ data: QUERY }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`置物櫃資料 ${res.status}`);
  const { elements } = await res.json();
  return elements.map((e) => ({
    name: e.tags.name || (e.tags.amenity === 'luggage_storage' ? '行李寄放處' : '置物櫃'),
    lat: e.lat ?? e.center?.lat,
    lng: e.lon ?? e.center?.lon,
    hours: e.tags.opening_hours || '',
    fee: e.tags.charge || (e.tags.fee === 'yes' ? '收費' : e.tags.fee === 'no' ? '免費' : ''),
  })).filter((l) => l.lat != null);
});

// point 附近的置物櫃，近的在前；資料抓不到就回傳空的（畫面仍有 Google 地圖搜尋）
export async function lockersNear(point) {
  const list = await lockers().catch(() => []);
  return list
    .map((l) => ({ ...l, distance: Math.round(distance(point, l)) }))
    .filter((l) => l.distance <= NEAR_M)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, LIMIT);
}
