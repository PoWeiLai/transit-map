// 公車轉乘規劃（台北市＋新北市公開資料，不需金鑰）
import { gunzipSync } from 'node:zlib';
import { distance } from './geo.js';

const BASE = 'https://tcgbusfs.blob.core.windows.net/';
const SOURCES = ['blobbus', 'ntpcbus']; // 台北市、新北市
const STATIC_MS = 24 * 60 * 60 * 1000;  // 路線、站牌一天更新一次
const ETA_MS = 30 * 1000;               // 到站時間 30 秒

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

// 附近 3×3 格內、距離 radius 以內的項目
function* nearGrid(grid, point, radius) {
  const r = Math.floor(point.lat / GRID), c = Math.floor(point.lng / GRID);
  for (let i = r - 1; i <= r + 1; i++) {
    for (let j = c - 1; j <= c + 1; j++) {
      for (const item of grid.get(`${i},${j}`) || []) {
        const d = distance(point, item.stop);
        if (d <= radius) yield { ...item, d };
      }
    }
  }
}

// ---------- 資料 ----------

let network = null;
let networkAt = 0;

async function getNetwork() {
  if (network && Date.now() - networkAt < STATIC_MS) return network;
  const [stops, routes] = await Promise.all([
    Promise.all(SOURCES.map((s) => getGz(`${s}/GetStop.gz`))).then((l) => l.flat()),
    Promise.all(SOURCES.map((s) => getGz(`${s}/GetRoute.gz`))).then((l) => l.flat()),
  ]);

  const info = new Map(routes.map((r) => [r.Id, r]));
  // 每條路線的每個方向 = 一條 line，站牌依序排好
  const lines = new Map();
  for (const s of stops) {
    const key = `${s.routeId}_${s.goBack}`;
    if (!lines.has(key)) {
      const r = info.get(s.routeId);
      lines.set(key, {
        key,
        name: r?.nameZh || String(s.routeId),
        headsign: r ? `往${s.goBack === '0' ? r.destinationZh : r.departureZh}` : '',
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

  network = { lines, grid };
  networkAt = Date.now();
  return network;
}

let etaCache = { at: 0, data: new Map() };

async function getEta() {
  if (Date.now() - etaCache.at < ETA_MS) return etaCache.data;
  try {
    const lists = await Promise.all(SOURCES.map((s) => getGz(`${s}/GetEstimateTime.gz`)));
    etaCache = { at: Date.now(), data: new Map(lists.flat().map((e) => [e.StopID, Number(e.EstimateTime)])) };
  } catch {
    // 到站時間抓不到時沿用舊資料，規劃照樣可用
  }
  return etaCache.data;
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
const rideTime = (line, i, j) => rideLength(line, i, j) / BUS_SPEED;

// ---------- 規劃 ----------

// 每條 line 在 point 附近最近的那個站
function nearestPerLine(grid, point) {
  const best = new Map();
  for (const hit of nearGrid(grid, point, NEAR_M)) {
    if (EXCLUDE.test(hit.line.name)) continue;
    const cur = best.get(hit.line.key);
    if (!cur || hit.d < cur.d) best.set(hit.line.key, hit);
  }
  return best;
}

// 找出不轉乘及轉一次的方案，依估計總時間排序
export async function planBus(from, to, route) {
  const [{ grid }, eta] = await Promise.all([getNetwork(), getEta()]);
  const boards = nearestPerLine(grid, from);
  const alights = nearestPerLine(grid, to);
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
  const [{ grid }, eta] = await Promise.all([getNetwork(), getEta()]);
  return [...nearestPerLine(grid, point).values()]
    .filter((h) => h.i < h.line.stops.length - 1) // 終點站上不了車
    .map((h) => {
      const e = eta.get(h.stop.id);
      return { route: h.line.name, headsign: h.line.headsign, stop: h.stop.name, distance: Math.round(h.d),
               eta: Number.isNaN(e) ? null : e ?? null, etaText: etaText(e) };
    })
    .sort((a, b) => (a.eta >= 0 ? a.eta : 1e9) - (b.eta >= 0 ? b.eta : 1e9) || a.distance - b.distance)
    .slice(0, limit);
}

// 啟動時先載入，第一次查詢才不會等太久
export const warmUp = () => Promise.all([getNetwork(), getEta()]);
