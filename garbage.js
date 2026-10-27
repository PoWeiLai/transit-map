// 垃圾車：各縣市環保局的清運點（固定丟垃圾的地點）與表定經過時間，加上垃圾車即時位置。
// 全國沒有統一的開放資料，有公開的縣市才查得到：
//   有座標：台北、新北、基隆、高雄、宜蘭（用距離找最近的）
//   只有地址：台中、新竹市、高雄今日預估（用查詢地點的「里」和「路名」比對）
//   即時位置：新北、台中、台南、高雄
// 只下載查詢地點所在縣市的資料；還在下載就先回覆「下載中」，不讓查詢卡住
import { daily, cached, taipeiNow, toMinutes } from './tdx.js';
import { distance } from './geo.js';
import { citiesAt } from './cities.js';

const NEAR_M = 600;         // 清運點多遠內
const TRUCK_NEAR_M = 2000;  // 即時位置：附近多遠內的車
const TRUCK_FRESH_MIN = 20; // 太久沒回報的車（多半已收班）不列
const LIVE_MS = 60 * 1000;
const MAX_POINTS = 8;
const LOAD_WAIT_MS = 8000;  // 查詢時最多等資料這麼久，其餘在背景下載
const LIVE_WAIT_MS = 6000;
const FETCH_MS = 45000;
const KCG_PARALLEL = 6;     // 高雄各區資料一次同時抓幾份
const DAYS = '日一二三四五六';
// 台北市週三、週日停收一般垃圾
const TAIPEI_DAYS = [1, 2, 4, 5, 6].reduce((m, d) => m | (1 << d), 0);

// 高雄市各區「垃圾清運路線及時間」資料集
const KAOHSIUNG = ['53fa3c3d-19a6-4bed-b864-9ae8e3734f7b', 'e983ab14-395e-438d-858c-b5da32592c10', '28d23cf4-4b41-43d7-ad2e-57ab1b13470f',
  '6cb25697-b1e3-4dad-9221-3348e42950d2', '229f7031-13a9-410b-9586-3ce04539dd62', '7392cdeb-d7fe-4913-a528-ff7fea13c031',
  '7650abef-10ae-43b8-b584-a678fbfb43cd', '11b45c9e-d5ef-4abc-a970-82a03d4fe758', '89cdab3d-b395-46cc-a1d3-086b3f195e32',
  'ef7e61e0-1e88-4b74-bf26-84defbb32917', '5f29ccae-ad8e-405b-9fc0-20895e4670f7', 'f27d99dd-a453-4674-b260-cef29129e194',
  '0c7c97e7-2b7f-4bec-bc1d-0cbfbff346f3', '885c8c43-3c72-4c45-ab9a-8f466ef3ec98', 'cc1a20ad-5731-46c2-ae8c-4375e138bf2c',
  'b35ae5f6-c622-4a42-9a7b-08adfc43dea0', '13d70f9a-b426-4b6e-a056-fd611171a645', '9854e42e-f38e-416c-915b-df480a102a12',
  '3bf0099f-c848-4983-b238-d99ce9632cec', 'c4b6327f-e53a-45d7-ad49-01c1a3358ccc', 'f13d89e9-33ee-4f12-b5e7-ac967cfdd410',
  '6c9776d0-49bf-42b6-8e00-5bb56a407b9c', '986c3b9a-4784-4972-a54b-22575c0f8d4b', '1ab01cc5-13f1-435c-b3df-55ba1899f7fc',
  '1bbbf953-5758-4d93-97ab-601cac7353b7', 'f313b733-ce41-40d3-8dab-62145770f763', '7ce09ffa-17e1-4f1a-ab72-3d55ca95b2e5',
  '4c170a24-5124-48a0-ba2f-3d3870a6bfc6', 'eb2de68e-6a47-4635-b059-3eab7948d8a7', '2e9d826c-756b-47be-8ee0-1406329bc319',
  '4a8ff3de-043e-40c3-8337-8f9d30a82375', 'a1e813f1-ae52-4b22-9fa7-e15512e41186', '888f41a8-e5cd-4ae5-8855-86e746fa52dc',
  '6bbc7e64-054b-4df0-a7f2-5789d1801496', '5888b615-2c27-411f-9153-15e1fae45bb6', 'eb7ef936-6cc3-41f7-9c2f-934fdb503802',
  'dad491d5-bd94-4ead-9b42-aad8274741f3'];
