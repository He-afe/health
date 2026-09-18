/* ==========================================================================
   历史页 —— 趋势图 + 记录列表

   每张图上方都有一句大字结论。这不是装饰：父母要的是
   "最近7天平均 6.8，最低 3.5 偏低"这句话本身，
   让他们自己去读一条 30 个点的曲线是不现实的。
   曲线负责呈现形状，结论负责给出意思。

   记录列表同时充当无障碍要求里的"表格视图"，
   保证任何数值都有不依赖图形的读取路径。
   ========================================================================== */

import { TYPES, dateKey, dayStart, dayEnd } from './db.js';
import { el, replace, trim, dateCN } from './ui.js';
import { renderChart, yDomainFor, COLOR } from './charts.js';
import { recordRow, classifyBP } from './record.js';

/* -------------------------------------------------------------------------
   小工具
   ------------------------------------------------------------------------- */

/** 最近 n 天的日期字符串，从早到晚 */
export function recentDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(dateKey(d.getTime()));
  }
  return out;
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/** 生成时间轴刻度，按天数抽稀，避免标签叠在一起 */
function timeTicks(t0, t1, days) {
  const step = days <= 8 ? 1 : days <= 31 ? 5 : 15;
  const ticks = [];
  const d = new Date(t0);
  d.setHours(12, 0, 0, 0);

  let i = 0;
  for (let t = d.getTime(); t <= t1; t += 86400000, i++) {
    if (i % step !== 0) continue;
    const dd = new Date(t);
    ticks.push({ x: t, label: `${dd.getMonth() + 1}/${dd.getDate()}` });
  }
  return ticks;
}

/** 每天的 [起, 止) 时间戳，给柱状图分桶 */
function dayRanges(days) {
  const list = recentDays(days);
  return list.map((d) => ({ date: d, t0: dayStart(d), t1: dayEnd(d) }));
}

function legend(items) {
  return el('div', { class: 'legend' }, items.map((it) =>
    el('span', { class: 'legend-item' },
      el('span', { class: 'legend-swatch', style: { background: it.color } }),
      it.label,
    )));
}

/**
 * 统一的图表卡片：标题 + 大字结论 + 图形 + 说明。
 * 点选读数也做在这里——点图里任意位置都会取最近的点，
 * 用大字显示在标题下方，老人不用去精确点中那个小圆点。
 */
function chartCard({ title, summary, summaryLevel, note, spec, legendItems }) {
  const readout = el('div', { class: 'chart-readout', hidden: true });

  const host = el('div', { class: 'chart-host' });
  spec.readout = (p) => {
    readout.hidden = false;
    replace(readout, p.readoutText);
  };

  const card = el('div', { class: 'card chart-card' },
    el('div', { class: 'card-head' },
      el('h3', { class: 'card-title', text: title }),
    ),
    summary ? el('p', { class: `chart-summary ${summaryLevel ? 'flag-' + summaryLevel : ''}`, text: summary }) : null,
    legendItems && legendItems.length > 1 ? legend(legendItems) : null,
    readout,
    host,
    note ? el('p', { class: 'chart-note', text: note }) : null,
  );

  // 必须挂到 DOM 之后才能量到宽度
  requestAnimationFrame(() => renderChart(host, spec));
  return card;
}

/* -------------------------------------------------------------------------
   各张图
   ------------------------------------------------------------------------- */

function glucoseCard(records, days, targets) {
  const pts = records
    .filter((r) => r.type === TYPES.GLUCOSE && Number.isFinite(r.value))
    .map((r) => ({ x: r.timestamp, y: r.value, rec: r }))
    .sort((a, b) => a.x - b.x);

  const hypo = pts.filter((p) => p.y < targets.glucoseHypo);
  const avg = mean(pts.map((p) => p.y));

  const summary = pts.length
    ? `平均 ${trim(avg, 1)}，最高 ${trim(Math.max(...pts.map((p) => p.y)), 1)}，`
      + `最低 ${trim(Math.min(...pts.map((p) => p.y)), 1)}`
      + (hypo.length ? `，有 ${hypo.length} 次低于 ${trim(targets.glucoseHypo, 1)}` : '')
    : `最近 ${days} 天还没有血糖记录`;

  const over = pts.filter((p) => p.y > 18);
  const note = over.length
    ? `有 ${over.length} 个数值超过 18，图上贴在顶端显示，实际最高 ${trim(Math.max(...over.map((p) => p.y)), 1)}，准确数值见下方记录。`
    : '绿色区域是空腹目标范围，红色虚线是低血糖警戒线。低于警戒线的点标成了红色。';

  const t0 = dayStart(recentDays(days)[0]);
  const t1 = Date.now();

  return chartCard({
    title: `血糖（最近 ${days} 天）`,
    summary,
    summaryLevel: hypo.length ? 'danger' : null,
    note,
    spec: {
      height: 210,
      label: '血糖趋势图',
      xDomain: [t0, t1],
      yDomain: yDomainFor(pts.map((p) => p.y), { floor: 2.5, ceil: 18, pad: 0.08 }),
      bands: [{ y0: targets.glucoseFastingLow, y1: targets.glucoseFastingHigh, label: '空腹目标' }],
      refLines: [
        { y: targets.glucosePostHigh, label: `餐后上限 ${trim(targets.glucosePostHigh, 1)}`, dash: true },
        { y: targets.glucoseHypo, label: `低血糖 ${trim(targets.glucoseHypo, 1)}`, dash: true },
      ],
      series: [{
        points: pts,
        color: COLOR.series1,
        flag: (p) => p.y < targets.glucoseHypo,
      }],
      // 超过 12 小时没有测量就不连线。跨夜连一条直线等于凭空造出一段
      // 根本没测过的血糖变化。
      breakGapMs: 12 * 3600 * 1000,
      xTicks: timeTicks(t0, t1, days),
      yFormat: (v) => trim(v, 0),
      emptyText: '这段时间还没有血糖记录',
    },
  });
}

