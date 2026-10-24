// 縣市的概略經緯度範圍（TDX 的 City 名稱），用來判斷一個點在哪些縣市、要載入哪些縣市的資料。
// 範圍是概略的，邊界附近會同時算進相鄰縣市
export const CITIES = [
  // [City, 南, 北, 西, 東]
  ['Taipei', 24.96, 25.21, 121.45, 121.67],
  ['NewTaipei', 24.67, 25.30, 121.28, 122.01],
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

// margin 約 1 公里
export const inBox = (p, [s, n, w, e], margin = 0.01) =>
  p.lat >= s - margin && p.lat <= n + margin && p.lng >= w - margin && p.lng <= e + margin;

// 這些點落在哪些縣市（可排除某些縣市，例如雙北公車另有資料來源）
export const citiesAt = (points, exclude = []) =>
  CITIES.filter(([name, ...box]) => !exclude.includes(name) && points.some((p) => inBox(p, box))).map(([name]) => name);
