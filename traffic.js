// 即時路況：TDX 國道、省道與各縣市市區道路的路段車速，找出地圖範圍內車多、壅塞的路段
import { tdx, hasTdx, daily, cached } from './tdx.js';
import { CITIES, inBox } from './cities.js';

const LIVE_MS = 3 * 60 * 1000;
const DOWNLOAD_MS = 3 * 60 * 1000;
const LOAD_WAIT_MS = 8000;
const CITY_MAX_DEG = 0.6; // 地圖範圍太大時不載入市區道路，只看國道、省道
// 依道路種類的車速門檻（km/h）：低於 slow 是車多（橘），低於 jam 是壅塞（紅）
const LIMITS = { Freeway: { slow: 60, jam: 40 }, Highway: { slow: 30, jam: 15 }, City: { slow: 30, jam: 15 } };

// WKT 的 LINESTRING／MULTILINESTRING → [[[lat, lng], …], …]
function parseWkt(wkt) {
  return [...String(wkt).matchAll(/\(([^()]+)\)/g)].map(([, body]) =>
    body.split(',').map((pair) => { const [lng, lat] = pair.trim().split(/\s+/).map(Number); return [lat, lng]; }));
}

const shapesOf = (source) => daily(`traffic-shape-${source.replace('/', '-')}`, async () => {
  const body = await tdx(`v2/Road/Traffic/SectionShape/${source}`, {}, { timeout: DOWNLOAD_MS });
  return (body.SectionShapes || body).map((s) => {
    const lines = parseWkt(s.Geometry);
    const all = lines.flat();
    const lats = all.map((p) => p[0]), lngs = all.map((p) => p[1]);
    return { id: s.SectionID, lines, box: [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)] };
  });
});

const liveOf = (source) => cached(`traffic-live:${source}`, LIVE_MS, async () => {
  const body = await tdx(`v2/Road/Traffic/Live/${source}`);
  return new Map((body.LiveTraffics || body).map((x) => [x.SectionID, { speed: x.TravelSpeed, time: x.DataCollectTime }]));
});

const within = (promise, ms, fallback) => Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
const overlaps = (a, [s, n, w, e]) => a[0] <= n && a[1] >= s && a[2] <= e && a[3] >= w;

// bbox = [南, 北, 西, 東]。回傳車多、壅塞的路段（順暢的不回傳）
export async function trafficIn(bbox) {
  if (!hasTdx()) return { sections: [], updated: '' };
  const [s, n, w, e] = bbox;
  const sources = ['Freeway', 'Highway'];
  if (n - s <= CITY_MAX_DEG && e - w <= CITY_MAX_DEG) {
    const center = { lat: (s + n) / 2, lng: (w + e) / 2 };
    const corners = [center, { lat: s, lng: w }, { lat: n, lng: e }, { lat: s, lng: e }, { lat: n, lng: w }];
    for (const [name, ...box] of CITIES) if (corners.some((p) => inBox(p, box, 0))) sources.push(`City/${name}`);
  }
  let updated = '';
  const found = await Promise.all(sources.map(async (source) => {
    const [shapes, live] = await Promise.all([
      within(shapesOf(source).catch(() => []), LOAD_WAIT_MS, []),
      within(liveOf(source).catch(() => new Map()), LOAD_WAIT_MS, new Map()),
    ]);
    const limit = LIMITS[source.split('/')[0]];
    const out = [];
    for (const sh of shapes) {
      if (!overlaps(sh.box, bbox)) continue;
      const x = live.get(sh.id);
      if (!x || !(x.speed > 0)) continue; // 沒有資料（-99）或 0 的不判斷
      if (x.speed >= limit.slow) continue;
      if (x.time > updated) updated = x.time;
      out.push({ level: x.speed < limit.jam ? 'jam' : 'slow', speed: x.speed, lines: sh.lines });
    }
    return out;
  }));
  return { sections: found.flat(), updated };
}
