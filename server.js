import { readFileSync } from 'node:fs';
import express from 'express';
import { distance } from './geo.js';
import { planBus, nearbyArrivals, warmUp } from './bus.js';
import { nearbyParking, warmUp as warmUpParking } from './scooter.js';
import { planRail, railStations, warmUp as warmUpRail } from './rail.js';
import { hasTdx, taipeiNow } from './tdx.js';
import { planMetro, metroMap } from './metro.js';

// TDX 金鑰等設定放在 .env（不進版控）
try { process.loadEnvFile(); } catch { /* 沒有 .env 也能跑 */ }

const PORT = process.env.PORT || 3000;
// --demo（或 DEMO=1）會用模擬的可借/可還數字，方便在 YouBike 停止服務時測試規劃功能
const DEMO = process.env.DEMO === '1' || process.argv.includes('--demo');

// YouBike 官方全台站點（含即時車輛數），約 9700 站
const STATIONS_URL = 'https://apis.youbike.com.tw/json/station-yb2.json';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const ROUTE_URL = {
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving',
  scooter: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
};
const VALHALLA_COSTING = { foot: 'pedestrian', bike: 'bicycle', scooter: 'motor_scooter' };
// 捷運出發時，在出發點多遠內找出口
const EXIT_RADIUS_M = 400;
const USER_AGENT = 'ubike-planner/1.0 (local dev)';
const STATION_CACHE_MS = 60 * 1000;
// 路線服務失敗時用直線距離估算
const FALLBACK_SPEED = { foot: 4.5 / 3.6, bike: 12 / 3.6, scooter: 25 / 3.6, taxi: 30 / 3.6 }; // m/s
const CANDIDATES = 3;

// ---------- 站點資料 ----------

let stationCache = { at: 0, data: [] };

function demoCount(id, max, salt) {
  let h = salt;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const n = h % (max + 1);
  return h % 5 === 0 ? 0 : n; // 約兩成站點故意設為 0，測試會不會跳過
}

async function getStations() {
  if (Date.now() - stationCache.at < STATION_CACHE_MS) return stationCache.data;
  const res = await fetch(STATIONS_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`YouBike API ${res.status}`);
  const raw = await res.json();
  const data = raw
    .map((s) => {
      const total = Number(s.parking_spaces) || 0;
      let bikes = Number(s.available_spaces) || 0;
      let docks = Number(s.empty_spaces) || 0;
      if (DEMO) {
        bikes = demoCount(s.station_no, total, 7);
        docks = total - bikes;
      }
      return {
        id: s.station_no,
        name: s.name_tw.replace(/^YouBike2\.0_/, ''),
        district: s.district_tw,
        address: s.address_tw,
        lat: Number(s.lat),
        lng: Number(s.lng),
        total,
        bikes,
        docks,
        active: Number(s.status) === 1 || DEMO,
        updatedAt: s.updated_at,
      };
    })
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  stationCache = { at: Date.now(), data };
  return data;
}

// ---------- 捷運出口 ----------

// 出口幾乎不會變動，且 TDX 未登入時常拒絕請求，所以存成本地檔案
const exits = JSON.parse(readFileSync(new URL('./data/metro-exits.json', import.meta.url), 'utf8'));

// 出發點附近的捷運站中，挑離借車站最近的出口
function bestExit(exits, origin, pickup) {
  const near = exits
    .map((e) => ({ ...e, fromOrigin: distance(origin, e) }))
    .filter((e) => e.fromOrigin <= EXIT_RADIUS_M);
  if (!near.length) return null;
  const station = near.reduce((a, b) => (a.fromOrigin < b.fromOrigin ? a : b)).station;
  const candidates = near
    .filter((e) => e.station === station)
    .map(({ fromOrigin, ...e }) => ({ ...e, toPickup: Math.round(distance(e, pickup)) }))
    .sort((a, b) => a.toPickup - b.toPickup);
  return { best: candidates[0], all: candidates };
}

// ---------- 地理工具 ----------

