import { readFileSync } from 'node:fs';
import express from 'express';
import { distance } from './geo.js';
import { planBus, nearbyArrivals, stillLoading, warmUp } from './bus.js';
import { warmUp as warmUpParking } from './scooter.js';
import { nearbyLots, costOf } from './vehicle.js';
import { camerasAlong, warmUp as warmUpCameras } from './cameras.js';
import { trafficIn } from './traffic.js';
import { planCoach } from './coach.js';
import { lockersNear } from './lockers.js';
import { toiletsNear, warmUp as warmUpToilets } from './toilets.js';
import { garbageNear, garbageRoute, warmUp as warmUpGarbage } from './garbage.js';
import { planRail, railStations } from './rail.js';
import { tdx, hasTdx, remembered, taipeiNow, tdxUsage } from './tdx.js';
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
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
};
const VALHALLA_COSTING = { foot: 'pedestrian', bike: 'bicycle', scooter: 'motor_scooter', car: 'auto' };
// 捷運出發時，在出發點多遠內找出口
const EXIT_RADIUS_M = 400;
// 公開服務要求標明是哪個程式在呼叫
const USER_AGENT = 'transit-map/1.0 (+https://github.com/PoWeiLai/transit-map)';
const STATION_CACHE_MS = 60 * 1000;
// 路線服務失敗時用直線距離估算
const FALLBACK_SPEED = { foot: 4.5 / 3.6, bike: 12 / 3.6, scooter: 25 / 3.6, car: 30 / 3.6, taxi: 30 / 3.6 }; // m/s
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
      // 所有車柱都被停用（forbidden_spaces = 總車柱）代表整站暫停，例如夜間系統維護
      const paused = Number(s.status) !== 1 || (total > 0 && Number(s.forbidden_spaces) >= total);
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
        active: !paused || DEMO,
        paused: paused && !DEMO,
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

// Nominatim 拒絕時（雲端主機的共用 IP 常被限流，回 429）改用 Photon（同樣是 OpenStreetMap 資料），
// 並暫停呼叫 Nominatim 一段時間
const PHOTON_URL = 'https://photon.komoot.io/api/';
const TAIWAN_BBOX = '119.3,21.8,122.1,25.4'; // 經度、緯度範圍
const NOMINATIM_COOLDOWN_MS = 10 * 60 * 1000;
let nominatimDownUntil = 0;

// 道路類的結果（公車站牌在地圖資料裡也算 highway，不算道路）
const ROAD_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'service', 'living_street', 'pedestrian', 'footway', 'path', 'cycleway', 'track', 'road', 'motorway_link', 'trunk_link',
  'primary_link', 'secondary_link', 'tertiary_link']);

// near：使用者的出發點，查詢時優先找附近的地點
async function nominatim(q, near) {
  const params = { q, format: 'jsonv2', countrycodes: 'tw', limit: '5', 'accept-language': 'zh-TW' };
  if (near) params.viewbox = [near.lng - 0.3, near.lat + 0.3, near.lng + 0.3, near.lat - 0.3].join(',');
  const url = `${NOMINATIM_URL}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  return (await res.json()).map((r) => {
    const parts = r.display_name.split(', ');
    return {
      name: r.name || parts[0],
      label: r.display_name,
      lat: Number(r.lat),
      lng: Number(r.lon),
      // 行政區（顯示用，讓使用者看出查到的是哪裡）：「…, 信義區, 臺北市, …」取區，沒有就取市
      area: parts.find((x) => /[區鄉鎮]$/.test(x)) || parts.find((x) => /[市縣]$/.test(x)),
      road: r.category === 'highway' && ROAD_TYPES.has(r.type),
    };
  });
}

// Photon 查不到「台北市信義區信義路五段7號」這種縣市區寫在前面的地址，
// 要改成「信義路五段7號, 信義區, 台北市」；查到的結果優先選縣市、區、門牌都對得上的，
// 門牌查不到就查那條路
const AREA = /^([臺台]?[^\d\s,]{1,2}[市縣])?([^\d\s,]{1,3}?[區鄉鎮])?(.+)$/;
const sameText = (a, b) => Boolean(a && b) && a.replace(/臺/g, '台') === b.replace(/臺/g, '台');

async function photon(q, near) {
  const [, city, district, rest] = q.replace(/\s+/g, '').match(AREA) || [];
  if (!city && !district) return photonOnce(q, near);
  const area = [district, city].filter(Boolean).join(', ');
  const number = rest.match(/(\d+)號/)?.[1];
  const road = rest.replace(/\d+號.*$/, '');
  for (const query of [`${rest}, ${area}`, road !== rest && `${road}, ${area}`].filter(Boolean)) {
    // 地址要在同一條路上（地標名稱本身就是那條路也算），門牌相同的排前面
    const onRoad = (r) => !road || [r.street, r.name].some((x) => x && x.replace(/臺/g, '台').startsWith(road.replace(/臺/g, '台')));
    const found = (await photonOnce(query))
      .filter((r) => (!city || sameText(r.city, city)) && (!district || sameText(r.district, district)) && onRoad(r))
      .sort((x, y) => (y.housenumber === number) - (x.housenumber === number));
    if (found.length) return found;
  }
  return [];
}

async function photonOnce(q, near, limit = 5) {
  // Photon 只認得「臺中市」這種正式寫法，「台中市」會查不到
  const params = { q: q.replace(/台([北中南東][市縣])/g, '臺$1'), limit: String(limit), bbox: TAIWAN_BBOX };
  if (near) Object.assign(params, { lat: near.lat, lon: near.lng });
  const url = `${PHOTON_URL}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`地址查詢失敗 ${res.status}`);
  return (await res.json()).features.map(({ properties: p, geometry }) => {
    const street = [p.street, p.housenumber && p.housenumber.replace(/號?$/, '號')].filter(Boolean).join('');
    return {
      name: p.name || street || p.district || p.city,
      label: [p.city, p.district, street, p.name].filter(Boolean).join(' '),
      lat: geometry.coordinates[1],
      lng: geometry.coordinates[0],
      city: p.city, district: p.district, street: p.street, housenumber: p.housenumber,
      area: p.district || p.city,
      road: p.osm_key === 'highway' && ROAD_TYPES.has(p.osm_value),
    };
  });
}

