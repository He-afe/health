/* ==========================================================================
   健康日记 —— 主程序

   启动顺序是有讲究的：先把数据层和快照检查跑完，再渲染界面。
   因为"记录是不是丢了"这件事必须比任何内容都先出现在屏幕上。
   ========================================================================== */

import {
  TYPES, saveRecord, deleteRecord, listByDateRange, latestOfType,
  getSettings, setSetting, dateKey,
} from './db.js';
import {
  el, replace, showSaved, confirmDialog, alertDialog,
  dateFullCN, dateCN, trim, pace, clock,
} from './ui.js';
import { openForm } from './forms.js';
import { renderHistory } from './history.js';
import { renderSettings, isInstalled } from './settings.js';
import {
  prepareExport, invalidateExport, writeSnapshot, detectDataLoss,
  restoreFromSnapshot, shareNow, exportInfo,
} from './export.js';

/* -------------------------------------------------------------------------
   状态
   ------------------------------------------------------------------------- */

const state = {
  view: 'today',
  days: 7,
  settings: null,
  lossCheck: null,
};

let lastSnapshotAt = 0;

const TODAY = () => dateKey();

/* -------------------------------------------------------------------------
   数据操作
   ------------------------------------------------------------------------- */

/**
 * 打开录入表单并处理结果。
 * 删除走的是同一个出口——表单返回一个 { __delete } 标记表示用户选了删除。
 */
async function openRecordForm(type, record = null, prefill = {}) {
  const result = await openForm(type, record, prefill);
  if (!result) return;

  const isDelete = !!result.__delete;
  if (isDelete) await deleteRecord(result.id);
  else await saveRecord(result);

  // 已经预取好的导出数据现在过期了，先作废再重新备好
  invalidateExport();

  await showSaved(isDelete ? '已删除' : '已保存');
  await refresh();
  void prepareExport();
  void maybeSnapshot();
}

/** 定期留一份快照，防止应用自身的 bug 或误操作把数据弄没 */
async function maybeSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - lastSnapshotAt < 3600 * 1000) return;
  lastSnapshotAt = now;
  await writeSnapshot();
}

/* -------------------------------------------------------------------------
   今日页
   ------------------------------------------------------------------------- */

function card(title, subtitle, body, onAdd, addLabel = '记一笔') {
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { class: 'card-title', text: title }),
      subtitle ? el('span', { class: 'card-when', text: subtitle }) : null,
    ),
    body,
    el('div', { class: 'card-actions' },
      el('button', { type: 'button', class: 'btn-secondary', text: addLabel, onclick: onAdd }),
    ),
  );
}

function metric(num, unit, label) {
  return el('span', { class: 'metric' },
    el('span', { class: 'metric-num', text: num }),
    unit ? el('span', { class: 'metric-unit', text: unit }) : null,
    label ? el('span', { class: 'metric-label', text: label }) : null,
  );
}

const emptyNote = (text) => el('p', { class: 'empty-note', text });

const sum = (arr, pick) => arr.reduce((s, x) => s + (Number(pick(x)) || 0), 0);

