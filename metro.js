// 全台捷運／輕軌：用站間行駛時間、轉乘時間與班距（平均等半個班距）找最快的路線
// 資料是 scripts/build-metro.js 產生的 data/metro.json，不用即時呼叫 TDX
import { readFileSync } from 'node:fs';
import { distance } from './geo.js';
import { taipeiNow } from './tdx.js';

const CANDIDATES = 3;
const CANDIDATE_EXTRA_M = 1500; // 比最近的車站遠不超過這麼多才列入
const MAX_ACCESS_M = 15000;     // 離最近的捷運站太遠就不規劃
const SAME_STATION_S = 60;      // 同一站換到另一條路線（同月台或換邊）
const TRANSFER_PENALTY_S = 120; // 轉乘不舒服，同樣快時選少轉乘的（只影響排序）
const MAX_OPTIONS = 3;
const WALK_FREE_S = 7 * 60;     // 走到車站約 500 公尺內不算懲罰
const WALK_WEIGHT = 1;          // 再走更遠，排序時多算一倍時間（寧可搭車、轉乘，也不要走很遠）
const FORCED_WALK_WEIGHT = 2;   // 使用者沒開步行、但只能走路時多算兩倍
const BOARD_CHOICES = 6;          // 列出幾個上車／下車站讓使用者改選
const BOARD_CHOICE_EXTRA_M = 3000;

let net = null;
function load() {
  if (net) return net;
  const data = JSON.parse(readFileSync(new URL('./data/metro.json', import.meta.url), 'utf8'));
  // 每個車站有哪些路線停靠：key → [[路線, 第幾站]]
  const at = new Map();
  data.services.forEach((s, si) => s.stations.forEach((k, pos) => {
    if (!at.has(k)) at.set(k, []);
    at.get(k).push([si, pos]);
  }));
  const links = new Map();
  for (const [a, b, sec] of data.transfers) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!links.has(x)) links.set(x, []);
      links.get(x).push([y, sec]);
    }
  }
  const list = Object.entries(data.stations).map(([key, s]) => ({ key, ...s }));
  net = { ...data, at, links, list };
  return net;
}

// 官方沒給顏色的路線
const COLORS = { 'KRTC:O': '#f59e0b', 'KRTC:R': '#e11d48', 'KLRT:C': '#22c55e', 'TRTCMG:MK': '#65a30d', 'TMRT:G': '#9cbe3c' };
const colorOf = (s) => s.color || COLORS[`${s.op}:${s.line}`] || '#0284c7';

// 一條線的班距範圍（分鐘），例：尖峰 4 分、離峰 10 分 → [4, 10]；沒有資料時是預設估計值
function headwayRange(op, line) {
  const all = load().services.filter((s) => s.op === op && s.line === line && !s.express)
    .flatMap((s) => [...s.weekday.headways, ...s.holiday.headways].map((h) => h[2]));
  if (!all.length) {
    const s = load().services.find((x) => x.op === op && x.line === line);
    return { min: s.defaultHeadway, max: s.defaultHeadway, estimated: true };
  }
  return { min: Math.round(Math.min(...all)), max: Math.round(Math.max(...all)) };
}

// 地圖上畫全台捷運：每條線的路徑，以及每個車站有哪些線（同名相鄰的站合併）
export function metroMap() {
  const { services, stations, operators } = load();
  const lines = new Map();
  for (const s of services) {
    const key = `${s.op}:${s.line}:${s.express ? 'x' : ''}`;
    if (s.express || (lines.has(key) && lines.get(key).path.length >= s.stations.length)) continue;
    lines.set(key, { name: s.name, color: colorOf(s), path: s.stations.map((k) => [stations[k].lat, stations[k].lng]) });
  }
  const merged = [];
  for (const st of load().list) {
    const here = services.filter((s) => s.stations.includes(st.key) && !s.express);
    const lineNames = [...new Map(here.map((s) => [s.name, { name: s.name, color: colorOf(s), headway: headwayRange(s.op, s.line) }])).values()];
    // 首末班車：每個方向一筆
    const times = (net.firstLast[st.key] || []).map(([dir, first, last, line]) => {
      const s = here.find((x) => x.line === line) || here[0];
      return { dir, first, last, line: s?.name, color: s ? colorOf(s) : null };
    });
    const m = merged.find((x) => x.name === st.name && distance(x, st) < 500);
    if (m) {
      m.lines.push(...lineNames.filter((l) => !m.lines.some((x) => x.name === l.name)));
      m.times.push(...times);
    } else merged.push({ name: st.name, lat: st.lat, lng: st.lng, operator: operators[st.op], lines: lineNames, times });
  }
  return { lines: [...lines.values()], stations: merged };
}

