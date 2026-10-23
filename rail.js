// 台鐵、高鐵：找離出發點／目的地最近的車站，列出接下來能搭的班次
import { distance } from './geo.js';
import { tdx, daily, cached, taipeiNow, toMinutes } from './tdx.js';

const MAX_TRAINS = 12;
const LIVE_MS = 2 * 60 * 1000;
const SEAT_MS = 5 * 60 * 1000;
const SEAT_TIMEOUT_MS = 8000; // 座位只是參考資訊，TDX 額度用完時不要讓整個規劃卡住

// 台鐵車種名稱很長（例：自強(推拉式自強號且無自行車車廂)），整理成常用叫法
function traType(name) {
  for (const t of ['普悠瑪', '太魯閣', '區間快', '區間', '莒光', '復興', '自強']) if (name.includes(t)) return t;
  return name.replace(/\(.*$/, '');
}

// 今天用 Today 的時刻表；其他日期用指定日期的時刻表（檔名帶日期，同樣每天重抓一次，以免時刻異動）
async function timetable(date, name, todayPath, datePath) {
  if (date === taipeiNow().date) return daily(name, () => tdx(todayPath));
  try {
    return await daily(`${name}-for-${date}`, () => tdx(datePath));
  } catch {
    throw new Error(`查不到 ${date} 的時刻表（可能還沒公布）`);
  }
}

const SYSTEMS = {
  tra: {
    label: '台鐵',
    async stations() {
      const { Stations } = await daily('tra-stations', () => tdx('v3/Rail/TRA/Station'));
      return Stations.map((s) => ({
        id: s.StationID, name: s.StationName.Zh_tw,
        lat: s.StationPosition.PositionLat, lng: s.StationPosition.PositionLon,
      }));
    },
    async trains(date) {
      const { TrainTimetables } = await timetable(date, 'tra-timetable',
        'v3/Rail/TRA/DailyTrainTimetable/Today', `v3/Rail/TRA/DailyTrainTimetable/TrainDate/${date}`);
      // SuspendedFlag：0 正常、1 停駛、2 部分停駛（個別車站另有標記）
      return TrainTimetables.map((t) => ({
        no: t.TrainInfo.TrainNo,
        type: traType(t.TrainInfo.TrainTypeName.Zh_tw),
        typeFull: t.TrainInfo.TrainTypeName.Zh_tw,
        headsign: t.TrainInfo.TripHeadSign || `往${t.TrainInfo.EndingStationName.Zh_tw}`,
        note: t.TrainInfo.Note || '',
        suspended: t.TrainInfo.SuspendedFlag === 1,
        stops: t.StopTimes.map((s) => ({
          id: s.StationID, name: s.StationName.Zh_tw, arr: s.ArrivalTime, dep: s.DepartureTime,
          suspended: s.SuspendedFlag === 1,
        })),
      }));
    },
    // 台鐵即時誤點（分鐘）
    async delays() {
      return cached('tra-live', LIVE_MS, async () => {
        const { TrainLiveBoards } = await tdx('v3/Rail/TRA/TrainLiveBoard');
        return new Map(TrainLiveBoards.map((b) => [b.TrainNo, b.DelayTime]));
      }).catch(() => new Map()); // 額度用完時不顯示誤點，規劃照樣可用
    },
  },
  thsr: {
    label: '高鐵',
    async stations() {
      const list = await daily('thsr-stations', () => tdx('v2/Rail/THSR/Station'));
      return list.map((s) => ({
        id: s.StationID, name: `高鐵${s.StationName.Zh_tw}`,
        lat: s.StationPosition.PositionLat, lng: s.StationPosition.PositionLon,
      }));
    },
    async trains(date) {
      const list = await timetable(date, 'thsr-timetable',
        'v2/Rail/THSR/DailyTimetable/Today', `v2/Rail/THSR/DailyTimetable/TrainDate/${date}`);
      return list.map((t) => ({
        no: t.DailyTrainInfo.TrainNo,
        type: '高鐵',
        typeFull: '高鐵',
        headsign: `往${t.DailyTrainInfo.EndingStationName.Zh_tw}`,
        note: '',
        suspended: false,
        stops: t.StopTimes.map((s) => ({ id: s.StationID, name: s.StationName.Zh_tw, arr: s.ArrivalTime, dep: s.DepartureTime })),
      }));
    },
    async delays() {
      return new Map();
    },
    // 票價（單程票）：全票與優待票（孩童、敬老、愛心，半價）
    async fares() {
      const list = await daily('thsr-fares', () => tdx('v2/Rail/THSR/ODFare'));
      const CABIN = { 1: 'standard', 2: 'business', 3: 'free' };
      return new Map(list.map((f) => {
        const fare = { full: {}, concession: {} };
        for (const x of f.Fares) {
          if (x.TicketType !== 1 || !CABIN[x.CabinClass]) continue;
          if (x.FareClass === 1) fare.full[CABIN[x.CabinClass]] = x.Price;
          if (x.FareClass === 9) fare.concession[CABIN[x.CabinClass]] = x.Price;
        }
        return [`${f.OriginStationID}-${f.DestinationStationID}`, fare];
      }));
    },
    // 剩餘座位：O 尚有座位、L 座位有限、X 已售完；回傳 車次 → 下車站 → 狀態
    async seats(stationId) {
      const job = cached(`thsr-seats:${stationId}`, SEAT_MS, async () => {
        const { AvailableSeats } = await tdx(`v2/Rail/THSR/AvailableSeatStatusList/${stationId}`);
        return new Map(AvailableSeats.map((t) => [t.TrainNo, new Map(t.StopStations.map((s) =>
          [s.StationID, { standard: s.StandardSeatStatus, business: s.BusinessSeatStatus }]))]));
      });
      const timeout = new Promise((r) => setTimeout(() => r(new Map()), SEAT_TIMEOUT_MS));
      return Promise.race([job, timeout]).catch(() => new Map());
    },
  },
};

export async function railStations(system) {
  const sys = SYSTEMS[system];
  if (!sys) throw new Error('未知的鐵路系統');
  return sys.stations();
}

// 附近幾個車站都考慮：最近的小站常常不停快車
const CANDIDATES = 3;
const CANDIDATE_EXTRA_M = 2000; // 比最近的車站遠不超過這麼多才列入

function nearbyStations(stations, point) {
  const sorted = stations
    .map((s) => ({ ...s, distance: Math.round(distance(point, s)) }))
    .sort((a, b) => a.distance - b.distance);
  return sorted.filter((s) => s.distance <= sorted[0].distance + CANDIDATE_EXTRA_M).slice(0, CANDIDATES);
}

// connect.in(from, 車站)／connect.out(車站, to) 規劃到車站、離開車站的接駁（步行、公車、YouBike、計程車），
// 太遠時先回傳估算的路線；connect.in.refine(access) 再換成實際路線，只對最後列出的班次做
// when = { date: 'YYYY-MM-DD', minutes: 當天第幾分鐘 }：列出這個時間之後的班次，預設現在
export async function planRail(system, from, to, connect, when = taipeiNow()) {
  const sys = SYSTEMS[system];
  if (!sys) throw new Error('未知的鐵路系統');
  const stations = await sys.stations();
  const origins = nearbyStations(stations, from);
  const dests = nearbyStations(stations, to).filter((d) => !origins.some((o) => o.id === d.id));
  if (!dests.length) throw new Error(`出發點和目的地附近是同一個${sys.label}車站「${origins[0].name}」，不需要搭${sys.label}`);

  const today = when.date === taipeiNow().date; // 誤點、剩餘座位只有今天的資料
  const [trains, delays, walkIns, walkOuts, fares] = await Promise.all([
    sys.trains(when.date),
    today ? sys.delays() : new Map(),
    Promise.all(origins.map((o) => connect.in(from, o))),
    Promise.all(dests.map((d) => connect.out(d, to))),
    sys.fares?.().catch(() => null), // 票價只是參考，抓不到照樣規劃
  ]);
  const byId = new Map(stations.map((s) => [s.id, s]));
  const now = when.minutes;

  const options = [];
  let suspendedCount = 0;
  for (const t of trains) {
    if (t.suspended) {
      // 統計「本來可以搭、但今天停駛」的班次，讓使用者知道不是沒車而是停駛
      const i0 = t.stops.findIndex((s) => origins.some((o) => o.id === s.id));
      if (i0 >= 0 && toMinutes(t.stops[i0].dep) >= now &&
          t.stops.some((s, n) => n > i0 && dests.some((d) => d.id === s.id))) suspendedCount++;
      continue;
    }
    // 第一個能趕上的上車站（依距離由近到遠）
    let i = -1, oi = -1, delay = 0;
    for (const [k, o] of origins.entries()) {
      const idx = t.stops.findIndex((s) => s.id === o.id && !s.suspended);
      if (idx < 0) continue;
      const d = delays.get(t.no) || 0;
      if (toMinutes(t.stops[idx].dep) + d >= now + Math.ceil(walkIns[k].duration / 60)) {
        i = idx; oi = k; delay = d;
        break;
      }
    }
    if (i < 0) continue;
    // 下車站：抵達目的地（含步行）最早的那站
    let j = -1, di = -1, best = Infinity;
    const dep = toMinutes(t.stops[i].dep);
    for (const [k, d] of dests.entries()) {
      const idx = t.stops.findIndex((s, n) => n > i && s.id === d.id && !s.suspended);
      if (idx < 0) continue;
      let a = toMinutes(t.stops[idx].arr);
      if (a < dep) a += 24 * 60; // 跨午夜
      const reach = a + walkOuts[k].duration / 60;
      if (reach < best) { best = reach; j = idx; di = k; }
    }
    if (j < 0) continue;

    const origin = origins[oi], dest = dests[di];
    let arr = toMinutes(t.stops[j].arr);
    if (arr < dep) arr += 24 * 60;
    const ride = t.stops.slice(i, j + 1).filter((s) => !s.suspended).map((s, k, all) => {
      const st = byId.get(s.id);
      return {
        lat: st?.lat, lng: st?.lng, name: s.name,
        type: k === 0 ? 'board' : k === all.length - 1 ? 'alight' : 'stop',
        time: k === 0 ? s.dep : s.arr,
        remaining: all.length - 1 - k,
      };
    }).filter((s) => s.lat != null);
    options.push({
      no: t.no, type: t.type, typeFull: t.typeFull, headsign: t.headsign, note: t.note,
      dep: t.stops[i].dep, arr: t.stops[j].arr, delay,
      minutes: arr - dep, stopCount: ride.length - 1,
      arrAt: arr + delay, // 火車抵達（當天第幾分鐘）
      reach: Math.round(best + delay), // 抵達目的地（當天第幾分鐘）
      origin, dest, walkIn: walkIns[oi], walkOut: walkOuts[di],
      fare: fares?.get(`${origin.id}-${dest.id}`) || fares?.get(`${dest.id}-${origin.id}`) || null,
      leg: {
        mode: 'train',
        route: `${t.type} ${t.no}`,
        headsign: t.headsign,
        stopCount: ride.length - 1,
        distance: Math.round(ride.reduce((n, s, k) => (k ? n + distance(ride[k - 1], s) : 0), 0)),
        duration: (arr - dep) * 60,
        path: ride.map((s) => [s.lat, s.lng]),
        steps: ride,
        board: { ...origin },
        alight: { ...dest },
      },
    });
  }
  // 依抵達目的地的時間排序：晚一點出發的快車可能比較早到
  options.sort((a, b) => a.reach - b.reach);
  const shown = options.slice(0, MAX_TRAINS);

  // 列出的班次才換成實際接駁路線（同一個車站只算一次），再依實際抵達時間重新排序
  const refined = new Map();
  const refine = (a) => {
    if (!refined.has(a)) refined.set(a, connect.in.refine(a));
    return refined.get(a);
  };
  const seatsBy = new Map();
  const seatsAt = (id) => {
    if (!seatsBy.has(id)) seatsBy.set(id, sys.seats && today ? sys.seats(id) : Promise.resolve(new Map()));
    return seatsBy.get(id);
  };
  await Promise.all(shown.map(async (o) => {
    const [walkIn, walkOut, seats] = await Promise.all([refine(o.walkIn), refine(o.walkOut), seatsAt(o.origin.id)]);
    Object.assign(o, { walkIn, walkOut, seats: seats.get(o.no)?.get(o.dest.id) || null });
    o.reach = Math.round(o.arrAt + walkOut.duration / 60);
  }));
  shown.sort((a, b) => a.reach - b.reach);

  return {
    system, label: sys.label, origins, dests,
    trains: shown,
    suspendedCount,
    date: when.date,
    today,
    now: when,
  };
}

// 啟動時先把今天的時刻表載入（若硬碟已有就不會呼叫 TDX）
export const warmUp = () => Promise.all(Object.values(SYSTEMS).flatMap((s) => [s.stations(), s.trains(taipeiNow().date), s.fares?.()]));
