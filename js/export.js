/* ==========================================================================
   导出与备份

   这个模块存在的唯一理由，是数据要能离开这台手机。
   它同时是整个项目里最容易做错的地方，原因：

   1. iOS Safari 不支持 <a download>，Blob 下载在 PWA 里点了完全没反应、
      不报错。唯一可用的出口是 navigator.share。
   2. navigator.share 需要"瞬时用户激活"。只要在点击处理器里 await 了
      任何东西（比如读一次 IndexedDB），手势就失效了，调用会静默失败。
      所以数据必须在用户点之前就准备好——prepareExport() 负责这件事，
      shareNow() 里绝不能出现 await。
   3. navigator.canShare({files}) 必须传真实的 File 实例。用 {type:'text/csv'}
      这种桩去探测会返回 false，从而在一个本来能用的设备上静默关掉
      唯一的数据出口。
   ========================================================================== */

import { getAllRecords, getSettings, putManyRecords, clearAllRecords, dateKey, TYPES } from './db.js';
import { pace, clock } from './ui.js';

const BACKUP_FORMAT = 1;

/* -------------------------------------------------------------------------
   CSV
   ------------------------------------------------------------------------- */

/** CSV 字段转义：含逗号、引号、换行时用引号包起来 */
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_COLUMNS = [
  '日期', '时间', '类型', '运动方式',
  '距离(公里)', '用时(分钟)', '平均配速', '热量(千卡)', '平均心率(次/分)',
  '血糖(mmol/L)', '测量时点',
  '高压(mmHg)', '低压(mmHg)', '脉搏(次/分)',
  '体重(公斤)', '糖化血红蛋白(%)',
  '药名', '剂量', '单位',
];

const TYPE_LABEL = {
  [TYPES.EXERCISE]: '运动',
  [TYPES.GLUCOSE]: '血糖',
  [TYPES.BP]: '血压',
  [TYPES.WEIGHT]: '体重',
  [TYPES.HBA1C]: '糖化血红蛋白',
  [TYPES.MED]: '用药',
};

function recordToRow(r) {
  const row = {
    日期: r.date,
    时间: clock(r.timestamp),
    类型: TYPE_LABEL[r.type] || r.type,
  };

  switch (r.type) {
    case TYPES.EXERCISE:
      row['运动方式'] = r.kind || '';
      row['距离(公里)'] = r.distanceKm ?? '';
      row['用时(分钟)'] = r.durationMin ?? '';
      // 配速在库里不存，导出时现算，和界面上显示的保持一致
      row['平均配速'] = pace(r.distanceKm, r.durationMin) || '';
      row['热量(千卡)'] = r.calories ?? '';
      row['平均心率(次/分)'] = r.avgHr ?? '';
      break;
    case TYPES.GLUCOSE:
      row['血糖(mmol/L)'] = r.value ?? '';
      row['测量时点'] = r.tag || '';
      break;
    case TYPES.BP:
      row['高压(mmHg)'] = r.systolic ?? '';
      row['低压(mmHg)'] = r.diastolic ?? '';
      row['脉搏(次/分)'] = r.pulse ?? '';
      break;
    case TYPES.WEIGHT:
      row['体重(公斤)'] = r.value ?? '';
      break;
    case TYPES.HBA1C:
      row['糖化血红蛋白(%)'] = r.value ?? '';
      break;
    case TYPES.MED:
      row['药名'] = r.name || '';
      row['剂量'] = r.dose ?? '';
      row['单位'] = r.unit || '';
      break;
  }
  return CSV_COLUMNS.map((c) => csvCell(row[c]));
}

/**
 * 生成 CSV 文本。
 *
 * 两个细节不做的话这张表基本没法用：
 * - 开头加 BOM（﻿）。不加的话 Excel 会按本地编码解析，
 *   中文表头全是乱码——而这张表正是要发给用 Windows 的家人看的。
 * - 用 CRLF 换行，Excel 对 \n 的兼容性不如 \r\n。
 */
