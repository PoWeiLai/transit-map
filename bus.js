// 公車轉乘規劃：台北市＋新北市用公開資料（不需金鑰），其他縣市與公路／國道客運用交通部 TDX
import { gunzipSync } from 'node:zlib';
import { distance } from './geo.js';
import { tdx, hasTdx, daily, cached, taipeiNow, toMinutes } from './tdx.js';
import { citiesAt, inBox } from './cities.js';
import { addCoachInfo } from './coach.js';

const BASE = 'https://tcgbusfs.blob.core.windows.net/';
const SOURCES = ['blobbus', 'ntpcbus']; // 台北市、新北市
const STATIC_MS = 24 * 60 * 60 * 1000;  // 路線、站牌一天更新一次
const ETA_MS = 30 * 1000;               // 到站時間 30 秒

// 雙北以外的縣市用 TDX，只載入起訖點所在（含邊界附近相鄰）的縣市；跨縣市轉乘也找得到。
// 雙北範圍：這裡面的查詢只用台北市、新北市資料（加上相鄰縣市）
const TAIPEI_AREA = [24.67, 25.30, 121.28, 122.01];
const INTERCITY = 'InterCity'; // 公路客運、國道客運（全台一份）
const INTERCITY_SPEED = 8;     // m/s，公路／國道客運停站少、常走快速道路（沒有時刻表時才用）
const HIGHWAY_GAP_M = 5000;    // 客運兩站距離超過這麼遠，當作走國道／快速道路
const HIGHWAY_SPEED = 22;      // m/s，約時速 80 公里
const DOWNLOAD_MS = 3 * 60 * 1000; // 路線站序檔案很大，下載逾時放寬
const SCHEDULE_MS = 5 * 60 * 1000; // 客運時刻表全台一份約 57 MB
const SCHEDULE_RETRY_MS = 10 * 60 * 1000; // 時刻表載入失敗，隔一段時間再試
const ETA_BATCH = 80;          // 客運即時到站一次查幾條路線（只查起訖點附近的，免費金鑰每分鐘只能 5 次）
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_S = 24 * 60 * 60;
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
    // 累計沿線距離與估計車程：客運站距很長的段落多半走國道，用比較快的速度
    let acc = 0, time = 0;
    line.stops.forEach((s, i) => {
      if (i) {
        const d = distance(line.stops[i - 1], s);
        acc += d;
        time += d / (line.source === INTERCITY && d > HIGHWAY_GAP_M ? HIGHWAY_SPEED : line.speed);
      }
      s.along = acc;
      s.est = time;
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
        id: tdxStopId(r.route, r.dir, uid), uid, location: station, seq, name, lat, lng,
      }));
      stops.sort((a, b) => a.seq - b.seq);
      lines.set(key, {
        key,
        source,
        route: r.route,
        name: source === INTERCITY ? `客運 ${r.name}` : r.name, // 畫面上看得出是客運
        sub: r.sub,
        dir: r.dir,
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

// 這幾個點會用到哪些資料：雙北一律載入（已預先載入，最快），其他縣市與公路客運要有 TDX 金鑰
function sourcesFor(points) {
  if (!hasTdx()) return [];
  const cities = citiesAt(points, ['Taipei', 'NewTaipei']);
  // 都在雙北範圍內就不載入公路客運，維持原本的速度
  const intercity = cities.length || points.some((p) => !inBox(p, TAIPEI_AREA, 0));
  return intercity ? [...cities, INTERCITY] : cities;
}

// 最多等 ms，逾時先回傳 fallback（原本的工作繼續跑完並快取）
const within = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// 取得所有用得到的路網；TDX 某個縣市失敗或還在下載時先略過，其他照樣能規劃
async function getNetworks(points) {
  if (sourcesFor(points).includes(INTERCITY)) loadTimetables();
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

const ETA_FIELDS = 'RouteUID,Direction,StopUID,EstimateTime,StopStatus';

function addEta(list, data) {
  for (const e of list) {
    const v = e.StopStatus === 0 && e.EstimateTime != null ? e.EstimateTime : e.StopStatus ? -e.StopStatus : NaN;
    const id = tdxStopId(e.RouteUID, e.Direction, e.StopUID);
    // 同一站有多筆（不同子路線）時取最快到的
    const cur = data.get(id);
    if (cur == null || (v >= 0 && (cur < 0 || v < cur))) data.set(id, v);
  }
  return data;
}

function getTdxEta(source) {
  return cached(`bus-eta:${source}`, ETA_MS, async () => {
    const list = await tdx(`v2/Bus/EstimatedTimeOfArrival/City/${source}`, { $select: ETA_FIELDS });
    const data = addEta(list, new Map());
    lastTdxEta.set(source, data);
    return data;
  }).catch(() => lastTdxEta.get(source) || new Map()); // 抓不到沿用舊資料
}

// 公路／國道客運的到站資料全台一份太大（約 15 MB），只查用得到的路線（起訖點附近），每條路線 30 秒內不重抓
const intercityEta = new Map();   // 站牌 id → 到站時間
const intercityFetch = new Map(); // RouteUID → { at, job }

function getIntercityEta(routes) {
  const now = Date.now();
  const wanted = [...new Set(routes)];
  const stale = wanted.filter((r) => !(now - (intercityFetch.get(r)?.at || 0) < ETA_MS));
  for (let k = 0; k < stale.length; k += ETA_BATCH) {
    const chunk = stale.slice(k, k + ETA_BATCH);
    const job = tdx(`v2/Bus/EstimatedTimeOfArrival/${INTERCITY}`, {
      $filter: chunk.map((r) => `RouteUID eq '${r}'`).join(' or '),
      $select: ETA_FIELDS,
    }).then((list) => {
      // 這幾條路線換成新資料（同一站取最快的，不跟舊資料比）
      const prefixes = chunk.map((r) => `${r}_`);
      for (const id of intercityEta.keys()) if (prefixes.some((p) => id.startsWith(p))) intercityEta.delete(id);
      addEta(list, intercityEta);
    }).catch(() => chunk.forEach((r) => intercityFetch.delete(r))); // 抓不到沿用舊資料，下次重抓
    chunk.forEach((r) => intercityFetch.set(r, { at: now, job }));
  }
  return Promise.all(wanted.map((r) => intercityFetch.get(r)?.job)).then(() => intercityEta);
}

// 起訖點附近的客運路線（近的優先），決定要查哪些路線的即時到站
const intercityRoutes = (hits) => [...new Set(hits
  .filter((h) => h.line.source === INTERCITY)
  .sort((a, b) => a.d - b.d)
  .map((h) => h.line.route))].slice(0, ETA_BATCH);

// 各份資料的站牌 id 不會重複，合併成一個查詢；客運只查 routes 這幾條路線
async function getEta(points, routes = []) {
  const maps = await Promise.all([
    getTaipeiEta(),
    ...sourcesFor(points).filter((s) => s !== INTERCITY)
      .map((s) => within(getTdxEta(s), ETA_WAIT_MS, lastTdxEta.get(s) || new Map())),
    routes.length ? within(getIntercityEta(routes), ETA_WAIT_MS, intercityEta) : new Map(),
  ]);
  return { get: (id) => { for (const m of maps) if (m.has(id)) return m.get(id); } };
}

// ---------- 客運時刻表 ----------

// TDX 的班表一天抓一次，壓縮成每條子路線方向：站牌 + 每班車 [行駛星期（位元）, 各站時間（分鐘）]
const schedules = () => daily(`bus-schedule-${INTERCITY}`, async () => {
  const list = await tdx(`v2/Bus/Schedule/${INTERCITY}`, { $select: 'SubRouteUID,Direction,Timetables' }, { timeout: SCHEDULE_MS });
  const out = {};
  for (const r of list) {
    const tt = (out[`${r.SubRouteUID}_${r.Direction}`] ||= { stops: [], trips: [] });
    const col = new Map(tt.stops.map((uid, k) => [uid, k]));
    for (const trip of r.Timetables || []) {
      if (!trip.ServiceDay || !(trip.StopTimes?.length > 1)) continue;
      const days = DAYS.reduce((m, d, k) => (trip.ServiceDay[d] ? m | (1 << k) : m), 0);
      const times = [];
      let prev = -Infinity;
      for (const st of [...trip.StopTimes].sort((a, b) => a.StopSequence - b.StopSequence)) {
        let m = toMinutes(st.DepartureTime || st.ArrivalTime);
        if (!Number.isFinite(m)) continue;
        if (m < prev - 12 * 60) m += 24 * 60; // 過午夜
        prev = m;
        if (!col.has(st.StopUID)) { col.set(st.StopUID, tt.stops.length); tt.stops.push(st.StopUID); }
        times[col.get(st.StopUID)] = m;
      }
      if (days) tt.trips.push([days, times]);
    }
  }
  return out;
});

let timetables = null;
let timetablesDate = '';
let timetablesTried = 0;

// 背景載入，載好之前客運照舊用平均速度估算
function loadTimetables() {
  const { date } = taipeiNow();
  if (timetablesDate === date || Date.now() - timetablesTried < SCHEDULE_RETRY_MS) return;
  timetablesTried = Date.now();
  schedules()
    .then((t) => { timetables = t; timetablesDate = date; })
    .catch((e) => console.log('客運時刻表載入失敗：', e.message));
}

// 一條客運路線依時刻表整理：offsets 是各站距第一站幾秒（典型值，算車程），trips 是每班車各站時間（算等車）
function timingOf(line) {
  if (line.source !== INTERCITY || !timetables) return null;
  if (line.timingFrom !== timetables) {
    const tt = timetables[line.key];
    line.timing = tt?.trips.length ? buildTiming(line, tt) : null;
    line.timingFrom = timetables;
  }
  return line.timing;
}

const median = (list) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];

function buildTiming(line, tt) {
  const col = new Map(tt.stops.map((uid, k) => [uid, k]));
  const cols = line.stops.map((s) => col.get(s.uid));
  const trips = tt.trips.map(([days, times]) => {
    const at = cols.map((c) => (c == null ? null : times[c] ?? null));
    return { days, at, first: at.findIndex((v) => v != null) };
  }).filter((t) => t.first >= 0);
  if (!trips.length) return null;

  // 從最前面那站發車的班次，各站與發車站的時間差取中位數
  const f0 = Math.min(...trips.map((t) => t.first));
  const ref = trips.filter((t) => t.first === f0);
  const raw = line.stops.map((_, k) => {
    const diffs = ref.filter((t) => t.at[k] != null && t.at[k] >= t.at[f0]).map((t) => t.at[k] - t.at[f0]);
    return diffs.length ? median(diffs) * 60 : null;
  });
  const known = raw.flatMap((v, k) => (v == null ? [] : [k]));
  let offsets = null;
  if (known.length >= 2) {
    // 沒有時間的站依沿線距離內插，頭尾外推用平均速度
    const along = (k) => line.stops[k].along;
    offsets = raw.map((v, k) => {
      if (v != null) return v;
      const p = known.findLast((x) => x < k), q = known.find((x) => x > k);
      if (p != null && q != null) return raw[p] + (raw[q] - raw[p]) * (along(k) - along(p)) / ((along(q) - along(p)) || 1);
      return p != null ? raw[p] + (along(k) - along(p)) / line.speed : raw[q] - (along(q) - along(k)) / line.speed;
    });
    for (let k = 1; k < offsets.length; k++) offsets[k] = Math.max(offsets[k], offsets[k - 1]);
  }
  return { offsets, trips, dep: new Map() };
}

// 第 k 站在星期 day 的各班發車時間（當天 0 點起算幾秒，排序好）；班表沒列到這站的班次用 offsets 推算
function departures(timing, k, day) {
  const key = day * 10000 + k;
  let list = timing.dep.get(key);
  if (!list) {
    list = [];
    for (const t of timing.trips) {
      if (!((t.days >> day) & 1)) continue;
      if (t.at[k] != null) list.push(t.at[k] * 60);
      else if (timing.offsets) list.push(t.at[t.first] * 60 + timing.offsets[k] - timing.offsets[t.first]);
    }
    list.sort((a, b) => a - b);
    timing.dep.set(key, list);
  }
  return list;
}

function firstAfter(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo < list.length ? list[lo] : Infinity;
}

const hhmm = (sec) => {
  const m = Math.floor(sec / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// 依時刻表，elapsed 秒後到第 i 站要等多久；沒有這條路線的時刻表回傳 null
function scheduledWait(line, i, clock, elapsed) {
  const timing = timingOf(line);
  if (!timing) return null;
  const reach = clock.sec + elapsed;
  const today = departures(timing, i, clock.day);
  const yesterday = departures(timing, i, (clock.day + 6) % 7); // 前一天過午夜的班次
  const next = Math.min(firstAfter(today, reach), firstAfter(yesterday, reach + DAY_S) - DAY_S);
  if (Number.isFinite(next)) return { wait: next - reach, text: `預定 ${hhmm(next)} 發車` };
  if (today.length) return { wait: Infinity, text: '末班車已過' };
  // 這站完全沒有班次資料（班表不完整）就不判斷
  if (DAYS.some((_, d) => departures(timing, i, d).length)) return { wait: Infinity, text: '今日未營運' };
  return null;
}

// 規劃用的時間：指定了 at（例如火車到站時間）就用它；現在要搭就用現在；都不是就不知道幾點，不看時刻表
function clockOf(live, at) {
  const c = at || (live ? taipeiNow() : null);
  return c && { day: new Date(`${c.date}T00:00:00Z`).getUTCDay(), sec: c.minutes * 60 };
}

// 等車時間：趕得上的即時到站優先；客運沒有即時資料、尚未發車或趕不上這班時看時刻表；都沒有就照原本估算。
// text：用時刻表算的才有，畫面顯示預定發車時間
function makeWaiter(eta, clock) {
  const waitAt = (line, i, elapsed) => {
    const e = eta.get(line.stops[i].id);
    if (e != null && (NO_SERVICE.has(e) || e >= elapsed)) return { wait: waitFor(e, elapsed), text: null };
    const s = clock && scheduledWait(line, i, clock, elapsed);
    // 少數客運路線 TDX 沒有時刻表，又沒有即時到站，只能請使用者看業者網站
    const unknown = line.source === INTERCITY && e == null ? '沒有時刻表資料，請看業者官網' : null;
    return s || { wait: waitFor(e, elapsed), text: unknown };
  };
  waitAt.clock = clock;
  return waitAt;
}

// elapsed 秒後到第 i 站，時刻表上接下來的 n 班（HH:MM），讓使用者知道錯過這班還有哪班
function upcoming(line, i, clock, elapsed, n = 3) {
  const timing = clock && timingOf(line);
  if (!timing) return [];
  const reach = clock.sec + elapsed;
  const today = departures(timing, i, clock.day);
  const yesterday = departures(timing, i, (clock.day + 6) % 7).filter((t) => t >= DAY_S).map((t) => t - DAY_S);
  return [...yesterday, ...today].filter((t) => t >= reach).sort((a, b) => a - b).slice(0, n).map(hhmm);
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
// 客運有時刻表就用時刻表的站間時間，否則用沿線距離與平均速度估算
function rideTime(line, i, j) {
  const off = timingOf(line)?.offsets;
  const t = off ? off[j] - off[i] : 0;
  return t > 0 ? t : line.stops[j].est - line.stops[i].est;
}

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
// live = false：不是現在要搭（例如火車幾小時後才到站），即時到站時間不適用，等車時間用預設值。
// at：大約幾點開始搭（{ date, minutes }），客運依這個時間查時刻表
export async function planBus(from, to, route, live = true, at = null) {
  const networks = await getNetworks([from, to]);
  const grids = networks.map((n) => n.grid);
  const boards = nearestPerLine(grids, from);
  const alights = nearestPerLine(grids, to);
  const eta = live ? await getEta([from, to], intercityRoutes([...boards.values(), ...alights.values()])) : new Map();
  const waitAt = makeWaiter(eta, clockOf(live, at));
  const options = [];

  // 不用轉乘
  for (const [key, b] of boards) {
    const a = alights.get(key);
    if (!a || a.i <= b.i || rideLength(b.line, b.i, a.i) < MIN_RIDE_M) continue;
    const w0 = walkTime(b.d);
    const cost = w0 + waitAt(b.line, b.i, w0).wait + rideTime(b.line, b.i, a.i) + walkTime(a.d);
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
    const wait1 = waitAt(b.line, b.i, w0).wait;
    if (wait1 === Infinity) continue;
    for (let i = b.i + 1; i < b.line.stops.length; i++) {
      if (rideLength(b.line, b.i, i) < MIN_RIDE_M) continue;
      const s1 = b.line.stops[i];
      for (const t of nearGrid(upstream, s1, TRANSFER_M)) {
        if (t.line.key === b.line.key || t.line.name === b.line.name) continue;
        if (rideLength(t.line, t.i, t.alight.i) < MIN_RIDE_M) continue;
        // 第二班車：用轉乘站的即時到站時間，算到時要等多久
        const reach = w0 + wait1 + rideTime(b.line, b.i, i) + walkTime(t.d) + TRANSFER_PENALTY;
        const wait2 = waitAt(t.line, t.i, reach).wait;
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
  const built = await Promise.all(top.map((o) => buildOption(o, from, to, eta, waitAt, route)));
  // 實際步行比估計久、趕不上末班車的方案拿掉
  const ok = built.filter((o) => Number.isFinite(o.total.duration)).sort((a, b) => a.total.duration - b.total.duration);
  // 客運附上票價、業者、路線圖；查不到就算了，規劃照樣回傳
  await addCoachInfo(ok.flatMap((o) => o.legs.filter((l) => l.coach))).catch(() => {});
  return ok;
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
    coach: r.line.source === INTERCITY ? { route: r.line.route, sub: r.line.sub, dir: r.line.dir } : undefined,
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

async function buildOption(o, from, to, eta, waitAt, route) {
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
  // 用時刻表算的，畫面顯示預定發車時間
  const waitOf = (k, elapsed) => {
    const w = waitAt(o.rides[k].line, o.rides[k].i, elapsed);
    if (w.text) buses[k].etaText = w.text;
    if (buses[k].coach) buses[k].coach.next = upcoming(o.rides[k].line, o.rides[k].i, waitAt.clock, elapsed);
    return w.wait;
  };
  let t = w0.duration;
  let wait = waitOf(0, t);
  t += wait + buses[0].duration;
  if (buses.length === 2) {
    t += (wt?.duration || 0) + TRANSFER_PENALTY;
    wait += TRANSFER_PENALTY + waitOf(1, t);
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
  const networks = await getNetworks([point]);
  const hits = [...nearestPerLine(networks.map((n) => n.grid), point).values()]
    .filter((h) => h.i < h.line.stops.length - 1); // 終點站上不了車
  const eta = await getEta([point], intercityRoutes(hits));
  const waitAt = makeWaiter(eta, clockOf(true));
  return hits
    .map((h) => {
      const e = eta.get(h.stop.id);
      // 客運沒有即時到站時，顯示時刻表的下一班
      const w = waitAt(h.line, h.i, 0);
      const live = Number.isNaN(e) ? null : e ?? null;
      return { route: h.line.name, headsign: h.line.headsign, stop: h.stop.name, distance: Math.round(h.d),
               eta: w.text ? (Number.isFinite(w.wait) ? w.wait : null) : live, etaText: w.text || etaText(e) };
    })
    .sort((a, b) => (a.eta >= 0 ? a.eta : 1e9) - (b.eta >= 0 ? b.eta : 1e9) || a.distance - b.distance)
    .slice(0, limit);
}

// 這幾個點用到的公車資料是否還在下載（第一次查某個縣市時），讓畫面提示稍後再查
export const stillLoading = (points) => sourcesFor(points).some((s) => loading.has(s));

// 啟動時先載入，第一次查詢才不會等太久
// 公路客運全台一份、第一次要抓約半分鐘，有金鑰就在背景先載入（含時刻表）
export const warmUp = () => {
  if (hasTdx()) {
    getTdxNetwork(INTERCITY).catch((e) => console.log('公路客運資料載入失敗：', e.message));
    loadTimetables();
  }
  return Promise.all([getNetwork(), getTaipeiEta()]);
};