function nearest(stations, point, filter, limit) {
  return stations
    .filter(filter)
    .map((s) => ({ ...s, distance: Math.round(distance(point, s)) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

function parsePoint(str) {
  const [lat, lng] = String(str || '').split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

// ---------- 地址查詢（OpenStreetMap Nominatim，限每秒 1 次） ----------

const geocodeCache = new Map();
let geocodeQueue = Promise.resolve();

function geocode(q) {
  if (geocodeCache.has(q)) return Promise.resolve(geocodeCache.get(q));
  const job = geocodeQueue.then(async () => {
    const url = `${NOMINATIM_URL}?${new URLSearchParams({
      q,
      format: 'jsonv2',
      countrycodes: 'tw',
      limit: '5',
      'accept-language': 'zh-TW',
    })}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`地址查詢失敗 ${res.status}`);
    const results = (await res.json()).map((r) => ({
      name: r.name || r.display_name.split(',')[0],
      label: r.display_name,
      lat: Number(r.lat),
      lng: Number(r.lon),
    }));
    geocodeCache.set(q, results);
    return results;
  });
  geocodeQueue = job.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1000)));
  return job;
}

// ---------- 路線（OSRM：步行 / 自行車） ----------

// 公開路線服務同時太多請求會被拒絕：最多同時 2 個，並快取結果
const ROUTE_CONCURRENCY = 2;
const routeCache = new Map();
let routeActive = 0;
const routeWaiting = [];

async function limited(fn) {
  if (routeActive >= ROUTE_CONCURRENCY) await new Promise((r) => routeWaiting.push(r));
  routeActive++;
  try {
    return await fn();
  } finally {
    routeActive--;
    routeWaiting.shift()?.();
  }
}

function route(mode, from, to) {
  const key = `${mode}:${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
  if (!routeCache.has(key)) {
    const job = limited(() => fetchRoute(mode, from, to));
    routeCache.set(key, job);
    // 估算結果不快取，下次再試真的路線
    job.then((r) => { if (r.estimated) routeCache.delete(key); });
    if (routeCache.size > 2000) routeCache.delete(routeCache.keys().next().value);
  }
  return routeCache.get(key);
}

// 連不上的服務：標記後 60 秒內直接跳過，不要每次都等逾時
const PROVIDER_COOLDOWN_MS = 60 * 1000;
const ROUTE_TIMEOUT_MS = 6000;

class ProviderDown extends Error {}

async function getJson(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderDown(err.message); // 逾時或連線失敗
  }
  if (res.status === 429 || res.status >= 500) throw new ProviderDown(`HTTP ${res.status}`);
  return res.json();
}

// Valhalla 的 shape 是精度 1e-6 的 encoded polyline
function decodePolyline6(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    out.push([lat / 1e6, lng / 1e6]);
  }
  return out;
}

// Valhalla 動作代碼 → 與 OSRM 相同的 type / modifier，前端共用同一套中文說明
const VALHALLA_MANEUVER = {
  1: ['depart'], 2: ['depart'], 3: ['depart'],
  4: ['arrive'], 5: ['arrive'], 6: ['arrive'],
  7: ['continue', 'straight'], 8: ['continue', 'straight'], 17: ['continue', 'straight'], 22: ['continue', 'straight'],
  9: ['turn', 'slight right'], 10: ['turn', 'right'], 11: ['turn', 'sharp right'],
  12: ['turn', 'uturn'], 13: ['turn', 'uturn'],
  14: ['turn', 'sharp left'], 15: ['turn', 'left'], 16: ['turn', 'slight left'],
  23: ['turn', 'slight right'], 24: ['turn', 'slight left'],
  26: ['roundabout'], 27: ['continue', 'straight'],
  39: ['elevator'], 40: ['stairs'], 41: ['escalator'],
};

async function valhallaRoute(mode, from, to) {
  const body = await getJson(VALHALLA_URL, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: [{ lat: from.lat, lon: from.lng }, { lat: to.lat, lon: to.lng }],
      costing: VALHALLA_COSTING[mode],
    }),
  });
  if (!body.trip) throw new Error(body.error || 'no route');
  const leg = body.trip.legs[0];
  const path = decodePolyline6(leg.shape);
  return {
    mode,
    distance: Math.round(body.trip.summary.length * 1000),
    duration: Math.round(body.trip.summary.time),
    path,
    steps: leg.maneuvers.map((m) => {
      const [type, modifier = ''] = VALHALLA_MANEUVER[m.type] || ['continue', 'straight'];
      const [lat, lng] = path[m.begin_shape_index];
      return { lat, lng, type, modifier, name: (m.street_names || [])[0] || '', distance: Math.round(m.length * 1000) };
    }),
    estimated: false,
  };
}

async function osrmRoute(mode, from, to) {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const body = await getJson(`${ROUTE_URL[mode]}/${coords}?overview=full&geometries=geojson&steps=true`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (body.code !== 'Ok') throw new Error(body.code);
  const r = body.routes[0];
  return {
    mode,
    distance: Math.round(r.distance),
    duration: Math.round(r.duration),
    path: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    // 轉彎提示：每個轉彎點的位置、動作與路名
    steps: r.legs[0].steps.map((s) => ({
      lat: s.maneuver.location[1],
      lng: s.maneuver.location[0],
      type: s.maneuver.type,
      modifier: s.maneuver.modifier || '',
      name: s.name || '',
      distance: Math.round(s.distance), // 這個轉彎之後要走多遠
    })),
    estimated: false,
  };
}

const providers = [
  { fn: valhallaRoute, downUntil: 0 },
  { fn: osrmRoute, downUntil: 0 },
];

async function fetchRoute(mode, from, to) {
  for (const p of providers) {
    if (Date.now() < p.downUntil) continue;
    try {
      return await p.fn(mode, from, to);
    } catch (err) {
      if (err instanceof ProviderDown) p.downUntil = Date.now() + PROVIDER_COOLDOWN_MS;
    }
  }
  return estimateRoute(mode, from, to);
}

function estimateRoute(mode, from, to) {
  const d = distance(from, to) * 1.3; // 直線距離 × 1.3 粗估實際路程
  return {
    mode,
    distance: Math.round(d),
    duration: Math.round(d / FALLBACK_SPEED[mode]),
    path: [[from.lat, from.lng], [to.lat, to.lng]],
    steps: [
      { lat: from.lat, lng: from.lng, type: 'depart', modifier: '', name: '', distance: Math.round(d) },
      { lat: to.lat, lng: to.lng, type: 'arrive', modifier: '', name: '', distance: 0 },
    ],
    estimated: true,
  };
}

// ---------- 火車站接駁 ----------

const ACCESS_WALK_M = 2500;      // 再遠就不建議走路到車站
const ACCESS_BIKE_NEAR_M = 800;  // YouBike 借還車站要在這個距離內
const TAXI_PREFER = 3;           // 公車／YouBike 比計程車慢超過 3 倍就建議搭計程車

// 起訖點與車站之間怎麼接駁。太遠時先用直線估算比較公車、YouBike、計程車，
// 選定後再由 refine 換成實際路線，避免每個候選車站都呼叫路線服務
async function connectRail(from, to) {
  if (distance(from, to) <= ACCESS_WALK_M) return { kind: 'walk', ...summarize([await route('foot', from, to)]) };

  const [bus, bike] = await Promise.all([
    planBus(from, to, estimateRoute).then((list) => list[0]).catch(() => null),
    getStations().then((stations) => {
      const pickup = nearest(stations, from, (s) => s.active && s.bikes > 0, 1)[0];
      const dropoff = nearest(stations, to, (s) => s.active && s.docks > 0, 1)[0];
      if (!pickup || !dropoff || pickup.id === dropoff.id) return null;
      if (pickup.distance > ACCESS_BIKE_NEAR_M || dropoff.distance > ACCESS_BIKE_NEAR_M) return null;
      return { pickup, dropoff, legs: [estimateRoute('foot', from, pickup), estimateRoute('bike', pickup, dropoff), estimateRoute('foot', dropoff, to)] };
    }).catch(() => null),
  ]);
  const candidates = [
    bus && { kind: 'bus', ...summarize(bus.legs, bus.total.duration) },
    bike && { kind: 'youbike', pickup: bike.pickup, dropoff: bike.dropoff, ...summarize(bike.legs) },
  ].filter(Boolean).sort((a, b) => a.duration - b.duration);
  const taxi = { kind: 'taxi', ...summarize([estimateRoute('taxi', from, to)]) };
  const pick = candidates[0] && candidates[0].duration <= taxi.duration * TAXI_PREFER ? candidates[0] : taxi;
  const alternatives = [...candidates, taxi].map(({ kind, duration }) => ({ kind, duration }));
  return { ...pick, alternatives };
}

function summarize(legs, duration = legs.reduce((n, l) => n + l.duration, 0)) {
  return { legs, duration: Math.round(duration), distance: legs.reduce((n, l) => n + l.distance, 0) };
}

// 把估算的步行／騎車／計程車段換成實際路線；公車的等車時間保留
connectRail.refine = async (a) => {
  if (!a.legs.some((l) => l.estimated)) return a;
  const legs = await Promise.all(a.legs.map(async (l) => {
    if (!l.estimated) return l;
    const [s, e] = [l.path[0], l.path.at(-1)].map(([lat, lng]) => ({ lat, lng }));
    const real = await route(l.mode === 'taxi' ? 'scooter' : l.mode, s, e);
    return { ...real, mode: l.mode };
  }));
  const diff = legs.reduce((n, l, i) => n + l.duration - a.legs[i].duration, 0);
  return { ...a, ...summarize(legs, a.duration + diff) };
};

// ---------- API ----------

const app = express();
app.use(express.static('public'));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(502).json({ error: err.message }));

app.get('/api/geocode', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '請輸入地點' });
  res.json(await geocode(q));
}));

