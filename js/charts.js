/* ==========================================================================
   图表 —— 手写 SVG，不依赖任何库（必须能离线跑）

   为老年用户做的几个关键取舍：

   1. viewBox 的宽度直接用容器实测像素宽度，让 1 个用户单位 = 1 个 CSS 像素。
      如果用固定 viewBox 再缩放，小屏手机上字号会被压缩到读不出来的程度。
   2. 不做十字准星那种需要精确点击的交互，改成"点哪里都行、取最近的点"
      再在图表上方用大字显示读数。精确点击对老人来说太难命中。
   3. 每张图上方都有一行大字结论。父母要的是"最近7天平均6.8，最低3.5偏低"
      这句话，不是自己去读曲线。
   4. 图下方的记录列表就是无障碍要求里的"表格视图"，
      它同时也解决了"只能靠交互才能读到数值"的问题。

   配色取自经过校验的分类色板（在白底上通过了色盲分离度和对比度检查）：
   单序列一律用蓝色，只有血压图需要区分收缩压/舒张压时才引入橙色。
   ========================================================================== */

const COLOR = {
  series1: '#2a78d6',   // 蓝：主数据
  series2: '#eb6834',   // 橙：第二条线（舒张压）
  band: '#1baf7a',      // 目标区间底色（仅作背景，不承担识别功能）
  hypo: '#d03b3b',      // 低血糖警戒
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  ink: '#0b0b0b',
  muted: '#6b757a',
};

const FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

/* -------------------------------------------------------------------------
   刻度
   ------------------------------------------------------------------------- */

/** 生成好看的刻度值（步长取 1/2/5 × 10^n） */
function niceTicks(min, max, target = 4) {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [min];

  const rawStep = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;

  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/** 折线在数据缺口处要断开，否则会凭空画出一段并不存在的趋势 */
function splitByGap(points, gapMs) {
  if (!gapMs || points.length < 2) return [points];
  const runs = [];
  let run = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].x - points[i - 1].x > gapMs) {
      runs.push(run);
      run = [];
    }
    run.push(points[i]);
  }
  runs.push(run);
  return runs.filter((r) => r.length > 0);
}

/* -------------------------------------------------------------------------
   主渲染函数
   ------------------------------------------------------------------------- */

/**
 * 在 host 里画一张图。
 * spec 会挂在 host 上，容器宽度变化（如横竖屏切换）时自动重画。
 */
export function renderChart(host, spec) {
  host._chartSpec = spec;
  paint(host, spec);

  if (!host._chartObserver && typeof ResizeObserver !== 'undefined') {
    let lastWidth = host.clientWidth;
    // 宽度变了才重画。屏幕上滚动时地址栏收起也会触发 resize，
    // 不判断的话图表会不停重绘。
    host._chartObserver = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (Math.abs(w - lastWidth) < 8) return;
      lastWidth = w;
      if (host._chartSpec) paint(host, host._chartSpec);
    });
    host._chartObserver.observe(host);
  }
}

