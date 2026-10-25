// 公路／國道客運的票價、業者（電話、官網）、路線圖：規劃結果直接附上，不用再到客運網站查
import { tdx, daily, cached } from './tdx.js';

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