// 班距（分鐘）與是否在營運時間內；週末用假日班距
function service(s, minutes, holiday) {
  const day = holiday ? s.holiday : s.weekday;
  const [open, close] = day.hours;
  const m = minutes % (24 * 60);
  const end = close <= open ? close + 24 * 60 : close; // 營運到午夜後
  const running = (m >= open && m < end) || m + 24 * 60 < end;
  const hw = day.headways.find(([a, b]) => m >= a && m < b)?.[2] || s.defaultHeadway;
  return { headway: hw, running, open, close };
}

const isHoliday = (date) => [0, 6].includes(new Date(`${date}T12:00:00+08:00`).getUTCDay());

// 附近的車站：同名的站（不同系統的同一站）只算一個，避免候選都擠在同一站
function nearby(point, limit = CANDIDATES, extra = CANDIDATE_EXTRA_M) {
  const sorted = load().list
    .map((s) => ({ ...s, distance: Math.round(distance(point, s)) }))
    .sort((a, b) => a.distance - b.distance);
  const seen = new Set();
  return sorted.filter((s) => s.distance <= sorted[0].distance + extra && !seen.has(s.name) && seen.add(s.name))
    .slice(0, limit);
}

// 使用者指定上車／下車站（站名）時只用那一站，否則用附近幾站
function candidates(point, name) {
  if (name) {
    const s = nearby(point, Infinity, Infinity).find((x) => x.name === name);
    if (s) return [s];
  }
  return nearby(point);
}

// 同名且相鄰的站（不同系統、或同系統不同線各有站號）視為同一站
const sameStation = (s) => load().list.filter((x) => x.name === s.name && distance(x, s) < 500);

// 從某個車站出發，到所有車站的最快時間（含等車與轉乘）。狀態是「在某條路線的第幾站車上」
function search(starts, startCost, minutes, holiday) {
  const { services, at, links } = load();
  const best = new Map(); // 'si|pos' → { cost, prev, how }
  const heap = [];
  const push = (si, pos, cost, prev, how) => {
    const id = `${si}|${pos}`;
    if (best.has(id) && best.get(id).cost <= cost) return;
    best.set(id, { cost, prev, how, si, pos });
    heap.push([cost, id]);
  };
  const board = (key, cost, prev, how) => {
    for (const [si, pos] of at.get(key) || []) {
      const sv = service(services[si], minutes + cost / 60, holiday);
      push(si, pos, cost + (sv.headway * 60) / 2, prev, { ...how, wait: Math.round((sv.headway * 60) / 2) });
    }
  };
  for (const key of starts) board(key, startCost, null, { type: 'start' });

  while (heap.length) {
    // 節點只有幾百個，直接找最小值即可
    let k = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[k][0]) k = i;
    const [cost, id] = heap.splice(k, 1)[0];
    const node = best.get(id);
    if (node.cost < cost) continue;
    const s = services[node.si];
    // 沿線往前或往後一站
    if (node.pos + 1 < s.stations.length) push(node.si, node.pos + 1, cost + s.times[node.pos], id, { type: 'ride' });
    if (node.pos > 0) push(node.si, node.pos - 1, cost + s.times[node.pos - 1], id, { type: 'ride' });
    // 轉乘：同一站的其他路線，或有轉乘通道／步行可到的車站
    const key = s.stations[node.pos];
    for (const [si, pos] of at.get(key) || []) {
      if (si === node.si) continue;
      const sv = service(services[si], minutes + cost / 60, holiday);
      // 同一條線的區間車／支線：等的是同一個月台，不另算轉乘
      const sameLine = services[si].line === s.line && services[si].op === s.op;
      const extra = sameLine ? 0 : SAME_STATION_S + TRANSFER_PENALTY_S;
      push(si, pos, cost + extra + (sv.headway * 60) / 2, id, { type: 'transfer', walk: sameLine ? 0 : SAME_STATION_S, wait: Math.round((sv.headway * 60) / 2), sameLine });
    }
    for (const [other, sec] of links.get(key) || []) {
      for (const [si, pos] of at.get(other) || []) {
        const sv = service(services[si], minutes + (cost + sec) / 60, holiday);
        push(si, pos, cost + sec + TRANSFER_PENALTY_S + (sv.headway * 60) / 2, id, { type: 'transfer', walk: sec, wait: Math.round((sv.headway * 60) / 2) });
      }
    }
  }
  return best;
}

