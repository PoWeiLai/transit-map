// 公廁：環境部「全國公廁建檔資料」（.env 設 MOENV_API_KEY 才能下載，到 data.moenv.gov.tw 註冊會員申請），
// 沒有金鑰就用 OpenStreetMap 上標記的公廁（數量較少）
import { daily } from './tdx.js';
import { distance } from './geo.js';

const MOENV = 'https://data.moenv.gov.tw/api/v2/fac_p_07';
const PAGE = 1000;
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NEAR_M = 800;
const LIMIT = 6;

async function fromMoenv(key) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${MOENV}?${new URLSearchParams({ api_key: key, limit: PAGE, offset, format: 'JSON' })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`環境部公廁資料 ${res.status}`);
    const body = await res.json();
    const records = Array.isArray(body) ? body : body.records || [];
    for (const r of records) {
      out.push({
        name: r.name, address: r.address || '',
        lat: Number(r.latitude), lng: Number(r.longitude),
        grade: r.grade || '', type: r.type2 || r.type || '',
        diaper: Number(r.diaper) > 0,
      });
    }
    if (records.length < PAGE) return out;
  }
}

async function fromOsm() {
  const query = '[out:json][timeout:120];area["ISO3166-1"="TW"]->.a;nwr["amenity"="toilets"](area.a);out center tags;';
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'transit-map' },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(150000),
  });
  if (!res.ok) throw new Error(`公廁資料 ${res.status}`);
  const { elements } = await res.json();
  return elements.map((e) => ({
    name: e.tags.name || '公廁', address: e.tags['addr:full'] || '',
    lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
    grade: '', type: e.tags.access === 'customers' ? '限消費者' : '',
    diaper: e.tags.changing_table === 'yes',
    hours: e.tags.opening_hours || '',
  }));
}

const KEY = () => process.env.MOENV_API_KEY;
const toilets = () => daily(KEY() ? 'toilets-moenv' : 'toilets-osm', async () =>
  (KEY() ? await fromMoenv(KEY()) : await fromOsm()).filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng)));

export async function toiletsNear(point) {
  const list = await toilets().catch(() => []);
  return {
    source: KEY() ? 'moenv' : 'osm',
    toilets: list
      .map((t) => ({ ...t, distance: Math.round(distance(point, t)) }))
      .filter((t) => t.distance <= NEAR_M)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, LIMIT),
  };
}

export const warmUp = () => toilets();