// ---------- 整句查不到時，放寬條件找最接近的地點 ----------
// 地圖資料的名稱常跟使用者打的不完全一樣（「台鐵便當南陽店」在地圖上只有「臺鐵便當本舖2號店」）：
// 從後面或前面一次少一個字再查，直到查到名稱含有剩下文字的地點；
// 去掉的字（「南陽」）當成位置提示，挑離那裡（南陽街）最近的分店
const FUZZY_TRIES = 6; // 最多查幾種少字的寫法（每種查 台／臺 兩個寫法）
const BRANCH = /(分店|門市|分館|店|館|站)$/;
const swapTai = (s) => (s.includes('台') ? s.replace(/台/g, '臺') : s.replace(/臺/g, '台'));

async function fuzzyPlace(text, near) {
  const q = plain(text).replace(/火車站/g, '車站');
  if (q.length < 3 || /\d+號/.test(q)) return []; // 門牌地址交給 TDX
  const tries = [];
  if (q !== plain(text)) tries.push({ core: q, hint: '' });
  for (let k = 1; q.length - k >= 2; k++) {
    tries.push({ core: q.slice(0, -k), hint: q.slice(-k) }, { core: q.slice(k), hint: q.slice(0, k) });
  }
  for (const { core, hint } of tries.slice(0, FUZZY_TRIES)) {
    // Photon 暫時不能用就不再一直試
    const lists = await Promise.all([core, swapTai(core)].filter((x, i, a) => a.indexOf(x) === i)
      .map((x) => photonOnce(x, near, 10)));
    // Photon 會回傳只像一點點的地點（查「台鐵便當」給「台富便當」），名稱要真的含有那幾個字
    const found = lists.flat().filter((r) => !r.road && plain(r.name).includes(core));
    if (!found.length) continue;
    // 位置提示：名稱或地址寫到的優先，不然查那個地名（附近的路、地區），挑離它近的
    const where = plain(hint).replace(BRANCH, '');
    let anchor = near;
    const named = found.filter((r) => where && plain(r.label).includes(where));
    if (where.length >= 2 && !named.length) {
      const [spot] = await photonOnce(where, near || found[0], 3).catch(() => []);
      if (spot && found.some((r) => distance(r, spot) < 5000)) anchor = spot;
    }
    const sorted = (named.length ? named : found)
      .sort((a, b) => (anchor ? distance(anchor, a) - distance(anchor, b) : 0))
      .filter((r, i, all) => !all.slice(0, i).some((x) => distance(x, r) < 50)); // 台／臺 兩種寫法查到同一個
    return sorted.slice(0, 3).map((r) => ({ ...r, name: `${r.name}（查不到「${text}」，這是最接近的地點）`, approx: true }));
  }
  return [];
}

// ---------- 門牌地址（TDX 地址定位，資料來自內政部門牌） ----------
// OpenStreetMap 幾乎沒有台灣的門牌號碼，只查得到那條路；有「號」的地址改用 TDX 查門牌位置。
// TDX 要有縣市＋區才查得準，少寫時先用地圖資料找出那條路在哪個縣市、區（離出發點近的優先）再補上

// 「台中文心南一路195號」：縣市少寫「市／縣」時補上（新竹、嘉義先當市）
const CITY_SUFFIX = {
  台北: '市', 新北: '市', 桃園: '市', 台中: '市', 台南: '市', 高雄: '市', 基隆: '市', 新竹: '市', 嘉義: '市',
  苗栗: '縣', 彰化: '縣', 南投: '縣', 雲林: '縣', 屏東: '縣', 宜蘭: '縣', 花蓮: '縣', 台東: '縣', 澎湖: '縣', 金門: '縣', 連江: '縣',
};
const ADDRESS_AREAS = 2; // 少寫縣市、區又不知道出發點時，最多試幾個可能的地區（每個要呼叫一次 TDX，額度很少）
const plain = (s) => String(s || '').replace(/臺/g, '台').replace(/\s+/g, '');