function paint(host, spec) {
  const W = Math.max(240, Math.round(host.clientWidth || 320));
  const H = spec.height || 190;
  const P = { t: 14, r: 14, b: 30, l: 40, ...(spec.padding || {}) };

  const plotW = W - P.l - P.r;
  const plotH = H - P.t - P.b;

  host.textContent = '';

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('role', 'img');
  if (spec.label) svg.setAttribute('aria-label', spec.label);
  svg.style.display = 'block';
  svg.style.touchAction = 'manipulation';

  const add = (tag, attrs) => {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) n.setAttribute(k, String(v));
    }
    svg.appendChild(n);
    return n;
  };
  // halo=true 给文字加一圈白色描边。目标区间和参考线的标签是画在绘图区
  // 内部的，数据点和连线会从它们身上压过去——实测 90 天视图里
  // "空腹目标"就被数据点盖得看不清了。
  const text = (x, y, str, {
    size = 13, fill = COLOR.muted, anchor = 'middle', weight = 400, halo = false,
  } = {}) => {
    const t = add('text', {
      x, y, 'text-anchor': anchor, fill,
      'font-size': size, 'font-family': FONT, 'font-weight': weight,
      stroke: halo ? '#fff' : null,
      'stroke-width': halo ? 3.5 : null,
      'stroke-linejoin': halo ? 'round' : null,
      'paint-order': halo ? 'stroke' : null,
    });
    t.textContent = str;
    return t;
  };

  // ---- 空状态 ----
  // 柱状图走的是 spec.bars，没有 spec.series。
  // 这里必须分开判断，否则柱状图的点数恒为 0，
  // 会直接掉进空状态分支返回——整张图画不出来，而且不报任何错。
  const totalPoints = spec.type === 'bar'
    ? (spec.bars || []).length
    : (spec.series || []).reduce((n, s) => n + s.points.length, 0);
  if (totalPoints === 0) {
    text(W / 2, H / 2, spec.emptyText || '这段时间还没有记录', { size: 15, anchor: 'middle' });
    host.appendChild(svg);
    return;
  }

  // ---- 坐标映射 ----
  // 柱状图是按天分桶、用下标定位的，没有时间轴，所以 xDomain 是缺的。
  // 这里给个退路：sx() 在柱状图里不会被调用，但解构 undefined 会直接抛错，
  // 整张图连柱子都画不出来。
  const [x0, x1] = spec.xDomain || [0, (spec.bars || []).length || 1];
  const [y0, y1] = spec.yDomain;
  const sx = (v) => P.l + ((v - x0) / (x1 - x0 || 1)) * plotW;
  const sy = (v) => P.t + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
  // 超出 Y 轴范围的点贴边画，并记下来，避免一个极端值把整张图压扁
  const clampY = (v) => Math.min(Math.max(v, y0), y1);

  // ---- 目标区间底色 ----
  for (const b of spec.bands || []) {
    const top = sy(clampY(Math.min(b.y1, y1)));
    const bot = sy(clampY(Math.max(b.y0, y0)));
    if (bot - top <= 0) continue;
    add('rect', {
      x: P.l, y: top, width: plotW, height: bot - top,
      fill: b.fill || COLOR.band, 'fill-opacity': b.opacity ?? 0.13,
    });
    if (b.label) {
      text(P.l + plotW - 4, top + 14, b.label, { size: 12, anchor: 'end', fill: '#3f7a63', halo: true });
    }
  }

  // ---- 横向参考线 ----
  for (const line of spec.refLines || []) {
    const y = sy(clampY(line.y));
    if (line.y < y0 || line.y > y1) continue;
    add('line', {
      x1: P.l, y1: y, x2: P.l + plotW, y2: y,
      stroke: line.dash ? COLOR.hypo : COLOR.axis,
      'stroke-width': 1.5,
      'stroke-dasharray': line.dash ? '6 5' : null,
    });
    if (line.label) {
      text(P.l + 4, y - 5, line.label, {
        size: 12, anchor: 'start', weight: 600, halo: true,
        fill: line.dash ? COLOR.hypo : COLOR.muted,
      });
    }
  }

  // ---- 网格线 ----
  const yTicks = spec.yTicks || niceTicks(y0, y1, spec.yTickCount || 4);
  for (const t of yTicks) {
    if (t < y0 || t > y1) continue;
    const y = sy(t);
    add('line', { x1: P.l, y1: y, x2: P.l + plotW, y2: y, stroke: COLOR.grid, 'stroke-width': 1 });
    text(P.l - 8, y + 4, spec.yFormat ? spec.yFormat(t) : String(t), { size: 13, anchor: 'end' });
  }

  // ---- 数据 ----
  const allPts = [];

  if (spec.type === 'bar') {
    // 柱状图：柱子之间留 2px 底色缝，顶端 4px 圆角
    const n = spec.bars.length;
    const slot = plotW / n;
    const bw = Math.max(2, slot - 2);
    for (const b of spec.bars) {
      const h = Math.max(b.y > 0 ? 2 : 0, P.t + plotH - sy(clampY(b.y)));
      const x = P.l + b.i * slot + (slot - bw) / 2;
      add('rect', {
        x, y: P.t + plotH - h, width: bw, height: h,
        fill: b.color || COLOR.series1, rx: Math.min(4, bw / 2),
      });
    }
  } else {
    for (const s of spec.series || []) {
      const pts = s.points;
      allPts.push(...pts);

      for (const run of splitByGap(pts, spec.breakGapMs)) {
        if (run.length === 1) continue;
        const d = run.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(clampY(p.y)).toFixed(1)}`).join(' ');
        add('path', {
          d, fill: 'none', stroke: s.color,
          'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        });
      }

      // 点。点多的时候缩小半径，否则 90 天视图会糊成一片
      const r = pts.length > 60 ? 2 : pts.length > 25 ? 3 : 4;
      for (const p of pts) {
        const isFlag = s.flag && s.flag(p);
        add('circle', {
          cx: sx(p.x), cy: sy(clampY(p.y)),
          r: isFlag ? Math.max(r, 5) : r,
          fill: isFlag ? COLOR.hypo : s.color,
          stroke: '#fff', 'stroke-width': 1.5,
        });
      }
    }
  }

  // ---- X 轴 ----
  add('line', {
    x1: P.l, y1: P.t + plotH, x2: P.l + plotW, y2: P.t + plotH,
    stroke: COLOR.axis, 'stroke-width': 1,
  });
  for (const t of spec.xTicks || []) {
    const x = spec.type === 'bar' ? P.l + (t.i + 0.5) * (plotW / spec.bars.length) : sx(t.x);
    text(x, H - 9, t.label, { size: 13 });
  }

  host.appendChild(svg);

  // ---- 点选读数 ----
  // 不做十字准星。老人很难精确点中一个 4px 的点，
  // 所以改成点图内任意位置都取最近的点，在上方用大字显示。
  if (spec.readout && allPts.length) {
    const pick = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const vx = ((clientX - rect.left) / rect.width) * W;
      let best = allPts[0];
      let bestD = Infinity;
      for (const p of allPts) {
        const d = Math.abs(sx(p.x) - vx);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    };
    const handler = (ev) => {
      const touch = ev.touches?.[0] || ev.changedTouches?.[0] || ev;
      const p = pick(touch.clientX);
      spec.readout(p);
    };
    svg.addEventListener('click', handler);
    svg.addEventListener('touchstart', handler, { passive: true });
  }
}

/* -------------------------------------------------------------------------
   域计算
   ------------------------------------------------------------------------- */

/** 从一组值算出 Y 轴范围，并把极端值挡在边界上而不是让它压扁整张图 */
export function yDomainFor(values, { min, max, pad = 0.1, floor, ceil } = {}) {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) { lo -= 1; hi += 1; }

  const span = hi - lo;
  lo -= span * pad;
  hi += span * pad;

  if (floor != null) lo = Math.max(lo, floor);
  if (ceil != null) hi = Math.min(hi, ceil);
  if (min != null) lo = Math.min(lo, min);
  if (max != null) hi = Math.max(hi, max);

  return [Number(lo.toFixed(2)), Number(hi.toFixed(2))];
}

export { COLOR, niceTicks };
