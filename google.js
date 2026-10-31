// ---------- Google 地點搜尋（Places API Text Search） ----------
// OpenStreetMap 找不到的店家（「台鐵便當南陽店」），改問 Google，查到就直接用，不用使用者自己去 Google 地圖複製連結。
// 要在 .env／Render 設定 GOOGLE_MAPS_API_KEY（Google Cloud 開啟「Places API (New)」）；沒設定就不使用。
// 免費額度每月 5,000 次（Text Search Pro），預設用到 4,000 次就暫停，可用 GOOGLE_MONTHLY_CALLS 調整
import { getKv, setKv } from './store.js';
import { remembered, taipeiNow } from './tdx.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const MONTHLY_CALLS = Number(process.env.GOOGLE_MONTHLY_CALLS) || 4000;
const CACHE_DAYS = 30; // Google 規定座標最多存 30 天
const BIAS_RADIUS_M = 30000; // 優先找出發點附近（同名的店全台有好幾家）

export const hasGoogle = () => Boolean(process.env.GOOGLE_MAPS_API_KEY);

// 本月用了幾次：記在 Turso，主機重開也算得到
const count = { month: '', calls: 0, loaded: null };
async function monthCalls() {
  const month = taipeiNow().date.slice(0, 7);
  if (count.month !== month) {
    Object.assign(count, { month, calls: 0 });
    count.loaded = getKv([`google-calls:${month}`], 40 * 86400000)
      .then((m) => { count.calls += m.get(`google-calls:${month}`) || 0; })
      .catch(() => {});
  }
  await count.loaded;
  return count;
}

async function search(q, near) {
  const c = await monthCalls();
  if (c.calls >= MONTHLY_CALLS) throw new Error('Google 地點搜尋本月額度用完'); // 丟錯誤才不會把空結果存起來
  c.calls++;
  setKv([[`google-calls:${c.month}`, c.calls]]).catch(() => {});
  const body = { textQuery: q, languageCode: 'zh-TW', regionCode: 'TW', pageSize: 3 };
  if (near) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: BIAS_RADIUS_M } };
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Google 地點搜尋 ${res.status}`);
  return ((await res.json()).places || []).map((p) => ({
    name: p.displayName?.text || q,
    label: (p.formattedAddress || '').replace(/^\d{3,6}/, '').replace(/^台灣/, ''),
    lat: p.location.latitude,
    lng: p.location.longitude,
    area: p.formattedAddress?.match(/[市縣]([^市縣\d]{1,3}?[區鄉鎮市])/)?.[1],
    road: false,
    google: true,
  })).filter((r) => r.lat >= 20 && r.lat <= 27 && r.lng >= 117 && r.lng <= 123); // 台灣附近才採用
}

export function googlePlace(q, near) {
  if (!hasGoogle()) return Promise.resolve([]);
  const key = near ? `google:${q}@${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : `google:${q}`;
  return remembered(key, CACHE_DAYS, () => search(q, near));
}

export async function googleUsage() {
  const c = await monthCalls();
  return { enabled: hasGoogle(), month: c.month, calls: c.calls, limit: MONTHLY_CALLS };
}