function bpCard(records, days, targets) {
  const all = records
    .filter((r) => r.type === TYPES.BP && Number.isFinite(r.systolic))
    .sort((a, b) => a.timestamp - b.timestamp);

  const sys = all.map((r) => ({ x: r.timestamp, y: r.systolic, rec: r }));
  const dia = all.map((r) => ({ x: r.timestamp, y: r.diastolic, rec: r }));
  const high = all.filter((r) => classifyBP(r.systolic, r.diastolic, targets).level === 'high');

  const summary = all.length
    ? `平均 ${trim(mean(sys.map((p) => p.y)), 0)}/${trim(mean(dia.map((p) => p.y)), 0)}，`
      + `最高 ${trim(Math.max(...sys.map((p) => p.y)), 0)}/${trim(Math.max(...dia.map((p) => p.y)), 0)}`
      // 措辞用"高于目标"而不是"偏高"：classifyBP 里同时包含了
      // "略高于目标"和"偏高"两种，统称"偏高"会夸大严重程度
      + (high.length ? `，有 ${high.length} 次高于目标` : '')
    : `最近 ${days} 天还没有血压记录`;

  const t0 = dayStart(recentDays(days)[0]);
  const t1 = Date.now();
  const values = [...sys.map((p) => p.y), ...dia.map((p) => p.y)];

  return chartCard({
    title: `血压（最近 ${days} 天）`,
    summary,
    summaryLevel: high.length ? 'warn' : null,
    note: '这里对照的是家庭自测血压标准（≥135/85 提示偏高）。家庭自测通常比诊室测的低，两者标准不同。',
    legendItems: [
      { color: COLOR.series1, label: '高压（收缩压）' },
      { color: COLOR.series2, label: '低压（舒张压）' },
    ],
    spec: {
      height: 210,
      label: '血压趋势图',
      xDomain: [t0, t1],
      yDomain: yDomainFor(values, { floor: 40, ceil: 200, pad: 0.1 }),
      refLines: [
        { y: targets.bpSystolicHigh, label: `目标 ${trim(targets.bpSystolicHigh, 0)}` },
        { y: targets.bpDiastolicHigh, label: `目标 ${trim(targets.bpDiastolicHigh, 0)}` },
      ],
      series: [
        { points: sys, color: COLOR.series1 },
        { points: dia, color: COLOR.series2 },
      ],
      breakGapMs: 14 * 24 * 3600 * 1000,   // 血压不必按天断线，隔几天没测仍可看趋势
      xTicks: timeTicks(t0, t1, days),
      yFormat: (v) => trim(v, 0),
      emptyText: '这段时间还没有血压记录',
      readout: null,
    },
  });
}