function todayCards(records, lastHba1c) {
  const cards = [];

  /* ---- 运动 ---- */
  const ex = records.filter((r) => r.type === TYPES.EXERCISE);
  const dist = sum(ex, (r) => r.distanceKm);
  const dur = sum(ex, (r) => r.durationMin);
  const cal = sum(ex, (r) => r.calories);
  const hrs = ex.map((r) => r.avgHr).filter(Number.isFinite);
  const avgHr = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;
  const p = pace(dist, dur);

  cards.push(card('走路运动', ex.length ? `今天记了 ${ex.length} 次` : null,
    ex.length
      ? el('div', {},
        el('div', { class: 'metric-row' },
          metric(trim(dist, 2), '公里'),
          metric(trim(dur, 0), '分钟'),
        ),
        el('div', { class: 'metric-row', style: { marginTop: '10px' } },
          p ? metric(p, '', '平均配速（每公里）') : null,
          cal ? metric(trim(cal, 0), '千卡') : null,
          avgHr ? metric(trim(avgHr, 0), '次/分', '平均心率') : null,
        ),
      )
      : emptyNote('今天还没有记录走路'),
    () => openRecordForm(TYPES.EXERCISE, null, { distanceKm: '', durationMin: '' }),
  ));

  /* ---- 血糖 ---- */
  const glu = records.filter((r) => r.type === TYPES.GLUCOSE && Number.isFinite(r.value));
  cards.push(card('血糖', glu.length ? `今天测了 ${glu.length} 次` : null,
    glu.length
      ? el('div', { class: 'chips' }, glu.map((r) =>
        el('span', { class: 'chip' },
          el('span', { class: 'chip-tag', text: r.tag || '血糖' }),
          el('span', { class: 'chip-val', text: trim(r.value, 1) }),
          el('span', { class: 'chip-tag', text: clock(r.timestamp) }),
        )))
      : emptyNote('今天还没有测血糖'),
    () => openRecordForm(TYPES.GLUCOSE),
  ));

  /* ---- 血压 ---- */
  const bp = records.filter((r) => r.type === TYPES.BP && Number.isFinite(r.systolic));
  cards.push(card('血压', bp.length ? `今天测了 ${bp.length} 次` : null,
    bp.length
      ? el('div', { class: 'chips' }, bp.map((r) =>
        el('span', { class: 'chip' },
          el('span', { class: 'chip-val', text: `${trim(r.systolic, 0)}/${trim(r.diastolic, 0)}` }),
          el('span', { class: 'chip-tag', text: r.pulse ? `脉搏 ${trim(r.pulse, 0)}　${clock(r.timestamp)}` : clock(r.timestamp) }),
        )))
      : emptyNote('今天还没有测血压'),
    () => openRecordForm(TYPES.BP),
  ));

  /* ---- 体重 ---- */
  const wt = records.filter((r) => r.type === TYPES.WEIGHT && Number.isFinite(r.value));
  const lastWt = wt.length ? wt[wt.length - 1] : null;
  cards.push(card('体重', null,
    lastWt
      ? el('div', { class: 'metric-row' }, metric(trim(lastWt.value, 1), '公斤'))
      : emptyNote('今天还没有记录体重'),
    () => openRecordForm(TYPES.WEIGHT, null, { value: lastWt ? lastWt.value : '' }),
  ));

  /* ---- 用药 ---- */
  const med = records.filter((r) => r.type === TYPES.MED);
  cards.push(card('用药', med.length ? `今天吃了 ${med.length} 次` : null,
    med.length
      ? el('div', { class: 'chips' }, med.map((r) =>
        el('span', { class: 'chip' },
          el('span', { class: 'chip-val', text: r.name || '用药' }),
          el('span', { class: 'chip-tag', text: [r.dose != null ? `${trim(r.dose, 2)}${r.unit || ''}` : null, clock(r.timestamp)].filter(Boolean).join('　') }),
        )))
      : emptyNote('今天还没有记录用药'),
    () => openRecordForm(TYPES.MED),
  ));

  /* ---- 糖化血红蛋白 ---- */
  // 三个月左右才查一次，所以这里显示"最近一次"而不是"今天"。
  // 把距今天数一并写出来——这个间隔本身就是有信息量的，
  // 超过 100 天给一句中性提醒，不催不吓。
  const hbDays = lastHba1c ? Math.floor((Date.now() - lastHba1c.timestamp) / 86400000) : null;
  cards.push(card('糖化血红蛋白', null,
    lastHba1c
      ? el('div', {},
        el('div', { class: 'metric-row' },
          metric(trim(lastHba1c.value, 1), '%', '最近一次'),
        ),
        el('div', {
          class: 'metric-label',
          style: { marginTop: '10px', display: 'block' },
          text: `${dateCN(lastHba1c.date)}（${hbDays === 0 ? '今天' : `${hbDays} 天前`}）`
            + (hbDays > 100 ? '　距上次检查已经有一段时间了' : ''),
        }),
      )
      : emptyNote('还没有记录过，一般三个月左右查一次'),
    () => openRecordForm(TYPES.HBA1C),
  ));

  return cards;
}

/* -------------------------------------------------------------------------
   横幅 —— 按优先级只显示一条
   ------------------------------------------------------------------------- */