// 規劃：出發點 → 步行到最近有車的站 → 騎到離目的地最近有空位的站 → 步行到目的地
app.get('/api/plan', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });

  const stations = await getStations();
  const pickups = nearest(stations, from, (s) => s.active && s.bikes > 0, CANDIDATES);
  const dropoffs = nearest(stations, to, (s) => s.active && s.docks > 0, CANDIDATES);

  if (!pickups.length || !dropoffs.length) {
    const anyOpen = stations.some((s) => s.active && (s.bikes > 0 || s.docks > 0));
    return res.status(404).json({
      error: anyOpen
        ? '附近找不到可借或可還的站點'
        : 'YouBike 目前全面暫停服務（所有站點可借、可還皆為 0），可用 npm run demo 啟動示範模式',
    });
  }

  // 使用者可從候選清單指定站點
  const pickup = pickups.find((s) => s.id === req.query.pickup) ||
    nearest(stations, from, (s) => s.id === req.query.pickup && s.bikes > 0, 1)[0] ||
    pickups[0];
  const dropoff = dropoffs.find((s) => s.id === req.query.dropoff) ||
    nearest(stations, to, (s) => s.id === req.query.dropoff && s.docks > 0, 1)[0] ||
    dropoffs[0];

  // 從捷運站出發（mrt=1）時，從最適合的出口開始走
  const exitPick = req.query.mrt === '1' ? bestExit(exits, from, pickup) : null;
  const start = exitPick ? exitPick.best : from;

  const legs = await Promise.all([
    route('foot', start, pickup),
    pickup.id === dropoff.id ? null : route('bike', pickup, dropoff),
    route('foot', dropoff, to),
  ]);

  const directWalk = distance(from, to);
  const steps = legs.filter(Boolean);
  res.json({
    demo: DEMO,
    from,
    to,
    exit: exitPick?.best || null,
    exits: exitPick?.all || [],
    pickup,
    dropoff,
    pickups,
    dropoffs,
    legs: steps,
    total: {
      distance: steps.reduce((n, l) => n + l.distance, 0),
      duration: steps.reduce((n, l) => n + l.duration, 0),
    },
    suggestWalk: pickup.id === dropoff.id || directWalk < 600,
  });
}));

