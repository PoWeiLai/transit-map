// 公路／國道客運：長途規劃（像火車一樣先接駁到客運站），以及票價、業者（電話、官網）、路線圖
import { tdx, daily, cached, taipeiNow } from './tdx.js';
import { distance } from './geo.js';
import { intercityData } from './bus.js';

const FARE_MS = 24 * 60 * 60 * 1000;
const FARE_BATCH = 40; // 一次查幾條路線的票價（全台一份太大，只查用得到的）

// 路線 → 業者、路線圖；業者 → 電話、官網（各一天抓一次，資料不大）
const routeInfo = () => daily('coach-routes', async () => {
  const list = await tdx('v2/Bus/Route/InterCity', { $select: 'RouteUID,Operators,RouteMapImageUrl' });
  return Object.fromEntries(list.map((r) => [r.RouteUID, { ops: (r.Operators || []).map((o) => o.OperatorID), map: r.RouteMapImageUrl || '' }]));
});
const operators = () => daily('coach-operators', async () => {
  const list = await tdx('v2/Bus/Operator/InterCity');
  return Object.fromEntries(list.map((o) => [o.OperatorID, { name: o.OperatorName?.Zh_tw || '', phone: o.OperatorPhone || '', url: o.OperatorUrl || '' }]));
});

// 票價：RouteID → { `${SubRouteID}_${Direction}`: [{ from, to, full: [價格…], half: [價格…] }] }，上下車站用 StopID
const fares = new Map(); // RouteID → Promise

function getFares(routeIds) {
  const stale = [...new Set(routeIds)].filter((id) => !fares.has(id));
  for (let k = 0; k < stale.length; k += FARE_BATCH) {
    const chunk = stale.slice(k, k + FARE_BATCH);
    const job = cached(`coach-fare:${chunk.join(',')}`, FARE_MS, () => tdx('v2/Bus/RouteFare/InterCity', {
      $filter: chunk.map((id) => `RouteID eq '${id}'`).join(' or '),
      $select: 'RouteID,SubRouteID,StageFares',
    }));
    for (const id of chunk) {
      const value = job.then((list) => {
        const out = {};
        for (const r of list.filter((x) => x.RouteID === id)) {
          for (const s of r.StageFares || []) {
            const prices = (cls) => s.Fares.filter((f) => f.FareClass === cls && f.Price > 0).map((f) => f.Price);
            (out[`${r.SubRouteID}_${s.Direction}`] ||= []).push({
              from: s.OriginStage.StopID, fromSeq: s.OriginStage.Sequence,
              to: s.DestinationStage.StopID, toSeq: s.DestinationStage.Sequence,
              full: prices(1), half: prices(10),
            });
          }
        }
        return out;
      });
      value.catch(() => fares.delete(id)); // 失敗下次重抓
      fares.set(id, value);
    }
  }
  return Promise.all(routeIds.map((id) => fares.get(id)));
}

// 分段票價：每站屬於它之前（含自己）最近的收費站那一段（例如台中市區各站都算「水湳轉運中心」段），
// 查上、下車兩段之間的票價；同一段（例如只坐到中途下客站）沒有列票價
function fareFor(stages, board, alight) {
  if (!stages?.length) return null;
  const seqs = [...new Set(stages.flatMap((s) => [s.fromSeq, s.toSeq]))].sort((a, b) => a - b);
  const o = seqs.findLast((q) => q <= board);
  const d = seqs.findLast((q) => q <= alight);
  const hit = o != null && o !== d && stages.find((s) => s.fromSeq === o && s.toSeq === d);
  if (!hit || !hit.full.length) return null;
  const range = (list) => (list.length ? [Math.min(...list), Math.max(...list)] : null);
  return { full: range(hit.full), half: range(hit.half) };
}

