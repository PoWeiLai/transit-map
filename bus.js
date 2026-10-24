// 公車轉乘規劃：台北市＋新北市用公開資料（不需金鑰），其他縣市與公路／國道客運用交通部 TDX
import { gunzipSync } from 'node:zlib';
import { distance } from './geo.js';
import { tdx, hasTdx, daily, cached } from './tdx.js';

const BASE = 'https://tcgbusfs.blob.core.windows.net/';
const SOURCES = ['blobbus', 'ntpcbus']; // 台北市、新北市
const STATIC_MS = 24 * 60 * 60 * 1000;  // 路線、站牌一天更新一次
const ETA_MS = 30 * 1000;               // 到站時間 30 秒

// 雙北以外的縣市（TDX 的 City 名稱），用概略的經緯度範圍判斷起訖點在哪些縣市，
// 只載入用得到的縣市；邊界附近會同時載入相鄰縣市，跨縣市轉乘也找得到
const CITIES = [
  // [City, 南, 北, 西, 東]
  ['Keelung', 25.05, 25.20, 121.62, 121.82],
  ['Taoyuan', 24.58, 25.13, 120.98, 121.48],
  ['Hsinchu', 24.70, 24.86, 120.88, 121.04],
  ['HsinchuCounty', 24.40, 24.96, 120.95, 121.42],
  ['MiaoliCounty', 24.25, 24.75, 120.60, 121.27],
  ['Taichung', 23.98, 24.45, 120.45, 121.46],
  ['ChanghuaCounty', 23.78, 24.21, 120.23, 120.70],
  ['NantouCounty', 23.43, 24.25, 120.60, 121.35],
  ['YunlinCounty', 23.49, 23.85, 120.12, 120.74],
  ['Chiayi', 23.44, 23.52, 120.39, 120.50],
  ['ChiayiCounty', 23.15, 23.65, 120.10, 120.95],
  ['Tainan', 22.88, 23.42, 120.02, 120.67],
  ['Kaohsiung', 22.45, 23.47, 120.15, 121.05],
  ['PingtungCounty', 21.89, 22.88, 120.40, 120.92],
  ['YilanCounty', 24.30, 24.99, 121.30, 121.98],
  ['HualienCounty', 23.09, 24.38, 121.27, 121.75],
  ['TaitungCounty', 21.90, 23.45, 120.73, 121.58], // 含綠島、蘭嶼
  ['PenghuCounty', 23.18, 23.80, 119.30, 119.75],
  ['KinmenCounty', 24.38, 24.53, 118.20, 118.50],
  ['LienchiangCounty', 25.90, 26.40, 119.85, 120.55], // 馬祖
];
// 雙北範圍：這裡面的查詢只用台北市、新北市資料（加上相鄰縣市）
const TAIPEI_AREA = [24.67, 25.30, 121.28, 122.01];
const INTERCITY = 'InterCity'; // 公路客運、國道客運（全台一份）
const INTERCITY_SPEED = 8;     // m/s，公路／國道客運停站少、常走快速道路
const DOWNLOAD_MS = 3 * 60 * 1000; // 路線站序檔案很大，下載逾時放寬
const LOAD_WAIT_MS = 8000;     // 查詢時最多等還沒載入的縣市這麼久，其餘在背景繼續載入，下次查詢就有
const ETA_WAIT_MS = 5000;      // 即時到站抓太久就先用上一次的資料

const NEAR_M = 600;          // 出發點／目的地多遠內的站牌
const MIN_RIDE_M = 700;      // 坐太短不如走路
const EXCLUDE = /懷恩|觀光巴士/; // 特殊用途路線，不列入規劃
const TRANSFER_M = 300;      // 轉乘可步行的距離
const WALK_SPEED = 1.2;      // m/s
const WALK_DETOUR = 1.3;     // 直線距離換算實際步行
const BUS_SPEED = 4.5;       // m/s，含停站的平均速度
const DEFAULT_WAIT = 5 * 60; // 不知道到站時間時，假設等 5 分鐘
const MISSED_WAIT = 10 * 60; // 車會比你早到，等下一班
const TRANSFER_PENALTY = 2 * 60;
const MAX_OPTIONS = 4;
const GRID = 0.005;          // 空間索引格子大小（約 500 公尺）

