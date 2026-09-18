/* ==========================================================================
   共享 UI 工具 — DOM 构造、格式化、对话框
   ========================================================================== */

/* -------------------------------------------------------------------------
   DOM 构造
   用一个小 hyperscript 代替 innerHTML 拼接。原因有两个：
   一是所有数据都来自用户输入，拼 HTML 容易出转义问题；
   二是这样写的事件绑定更直观。
   ------------------------------------------------------------------------- */

/**
 * el('div', { class:'card', onclick: fn }, child1, child2, ...)
 * 子元素可以是节点、字符串、数字，null/undefined/false 会被跳过。
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);

  for (const [key, val] of Object.entries(props || {})) {
    if (val == null || val === false) continue;

    if (key === 'class') node.className = val;
    else if (key === 'style' && typeof val === 'object') Object.assign(node.style, val);
    else if (key === 'dataset') Object.assign(node.dataset, val);
    else if (key.startsWith('on') && typeof val === 'function') {
      node.addEventListener(key.slice(2), val);
    } else if (key === 'text') node.textContent = String(val);
    else if (key === 'html') node.innerHTML = val;
    else if (key in node && key !== 'list' && key !== 'type') node[key] = val;
    else node.setAttribute(key, val === true ? '' : String(val));
  }

  append(node, children);
  return node;
}

function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** 清空一个容器 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 用新内容替换容器里的全部内容 */
export function replace(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/* -------------------------------------------------------------------------
   数字与日期格式化
   ------------------------------------------------------------------------- */

/**
 * 去掉多余的小数尾零：3.20 -> 3.2，6.0 -> 6
 *
 * 注意末尾那个 if：只有确实存在小数点时才允许削零。
 * 少了这个判断，"10" 会被削成 "1"、"130" 削成 "13"、
 * "80" 削成 "8"——血糖 10.0 显示成 1、血压 130 显示成 13，
 * 对糖尿病人来说是会直接误导判断的错误，而且隐蔽得很难发现。
 */
export function trim(value, decimals = 1) {
  if (value == null) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  let s = num.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s;
}

/**
 * 配速 = 用时 ÷ 距离，显示成 12'03" 这种跑者习惯的写法。
 * 距离为 0 或缺失时返回 null，由调用方决定怎么显示。
 */
export function pace(distanceKm, durationMin) {
  if (!distanceKm || !durationMin || distanceKm <= 0 || durationMin <= 0) return null;
  const minPerKm = durationMin / distanceKm;
  if (!Number.isFinite(minPerKm) || minPerKm > 600) return null;
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  // 秒数四舍五入到 60 时向前进一分钟，否则会出现 12'60"
  if (s === 60) return `${m + 1}'00"`;
  return `${m}'${String(s).padStart(2, '0')}"`;
}

/** 平均速度 km/h */
export function speed(distanceKm, durationMin) {
  if (!distanceKm || !durationMin) return null;
  const v = distanceKm / (durationMin / 60);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 时间戳 -> "08:30" */
export function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 时间戳 -> "08:30:15" 这种带秒的（很少用） */
export function clockSec(ts) {
  return `${clock(ts)}:${String(new Date(ts).getSeconds()).padStart(2, '0')}`;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** "2026-09-18" -> "9月18日" */
export function dateCN(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}月${d}日`;
}

/** "2026-09-18" -> "9月18日 星期四" */
export function dateFullCN(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日 ${wd}`;
}

/** 时间戳 -> "2026年9月18日" */
export function dateYearCN(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 相对日期：今天 / 昨天 / 9月18日 */
export function relDay(dateStr, todayStr) {
  if (dateStr === todayStr) return '今天';

  const [y, m, d] = dateStr.split('-').map(Number);
  const that = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = Math.round((now - that) / 86400000);
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  return dateCN(dateStr);
}

/* -------------------------------------------------------------------------
   对话框 —— 都用 Promise 包一层，调用处可以 await
   ------------------------------------------------------------------------- */

const dialogWrap = () => document.getElementById('dialog');
const dialogText = () => document.getElementById('dialogText');

/**
 * 大白话的确认框。
 * 措辞刻意保持完整句式，不用"确认/取消"这种需要思考的短标签。
 */
export function confirmDialog(message, { yes = '确定', no = '取消' } = {}) {
  return new Promise((resolve) => {
    const wrap = dialogWrap();
    replace(dialogText(), message);

    const btnYes = document.getElementById('dialogYes');
    const btnNo = document.getElementById('dialogNo');
    replace(btnYes, yes);
    replace(btnNo, no);
    wrap.hidden = false;

    const done = (result) => {
      wrap.hidden = true;
      btnYes.removeEventListener('click', onYes);
      btnNo.removeEventListener('click', onNo);
      wrap.removeEventListener('click', onBackdrop);
      resolve(result);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    // 点遮罩等于取消，防止父母误触后卡在一个无法关闭的框里
    const onBackdrop = (e) => { if (e.target === wrap) done(false); };

    btnYes.addEventListener('click', onYes);
    btnNo.addEventListener('click', onNo);
    wrap.addEventListener('click', onBackdrop);
  });
}

/** 只有"知道了"一个按钮的提示框 */
export function alertDialog(message) {
  return new Promise((resolve) => {
    const wrap = dialogWrap();
    replace(dialogText(), message);

    const btnYes = document.getElementById('dialogYes');
    const btnNo = document.getElementById('dialogNo');
    replace(btnYes, '知道了');
    btnNo.hidden = true;
    wrap.hidden = false;

    const done = () => {
      wrap.hidden = true;
      btnNo.hidden = false;
      btnYes.removeEventListener('click', done);
      wrap.removeEventListener('click', onBackdrop);
      resolve();
    };
    const onBackdrop = (e) => { if (e.target === wrap) done(); };

    btnYes.addEventListener('click', done);
    wrap.addEventListener('click', onBackdrop);
  });
}

/**
 * 保存成功的满屏反馈。
 * 不用 toast —— iOS 上 toast 会被键盘挡住，而且父母很可能看不到那几秒。
 * 这里用一张占满屏幕的白底大对勾，看得见、也给了"可以松手了"的明确信号。
 */
let savedTimer = null;
export function showSaved(text = '已保存') {
  const node = document.getElementById('saved');
  replace(node.querySelector('.saved-text'), text);
  node.hidden = false;

  // 重启一次动画
  const path = node.querySelector('path');
  path.style.animation = 'none';
  void path.offsetWidth;   // 强制重排，否则动画不会重播
  path.style.animation = '';

  clearTimeout(savedTimer);
  return new Promise((resolve) => {
    savedTimer = setTimeout(() => {
      node.hidden = true;
      resolve();
    }, 850);
  });
}

/** 停顿一下 */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