// 接駁裡走太遠的排序懲罰（秒）；a.forcedWalk 表示使用者沒開步行、只是沒有其他方式
function walkPenalty(a) {
  const weight = a.forcedWalk ? FORCED_WALK_WEIGHT : WALK_WEIGHT;
  return a.legs.filter((l) => l.mode === 'foot')
    .reduce((n, l) => n + Math.max(0, l.duration - WALK_FREE_S) * weight, 0);
}

// 把找到的路徑整理成一段一段的搭乘
function rides(best, endId) {
  const { services, stations } = load();
  const chain = [];
  for (let id = endId; id; id = best.get(id).prev) chain.unshift(best.get(id));
  const out = [];
  for (const n of chain) {
    const last = out.at(-1);
    if (n.how.type === 'ride' && last && last.si === n.si) last.positions.push(n.pos);
    else if (n.how.type === 'transfer' && n.how.sameLine && last) {
      // 區間車換支線（例：七張轉小碧潭）仍是同一條線，但要換車
      out.push({ si: n.si, positions: [n.pos], wait: n.how.wait, transfer: { walk: 0, sameLine: true } });
    } else {
      out.push({ si: n.si, positions: [n.pos], wait: n.how.wait, transfer: n.how.type === 'transfer' ? { walk: n.how.walk } : null });
    }
  }
  // 原地換線再換回來的空段（只有一站）去掉
  const segs = out.filter((r) => r.positions.length > 1);
  if (segs[0]) segs[0].transfer = null;
  return segs.map((r) => {
    const s = services[r.si];
    const ids = r.positions.map((p) => s.stations[p]);
    const forward = r.positions[1] > r.positions[0];
    const terminal = stations[forward ? s.stations.at(-1) : s.stations[0]];
    const loop = s.stations[0] === s.stations.at(-1);
    const pts = ids.map((k) => stations[k]);
    let sec = 0;
    for (let i = 1; i < r.positions.length; i++) sec += s.times[Math.min(r.positions[i], r.positions[i - 1])];
    const steps = pts.map((p, k) => ({
      lat: p.lat, lng: p.lng, name: p.name,
      type: k === 0 ? 'board' : k === pts.length - 1 ? 'alight' : 'stop',
      remaining: pts.length - 1 - k,
    }));
    const board = { ...pts[0], key: ids[0] }, alight = { ...pts.at(-1), key: ids.at(-1) };
    return {
      wait: r.wait,
      transfer: r.transfer,
      service: s,
      leg: {
        mode: 'metro',
        route: s.name,
        operator: load().operators[s.op],
        color: colorOf(s),
        headsign: loop ? `往${pts[1].name}方向` : `往${terminal.name}`,
        stopCount: pts.length - 1,
        distance: Math.round(pts.reduce((n, p, k) => (k ? n + distance(pts[k - 1], p) : 0), 0)),
        duration: sec,
        path: pts.map((p) => [p.lat, p.lng]),
        steps,
        board,
        alight,
      },
    };
  });
}

// 票價：同一個業者的連續搭乘算一段（站內轉乘不出站），不同業者分開計價
function fareOf(segments) {
  const groups = [];
  for (const r of segments) {
    const g = groups.at(-1);
    if (g && g.op === r.service.op) g.to = r.leg.alight;
    else groups.push({ op: r.service.op, from: r.leg.board, to: r.leg.alight });
  }
  let total = 0;
  for (const g of groups) {
    const t = load().fares[g.op];
    const p = t?.[`${g.from.id}-${g.to.id}`] ?? t?.[`${g.to.id}-${g.from.id}`];
    if (p == null) return { total: null, split: groups.length > 1 };
    total += p;
  }
  return { total, split: groups.length > 1 };
}