async function getGz(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`公車資料 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let text;
  try { text = gunzipSync(buf).toString('utf8'); } catch { text = buf.toString('utf8'); }
  return JSON.parse(text.replace(/^﻿/, '')).BusInfo;
}

const cellKey = (lat, lng) => `${Math.floor(lat / GRID)},${Math.floor(lng / GRID)}`;

function addToGrid(grid, item) {
  const k = cellKey(item.stop.lat, item.stop.lng);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(item);
}

// 附近 3×3 格內、距離 radius 以內的項目；grids 可以是多份資料各自的索引
function* nearGrid(grids, point, radius) {
  const r = Math.floor(point.lat / GRID), c = Math.floor(point.lng / GRID);
  for (const grid of [grids].flat()) {
    for (let i = r - 1; i <= r + 1; i++) {
      for (let j = c - 1; j <= c + 1; j++) {
        for (const item of grid.get(`${i},${j}`) || []) {
          const d = distance(point, item.stop);
          if (d <= radius) yield { ...item, d };
        }
      }
    }
  }
}

// ---------- 資料 ----------

// lines：每條路線的每個方向，站牌依序排好；算出沿線累計距離並建立空間索引
function indexLines(lines) {
  const grid = new Map();
  for (const line of lines.values()) {
    line.stops.sort((a, b) => a.seq - b.seq);
    // 累計沿線距離，用來估算搭乘時間
    let acc = 0;
    line.stops.forEach((s, i) => {
      if (i) acc += distance(line.stops[i - 1], s);
      s.along = acc;
      addToGrid(grid, { line, i, stop: s });
    });
  }
  return { lines, grid };
}

let network = null;
let networkAt = 0;

async function getNetwork() {
  if (network && Date.now() - networkAt < STATIC_MS) return network;
  const [stops, routes] = await Promise.all([
    Promise.all(SOURCES.map((s) => getGz(`${s}/GetStop.gz`))).then((l) => l.flat()),
    Promise.all(SOURCES.map((s) => getGz(`${s}/GetRoute.gz`))).then((l) => l.flat()),
  ]);

  const info = new Map(routes.map((r) => [r.Id, r]));
  const lines = new Map();
  for (const s of stops) {
    const key = `${s.routeId}_${s.goBack}`;
    if (!lines.has(key)) {
      const r = info.get(s.routeId);
      lines.set(key, {
        key,
        name: r?.nameZh || String(s.routeId),
        headsign: r ? `往${s.goBack === '0' ? r.destinationZh : r.departureZh}` : '',
        speed: BUS_SPEED,
        stops: [],
      });
    }
    lines.get(key).stops.push({
      id: s.Id,
      location: s.stopLocationId,
      seq: s.seqNo,
      name: s.nameZh,
      address: s.address,
      lat: Number(s.latitude),
      lng: Number(s.longitude),
    });
  }

  network = indexLines(lines);
  networkAt = Date.now();
  return network;
}

// TDX 的路線站序（一天抓一次存到硬碟），只留規劃用得到的欄位
const tdxRoutes = (source) => daily(`bus-${source}`, async () => {
  const path = source === INTERCITY ? 'v2/Bus/StopOfRoute/InterCity' : `v2/Bus/StopOfRoute/City/${source}`;
  const list = await tdx(path, { $select: 'RouteUID,RouteName,SubRouteUID,SubRouteName,Direction,Stops' }, { timeout: DOWNLOAD_MS });
  return list.map((r) => ({
    route: r.RouteUID,
    sub: r.SubRouteUID,
    name: r.SubRouteName?.Zh_tw || r.RouteName?.Zh_tw || r.RouteUID,
    dir: r.Direction,
    stops: r.Stops.map((s) => [s.StopUID, s.StopSequence, s.StopName?.Zh_tw || '', s.StopPosition.PositionLat, s.StopPosition.PositionLon, s.StationID || s.StopUID]),
  }));
});

// 到站時間的 key：TDX 的 StopUID 會被多條路線共用，要加上路線與方向
const tdxStopId = (route, dir, stop) => `${route}_${dir}_${stop}`;

const tdxNetworks = new Map();
const loading = new Set(); // 還在下載的資料

function getTdxNetwork(source) {
  const hit = tdxNetworks.get(source);
  if (hit && Date.now() - hit.at < STATIC_MS) return hit.value;
  const value = tdxRoutes(source).then((routes) => {
    const lines = new Map();
    for (const r of routes) {
      if (r.stops.length < 2) continue;
      const key = `${r.sub}_${r.dir}`;
      const stops = r.stops.map(([uid, seq, name, lat, lng, station]) => ({
        id: tdxStopId(r.route, r.dir, uid), location: station, seq, name, lat, lng,
      }));
      stops.sort((a, b) => a.seq - b.seq);
      lines.set(key, {
        key,
        name: r.name,
        headsign: `往${stops.at(-1).name}`,
        speed: source === INTERCITY ? INTERCITY_SPEED : BUS_SPEED,
        stops,
      });
    }
    return indexLines(lines);
  });
  loading.add(source);
  value.catch(() => tdxNetworks.delete(source)).finally(() => loading.delete(source)); // 失敗下次重抓
  tdxNetworks.set(source, { at: Date.now(), value });
  return value;
}

const inBox = (p, [s, n, w, e], margin = 0.01) => p.lat >= s - margin && p.lat <= n + margin && p.lng >= w - margin && p.lng <= e + margin;

// 這幾個點會用到哪些資料：雙北一律載入（已預先載入，最快），其他縣市與公路客運要有 TDX 金鑰
function sourcesFor(points) {
  if (!hasTdx()) return [];
  const cities = CITIES.filter(([, ...box]) => points.some((p) => inBox(p, box))).map(([name]) => name);
  // 都在雙北範圍內就不載入公路客運，維持原本的速度
  const intercity = cities.length || points.some((p) => !inBox(p, TAIPEI_AREA, 0));
  return intercity ? [...cities, INTERCITY] : cities;
}

// 最多等 ms，逾時先回傳 fallback（原本的工作繼續跑完並快取）
const within = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// 取得所有用得到的路網；TDX 某個縣市失敗或還在下載時先略過，其他照樣能規劃
async function getNetworks(points) {
  const list = await Promise.all([
    getNetwork(),
    ...sourcesFor(points).map((s) => within(getTdxNetwork(s).catch(() => null), LOAD_WAIT_MS, null)),
  ]);
  return list.filter(Boolean);
}

let etaCache = { at: 0, data: new Map() };

async function getTaipeiEta() {
  if (Date.now() - etaCache.at < ETA_MS) return etaCache.data;
  try {
    const lists = await Promise.all(SOURCES.map((s) => getGz(`${s}/GetEstimateTime.gz`)));
    etaCache = { at: Date.now(), data: new Map(lists.flat().map((e) => [e.StopID, Number(e.EstimateTime)])) };
  } catch {
    // 到站時間抓不到時沿用舊資料，規劃照樣可用
  }
  return etaCache.data;
}

// TDX 的 StopStatus：0 正常、1 尚未發車、2 交管不停靠、3 末班車已過、4 今日未營運，換成與雙北相同的代碼
const lastTdxEta = new Map();

function getTdxEta(source) {
  // 公路／國道客運的到站資料全台一份太大（約 15 MB），不抓，用預設等車時間
  if (source === INTERCITY) return new Map();
  return cached(`bus-eta:${source}`, ETA_MS, async () => {
    const list = await tdx(`v2/Bus/EstimatedTimeOfArrival/City/${source}`, { $select: 'RouteUID,Direction,StopUID,EstimateTime,StopStatus' });
    const data = new Map();
    for (const e of list) {
      const v = e.StopStatus === 0 && e.EstimateTime != null ? e.EstimateTime : e.StopStatus ? -e.StopStatus : NaN;
      const id = tdxStopId(e.RouteUID, e.Direction, e.StopUID);
      // 同一站有多筆（不同子路線）時取最快到的
      const cur = data.get(id);
      if (cur == null || (v >= 0 && (cur < 0 || v < cur))) data.set(id, v);
    }
    lastTdxEta.set(source, data);
    return data;
  }).catch(() => lastTdxEta.get(source) || new Map()); // 抓不到沿用舊資料
}

// 各份資料的站牌 id 不會重複，合併成一個查詢
async function getEta(points) {
  const maps = await Promise.all([getTaipeiEta(), ...sourcesFor(points).map((s) => within(getTdxEta(s), ETA_WAIT_MS, lastTdxEta.get(s) || new Map()))]);
  return { get: (id) => { for (const m of maps) if (m.has(id)) return m.get(id); } };
}

// -1 尚未發車、-2 交管不停靠、-3 末班車已過、-4 今日未營運
const NO_SERVICE = new Set([-2, -3, -4]);

export function etaText(eta) {
  if (eta == null || Number.isNaN(eta)) return '無到站資訊';
  if (eta >= 0) return eta < 60 ? '即將進站' : `約 ${Math.round(eta / 60)} 分鐘到站`;
  return { '-1': '尚未發車', '-2': '交管不停靠', '-3': '末班車已過', '-4': '今日未營運' }[eta] || '無到站資訊';
}

// 走到站牌要 walkTime 秒，估計要等多久
function waitFor(eta, walkTime) {
  if (eta == null || Number.isNaN(eta)) return DEFAULT_WAIT;
  if (NO_SERVICE.has(eta)) return Infinity;
  if (eta === -1) return MISSED_WAIT; // 尚未發車，可能要等很久
  return eta >= walkTime ? eta - walkTime : MISSED_WAIT;
}

const walkTime = (m) => (m * WALK_DETOUR) / WALK_SPEED;
const rideLength = (line, i, j) => line.stops[j].along - line.stops[i].along;
const rideTime = (line, i, j) => rideLength(line, i, j) / line.speed;

// ---------- 規劃 ----------

// 每條 line 在 point 附近最近的那個站
function nearestPerLine(grids, point) {
  const best = new Map();
  for (const hit of nearGrid(grids, point, NEAR_M)) {
    if (EXCLUDE.test(hit.line.name)) continue;
    const cur = best.get(hit.line.key);
    if (!cur || hit.d < cur.d) best.set(hit.line.key, hit);
  }
  return best;
}

// 找出不轉乘及轉一次的方案，依估計總時間排序。
// live = false：不是現在要搭（例如火車幾小時後才到站），即時到站時間不適用，等車時間用預設值
export async function planBus(from, to, route, live = true) {
  const [networks, eta] = await Promise.all([getNetworks([from, to]), live ? getEta([from, to]) : new Map()]);
  const grids = networks.map((n) => n.grid);
  const boards = nearestPerLine(grids, from);
  const alights = nearestPerLine(grids, to);
  const options = [];

  // 不用轉乘
  for (const [key, b] of boards) {
    const a = alights.get(key);
    if (!a || a.i <= b.i || rideLength(b.line, b.i, a.i) < MIN_RIDE_M) continue;
    const w0 = walkTime(b.d);
    const cost = w0 + waitFor(eta.get(b.stop.id), w0) + rideTime(b.line, b.i, a.i) + walkTime(a.d);
    if (cost < Infinity) options.push({ cost, direct: true, rides: [{ line: b.line, i: b.i, j: a.i }], walk0: b.d, walkEnd: a.d });
  }

  // 轉乘一次：第一班車下游的站 × 第二班車上游的站，距離在 TRANSFER_M 內
  const upstream = new Map();
  for (const [, a] of alights) {
    for (let j = 0; j < a.i; j++) addToGrid(upstream, { line: a.line, i: j, stop: a.line.stops[j], alight: a });
  }
  const bestPair = new Map();
  for (const [, b] of boards) {
    const w0 = walkTime(b.d);
    const wait1 = waitFor(eta.get(b.stop.id), w0);
    if (wait1 === Infinity) continue;
    for (let i = b.i + 1; i < b.line.stops.length; i++) {
      if (rideLength(b.line, b.i, i) < MIN_RIDE_M) continue;
      const s1 = b.line.stops[i];
      for (const t of nearGrid(upstream, s1, TRANSFER_M)) {
        if (t.line.key === b.line.key || t.line.name === b.line.name) continue;
        if (rideLength(t.line, t.i, t.alight.i) < MIN_RIDE_M) continue;
        // 第二班車：用轉乘站的即時到站時間，算到時要等多久
        const reach = w0 + wait1 + rideTime(b.line, b.i, i) + walkTime(t.d) + TRANSFER_PENALTY;
        const wait2 = waitFor(eta.get(t.stop.id), reach);
        if (wait2 === Infinity) continue;
        const cost = reach + wait2 + rideTime(t.line, t.i, t.alight.i) + walkTime(t.alight.d);
        const pair = `${b.line.key}|${t.line.key}`;
        if (!bestPair.has(pair) || cost < bestPair.get(pair).cost) {
          bestPair.set(pair, {
            cost,
            rides: [{ line: b.line, i: b.i, j: i }, { line: t.line, i: t.i, j: t.alight.i }],
            walk0: b.d,
            walkEnd: t.alight.d,
          });
        }
      }
    }
  }
  options.push(...bestPair.values());

  // 同一組路線名稱只留最快的（例如同一路線不同方向的重複）
  const seen = new Set();
  const ranked = options
    .sort((a, b) => a.cost - b.cost)
    .filter((o) => {
      const sig = o.rides.map((r) => r.line.name).join('>');
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  // 不用轉乘比較輕鬆：最快的直達車一定列出來，即使慢一點
  const top = ranked.slice(0, MAX_OPTIONS);
  const direct = ranked.find((o) => o.direct);
  if (direct && !top.includes(direct)) top[top.length - 1] = direct;
  top.sort((a, b) => a.cost - b.cost);

  // 用實際步行路線算出的總時間重新排序
  const built = await Promise.all(top.map((o) => buildOption(o, from, to, eta, route)));
  return built.sort((a, b) => a.total.duration - b.total.duration);
}

function busLeg(r, eta) {
  const stops = r.line.stops.slice(r.i, r.j + 1);
  const e = eta.get(stops[0].id);
  return {
    mode: 'bus',
    route: r.line.name,
    headsign: r.line.headsign,
    eta: Number.isNaN(e) ? null : e ?? null,
    etaText: etaText(e),
    stopCount: stops.length - 1,
    distance: Math.round(stops.at(-1).along - stops[0].along),
    duration: Math.round(rideTime(r.line, r.i, r.j)),
    path: stops.map((s) => [s.lat, s.lng]),
    // 坐車時的「步驟」就是沿途每一站，導航時用來提示還有幾站
    steps: stops.map((s, k) => ({
      lat: s.lat,
      lng: s.lng,
      type: k === 0 ? 'board' : k === stops.length - 1 ? 'alight' : 'stop',
      name: s.name,
      address: s.address,
      remaining: stops.length - 1 - k,
    })),
    board: stops[0],
    alight: stops.at(-1),
  };
}

async function buildOption(o, from, to, eta, route) {
  const buses = o.rides.map((r) => busLeg(r, eta));
  const walks = [route('foot', from, buses[0].board)];
  if (buses.length === 2) {
    // 同一個站牌位置轉乘就不用走
    const sameSpot = buses[0].alight.location === buses[1].board.location ||
      distance(buses[0].alight, buses[1].board) < 20;
    walks.push(sameSpot ? null : route('foot', buses[0].alight, buses[1].board));
  }
  walks.push(route('foot', buses.at(-1).alight, to));
  const [w0, wt, wEnd] = buses.length === 2 ? await Promise.all(walks) : [await walks[0], null, await walks[1]];

  const legs = buses.length === 2
    ? [w0, buses[0], wt, buses[1], wEnd].filter(Boolean)
    : [w0, buses[0], wEnd];
  // 總時間用實際步行路線重算等車時間
  let t = w0.duration;
  let wait = waitFor(buses[0].eta ?? NaN, t);
  t += wait + buses[0].duration;
  if (buses.length === 2) {
    t += (wt?.duration || 0) + TRANSFER_PENALTY;
    const w2 = waitFor(buses[1].eta ?? NaN, t);
    wait += TRANSFER_PENALTY + w2;
  }
  return {
    legs,
    transfers: buses.length - 1,
    walkDistance: legs.filter((l) => l.mode === 'foot').reduce((n, l) => n + l.distance, 0),
    total: {
      distance: legs.reduce((n, l) => n + l.distance, 0),
      duration: Math.round(legs.reduce((n, l) => n + l.duration, 0) + wait),
    },
  };
}

// 出發點附近的公車即時到站（每條路線方向取最近的站）
export async function nearbyArrivals(point, limit = 15) {
  const [networks, eta] = await Promise.all([getNetworks([point]), getEta([point])]);
  return [...nearestPerLine(networks.map((n) => n.grid), point).values()]
    .filter((h) => h.i < h.line.stops.length - 1) // 終點站上不了車
    .map((h) => {
      const e = eta.get(h.stop.id);
      return { route: h.line.name, headsign: h.line.headsign, stop: h.stop.name, distance: Math.round(h.d),
               eta: Number.isNaN(e) ? null : e ?? null, etaText: etaText(e) };
    })
    .sort((a, b) => (a.eta >= 0 ? a.eta : 1e9) - (b.eta >= 0 ? b.eta : 1e9) || a.distance - b.distance)
    .slice(0, limit);
}

// 這幾個點用到的公車資料是否還在下載（第一次查某個縣市時），讓畫面提示稍後再查
export const stillLoading = (points) => sourcesFor(points).some((s) => loading.has(s));

// 啟動時先載入，第一次查詢才不會等太久
// 公路客運全台一份、第一次要抓約半分鐘，有金鑰就在背景先載入
export const warmUp = () => {
  if (hasTdx()) getTdxNetwork(INTERCITY).catch((e) => console.log('公路客運資料載入失敗：', e.message));
  return Promise.all([getNetwork(), getTaipeiEta()]);
};