function parseAddress(text) {
  let q = plain(text).replace(/^(中華民國|台灣)/, '').replace(/^\d{3,6}/, ''); // 去掉郵遞區號
  const short = Object.keys(CITY_SUFFIX).find((c) => q.startsWith(c) && !/^[市縣]/.test(q.slice(c.length)));
  if (short) q = short + CITY_SUFFIX[short] + q.slice(short.length);
  const m = q.match(/^([^\d]{2}[市縣])?([^\d]{1,3}?[區鄉鎮市])?(\D.*?)(\d+(?:之\d+)?)號/);
  if (!m) return null;
  const [, city, district, road, number] = m;
  return { city, district, road, number };
}

// 路名比對：寫法有出入時（「文心南一段」其實是「文心南一路」），去掉最後的「段」再比前面
function roadMatches(name, road) {
  const base = plain(road).replace(/\d+[巷弄].*$/, '');
  const x = plain(name);
  return x.startsWith(base) || (base.length >= 4 && /段$/.test(base) && !/[路街道]/.test(base) && x.startsWith(base.slice(0, -1)));
}

async function tdxAddress(text, near) {
  const a = parseAddress(text);
  if (!a) return [];
  const lane = plain(a.road).match(/\d+[巷弄].*$/)?.[0] || '';
  // 找那條路在哪些縣市、區（寫了縣市、區就只留那裡的）。
  // 少寫「區」（「板橋實踐路64號」「台中市南屯文心南一段195號」）：把前兩個字當區名再試
  const tries = [a];
  if (!a.district && a.road.length > 3) {
    for (const suffix of ['區', '鎮', '鄉', '市']) tries.push({ ...a, district: a.road.slice(0, 2) + suffix, road: a.road.slice(2) });
  }
  let hits = [];
  for (const t of tries) {
    const roads = await photonOnce([t.road, t.district, t.city].filter(Boolean).join(', '), near).catch(() => []);
    hits = roads
      .filter((r) => r.city && r.district && [r.street, r.name].some((x) => x && roadMatches(x, t.road)))
      .filter((r) => (!t.city || sameText(r.city, t.city)) && (!t.district || sameText(r.district, t.district)));
    if (hits.length) { Object.assign(a, t); break; }
  }
  // 用地圖資料上的正確路名查門牌（同一個地區、同一條路只查一次）
  const areas = [];
  for (const r of hits) {
    const road = plain([r.street, r.name].find((x) => x && roadMatches(x, a.road))).replace(/\d+[巷弄].*$/, '') + lane;
    const area = { city: plain(r.city), district: plain(r.district), road, hit: r };
    if (!areas.some((x) => x.city + x.district + x.road === area.city + area.district + area.road)) areas.push(area);
  }
  if (!areas.length && a.city && a.district) areas.push({ city: a.city, district: a.district, road: a.road, hit: null });

  const found = [];
  if (hasTdx()) {
    for (const ar of areas.slice(0, near ? 1 : ADDRESS_AREAS)) { // 知道出發點時只查最近的那個地區
      const full = `${ar.city}${ar.district}${ar.road}${a.number}號`;
      // 門牌座標幾乎不會變，查過的存在 Turso 三個月
      const list = await remembered(`geocode:${full}`, 90, () => tdx(`advanced/V3/Map/GeoCode/Coordinate/Address/${encodeURIComponent(full)}`)).catch(() => []);
      for (const r of list) {
        // 查不到時 TDX 會回傳不相干的近似地址（例如別區的巷子），路名和門牌要對得上才採用
        if (!plain(r.Address).includes(`${ar.road}${a.number}號`)) continue;
        const [lng, lat] = r.Geometry.match(/[\d.]+/g).map(Number);
        found.push({ name: `${ar.road}${a.number}號`, label: r.Address, lat, lng, area: ar.district, road: false, exact: true });
      }
    }
  }
  // TDX 查不到這個門牌（或 TDX 暫時不能用）：標在那條路上，名稱註明不是確切位置
  const ar = areas.find((x) => x.hit);
  if (!found.length && ar) {
    found.push({
      name: `${ar.road}（${ar.district}，${a.number}號的確切位置查不到，標在路上）`,
      label: `${ar.city}${ar.district}${ar.road}`,
      lat: ar.hit.lat, lng: ar.hit.lng, area: ar.district, road: false, exact: true,
    });
  }
  return found;
}

// ---------- 從 Google 地圖貼回來的連結、座標 ----------
// 查不到的地點，使用者可以到 Google 地圖找，再把分享連結或座標貼回來
const COORDS = /^\s*\(?(-?\d{1,2}\.\d+)\s*[,，\s]\s*(-?\d{1,3}\.\d+)\)?\s*$/;
// 只跟著 Google 地圖的網址走，避免伺服器被拿去連其他網站
const GOOGLE_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.com(\.tw)?)$/;