export function buildCSV(records) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);
  for (const r of sorted) lines.push(recordToRow(r).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/* -------------------------------------------------------------------------
   JSON 备份
   ------------------------------------------------------------------------- */

export function buildBackup(records, settings) {
  return {
    app: '健康日记',
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    counts: countByType(records),
    settings: {
      targets: settings.targets,
      medNames: settings.medNames,
    },
    records,
  };
}

export function countByType(records) {
  const out = {};
  for (const r of records) out[r.type] = (out[r.type] || 0) + 1;
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/* -------------------------------------------------------------------------
   预取 —— 必须在用户点击之前完成
   ------------------------------------------------------------------------- */

let prepared = null;     // { files, at, count }
let preparing = null;

/** 数据变化后要重新预取，否则分享出去的是旧数据 */
export function invalidateExport() {
  prepared = null;
}

export function isExportReady() {
  return !!prepared;
}

export function exportInfo() {
  return prepared ? { at: prepared.at, count: prepared.count } : null;
}

/**
 * 提前把全部数据读出来、把 File 对象构造好。
 * 之所以要"提前"，是因为 navigator.share 不能 await —— 见文件头的说明。
 * 记录条数在几千条这个量级，序列化开销可以忽略，每次存完记录调用一次也无所谓。
 */
export function prepareExport() {
  if (preparing) return preparing;

  preparing = (async () => {
    const [records, settings] = await Promise.all([getAllRecords(), getSettings()]);

    const csv = buildCSV(records);
    const json = JSON.stringify(buildBackup(records, settings), null, 2);
    const s = stamp();

    prepared = {
      at: Date.now(),
      count: records.length,
      files: [
        new File([json], `健康日记备份_${s}.json`, { type: 'application/json' }),
        new File([csv], `健康记录_${s}.csv`, { type: 'text/csv' }),
      ],
    };
    return prepared;
  })().finally(() => { preparing = null; });

  return preparing;
}

/* -------------------------------------------------------------------------
   分享 —— 必须同步调用
   ------------------------------------------------------------------------- */

/**
 * 唤起系统分享面板。
 *
 * 注意这个函数里不能出现 await：一旦在调用 navigator.share 之前让出执行权，
 * 浏览器就认为用户手势已经过期，调用直接失败。
 *
 * 返回的 promise 只用于判断结果，不影响手势有效性。
 */
export function shareNow() {
  if (!prepared) {
    return Promise.resolve({ ok: false, reason: 'not-ready' });
  }

  const { files } = prepared;

  // 判断依据必须是真实的 File 对象。传 {type:'text/csv'} 这样的桩，
  // iOS 上会返回 false，等于在一个本来能用的设备上把导出功能关掉了。
  const canShareFiles = !!(navigator.canShare && navigator.canShare({ files }));

  if (canShareFiles) {
    // 同步发起，不 await 任何前置操作
    return navigator.share({ files, title: '健康日记备份' })
      .then(() => ({ ok: true, reason: 'shared' }))
      .catch((err) => {
        // 用户自己划掉分享面板不算失败，不要记成"已备份"
        if (err && err.name === 'AbortError') return { ok: false, reason: 'cancelled' };
        return { ok: false, reason: 'error', error: err };
      });
  }

  // 桌面浏览器退路。<a download> 在桌面 Chrome/Edge 上是好的，
  // 只在 iOS 上没用——所以这条分支绝不能是 iOS 的默认路径。
  try {
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    return Promise.resolve({ ok: true, reason: 'downloaded' });
  } catch (err) {
    return Promise.resolve({ ok: false, reason: 'error', error: err });
  }
}

/** 这个设备能不能用系统分享面板分享文件 */
export function canShare() {
  return !!(navigator.canShare && navigator.canShare({
    files: [new File(['x'], 'x.txt', { type: 'text/plain' })],
  }));
}

/* -------------------------------------------------------------------------
   导入与还原
   ------------------------------------------------------------------------- */

/** 解析备份文件，返回 { records, settings, exportedAt } */
export async function parseBackupFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('这个文件不是备份文件，读不出来。');
  }
  if (!data || !Array.isArray(data.records)) {
    throw new Error('这个文件里没有找到记录，可能不是本应用导出的备份。');
  }

  // 逐条校验，挡掉结构不对的数据。宁可少导入几条，也不能让脏数据进库
  // ——一条 timestamp 是 NaN 的记录足以让整张趋势图静默消失。
  const records = [];
  let skipped = 0;
  for (const r of data.records) {
    if (!r || typeof r !== 'object' || !r.type || !Number.isFinite(Number(r.timestamp))) {
      skipped++;
      continue;
    }
    const ts = Number(r.timestamp);
    records.push({
      ...r,
      timestamp: ts,
      // 日期一律从时间戳重新推，不信任备份里的值：
      // 万一之前存的时候两者不一致，这里正好纠正过来
      date: dateKey(ts),
    });
  }

  return { records, skipped, settings: data.settings || null, exportedAt: data.exportedAt || null };
}