const KCG = (id) => `https://openapi.kcg.gov.tw/Api/Service/Get/${id}`;

async function get(url, type = 'json') {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { 'User-Agent': 'Mozilla/5.0 transit-map' } });
  if (!res.ok) throw new Error(`垃圾車資料 ${res.status}`);
  return type === 'json' ? res.json() : (await res.text()).replace(/^﻿/, '');
}

// CSV → 物件陣列（第一列是欄位名稱，欄位可能有雙引號）
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, k) => [h.trim(), (r[k] ?? '').trim()])));
}

const hhmm = (s) => (/^\d{3,4}$/.test(s) ? `${s.padStart(4, '0').slice(0, 2)}:${s.padStart(4, '0').slice(2)}` : s);
const minText = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
// city：TDX 縣市代碼；line：同一條路線的 key（新北用路線編號，和即時位置對得上）
const stop = (city, route, name, lat, lng, start, end = '', days = null, note = '', line = '', rank = null) => {
  lat = Number(lat); lng = Number(lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 21 && lat < 27 && /^\d{1,2}:\d{2}$/.test(start)
    ? { city, route, name, lat, lng, start, end, days, note, line: line || `${city}:${route}`, rank } : null;
};

// 同時最多跑 n 個
async function pool(items, n, fn) {
  const out = [];
  let k = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (k < items.length) { const i = k++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// 各縣市的清運點（固定丟垃圾的地點），用 TDX 縣市代碼
const SOURCES = {
  async Taipei() {
    const rows = parseCsv(await get('https://data.taipei/api/dataset/6bb3304b-4f46-4bb0-8cd1-60c66dcd1cae/resource/a6e90031-7ec4-4089-afb5-361a4efe7202/download', 'text'));
    return rows.map((r) => stop('Taipei', `${r['路線']} ${r['車次']}`, r['地點'], r['緯度'], r['經度'], hhmm(r['抵達時間']), hhmm(r['離開時間']), TAIPEI_DAYS, '週三、週日停收'));
  },
  async NewTaipei() {
    const rows = parseCsv(await get('https://data.ntpc.gov.tw/api/datasets/edc3ad26-8ae7-4916-a00b-bc6048d19bf8/csv/file', 'text'));
    const en = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return rows.map((r) => {
      const bits = (kind) => en.reduce((m, d, k) => (r[`${kind}${d}`] === 'Y' ? m | (1 << k) : m), 0);
      const recycle = en.map((d, k) => (r[`recycling${d}`] === 'Y' ? DAYS[k] : '')).join('');
      // 路線編號跟即時位置的 lineid 一樣，用來算垃圾車現在的進度
      return stop('NewTaipei', `${r.city} ${r.linename}`, r.name, r.latitude, r.longitude, r.time, '', bits('garbage') || null,
        recycle ? `資源回收：星期${[...recycle].join('、')}` : '', `NewTaipei:${r.lineid}`, Number(r.rank));
    });
  },
  async Keelung() {
    const rows = parseCsv(await get('https://opendata-kl.askeycloud.com/route_klepb.csv', 'text'));
    return rows.map((r) => stop('Keelung', r['清運路線名稱'], r['清運點'], r['緯度'], r['經度'], r['預估到達時間'], r['預估離開時間'], null,
      r['回收日(星期幾)'] ? `資源回收：星期${r['回收日(星期幾)'].split(',').map((d) => DAYS[Number(d) % 7]).join('、')}` : ''));
  },
  // 宜蘭：每列是某個星期的一站，同一站同一時間合併成一筆
  async YilanCounty() {
    const rows = await get('https://opendata.ilepb.gov.tw/ILEPB04004?format=json&media=file');
    const by = new Map();
    for (const r of rows) {
      const key = `${r['鄉鎮市']}|${r['路線名稱']}|${r['清運點名稱']}|${r['表定時間']}`;
      const day = 1 << (Number(r['星期']) % 7);
      if (by.has(key)) by.get(key).days |= day; else by.set(key, { r, days: day });
    }
    return [...by.values()].map(({ r, days }) => stop('YilanCounty', `${r['鄉鎮市'].replace('清潔隊', '')} ${r['路線名稱']}`, r['清運點名稱'],
      r['緯度'], r['經度'], r['表定時間'], '', days, '', '', Number(r['站序'])));
  },
  async Kaohsiung() {
    const bodies = await pool(KAOHSIUNG, KCG_PARALLEL, (id) => get(KCG(id)).catch(() => null));
    if (!bodies.some(Boolean)) throw new Error('高雄各區資料都抓不到');
    return bodies.flatMap((b) => (b?.data || []).map((r) => {
      const [s, e] = String(r['停留時間'] || '').split('-');
      return stop('Kaohsiung', `${r['行政區']} ${r['責任區']}責任區 第${r['車次']}車`, r['停留地點'], r['緯度'], r['經度'], s, e, null,
        r['回收日'] ? `資源回收：星期${r['回收日']}` : '');
    }));
  },
};

// 一個縣市的清運點，依路線排好順序（新北有清運序，其他依表定時間）。
// 下載失敗（例如政府網站對國外主機沒有回應）就記下來，30 分鐘內不再重試，畫面直接說抓不到
const RETRY_MS = 30 * 60 * 1000;
const loading = new Set();
const failedAt = new Map();
const cityData = (city) => (Date.now() - (failedAt.get(city) || 0) < RETRY_MS ? Promise.reject(new Error('剛剛抓不到')) : cached(`garbage-index:${city}:${taipeiNow().date}`, 24 * 60 * 60 * 1000, () => {
  const value = daily(`garbage-${city}`, async () => (await SOURCES[city]()).filter(Boolean)).then((stops) => {
    const lines = new Map();
    for (const s of stops) (lines.get(s.line) || lines.set(s.line, []).get(s.line)).push(s);
    for (const list of lines.values()) list.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || toMinutes(a.start) - toMinutes(b.start));
    return { stops, lines };
  });
  loading.add(city);
  value.then(() => failedAt.delete(city), (e) => { failedAt.set(city, Date.now()); console.log(`${city} 垃圾車資料載入失敗：`, e.message); })
    .finally(() => loading.delete(city));
  return value; // 失敗不快取，30 分鐘後再試
}));

// 最多等 ms，逾時回傳 fallback（原本的工作繼續在背景跑完）
const within = (promise, ms, fallback) => Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// 高雄市今天各點的表定與預估到點時間（依垃圾車實際進度推算），全市都有（含沒有路線資料的區）
const kaohsiungToday = () => cached('garbage-kcg-today', 5 * 60 * 1000, async () => (await get(KCG('14fe516d-ac62-4905-9325-70daae7616bd'))).data || []);
const kaohsiungEta = async () => new Map((await kaohsiungToday()).filter((r) => r.estime_s).map((r) => [`${r.area}|${r.caption}`, r.estime_s]));

// ---------- 只有地址的縣市：用查詢地點的里、路名比對 ----------

// 每筆：區、里、地點（地址）、表定時間、星期（位元）
const ADDRESS = {
  // 台中市定時定點垃圾收運地點：g_d1～g_d7 是星期一～日的一般垃圾時間，r_ 是資源回收
  async Taichung() {
    const rows = await get('https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=68d1a87f-7baa-4b50-8408-c36a3a7eda68');
    return rows.map((r) => {
      let days = 0, start = '', end = '';
      for (let k = 1; k <= 7; k++) {
        if (!r[`g_d${k}_time_s`]) continue;
        days |= 1 << (k % 7);
        start ||= r[`g_d${k}_time_s`];
        end ||= r[`g_d${k}_time_e`];
      }
      const recycle = [1, 2, 3, 4, 5, 6, 7].filter((k) => r[`r_d${k}_time_s`]).map((k) => DAYS[k % 7]).join('、');
      return start && {
        area: r.area, village: r.village, name: r.caption, start, end: end !== start ? end : '', days,
        route: `${r.area} ${r.car_licence}`, note: [r.task_type, recycle && `資源回收：星期${recycle}`].filter(Boolean).join('・'),
      };
    }).filter(Boolean);
  },
  // 新竹市垃圾清運路線總表：只有地點文字，沒有區、里
  async Hsinchu() {
    const rows = parseCsv(await get('https://7966.hccg.gov.tw/WEB/_IMP/API/CleanWeb/SummaryCsvForOpenData/City/hcc', 'text'));
    return rows.map((r) => {
      const recycle = String(r['回收日_星期幾'] || '').split(/[，,]/).filter(Boolean).map((d) => DAYS[Number(d) % 7]).join('、');
      return {
        area: '', village: '', name: r['清潔公車停置地點'], start: String(r['預估到達時間']).slice(0, 5), end: String(r['預估離開時間']).slice(0, 5),
        days: null, route: r['清運路線名稱'], note: recycle ? `資源回收：星期${recycle}` : '',
      };
    }).filter((x) => /^\d{1,2}:\d{2}$/.test(x.start));
  },
};
const addressData = (city) => cached(`garbage-addr:${city}:${taipeiNow().date}`, 24 * 60 * 60 * 1000,
  () => daily(`garbage-addr-${city}`, () => ADDRESS[city]()));

// 查詢地點的路名、里、區（OpenStreetMap 反查地址）
const addressOf = (p) => cached(`garbage-rev:${p.lat.toFixed(4)},${p.lng.toFixed(4)}`, 24 * 60 * 60 * 1000, async () => {
  const url = `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({ lat: p.lat, lon: p.lng, format: 'jsonv2', 'accept-language': 'zh-TW', zoom: 18 })}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'transit-map/1.0 (+https://github.com/PoWeiLai/transit-map)' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`地址反查 ${res.status}`);
  const a = (await res.json()).address || {};
  return { road: a.road || '', village: a.neighbourhood || a.quarter || a.village || '', area: a.suburb || a.city_district || a.town || '' };
});

// 路名比對：一段／1段、台／臺 寫法不同
const NUM = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
const normAddr = (s) => String(s).replace(/台/g, '臺').replace(/([一二三四五六七八九])段/g, (_, c) => `${NUM[c]}段`).replace(/\s/g, '');

// 同一個里的點最優先，其次同一條路（同一區）；格式和有座標的地點一樣，但沒有距離
function addressPoints(rows, addr, now, day) {
  const village = addr.village, road = normAddr(addr.road), area = addr.area;
  const sameArea = (r) => !area || !r.area || r.area === area;
  const byVillage = village ? rows.filter((r) => r.village === village && sameArea(r)) : [];
  const byRoad = road ? rows.filter((r) => !byVillage.includes(r) && sameArea(r) && normAddr(r.name).includes(road)) : [];
  const points = new Map();
  for (const [list, approx] of [[byVillage, `同一個里（${village}）`], [byRoad, `同一條路（${addr.road}）`]]) {
    for (const r of list) {
      if (!points.has(r.name)) points.set(r.name, { name: r.name, lat: null, lng: null, distance: null, approx, passes: [] });
      const next = r.when ? { when: r.when, soon: r.soon } : nextPass(r, now, day);
      points.get(r.name).passes.push({
        route: r.route, line: null, start: r.start, end: r.end, days: daysText(r.days), note: r.note,
        when: next.when, soon: next.soon, progress: null,
      });
    }
  }
  return [...points.values()];
}

// ---------- 即時位置 ----------

// 各家時間格式不同：2026/10/26 22:54:44、20261027T005949、2026-10-27T01:15:44
function minutesAgo(text) {
  const d = String(text).replace(/\D/g, '');
  if (d.length < 12) return null;
  const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10) - 8, +d.slice(10, 12), +(d.slice(12, 14) || 0));
  return Math.round((Date.now() - t) / 60000);
}

const LIVE = {
  NewTaipei: async () => (await get('https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=1000'))
    .map((r) => ({ car: r.car, location: r.location, lat: +r.latitude, lng: +r.longitude, time: r.time, line: `NewTaipei:${r.lineid}` })),
  Taichung: async () => (await get('https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=c923ad20-2ec6-43b9-b3ab-54527e99f7bc'))
    .map((r) => ({ car: r.car, location: r.location, lat: +r.Y, lng: +r.X, time: r.time })),
  Tainan: async () => ((await get('https://soa.tainan.gov.tw/Api/Service/Get/2c8a70d5-06f2-4353-9e92-c40d33bcd969')).data || [])
    .map((r) => ({ car: r.car, location: r.location, lat: +r.y, lng: +r.x, time: r.time })),
  Kaohsiung: async () => ((await get(KCG('aaf4ce4b-4ca8-43de-bfaf-6dc97e89cac0'))).data || [])
    .map((r) => ({ car: r.car, location: r.location, lat: +r.y, lng: +r.x, time: r.time })),
};

// 一個縣市正在開的垃圾車（太久沒回報的不算）
const liveTrucks = (city) => cached(`garbage-live:${city}`, LIVE_MS, async () => (await LIVE[city]())
  .map((t) => ({ ...t, ago: minutesAgo(t.time) }))
  .filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng) && t.ago != null && t.ago >= -5 && t.ago <= TRUCK_FRESH_MIN)
  .map((t) => ({ ...t, ago: Math.max(0, t.ago) })));

// ---------- 查詢 ----------

// 下一次經過：有星期資料就找今天（還沒過）或之後最近的一天，沒有就只給表定時間
function nextPass(s, now, day) {
  if (!s.days) return { when: `每次 ${s.start}`, soon: null };
  for (let k = 0; k < 7; k++) {
    const d = (day + k) % 7;
    if (!((s.days >> d) & 1)) continue;
    if (k === 0 && toMinutes(s.start) < now) continue;
    const label = k === 0 ? '今天' : k === 1 ? '明天' : `星期${DAYS[d]}`;
    return { when: `${label} ${s.start}`, soon: k === 0 ? toMinutes(s.start) - now : null };
  }
  return { when: `每次 ${s.start}`, soon: null };
}

const daysText = (bits) => (bits ? `星期${[...DAYS].filter((_, d) => (bits >> d) & 1).join('、')}` : '');

// 垃圾車現在的進度：用即時位置找出它在路線上的哪一站，比表定晚／早多少，推算到 mine 這站的時間
function progressOf(list, truck, mine, now) {
  if (!truck) return null;
  let at = 0;
  list.forEach((s, k) => { if (distance(truck, s) < distance(truck, list[at])) at = k; });
  const late = now - toMinutes(list[at].start); // 正的是比表定晚
  const left = mine - at;
  return {
    at: list[at].name, atIndex: at, left, late,
    eta: left > 0 ? minText(toMinutes(list[mine].start) + late) : null,
    car: truck.car, location: truck.location, ago: truck.ago, lat: truck.lat, lng: truck.lng,
  };
}

// point 附近：固定丟垃圾的地點（清運點），每個點有哪些垃圾車、幾點經過、現在到哪；附近正在開的垃圾車
export async function garbageNear(point) {
  const cities = citiesAt([point]);
  const withStops = cities.filter((c) => SOURCES[c]);
  const withAddr = cities.filter((c) => ADDRESS[c]);
  const withLive = cities.filter((c) => LIVE[c]);
  const [datas, lives, eta] = await Promise.all([
    Promise.all(withStops.map((c) => within(cityData(c).catch(() => false), LOAD_WAIT_MS, null))),
    Promise.all(withLive.map((c) => within(liveTrucks(c).catch(() => []), LIVE_WAIT_MS, []))),
    withStops.includes('Kaohsiung') ? within(kaohsiungEta().catch(() => new Map()), LIVE_WAIT_MS, new Map()) : new Map(),
  ]);
  const trucks = lives.flat();
  const truckOf = new Map(trucks.filter((t) => t.line).map((t) => [t.line, t]));
  const { minutes: now, date } = taipeiNow();
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();

  // 同一個地點（同名、20 公尺內）的各路線合併成一個丟垃圾地點
  const points = [];
  for (const d of datas) {
    if (!d) continue;
    for (const s of d.stops) {
      const dist = distance(point, s);
      if (dist > NEAR_M) continue;
      let p = points.find((x) => x.name === s.name && distance(x, s) < 20);
      if (!p) points.push(p = { name: s.name, lat: s.lat, lng: s.lng, distance: Math.round(dist), passes: [] });
      if (p.passes.some((x) => x.line === s.line && x.start === s.start)) continue;
      const route = d.lines.get(s.line) || [];
      const mine = route.indexOf(s);
      const progress = mine >= 0 ? progressOf(route, truckOf.get(s.line), mine, now) : null;
      const next = nextPass(s, now, day);
      const estimate = s.city === 'Kaohsiung' ? eta.get(`${s.route.split(' ')[0]}|${s.name}`) : null;
      const soonAt = progress?.eta || estimate;
      p.passes.push({
        route: s.route, line: s.line, start: s.start, end: s.end, days: daysText(s.days), note: s.note,
        when: progress?.eta ? `預計 ${progress.eta}（表定 ${s.start}）` : estimate ? `今天預估 ${estimate}（表定 ${s.start}）` : next.when,
        soon: soonAt ? toMinutes(soonAt) - now : next.soon,
        progress,
      });
    }
  }
  // 近的地點在前（最近的幾個）
  points.sort((a, b) => a.distance - b.distance);
  let shown = points.slice(0, MAX_POINTS);

  // 附近沒有有座標的點：台中、新竹市、高雄（今日預估）用地址比對同一個里、同一條路
  const useKcgToday = withStops.includes('Kaohsiung') && !shown.length;
  let addrLoading = false, addrFailed = false;
  if (!shown.length && (withAddr.length || useKcgToday)) {
    const addr = await within(addressOf(point).catch(() => null), LIVE_WAIT_MS, null);
    if (addr && (addr.village || addr.road)) {
      const lists = await Promise.all(withAddr.map((c) => within(addressData(c).catch(() => false), LOAD_WAIT_MS, null)));
      addrLoading = lists.some((l) => l === null);
      addrFailed = lists.some((l) => l === false);
      const rows = lists.filter(Boolean).flat();
      if (useKcgToday) {
        const today = await within(kaohsiungToday().catch(() => []), LIVE_WAIT_MS, []);
        rows.push(...today.filter((r) => r.today_s).map((r) => ({
          area: r.area, village: r.village, name: r.caption, start: r.today_s, end: r.today_e, days: 1 << day,
          route: `${r.area} ${r.car_licence}`, note: r.task || '',
          when: r.estime_s ? `今天預估 ${r.estime_s}（表定 ${r.today_s}）` : `今天 ${r.today_s}`,
          soon: toMinutes(r.estime_s || r.today_s) - now,
        })));
      }
      shown = addressPoints(rows, addr, now, day).slice(0, MAX_POINTS);
    }
  }
  for (const p of shown) p.passes.sort((a, b) => (a.soon ?? 9999) - (b.soon ?? 9999) || toMinutes(a.start) - toMinutes(b.start));
  const next = shown.flatMap((p) => p.passes.map((x) => ({ ...x, name: p.name, distance: p.distance })))
    .filter((x) => x.soon != null && x.soon >= -2).sort((a, b) => a.soon - b.soon)[0] || null;

  const nearTrucks = trucks
    .map((t) => ({ ...t, distance: Math.round(distance(point, t)) }))
    .filter((t) => t.distance <= TRUCK_NEAR_M)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5)
    .map(({ car, location, distance: d, ago, lat, lng }) => ({ car, location, distance: d, ago, lat, lng }));

  return {
    points: shown,
    next,
    trucks: nearTrucks,
    covered: withStops.length > 0 || withAddr.length > 0 || withLive.length > 0,
    loading: datas.some((d) => d === null) || withStops.some((c) => loading.has(c)) || addrLoading,
    failed: withStops.some((c, k) => datas[k] === false) || addrFailed, // 有縣市的資料抓不到
  };
}

// 一條路線的所有清運點（依順序）與垃圾車現在的位置
export async function garbageRoute(line) {
  const city = line.split(':')[0];
  if (!SOURCES[city]) return null;
  const [d, trucks] = await Promise.all([
    within(cityData(city).catch(() => null), LOAD_WAIT_MS, null),
    LIVE[city] ? within(liveTrucks(city).catch(() => []), LIVE_WAIT_MS, []) : [],
  ]);
  const list = d?.lines.get(line);
  if (!list) return null;
  const truck = trucks.find((t) => t.line === line);
  return {
    route: list[0].route,
    stops: list.map(({ name, lat, lng, start, end }) => ({ name, lat, lng, start, end })),
    progress: progressOf(list, truck, list.length - 1, taipeiNow().minutes),
  };
}

// 啟動時在背景先下載雙北（查詢最多），不等它
export const warmUp = () => Promise.all(['NewTaipei', 'Taipei'].map((c) => cityData(c).then((d) => d.stops)))
  .then((lists) => lists.flat());