function coordsResult(lat, lng, name = '座標位置') {
  if (!(lat >= 20 && lat <= 27 && lng >= 117 && lng <= 123)) return []; // 台灣附近才採用
  return [{ name, label: `${name}（${lat.toFixed(5)}, ${lng.toFixed(5)}）`, lat, lng, exact: true }];
}

async function pastedPlace(text) {
  const c = text.match(COORDS);
  if (c) return coordsResult(Number(c[1]), Number(c[2]));
  let url;
  try { url = new URL(text.trim()); } catch { return null; }
  if (!GOOGLE_HOSTS.test(url.hostname)) return null;
  // 短網址（maps.app.goo.gl）要跟著轉址才看得到座標
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  const final = new URL(res.url);
  if (!GOOGLE_HOSTS.test(final.hostname)) return [];
  const href = decodeURIComponent(final.href);
  const name = href.match(/\/place\/([^/@]+)/)?.[1].replace(/\+/g, ' ');
  // !3d…!4d… 是地點本身的位置，@緯度,經度 只是畫面中心，優先用前者
  const pos = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
    (final.searchParams.get('q') || final.searchParams.get('ll') || '').match(COORDS);
  if (pos) return coordsResult(Number(pos[1]), Number(pos[2]), name || 'Google 地圖的地點');
  // 連結裡只有地名（例如 ?q=地址）：改查那個地名
  const q = final.searchParams.get('q') || name;
  return q ? geocode(q) : [];
}

// 常見簡稱：「101」在地圖資料裡是台 101 線公路
const ALIASES = { 101: '台北101' };

// 排序：門牌完全對上的最優先、名稱相符的優先、道路排後面（例如「101」查到台 101 線）、離出發點近的優先；
// 幾個服務常查到同一個地點，100 公尺內只留一個
function rank(results, q, near) {
  const score = (r) => (r.exact ? -30 : 0) + (r.name === q ? -10 : r.name?.includes(q) ? -3 : 0) + (r.road ? 20 : 0)
    + (near ? distance(near, r) / 1000 : 0);
  const sorted = results.map((r) => ({ r, s: score(r) })).sort((a, b) => a.s - b.s).map((x) => x.r);
  return sorted.filter((r, i) => !sorted.slice(0, i).some((x) => distance(x, r) < 100));
}