/**
 * 粗略判断平台，只用来决定显示哪一套安装说明。
 * 两边的入口完全不一样：iPhone 在 Safari 的分享菜单里，
 * 安卓在浏览器右上角的菜单里——给安卓用户看 iPhone 的说明，
 * 他们会照着找半天然后找不到"底部中间的分享按钮"。
 */
function platform() {
  const ua = navigator.userAgent || '';
  // iPadOS 13 以后 Safari 会把自己伪装成 macOS，只能靠触摸点数认出来
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadOS) return 'ios';
  if (/Android|HarmonyOS/.test(ua)) return 'android';
  return 'other';
}

// 安卓 Chrome 会抛这个事件，拿到之后就能由应用自己触发安装，
// 比让用户去翻浏览器菜单省事得多。iOS 没有对应机制。
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
});

function installBanner() {
  const p = platform();

  if (p === 'android') {
    const btn = el('button', {
      type: 'button',
      class: 'btn-primary btn-block',
      text: '一键安装到桌面',
      style: { minHeight: '60px', fontSize: '21px', marginTop: '14px' },
      onclick: async () => {
        if (!deferredInstall) {
          await alertDialog('请点浏览器右上角的三个点 ⋮，选「安装应用」或「添加到主屏幕」。');
          return;
        }
        deferredInstall.prompt();
        const choice = await deferredInstall.userChoice;
        deferredInstall = null;
        if (choice?.outcome === 'accepted') await refresh();
      },
    });

    return el('div', { class: 'alert alert-info', style: { display: 'block' } },
      el('div', { class: 'alert-mark', text: '📱 请先安装到桌面', style: { fontWeight: '700', marginBottom: '8px' } }),
      el('div', { style: { fontWeight: '400', lineHeight: '1.7' } },
        // 安卓没有 iOS 那条 7 天清理规则，所以不吓唬人，如实说好处就行
        '安装后可以全屏使用、断网也能记，数据也更不容易被浏览器清掉。',
        el('div', { style: { marginTop: '10px' } },
          el('div', { text: '1. 点浏览器右上角的三个点 ⋮' }),
          el('div', { text: '2. 选「安装应用」或「添加到主屏幕」' }),
          el('div', { text: '3. 确认安装' }),
        ),
      ),
      btn,
    );
  }

  if (p === 'ios') {
    return el('div', { class: 'alert alert-info', style: { display: 'block' } },
      el('div', { class: 'alert-mark', text: '📱 请先添加到主屏幕', style: { fontWeight: '700', marginBottom: '8px' } }),
      el('div', { style: { fontWeight: '400', lineHeight: '1.7' } },
        '这一步不能省。只有在主屏幕上的应用，记录才不会被 iPhone 自动清理掉。',
        el('div', { style: { marginTop: '10px' } },
          el('div', { text: '1. 点屏幕底部中间的「分享」按钮 ⬆️' }),
          el('div', { text: '2. 在列表里往下滑，点「添加到主屏幕」' }),
          el('div', { text: '3. 点右上角的「添加」' }),
        ),
      ),
    );
  }

  // 电脑浏览器：这里没东西可装，说明清楚就行，免得白折腾
  return el('div', { class: 'alert alert-info', style: { display: 'block' } },
    el('div', { class: 'alert-mark', text: '📱 请用手机打开', style: { fontWeight: '700', marginBottom: '8px' } }),
    el('div', { style: { fontWeight: '400', lineHeight: '1.7' } },
      '这是给手机用的。用 iPhone 的 Safari、或安卓的 Chrome 打开这个网址，'
      + '再「添加到主屏幕」，就能像 App 一样全屏使用、断网也能记。',
    ),
  );
}