// legs：規劃結果裡的客運段（有 coach = { route, sub, dir }），直接加上 operator、fare、map
export async function addCoachInfo(legs) {
  if (!legs.length) return;
  const routeId = (uid) => uid.replace(/^THB/, '');
  const [routes, ops, fareList] = await Promise.all([
    routeInfo().catch(() => ({})),
    operators().catch(() => ({})),
    getFares(legs.map((l) => routeId(l.coach.route))).catch(() => []),
  ]);
  const byRoute = new Map(legs.map((l, k) => [routeId(l.coach.route), fareList[k]]));
  for (const l of legs) {
    const { route, sub, dir } = l.coach;
    const info = routes[route];
    const op = info?.ops.map((id) => ops[id]).find(Boolean);
    const stages = byRoute.get(routeId(route))?.[`${sub.replace(/^THB/, '')}_${dir}`];
    l.coach = {
      operator: op || null,
      map: info?.map || '',
      fare: fareFor(stages, l.board.seq, l.alight.seq),
      next: l.coach.next,
    };
  }
}

// ---------- 長途規劃：接駁到客運站 → 搭客運 → 接駁到目的地 ----------

const STOP_RADIUS_M = 12000; // 出發點／目的地多遠內的客運站都考慮（例如板橋 → 台北轉運站）
const STATIONS = 4;          // 上車、下車各最多幾個客運站（每個站都要規劃一次接駁）
const MAX_TRIPS = 8;
const ACCESS_GUESS_MIN = 10; // 估計出站後接駁的開始時間：再多抓一點
// 直線距離粗估接駁時間（秒）：近的走路，遠的搭車（含等車）
const guessAccess = (m) => (m <= 800 ? m * 1.3 / 1.2 : 10 * 60 + m * 1.3 / 6);
const hm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`;

// 同一個客運站各路線的站牌位置略有不同，用站名加大約位置（約 1 公里）合併
const stationOf = (s) => ({ id: `${s.name}@${s.lat.toFixed(2)},${s.lng.toFixed(2)}`, name: s.name, lat: s.lat, lng: s.lng });

// 某班車第 k 站的時間（分鐘）；班表沒列到這站就用典型站間時間推算
function stopTime(timing, trip, k) {
  if (trip.at[k] != null) return trip.at[k];
  if (!timing.offsets) return null;
  return trip.at[trip.first] + (timing.offsets[k] - timing.offsets[trip.first]) / 60;
}

// 回傳格式跟 planRail 一樣，畫面沿用火車的顯示
export async function planCoach(from, to, connect, when = taipeiNow()) {
  const { lines, timingOf } = await intercityData();

  // 每條有時刻表的路線：出發點附近上車、目的地附近下車，挑估計最快的上下車站
  const cands = [];
  for (const line of lines) {
    const timing = timingOf(line);
    if (!timing) continue; // 沒有時刻表就給不出班次
    const near = (p) => line.stops.map((s, k) => ({ k, d: distance(p, s) })).filter((x) => x.d <= STOP_RADIUS_M);
    const ins = near(from);
    if (!ins.length) continue;
    const outs = near(to);
    let best = null;
    for (const a of ins) {
      for (const b of outs) {
        if (b.k <= a.k) continue;
        const ride = timing.offsets ? timing.offsets[b.k] - timing.offsets[a.k] : line.stops[b.k].est - line.stops[a.k].est;
        const cost = guessAccess(a.d) + ride + guessAccess(b.d);
        if (!best || cost < best.cost) best = { line, timing, i: a.k, j: b.k, cost };
      }
    }
    if (best) cands.push(best);
  }
  if (!cands.length) throw new Error('出發點和目的地附近 12 公里內沒有可以直達的客運路線（或這些路線沒有時刻表資料）');
  cands.sort((a, b) => a.cost - b.cost);

  // 上車、下車的客運站：依候選路線的快慢挑前幾個
  const pick = (key) => {
    const list = [];
    for (const c of cands) {
      const st = stationOf(c.line.stops[c[key]]);
      if (!list.some((s) => s.id === st.id)) list.push(st);
      if (list.length >= STATIONS) break;
    }
    return list;
  };
  const origins = pick('i'), dests = pick('j');
  const index = (list, s) => list.findIndex((x) => x.id === stationOf(s).id);
  const usable = cands.filter((c) => index(origins, c.line.stops[c.i]) >= 0 && index(dests, c.line.stops[c.j]) >= 0);

  const [walkIns, walkOuts] = await Promise.all([
    Promise.all(origins.map((o) => connect.in(from, o))),
    Promise.all(dests.map((d) => connect.out(d, to, {
      date: when.date,
      minutes: when.minutes + Math.round(Math.min(...usable.map((c) => c.cost)) / 60) + ACCESS_GUESS_MIN,
    }))),
  ]);

  const day = new Date(`${when.date}T00:00:00Z`).getUTCDay();
  const options = [];
  for (const { line, timing, i, j } of usable) {
    const oi = index(origins, line.stops[i]), di = index(dests, line.stops[j]);
    const ready = when.minutes + walkIns[oi].duration / 60; // 走到客運站的時間
    for (const trip of timing.trips) {
      if (!((trip.days >> day) & 1)) continue;
      const dep = stopTime(timing, trip, i), arr = stopTime(timing, trip, j);
      if (dep == null || arr == null || dep < ready || arr <= dep) continue;
      const ride = line.stops.slice(i, j + 1).map((s, k, all) => ({
        lat: s.lat, lng: s.lng, name: s.name,
        type: k === 0 ? 'board' : k === all.length - 1 ? 'alight' : 'stop',
        time: hm(stopTime(timing, trip, i + k) ?? dep),
        remaining: all.length - 1 - k,
      }));
      const no = line.name.replace(/^客運 /, '');
      options.push({
        no, type: '客運', typeFull: '公路／國道客運', headsign: line.headsign, note: '',
        dep: hm(dep), arr: hm(arr), delay: 0,
        minutes: Math.round(arr - dep), stopCount: j - i,
        arrAt: Math.round(arr),
        reach: Math.round(arr + walkOuts[di].duration / 60),
        origin: origins[oi], dest: dests[di], walkIn: walkIns[oi], walkOut: walkOuts[di],
        fare: null,
        coach: { route: line.route, sub: line.sub, dir: line.dir },
        leg: {
          mode: 'train',
          route: `客運 ${no}`,
          headsign: line.headsign,
          stopCount: j - i,
          distance: Math.round(line.stops[j].along - line.stops[i].along),
          duration: Math.round((arr - dep) * 60),
          path: ride.map((s) => [s.lat, s.lng]),
          steps: ride,
          board: { ...origins[oi], seq: line.stops[i].seq },
          alight: { ...dests[di], seq: line.stops[j].seq },
        },
      });
    }
  }
  // 同一條路線同一時間發車（不同子路線）只留一班，依抵達目的地時間排序
  options.sort((a, b) => a.reach - b.reach || a.arrAt - b.arrAt);
  const seen = new Set();
  const shown = options.filter((o) => {
    const k = `${o.no}|${o.dep}|${o.origin.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_TRIPS);

  // 列出的班次才換成實際接駁路線，附上票價、業者
  const refined = new Map();
  const refine = (a) => {
    if (!refined.has(a)) refined.set(a, connect.in.refine(a));
    return refined.get(a);
  };
  const infos = shown.map((o) => ({ coach: o.coach, board: o.leg.board, alight: o.leg.alight }));
  await Promise.all([
    addCoachInfo(infos).catch(() => {}),
    ...shown.map(async (o) => {
      const [walkIn, walkOut] = await Promise.all([refine(o.walkIn), refine(o.walkOut)]);
      Object.assign(o, { walkIn, walkOut, reach: Math.round(o.arrAt + walkOut.duration / 60) });
    }),
  ]);
  shown.forEach((o, k) => { o.coach = infos[k].coach.operator !== undefined ? infos[k].coach : null; });
  shown.sort((a, b) => a.reach - b.reach);

  return {
    system: 'coach', label: '客運', origins, dests,
    trains: shown,
    suspendedCount: 0,
    date: when.date,
    today: when.date === taipeiNow().date,
    now: when,
  };
}