// 公車規劃：步行 → 公車 →（步行轉乘 → 公車）→ 步行
app.get('/api/bus', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  const [options, nearby] = await Promise.all([planBus(from, to, route), nearbyArrivals(from)]);
  res.json({ from, to, options, nearby });
}));

// 共享機車：（步行到取車位置）→ 騎到目的地附近有機車格的停車場 → 步行到目的地
app.get('/api/scooter', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  const vehicle = parsePoint(req.query.vehicle); // 使用者在 App 看到的車輛位置，可不填

  const { list: parkings, updated } = await nearbyParking(to);
  if (!parkings.length) {
    return res.status(404).json({ error: '目的地附近 1.5 公里內找不到有機車格的停車場（目前只支援台北市）' });
  }
  const parking = parkings.find((p) => p.id === req.query.parking) || parkings[0];
  const start = vehicle || from;

  const legs = await Promise.all([
    vehicle ? route('foot', from, vehicle) : null,
    route('scooter', start, parking),
    route('foot', parking, to),
  ]);
  const steps = legs.filter(Boolean);
  res.json({
    from,
    to,
    vehicle,
    parking,
    parkings,
    availabilityUpdated: updated,
    legs: steps,
    total: {
      distance: steps.reduce((n, l) => n + l.distance, 0),
      duration: steps.reduce((n, l) => n + l.duration, 0),
    },
  });
}));