function backupBanner(settings) {
  const days = settings.lastBackupAt
    ? Math.floor((Date.now() - settings.lastBackupAt) / 86400000)
    : null;

  const card = el('div', { class: 'alert alert-warn', style: { display: 'block' } },
    el('div', { class: 'alert-mark', style: { fontWeight: '700', marginBottom: '6px' } },
      days == null ? '还没有备份过记录' : `上次备份是 ${days} 天前`),
    el('div', { style: { fontWeight: '400', lineHeight: '1.7' } },
      '记录只在这台手机上。发给家人保存一份，手机丢了也不会丢。'),
    el('div', { style: { marginTop: '12px' } },
      el('button', {
        type: 'button',
        class: 'btn-primary btn-block',
        text: '现在发给家人',
        style: { minHeight: '60px', fontSize: '21px' },
        // 这个处理器本身绝不能是 async，也不能在 shareNow() 之前 await 任何东西
        // ——哪怕只是 await 一次 import()，用户手势就失效了，分享会静默失败。
        // 数据在启动时就已经预取好，所以这里只做同步调用。
        onclick: () => {
          if (!exportInfo()) {
            void prepareExport();
            void alertDialog('数据还在整理，请稍等两秒再点一次。');
            return;
          }
          void afterShare(shareNow(), settings);
        },
      }),
    ),
  );
  return card;
}

/** 分享结果的处理。它在 shareNow() 同步发起之后才执行，所以可以放心 await。 */
async function afterShare(promise, settings) {
  const res = await promise;

  if (res.ok) {
    // 分享面板正常关闭 ≠ 文件确实落到了某处，所以措辞是"已发送"
    await setSetting('lastBackupAt', Date.now());
    settings.lastBackupAt = Date.now();
    await writeSnapshot(true);
    await showSaved('已发送');
    await refresh();
    return;
  }
  if (res.reason === 'cancelled') return;
  if (res.reason === 'not-ready') {
    await alertDialog('数据还在整理，请稍等两秒再点一次。');
    return;
  }
  await alertDialog('分享没有成功，可以再点一次试试。');
}

function lossBanner(loss, onRestore) {
  return el('div', { class: 'alert alert-danger', style: { display: 'block' } },
    el('div', { class: 'alert-mark', style: { fontWeight: '700', marginBottom: '6px' } },
      '发现本地备份，记录可能丢了'),
    el('div', { style: { fontWeight: '400', lineHeight: '1.7' } },
      `现在手机里有 ${loss.liveCount} 条记录，上次备份时有 ${loss.snapCount} 条。`),
    el('div', { style: { marginTop: '12px' } },
      el('button', {
        type: 'button', class: 'btn-primary btn-block', text: '恢复备份的数据',
        style: { minHeight: '60px', fontSize: '21px' },
        onclick: onRestore,
      }),
    ),
  );
}

/* -------------------------------------------------------------------------
   渲染
   ------------------------------------------------------------------------- */

async function renderToday(host) {
  const today = TODAY();
  // 糖化血红蛋白不是每天测的，所以要单独取"最近一次"，而不是只看今天
  const [records, lastHba1c] = await Promise.all([
    listByDateRange(today, today),
    latestOfType(TYPES.HBA1C),
  ]);
  const settings = state.settings;

  const banners = [];

  // 优先级：数据可能丢了 > 没装到主屏幕 > 该备份了
  // 一次只显示一条，三条叠在一起父母会直接忽略掉全部。
  if (state.lossCheck?.suspected) {
    banners.push(lossBanner(state.lossCheck, async () => {
      const ok = await confirmDialog(
        `要把备份里的 ${state.lossCheck.snapCount} 条记录合并回来吗？现有的记录不会被删除。`,
        { yes: '恢复', no: '取消' },
      );
      if (!ok) return;
      await restoreFromSnapshot(state.lossCheck.snapshot);
      state.lossCheck = null;
      invalidateExport();
      await showSaved('已恢复');
      await refresh();
    }));
  } else if (!isInstalled()) {
    banners.push(installBanner());
  } else {
    const days = settings.lastBackupAt
      ? Math.floor((Date.now() - settings.lastBackupAt) / 86400000)
      : Infinity;
    if (days >= (settings.backupEveryDays || 14)) banners.push(backupBanner(settings));
  }

  replace(host,
    ...banners,
    ...todayCards(records, lastHba1c),
    el('p', { class: 'set-note', style: { padding: '6px 4px' } },
      '本应用只做记录和趋势对照，不提供诊疗建议。参考范围来自通用临床指南，'
      + '个人目标请以医嘱为准。'),
  );
}