/** 导入。mode: 'merge' 合并（同 id 覆盖） | 'replace' 清空后导入 */
export async function importRecords(records, mode = 'merge') {
  if (mode === 'replace') await clearAllRecords();
  return putManyRecords(records);
}

/* -------------------------------------------------------------------------
   快照保险 —— Cache Storage 是独立于 IndexedDB 的另一个存储桶
   ------------------------------------------------------------------------- */

const SNAPSHOT_CACHE = 'health-diary-snapshots-v1';
const SNAPSHOT_KEEP = 5;

const snapshotsSupported = () => typeof caches !== 'undefined';

function snapshotURL(at) {
  return new URL(`./__snapshot__/${at}.json`, location.href).href;
}

/**
 * 写一份快照到 Cache Storage。
 *
 * 它防的是应用自己的错误：IndexedDB 损坏、升级迁移写坏、误触"清空数据"、
 * 或者某个 bug 删掉了记录——这些情况下 IndexedDB 没了但 Cache Storage 还在。
 * 它防不了"清除网站数据"和丢手机，这一点在界面上要说清楚，
 * 不能让人误以为这就是备份了。
 */
export async function writeSnapshot() {
  if (!snapshotsSupported()) return null;
  try {
    const [records, settings] = await Promise.all([getAllRecords(), getSettings()]);
    if (!records.length) return null;

    const at = Date.now();
    const body = JSON.stringify({ at, records, settings });
    const cache = await caches.open(SNAPSHOT_CACHE);
    await cache.put(snapshotURL(at), new Response(body, {
      headers: { 'Content-Type': 'application/json' },
    }));

    await pruneSnapshots();
    return { at, count: records.length };
  } catch {
    // 快照失败不该影响正常使用，静默跳过
    return null;
  }
}

export async function listSnapshots() {
  if (!snapshotsSupported()) return [];
  try {
    const cache = await caches.open(SNAPSHOT_CACHE);
    const keys = await cache.keys();
    return keys
      .map((req) => {
        const m = req.url.match(/__snapshot__\/(\d+)\.json$/);
        return m ? { url: req.url, at: Number(m[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

async function pruneSnapshots(keep = SNAPSHOT_KEEP) {
  const list = await listSnapshots();
  if (list.length <= keep) return;
  const cache = await caches.open(SNAPSHOT_CACHE);
  for (const item of list.slice(keep)) await cache.delete(item.url);
}

/**
 * 启动时检查：IndexedDB 里的记录数是不是比最近一次快照少了很多。
 * 少了就提示恢复——不自动还原，只是把选择权交给用户。
 */
export async function detectDataLoss() {
  if (!snapshotsSupported()) return { suspected: false };
  try {
    const [snapshots, records] = await Promise.all([listSnapshots(), getAllRecords()]);
    if (!snapshots.length) return { suspected: false };

    const cache = await caches.open(SNAPSHOT_CACHE);
    const res = await cache.match(snapshots[0].url);
    if (!res) return { suspected: false };

    const snap = await res.json();
    const snapCount = (snap.records || []).length;
    const liveCount = records.length;

    // 空库 + 有快照 = 很可能整个丢了；或者数量掉了两成以上
    const wiped = liveCount === 0 && snapCount > 0;
    const shrunk = snapCount > 20 && liveCount < snapCount * 0.8;

    if (!wiped && !shrunk) return { suspected: false };
    return { suspected: true, wiped, liveCount, snapCount, at: snap.at, snapshot: snap };
  } catch {
    return { suspected: false };
  }
}

/** 从快照还原（合并模式，不会删掉现有记录） */
export async function restoreFromSnapshot(snap) {
  const records = (snap.records || []).filter(
    (r) => r && r.type && Number.isFinite(Number(r.timestamp)),
  );
  return putManyRecords(records);
}