// 台鐵（system=tra）／高鐵（system=thsr）：接駁到車站 → 搭車 → 接駁到目的地
app.get('/api/rail', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  if (!hasTdx()) return res.status(503).json({ error: '伺服器尚未設定 TDX 金鑰，無法查詢火車時刻' });
  const when = parseWhen(req.query.date, req.query.time);
  if (when.error) return res.status(400).json({ error: when.error });
  res.json(await planRail(req.query.system === 'thsr' ? 'thsr' : 'tra', from, to, connectRail, when));
}));

// 全台捷運／輕軌：接駁到車站 → 搭捷運（可轉乘） → 接駁到目的地
app.get('/api/metro', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  res.json(await planMetro(from, to, connectRail));
}));

app.get('/api/metro/map', (req, res) => res.json(metroMap()));

// 乘車日期（YYYY-MM-DD）與出發時間（HH:MM）；沒填日期就是現在，其他日期沒填時間就從頭班車列起
const MAX_DAYS_AHEAD = 30;
function parseWhen(date, time) {
  const now = taipeiNow();
  if (!date) return now;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日期格式不正確' };
  const days = (Date.parse(date) - Date.parse(now.date)) / 86400000;
  if (!(days >= 0 && days <= MAX_DAYS_AHEAD)) return { error: `只能查今天起 ${MAX_DAYS_AHEAD} 天內的班次` };
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : date === now.date ? now.minutes : 0;
  return { date, minutes };
}

// 車站位置（地圖上標示高鐵站用）
app.get('/api/rail/stations', wrap(async (req, res) => {
  if (!hasTdx()) return res.status(503).json({ error: '伺服器尚未設定 TDX 金鑰' });
  res.json(await railStations(req.query.system === 'tra' ? 'tra' : 'thsr'));
}));

app.listen(PORT, () => {
  console.log(`公共交通地圖：http://localhost:${PORT}${DEMO ? '（YouBike 示範模式）' : ''}`);
  if (hasTdx()) {
    warmUpRail()
      .then(() => console.log('已載入今天的台鐵、高鐵時刻表'))
      .catch((e) => console.log('火車時刻表載入失敗：', e.message));
  }
  warmUpParking()
    .then(([lots]) => console.log(`已載入 ${lots.length} 個有機車格的停車場`))
    .catch((e) => console.log('停車場資料載入失敗：', e.message));
  console.log(`已載入 ${exits.length} 個捷運出口`);
  const t = Date.now();
  warmUp()
    .then(([n]) => console.log(`已載入 ${n.lines.size} 條公車路線（${Date.now() - t} ms）`))
    .catch((e) => console.log('公車資料載入失敗：', e.message));
});