async function renderHistoryView(host) {
  const days = state.days;
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const records = await listByDateRange(dateKey(from.getTime()), TODAY());

  renderHistory(host, {
    records,
    days,
    targets: state.settings.targets,
    todayStr: TODAY(),
    onEdit: (r) => openRecordForm(r.type, r),
  });
}

async function renderSettingsView(host) {
  await renderSettings(host, {
    settings: state.settings,
    onChanged: async () => {
      state.settings = await getSettings();
      await refresh();
    },
  });
}

/* -------------------------------------------------------------------------
   路由
   ------------------------------------------------------------------------- */

const VIEW_TITLES = { today: '今天', history: '历史', settings: '设置' };

async function refresh() {
  const view = state.view;
  const topTitle = document.getElementById('topTitle');
  const topSub = document.getElementById('topSub');

  replace(topTitle, VIEW_TITLES[view]);
  replace(topSub, view === 'today' ? dateFullCN(TODAY()) : '');

  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.view === view;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
  }

  // 写到各页面内部的容器，而不是 section 本身。
  // 写 section 会把页面里的固定控件（历史页的时间范围切换）一起清掉。
  const hostId = { today: 'todayBody', history: 'historyBody', settings: 'settingsBody' }[view];
  const host = document.getElementById(hostId);
  if (view === 'today') await renderToday(host);
  else if (view === 'history') await renderHistoryView(host);
  else await renderSettingsView(host);
}

function switchView(view) {
  state.view = view;
  for (const id of ['today', 'history', 'settings']) {
    document.getElementById(`view-${id}`).hidden = id !== view;
  }
  window.scrollTo(0, 0);
  return refresh();
}

/* -------------------------------------------------------------------------
   启动
   ------------------------------------------------------------------------- */

async function boot() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }

  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.addEventListener('click', () => {
      state.days = Number(btn.dataset.range);
      for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('is-on', b === btn);
      if (state.view === 'history') void refresh();
    });
  }

  state.settings = await getSettings();

  // 先查数据有没有丢，再渲染 —— 这条提示必须比内容先出现
  try {
    state.lossCheck = await detectDataLoss();
  } catch {
    state.lossCheck = null;
  }

  // 走 switchView 而不是 refresh —— 三个 section 在 HTML 里初始都是 hidden 的
  //（避免启动瞬间闪一下空页面），需要有人把它们显示出来
  await switchView('today');

  // 预取导出数据，这样用户点"发给家人"时可以同步唤起分享面板
  void prepareExport();

  // 留一份快照（距上次超过一小时才真的写）
  void maybeSnapshot();

  // 主动申请持久化存储。Safari 未必给，但代价为零，而且独立模式下是有效的。
  void navigator.storage?.persist?.().catch(() => {});

  registerServiceWorker();
  scheduleMidnightRefresh();
  setupVisibilityRefresh();
}

/** 跨过午夜时要重画，否则凌晨记的数据会落到"昨天"那一屏上 */
function scheduleMidnightRefresh() {
  const next = new Date();
  next.setHours(24, 0, 5, 0);
  setTimeout(async () => {
    if (state.view === 'today') await refresh();
    scheduleMidnightRefresh();
  }, next.getTime() - Date.now());
}

/**
 * 从后台切回前台时重新读一次数据。
 * 父母可能开着两个界面（主屏图标 + Safari 标签页），
 * 不重读的话会看到过期内容。
 */
function setupVisibilityRefresh() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 注册失败不影响使用，只是没有离线能力
    });
  });
}

/* -------------------------------------------------------------------------
   全局错误兜底
   父母遇到白屏时不会去看控制台，至少要让他们知道发生什么、该做什么。
   ------------------------------------------------------------------------- */

window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
});

boot().catch(async (err) => {
  console.error(err);
  const host = document.getElementById('todayBody');
  if (host) {
    replace(host,
      el('div', { class: 'alert alert-danger' },
        el('div', {},
          el('div', { class: 'alert-mark', text: '应用没能启动' }),
          el('p', { style: { fontWeight: '400' }, text: String(err.message || err) }),
          el('p', { style: { fontWeight: '400', marginTop: '10px' },
            text: '如果是在 Safari 的普通标签页里打开的，请先"添加到主屏幕"再打开一次。' }),
        ),
      ),
    );
  }
});

export { refresh, openRecordForm };