function geocode(text, near) {
  const q = ALIASES[text] || text;
  const key = near ? `${q}@${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : q;
  if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key));
  const job = geocodeQueue.then(async () => {
    let found = await tdxAddress(q, near).catch(() => []);
    if (Date.now() >= nominatimDownUntil) {
      try {
        found = found.concat(await nominatim(q, near));
      } catch {
        nominatimDownUntil = Date.now() + NOMINATIM_COOLDOWN_MS;
      }
    }
    // 兩個服務的結果合在一起排序；Nominatim 不能用時只靠 Photon
    found = found.concat(await photon(q, near).catch(() => []));
    let results = rank(found, q, near).slice(0, 5);
    // 整句都查不到：放寬條件找最接近的（已經依位置提示排好，不再重排）
    if (!results.length) results = await fuzzyPlace(q, near).catch(() => []);
    geocodeCache.set(key, results);
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

const PLAN_BIKE_NEAR_M = 1500;   // 全程騎 YouBike 時，借還車站最遠走多遠
const SHORT_WALK_M = 400;         // 沒開步行時，這麼近還是走路
const ACCESS_BIKE_PICK_M = 2000; // 使用者指定騎 YouBike 時，借還車站可以遠一點
const BIKE_CHOICES = 5;          // 列出幾個借／還車站讓使用者換
const ACCESS_KINDS = new Set(['auto', 'walk', 'youbike', 'bus', 'metro', 'taxi', 'uber']);
const WALK_PREFER_M = 500;       // 自動選時，再遠就改用 YouBike、公車等（除非附近都沒有）
const METRO_ACCESS_MIN_M = 1000; // 太近不值得進出捷運站
const BIKE_DOCK_S = 2 * 60;      // 借車、還車（刷卡、找車柱）大約花的時間

// 起訖點與車站之間騎 YouBike：走到借車站 → 騎到還車站 → 走過去。
// 使用者選的借／還車站（pref.pickup / pref.dropoff）在附近才採用，否則從附近有車／有位的站挑全程最快的組合
// （最近的站借光時，不會硬繞到遠的站；繞太遠就會比走路慢，自動選時改走路）
async function bikeAccess(from, to, pref, maxM) {
  const stations = await getStations();
  const pickups = nearest(stations, from, (s) => s.active && s.bikes > 0, BIKE_CHOICES).filter((s) => s.distance <= maxM);
  const dropoffs = nearest(stations, to, (s) => s.active && s.docks > 0, BIKE_CHOICES).filter((s) => s.distance <= maxM);
  const legsOf = (p, d) => [estimateRoute('foot', from, p), estimateRoute('bike', p, d), estimateRoute('foot', d, to)];
  const time = (legs) => legs.reduce((n, l) => n + l.duration, 0);
  const pickupOk = pickups.filter((s) => !pref.pickup || s.id === pref.pickup);
  const dropoffOk = dropoffs.filter((s) => !pref.dropoff || s.id === pref.dropoff);
  let best = null;
  for (const p of pickupOk.length ? pickupOk : pickups) {
    for (const d of dropoffOk.length ? dropoffOk : dropoffs) {
      if (d.id === p.id) continue;
      const legs = legsOf(p, d);
      if (!best || time(legs) < time(best.legs)) best = { pickup: p, dropoff: d, legs };
    }
  }
  if (!best) return null;
  // 借車、還車各要一點時間，比走路快一些才值得騎
  return { kind: 'youbike', pickup: best.pickup, dropoff: best.dropoff, pickups, dropoffs, ...summarize(best.legs, time(best.legs) + BIKE_DOCK_S) };
}

// 接駁在一小時內開始才用公車即時到站時間（例如火車幾小時後才到站，現在的到站時間沒有參考價值）
const SOON_MIN = 60;
function isSoon(at) {
  if (!at) return true;
  const now = taipeiNow();
  return at.date === now.date && Math.abs(at.minutes - now.minutes) <= SOON_MIN;
}

// 火車站與起訖點之間搭捷運（例如松山車站 → 台北101）。到捷運站的接駁不再搭捷運，
// 先用估算的路線，等選定班次後再由 refineAccess 換成實際路線
async function metroAccess(from, to, allow, at) {
  const inner = makeConnect({ allow, noMetro: true });
  inner.refine = async (a) => a;
  const r = await planMetro(from, to, { in: inner, out: inner }, {}, at);
  const o = r.options[0];
  // 知道大概幾點到車站時（at），捷運已收班就不建議；不知道時只在畫面上提醒營運時間
  if (!o || (at && o.closed)) return null;
  return { kind: 'metro', ...summarize([...o.walkIn.legs, ...o.rides, ...o.walkOut.legs], o.duration) };
}

// 自動選：500 公尺內走路；再遠就比較公車、YouBike、捷運、步行（2.5 公里內），選最快的
// （公車要等很久時自然會選 YouBike；附近的站借光、要繞路才借得到時，走路比較快就走路），
// 都沒有才叫車。先用直線估算，選定後再由 refine 換成實際路線，避免每個候選車站都呼叫路線服務。
// allow：使用者開啟的交通工具（walk／youbike／bus／metro／uber），沒給就全部可用；都不能用時只好走路
// noMetro：本身就是捷運的接駁，不再考慮捷運
async function autoAccess(from, to, allow, noMetro, at) {
  const ok = (k) => (!allow || allow.has(k)) && !(noMetro && k === 'metro');
  const d = distance(from, to);
  // 沒開「步行」時，只有很近才走路，其他用開啟的工具（例如叫 Uber 到捷運站）
  if (d <= (ok('walk') ? WALK_PREFER_M : SHORT_WALK_M)) return { kind: 'walk', ...summarize([await route('foot', from, to)]) };

  const [bus, bike, metro] = await Promise.all([
    ok('bus') && planBus(from, to, estimateRoute, isSoon(at), at).then((list) => list[0]).catch(() => null),
    ok('youbike') && bikeAccess(from, to, {}, ACCESS_BIKE_NEAR_M).catch(() => null),
    ok('metro') && d > METRO_ACCESS_MIN_M && metroAccess(from, to, allow, at).catch(() => null),
  ]);
  // 步行也一起比快慢；想多走路的人也可以在畫面上換成步行
  const walk = ok('walk') && d <= ACCESS_WALK_M && { kind: 'walk', ...summarize([estimateRoute('foot', from, to)]) };
  const candidates = [
    bus && { kind: 'bus', ...summarize(bus.legs, bus.total.duration) },
    bike,
    metro,
    walk,
  ].filter(Boolean).sort((a, b) => a.duration - b.duration);
  const brief = (list) => list.map(({ kind, duration }) => ({ kind, duration }));
  if (!ok('uber')) {
    // forcedWalk：沒開步行、只是沒有其他方式，捷運規劃排序時會盡量避開
    const pick = candidates[0] || { kind: 'walk', forcedWalk: true, ...summarize([estimateRoute('foot', from, to)]) };
    return { ...pick, alternatives: brief(candidates) };
  }
  const taxi = { kind: allow ? 'uber' : 'taxi', ...summarize([estimateRoute('taxi', from, to)]) };
  // 有開步行時 Uber 只在其他方式慢很多時才建議；沒開步行就直接比快慢
  const prefer = ok('walk') ? TAXI_PREFER : 1;
  const pick = candidates[0] && candidates[0].duration <= taxi.duration * prefer ? candidates[0] : taxi;
  return { ...pick, alternatives: brief([...candidates, taxi]) };
}

// 接駁方式：pref = { kind: auto／walk／youbike／bus／metro／taxi／uber, pickup, dropoff }。
// 指定的方式行不通（例如附近沒有 YouBike）就改用自動，並標記 fallback 讓畫面說明
function makeConnect(pref = {}) {
  const kind = ACCESS_KINDS.has(pref.kind) ? pref.kind : 'auto';
  // at：大約幾點開始這段接駁（例如火車到站時間），捷運依這個時間算班距與營運時間
  const connect = async (from, to, at) => {
    if (kind === 'walk') return { kind: 'walk', ...summarize([estimateRoute('foot', from, to)]) };
    // Uber 與計程車路線相同（開車），差在畫面上給叫車按鈕
    if (kind === 'taxi' || kind === 'uber') return { kind, ...summarize([estimateRoute('taxi', from, to)]) };
    if (kind === 'youbike') {
      const bike = await bikeAccess(from, to, pref, ACCESS_BIKE_PICK_M).catch(() => null);
      if (bike) return bike;
    }
    if (kind === 'bus') {
      const bus = await planBus(from, to, estimateRoute, isSoon(at), at).then((list) => list[0]).catch(() => null);
      if (bus) return { kind: 'bus', ...summarize(bus.legs, bus.total.duration) };
    }
    if (kind === 'metro' && !pref.noMetro) {
      const metro = await metroAccess(from, to, pref.allow, at).catch(() => null);
      if (metro) return metro;
    }
    const auto = await autoAccess(from, to, pref.allow, pref.noMetro, at);
    return kind === 'auto' ? auto : { ...auto, fallback: kind };
  };
  connect.refine = refineAccess;
  return connect;
}

// 規劃 API 的接駁參數：access／egress 是到車站、出站後的方式，inPickup 等是使用者選的 YouBike 站
// allow：使用者開啟的交通工具，自動選接駁時只從這些裡面挑；noMetro：捷運規劃本身的接駁不再搭捷運
const accessPrefs = (q, noMetro = false) => {
  const allow = q.allow != null ? new Set(String(q.allow).split(',')) : null;
  return {
    in: makeConnect({ kind: q.access, pickup: q.inPickup, dropoff: q.inDropoff, allow, noMetro }),
    out: makeConnect({ kind: q.egress, pickup: q.outPickup, dropoff: q.outDropoff, allow, noMetro }),
  };
};

function summarize(legs, duration = legs.reduce((n, l) => n + l.duration, 0)) {
  return { legs, duration: Math.round(duration), distance: legs.reduce((n, l) => n + l.distance, 0) };
}

// 把估算的步行／騎車／計程車段換成實際路線；公車的等車時間保留
async function refineAccess(a) {
  if (!a.legs.some((l) => l.estimated)) return a;
  const legs = await Promise.all(a.legs.map(async (l) => {
    if (!l.estimated) return l;
    const [s, e] = [l.path[0], l.path.at(-1)].map(([lat, lng]) => ({ lat, lng }));
    const real = await route(l.mode === 'taxi' ? 'scooter' : l.mode, s, e);
    return { ...real, mode: l.mode };
  }));
  const diff = legs.reduce((n, l, i) => n + l.duration - a.legs[i].duration, 0);
  return { ...a, ...summarize(legs, a.duration + diff) };
}

// ---------- API ----------

const app = express();
app.use(express.static('public'));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(502).json({ error: err.message }));

app.get('/api/geocode', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '請輸入地點' });
  // 貼上的 Google 地圖連結或座標；讀不到時回傳空的，畫面會再提供用 Google 地圖找的按鈕
  const pasted = await pastedPlace(q).catch(() => []);
  if (pasted) return res.json(pasted);
  res.json(await geocode(q, parsePoint(req.query.near)));
}));

// 規劃：出發點 → 步行到最近有車的站 → 騎到離目的地最近有空位的站 → 步行到目的地
// 開車（叫 Uber）：路線與時間用汽車路線估算
app.get('/api/drive', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  const leg = { ...(await route('scooter', from, to)), mode: 'taxi' };
  res.json({ legs: [leg], total: { distance: leg.distance, duration: leg.duration } });
}));

// 地圖範圍內車多、壅塞的路段（bbox = 南,西,北,東）
const MAX_TRAFFIC_DEG = 3; // 範圍太大（地圖縮太小）就不回傳
app.get('/api/traffic', wrap(async (req, res) => {
  const [s, w, n, e] = String(req.query.bbox || '').split(',').map(Number);
  if (![s, w, n, e].every(Number.isFinite)) return res.status(400).json({ error: '請提供地圖範圍' });
  if (n - s > MAX_TRAFFIC_DEG || e - w > MAX_TRAFFIC_DEG) return res.json({ sections: [], updated: '', tooBig: true });
  res.json(await trafficIn([s, n, w, e]));
}));

// 地圖範圍內的 YouBike 站點與統計（bbox = 南,西,北,東），讓使用者看哪裡有車
const MAX_BBOX_DEG = 0.25; // 範圍太大（地圖縮太小）就不回傳站點，只回統計
app.get('/api/youbike', wrap(async (req, res) => {
  const [s, w, n, e] = String(req.query.bbox || '').split(',').map(Number);
  if (![s, w, n, e].every(Number.isFinite)) return res.status(400).json({ error: '請提供地圖範圍' });
  const inside = (await getStations()).filter((x) => x.lat >= s && x.lat <= n && x.lng >= w && x.lng <= e);
  const summary = {
    stations: inside.length,
    withBikes: inside.filter((x) => x.active && x.bikes > 0).length,
    bikes: inside.reduce((t, x) => t + (x.active ? x.bikes : 0), 0),
    paused: inside.filter((x) => x.paused).length,
  };
  const small = n - s <= MAX_BBOX_DEG && e - w <= MAX_BBOX_DEG;
  res.json({
    summary,
    updatedAt: inside[0]?.updatedAt || null,
    stations: small ? inside.map(({ id, name, lat, lng, bikes, docks, total, paused, address }) => ({ id, name, lat, lng, bikes, docks, total, paused, address })) : null,
  });
}));

// 全程走路
const MAX_WALK_M = 30000;
app.get('/api/walk', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  if (distance(from, to) > MAX_WALK_M) return res.status(400).json({ error: '距離超過 30 公里，不適合全程走路' });
  const leg = await route('foot', from, to);
  res.json({ legs: [leg], total: { distance: leg.distance, duration: leg.duration } });
}));

app.get('/api/plan', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });

  const stations = await getStations();
  // 只找走得到的站：附近都沒車時（例如夜間暫停服務），不要跑去別的縣市借
  const pickups = nearest(stations, from, (s) => s.active && s.bikes > 0, CANDIDATES).filter((s) => s.distance <= PLAN_BIKE_NEAR_M);
  const dropoffs = nearest(stations, to, (s) => s.active && s.docks > 0, CANDIDATES).filter((s) => s.distance <= PLAN_BIKE_NEAR_M);

  if (!pickups.length || !dropoffs.length) {
    const near = (p) => nearest(stations, p, () => true, 50).filter((s) => s.distance <= PLAN_BIKE_NEAR_M);
    const around = near(pickups.length ? to : from);
    const paused = around.length && around.every((s) => s.paused);
    const where = pickups.length ? '目的地' : '出發點';
    return res.status(404).json({
      error: !around.length ? `${where}附近 ${PLAN_BIKE_NEAR_M / 1000} 公里內沒有 YouBike 站`
        : paused ? `${where}附近的 YouBike 目前暫停服務（可能因颱風等天候因素或系統維護，請留意 YouBike 公告），請改用其他交通方式`
        : `${where}附近 ${PLAN_BIKE_NEAR_M / 1000} 公里內的 YouBike 目前${pickups.length ? '都沒有空位可還' : '都沒有車可借'}`,
    });
  }

  // 使用者可從候選清單指定站點；沒指定時挑全程最快的借還組合（最近的站借光時，不硬繞去遠的站）
  const fastest = (() => {
    let best = null;
    for (const p of pickups) {
      for (const d of dropoffs) {
        const t = [estimateRoute('foot', from, p), estimateRoute('bike', p, d), estimateRoute('foot', d, to)].reduce((n, l) => n + l.duration, 0);
        if (!best || t < best.t) best = { p, d, t };
      }
    }
    return best;
  })();
  const pickup = pickups.find((s) => s.id === req.query.pickup) ||
    nearest(stations, from, (s) => s.id === req.query.pickup && s.bikes > 0, 1)[0] ||
    fastest.p;
  const dropoff = dropoffs.find((s) => s.id === req.query.dropoff) ||
    nearest(stations, to, (s) => s.id === req.query.dropoff && s.docks > 0, 1)[0] ||
    fastest.d;

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
    // 很近、或騎車（含借還車時間）沒有比直接走路快
    suggestWalk: pickup.id === dropoff.id || directWalk < 600 ||
      estimateRoute('foot', from, to).duration <= fastest.t + BIKE_DOCK_S,
  });
}));

// 公車規劃：步行 → 公車 →（步行轉乘 → 公車）→ 步行
app.get('/api/bus', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  // 有指定日期、時間（例如明天搭客運）就依那時候的時刻表規劃；一小時內才用即時到站
  const when = parseWhen(req.query.date, req.query.time);
  if (when.error) return res.status(400).json({ error: when.error });
  const live = isSoon(when);
  const [options, nearby] = await Promise.all([planBus(from, to, route, live, when), live ? nearbyArrivals(from) : []]);
  res.json({ from, to, options, nearby, live, when, loading: stillLoading([from, to]) });
}));

// 汽車、機車：kind = car（自己開車）／moto（自己騎車）／scooter（共享機車）／sharecar（共享汽車）。
// （共享車先步行到取車位置）→ 開／騎到目的地附近有車位的停車場 → 步行到目的地；附近沒有停車場就直接到目的地
const VEHICLES = {
  car: { route: 'car', space: 'car', shared: false },
  moto: { route: 'scooter', space: 'moto', shared: false },
  scooter: { route: 'scooter', space: 'moto', shared: true },
  sharecar: { route: 'car', space: 'car', shared: true },
};
app.get('/api/vehicle', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  const kind = VEHICLES[req.query.kind] ? req.query.kind : 'scooter';
  const v = VEHICLES[kind];
  // 共享車：使用者在 App 看到的車輛位置，可不填
  const vehicle = v.shared ? parsePoint(req.query.vehicle) : null;

  const { list: parkings, updated } = await nearbyLots(to, v.space);
  const parking = parkings.find((p) => p.id === req.query.parking) || parkings[0] || null;
  const start = vehicle || from;
  const end = parking || to;

  const legs = await Promise.all([
    vehicle ? route('foot', from, vehicle) : null,
    route(v.route, start, end),
    parking ? route('foot', parking, to) : null,
  ]);
  const ride = legs[1];
  const steps = legs.filter(Boolean);
  // 路線經過、拍得到這個方向的測速照相（導航時依距離提醒）
  const cameras = ride.estimated ? [] : await camerasAlong(ride.path);
  res.json({
    kind,
    cameras,
    from,
    to,
    vehicle,
    parking,
    parkings,
    availabilityUpdated: updated,
    legs: steps,
    cost: costOf(kind, ride.distance, ride.duration),
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
  res.json(await planRail(req.query.system === 'thsr' ? 'thsr' : 'tra', from, to, accessPrefs(req.query), when));
}));

// TDX 用量：這次開機以來今天的明細（哪些資料最大），以及 Turso 記錄的最近幾天，和 TDX 會員中心對照
app.get('/api/tdx-usage', wrap(async (req, res) => res.json(await tdxUsage())));

// 寄放行李：某個地點（例如下車的車站、目的地）附近的置物櫃
app.get('/api/lockers', wrap(async (req, res) => {
  const near = parsePoint(req.query.near);
  if (!near) return res.status(400).json({ error: '請提供地點' });
  res.json(await lockersNear(near));
}));

// 附近的公廁
app.get('/api/toilets', wrap(async (req, res) => {
  const near = parsePoint(req.query.near);
  if (!near) return res.status(400).json({ error: '請提供地點' });
  res.json(await toiletsNear(near));
}));

// 附近的垃圾車清運點（表定經過時間）與垃圾車即時位置
app.get('/api/garbage', wrap(async (req, res) => {
  const near = parsePoint(req.query.near);
  if (!near) return res.status(400).json({ error: '請提供地點' });
  res.json(await garbageNear(near));
}));

// 一條垃圾車路線的所有清運點與垃圾車現在的進度
app.get('/api/garbage/route', wrap(async (req, res) => {
  const r = await garbageRoute(String(req.query.line || ''));
  if (!r) return res.status(404).json({ error: '找不到這條路線' });
  res.json(r);
}));

// 長途客運：接駁到客運站（例如板橋 → 台北轉運站）→ 搭客運 → 接駁到目的地，依時刻表列出班次
app.get('/api/coach', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  const when = parseWhen(req.query.date, req.query.time);
  if (when.error) return res.status(400).json({ error: when.error });
  res.json(await planCoach(from, to, accessPrefs(req.query), when));
}));

// 全台捷運／輕軌：接駁到車站 → 搭捷運（可轉乘） → 接駁到目的地
app.get('/api/metro', wrap(async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!from || !to) return res.status(400).json({ error: '請提供出發點與目的地' });
  res.json(await planMetro(from, to, accessPrefs(req.query, true), { board: req.query.board, alight: req.query.alight }));
}));

app.get('/api/metro/map', (req, res) => res.json(metroMap()));

// 乘車日期（YYYY-MM-DD）與出發時間（HH:MM）；沒填日期就是現在，其他日期沒填時間就從頭班車列起
const MAX_DAYS_AHEAD = 30;
function parseWhen(date, time) {
  const now = taipeiNow();
  if (!date && !time) return now;
  date ||= now.date; // 只填時間就是今天

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
  // 台鐵、高鐵時刻表不在啟動時下載（免費主機常休眠重開，每次都抓會超過 TDX 用量），有人查火車時才下載
  warmUpCameras()
    .then((list) => console.log(`已載入 ${list.length} 個測速照相點`))
    .catch((e) => console.log('測速照相資料載入失敗：', e.message));
  warmUpParking()
    .then(([lots]) => console.log(`已載入 ${lots.length} 個有機車格的停車場`))
    .catch((e) => console.log('停車場資料載入失敗：', e.message));
  warmUpToilets()
    .then((list) => console.log(`已載入 ${list.length} 個公廁`))
    .catch((e) => console.log('公廁資料載入失敗：', e.message));
  warmUpGarbage()
    .then((list) => console.log(`已載入 ${list.length} 個垃圾車清運點`))
    .catch((e) => console.log('垃圾車資料載入失敗：', e.message));
  console.log(`已載入 ${exits.length} 個捷運出口`);
  const t = Date.now();
  warmUp()
    .then(([n]) => console.log(`已載入 ${n.lines.size} 條公車路線（${Date.now() - t} ms）`))
    .catch((e) => console.log('公車資料載入失敗：', e.message));
});
