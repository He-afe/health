/* ==========================================================================
   数据层 — IndexedDB 封装
   全部数据只存在这台手机上，不发送到任何地方。

   一个注意点：IndexedDB 的事务在遇到 await 非 IDB 操作时会自动提交关闭
   （iOS Safari 上尤其容易踩）。所以下面所有事务内部都不穿插异步调用，
   要 await 的东西全部放在事务外面。
   ========================================================================== */

const DB_NAME = 'health-diary';
const DB_VERSION = 1;

export const STORE_RECORDS = 'records';
export const STORE_SETTINGS = 'settings';

/** 记录类型 */
export const TYPES = {
  EXERCISE: 'exercise',
  GLUCOSE: 'glucose',
  BP: 'bp',
  WEIGHT: 'weight',
  HBA1C: 'hba1c',
  MED: 'med',
};

/** 血糖测量时点。医学上不同时点的目标值完全不同，必须分开统计。 */
export const GLUCOSE_TAGS = ['空腹', '餐前', '餐后2h', '睡前', '凌晨', '随机'];

/** 运动方式 */
export const EXERCISE_KINDS = ['步行', '跑步', '骑车', '其他'];

/** 用药单位 */
export const DOSE_UNITS = ['毫克', '片', '单位', '毫升'];

/* -------------------------------------------------------------------------
   参考范围
   取自《中国2型糖尿病防治指南》和《中国高血压防治指南》中一般成人
   的控制目标。这些只是默认值——设置页里可以改成医生给的个人目标，
   因为个体化目标常常和通用值不一样。

   应用只把这里当作画参考线和给"偏高/正常/偏低"文字标记的依据，
   不做任何诊断式表述。
   ------------------------------------------------------------------------- */
export const DEFAULT_TARGETS = {
  glucoseFastingLow: 4.4,     // 空腹下限 mmol/L
  glucoseFastingHigh: 7.0,    // 空腹上限
  glucosePostHigh: 10.0,      // 非空腹上限
  glucoseHypo: 3.9,           // 低血糖警戒线
  hba1cHigh: 7.0,             // %

  // 血压：这里用的是「家庭自测」标准，不是诊室标准。
  // 家庭自测值普遍低于诊室值，所以家庭自测 ≥135/85 就提示血压升高，
  // 而诊室要 ≥140/90。拿诊室标准套家庭数据会明显过度判读。
  bpSystolicHigh: 130,        // 糖尿病合并高血压的降压目标
  bpDiastolicHigh: 80,
  bpHomeSystolic: 135,        // 家庭自测提示升高的界值
  bpHomeDiastolic: 85,
};

export const DEFAULT_SETTINGS = {
  targets: DEFAULT_TARGETS,
  medNames: [],               // 常用药名，录入时可直接点选
  lastBackupAt: 0,            // 上次备份时间戳，用于提醒
  backupEveryDays: 14,        // 多少天没备份就提醒
};

/* -------------------------------------------------------------------------
   日期工具
   一律用本地时区的 YYYY-MM-DD。用 UTC 的话，父母晚上 11 点记的数据
   会被算到第二天去。
   ------------------------------------------------------------------------- */

/** 时间戳 -> 'YYYY-MM-DD'（本地时区） */
export function dateKey(ts = Date.now()) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 'YYYY-MM-DD' -> 当天 00:00 的时间戳（本地时区） */
export function dayStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** 'YYYY-MM-DD' -> 当天 23:59:59.999 的时间戳（本地时区） */
export function dayEnd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/** 从今天往前数 n 天的日期字符串（含今天） */
export function daysAgoKey(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateKey(d.getTime());
}

/** 生成一个 id。crypto.randomUUID 在 iOS 15.4+ 才有，留个退路。 */
export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* -------------------------------------------------------------------------
   打开数据库
   ------------------------------------------------------------------------- */

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('这台设备不支持本地数据库，无法保存记录。'));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        // 复合索引：查"某个类型在某时间段的记录"时可以直接走区间扫描
        store.createIndex('by_type_time', ['type', 'timestamp']);
        store.createIndex('by_type_date', ['type', 'date']);
        store.createIndex('by_date', 'date');
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }

      void event;
    };

    req.onsuccess = () => {
      const db = req.result;
      // 另一个标签页要升级数据库时，主动让路，否则会互相阻塞
      db.onversionchange = () => db.close();
      resolve(db);
    };

    req.onerror = () => reject(req.error || new Error('打不开本地数据库'));
    req.onblocked = () => reject(new Error('数据库被其他窗口占用，请关掉其他标签页后重试'));
  });

  // 打开失败就把缓存清掉，下次调用可以重试
  dbPromise.catch(() => { dbPromise = null; });

  return dbPromise;
}