function walkCard(records, days) {
  const walks = records.filter((r) => r.type === TYPES.EXERCISE && Number.isFinite(r.distanceKm));
  const buckets = dayRanges(days);

  // 90 天按天画的话每根柱子不到 4px，什么也看不出来，改成按周合计
  const byWeek = days > 45;
  let bars;
  let granularityNote = '';

  if (byWeek) {
    const weeks = [];
    for (let i = 0; i < buckets.length; i += 7) {
      const chunk = buckets.slice(i, i + 7);
      weeks.push({
        t0: chunk[0].t0,
        t1: chunk[chunk.length - 1].t1,
        label: dateCN(chunk[0].date),
      });
    }
    bars = weeks.map((w, i) => ({
      i,
      y: walks.filter((r) => r.timestamp >= w.t0 && r.timestamp <= w.t1)
        .reduce((s, r) => s + r.distanceKm, 0),
      label: w.label,
    }));
    granularityNote = '柱子按周合计。';
  } else {
    bars = buckets.map((b, i) => ({
      i,
      y: walks.filter((r) => r.timestamp >= b.t0 && r.timestamp <= b.t1)
        .reduce((s, r) => s + r.distanceKm, 0),
      label: dateCN(b.date),
    }));
  }

  const total = walks.reduce((s, r) => s + r.distanceKm, 0);
  const totalMin = walks.reduce((s, r) => s + (r.durationMin || 0), 0);
  const activeDays = bars.filter((b) => b.y > 0).length;
  const unitDays = byWeek ? bars.length : days;

  const summary = walks.length
    ? `共走 ${trim(total, 1)} 公里，平均每${byWeek ? '周' : '天'} `
      + `${trim(total / unitDays, 1)} 公里，累计 ${trim(totalMin, 0)} 分钟`
    : `最近 ${days} 天还没有走路记录`;

  // X 轴标签按柱子数量抽稀
  const step = bars.length <= 8 ? 1 : bars.length <= 16 ? 2 : Math.ceil(bars.length / 8);
  const xTicks = bars.filter((_, i) => i % step === 0).map((b) => ({ i: b.i, label: b.label }));

  return chartCard({
    // 按周合计时标题也要跟着改成"每周"，否则标题说每天、结论说每周，对不上
    title: `${byWeek ? '每周' : '每天'}走的距离（最近 ${days} 天）`,
    summary,
    note: `${granularityNote}最近 ${days} 天里有 ${activeDays} ${byWeek ? '周' : '天'}记录了走路。`,
    spec: {
      type: 'bar',
      height: 190,
      label: '每天行走距离柱状图',
      bars,
      yDomain: [0, Math.max(1, Math.max(...bars.map((b) => b.y)) * 1.18)],
      yFormat: (v) => trim(v, 0),
      xTicks,
      emptyText: '这段时间还没有走路记录',
      readout: null,
    },
  });
}

function weightCard(records, days, targets) {
  const pts = records
    .filter((r) => r.type === TYPES.WEIGHT && Number.isFinite(r.value))
    .map((r) => ({ x: r.timestamp, y: r.value, rec: r }))
    .sort((a, b) => a.x - b.x);

  // 体重没有普适的目标值，给一个反而是在编造。只显示变化量。
  let summary = `最近 ${days} 天还没有体重记录`;
  if (pts.length === 1) {
    summary = `最近一次 ${trim(pts[0].y, 1)} 公斤`;
  } else if (pts.length > 1) {
    const first = pts[0].y;
    const last = pts[pts.length - 1].y;
    const delta = last - first;
    const dir = Math.abs(delta) < 0.05 ? '基本没变'
      : delta > 0 ? `增加了 ${trim(Math.abs(delta), 1)} 公斤`
      : `减少了 ${trim(Math.abs(delta), 1)} 公斤`;
    summary = `最近一次 ${trim(last, 1)} 公斤，比 ${days} 天前${dir}`;
  }

  const t0 = dayStart(recentDays(days)[0]);
  const t1 = Date.now();

  return chartCard({
    title: `体重（最近 ${days} 天）`,
    summary,
    note: '体重没有通用的目标值，这里只显示变化趋势，不设参考线。',
    spec: {
      height: 180,
      label: '体重趋势图',
      xDomain: [t0, t1],
      // 体重的变化幅度通常很小，按数据自身范围收紧 Y 轴，
      // 否则几公斤的波动会被画成一条毫无信息的直线
      yDomain: yDomainFor(pts.map((p) => p.y), { pad: 0.25 }),
      series: [{ points: pts, color: COLOR.series1, width: 2.5 }],
      breakGapMs: 35 * 24 * 3600 * 1000,
      xTicks: timeTicks(t0, t1, days),
      yFormat: (v) => trim(v, 0),
      emptyText: '这段时间还没有体重记录',
      readout: null,
    },
  });
}

/* -------------------------------------------------------------------------
   入口
   ------------------------------------------------------------------------- */

export function renderHistory(host, { records, days, targets, todayStr, onEdit }) {
  const charts = [];
  charts.push(glucoseCard(records, days, targets));
  charts.push(bpCard(records, days, targets));
  charts.push(walkCard(records, days));
  charts.push(weightCard(records, days, targets));

  // 记录列表：按时间倒序，最新的在最上面
  const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
  const list = sorted.length
    ? sorted.map((r) => recordRow(r, targets, { todayStr, onOpen: onEdit }))
    : [el('p', { class: 'empty-note', text: `最近 ${days} 天还没有任何记录。` })];

  replace(host,
    ...charts,
    el('h2', { class: 'section-title', text: `这段时间的记录（${sorted.length} 条）` }),
    ...list,
  );
}