// connect.in／connect.out 與台鐵相同：規劃到車站、離開車站的接駁
// choice = { board, alight }：使用者指定的上車／下車站名（例如騎 YouBike 到遠一點、不用轉乘的站）
export async function planMetro(from, to, connect, choice = {}, when = taipeiNow()) {
  const origins = candidates(from, choice.board);
  const dests = candidates(to, choice.alight);
  // 可以改選的上車／下車站（附近 3 公里內）
  const boardChoices = nearby(from, BOARD_CHOICES, BOARD_CHOICE_EXTRA_M);
  const alightChoices = nearby(to, BOARD_CHOICES, BOARD_CHOICE_EXTRA_M);
  if (!origins.length || origins[0].distance > MAX_ACCESS_M) throw new Error('出發點附近 15 公里內沒有捷運或輕軌站');
  if (!dests.length || dests[0].distance > MAX_ACCESS_M) throw new Error('目的地附近 15 公里內沒有捷運或輕軌站');
  if (origins.some((o) => dests.some((d) => d.name === o.name)) && origins[0].name === dests[0].name) {
    throw new Error(`出發點和目的地最近的都是「${origins[0].name}」站，不需要搭捷運`);
  }
  const holiday = isHoliday(when.date);
  const [walkIns, walkOuts] = await Promise.all([
    Promise.all(origins.map((o) => connect.in(from, o))),
    Promise.all(dests.map((d) => connect.out(d, to))),
  ]);

  const { services } = load();
  const found = [];
  origins.forEach((o, oi) => {
    const best = search(sameStation(o).map((s) => s.key), walkIns[oi].duration, when.minutes, holiday);
    dests.forEach((d, di) => {
      if (d.name === o.name) return;
      // 這一站（含其他系統的同名站）任何路線上的最佳結果
      const keys = new Set(sameStation(d).map((s) => s.key));
      let end = null;
      for (const [id, n] of best) {
        if (keys.has(services[n.si].stations[n.pos]) && (!end || n.cost < best.get(end).cost)) end = id;
      }
      if (!end) return;
      const segments = rides(best, end);
      if (!segments.length) return;
      // 轉乘懲罰只影響排序，顯示的時間要扣掉
      const penalty = segments.filter((r) => r.transfer && !r.transfer.sameLine).length * TRANSFER_PENALTY_S;
      const ride = best.get(end).cost - walkIns[oi].duration - penalty;
      const total = best.get(end).cost + walkOuts[di].duration;
      found.push({ oi, di, segments, total, ride, rank: total + walkPenalty(walkIns[oi]) + walkPenalty(walkOuts[di]) });
    });
  });
  if (!found.length) throw new Error('找不到可以搭捷運到達的路線（出發點和目的地可能在不同城市的捷運系統）');

  // 依總時間（含走太遠的懲罰）排序，路線一樣（同樣的線、同樣的上下車站）只留一個
  found.sort((a, b) => a.rank - b.rank);
  const seen = new Set();
  const picked = found.filter((f) => {
    const sig = f.segments.map((r) => `${r.service.line}:${r.leg.board.name}>${r.leg.alight.name}`).join('/');
    return !seen.has(sig) && seen.add(sig);
  }).slice(0, MAX_OPTIONS);

  const options = await Promise.all(picked.map(async (f) => {
    const [walkIn, walkOut] = await Promise.all([connect.in.refine(walkIns[f.oi]), connect.out.refine(walkOuts[f.di])]);
    const duration = Math.round(walkIn.duration + f.ride + walkOut.duration);
    // 搭第一班車時是否在營運時間內
    const first = f.segments[0];
    const sv = service(first.service, when.minutes + walkIn.duration / 60, holiday);
    return {
      origin: origins[f.oi], dest: dests[f.di], walkIn, walkOut,
      rides: f.segments.map((r) => ({
        ...r.leg, wait: r.wait, transfer: r.transfer,
        headway: service(r.service, when.minutes, holiday).headway,
      })),
      transfers: f.segments.length - 1,
      duration,
      reach: Math.round(when.minutes + duration / 60),
      fare: fareOf(f.segments),
      closed: sv.running ? null : { open: sv.open, close: sv.close },
      rank: duration + walkPenalty(walkIn) + walkPenalty(walkOut),
    };
  }));
  options.sort((a, b) => a.rank - b.rank);
  const brief = (list) => list.map(({ name, distance: d, op }) => ({ name, distance: d, operator: load().operators[op] }));
  return { origins, dests, options, now: when, holiday, boardChoices: brief(boardChoices), alightChoices: brief(alightChoices), choice };
}