/** 把一次事务包装成 Promise，事务完成才 resolve */
function run(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;

    // 只做同步的 IDB 调用，不在这里 await 任何东西
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }

    tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('数据库操作被中断'));
  }));
}

/** 包一层，标记这是个需要取 result 的请求 */
const take = (req) => ({ __req: req });

/* -------------------------------------------------------------------------
   记录读写
   ------------------------------------------------------------------------- */

/** 新增或覆盖一条记录，自动补 id / date / timestamp */
export async function saveRecord(rec) {
  const now = Date.now();
  const full = {
    ...rec,
    id: rec.id || uid(),
    timestamp: rec.timestamp || now,
    date: rec.date || dateKey(rec.timestamp || now),
    updatedAt: now,
  };
  await run(STORE_RECORDS, 'readwrite', (s) => s.put(full));
  return full;
}

export function getRecord(id) {
  return run(STORE_RECORDS, 'readonly', (s) => take(s.get(id)));
}

export function deleteRecord(id) {
  return run(STORE_RECORDS, 'readwrite', (s) => s.delete(id));
}

/**
 * 按类型 + 时间范围查记录，按时间正序返回。
 * from / to 是时间戳，省略则不限。
 */
export async function listByType(type, from, to) {
  const rows = await run(STORE_RECORDS, 'readonly', (s) => {
    const idx = s.index('by_type_time');
    // 复合键区间：上下界都必须给完整的两段
    const lo = [type, from ?? -8640000000000000];
    const hi = [type, to ?? 8640000000000000];
    return take(idx.getAll(IDBKeyRange.bound(lo, hi)));
  });
  return rows || [];
}

/** 按日期范围查全部类型的记录，按时间正序返回 */
export async function listByDateRange(fromDate, toDate) {
  const rows = await run(STORE_RECORDS, 'readonly', (s) => {
    const idx = s.index('by_date');
    return take(idx.getAll(IDBKeyRange.bound(fromDate, toDate)));
  });
  return (rows || []).sort((a, b) => a.timestamp - b.timestamp);
}

/** 某个类型的全部记录，按时间倒序（最新的在前） */
export async function listAllOfType(type) {
  const rows = await listByType(type);
  return rows.reverse();
}

/** 取某类型最近的一条，用于"和上次一样" */
export async function latestOfType(type) {
  const rows = await listByType(type);
  if (!rows.length) return null;
  return rows.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
}

/** 导出用：取出全部记录 */
export function getAllRecords() {
  return run(STORE_RECORDS, 'readonly', (s) => take(s.getAll())).then((r) => r || []);
}

/** 导入用：整批写入 */
export function putManyRecords(records) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDS);
    for (const r of records) store.put(r);
    tx.oncomplete = () => resolve(records.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('导入被中断'));
  }));
}

/** 清空全部记录（危险操作，界面上要二次确认） */
export function clearAllRecords() {
  return run(STORE_RECORDS, 'readwrite', (s) => s.clear());
}

/* -------------------------------------------------------------------------
   设置
   ------------------------------------------------------------------------- */

export async function getSettings() {
  const rows = await run(STORE_SETTINGS, 'readonly', (s) => take(s.getAll()));
  // 不用 structuredClone — 那是 iOS 15.4+ 才有的，设置对象本来就是纯 JSON
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const row of rows || []) out[row.key] = row.value;
  // 目标值逐项合并，避免旧版本存的残缺对象盖掉新加的字段
  out.targets = { ...DEFAULT_TARGETS, ...(out.targets || {}) };
  return out;
}

export function setSetting(key, value) {
  return run(STORE_SETTINGS, 'readwrite', (s) => s.put({ key, value }));
}

export function getTargets() {
  return getSettings().then((s) => s.targets);
}
