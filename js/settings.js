/* ==========================================================================
   设置页

   包含三件要紧的事：
   1. 备份 —— 按钮的措辞是"把记录发给家人"，不是"导出备份文件"。
      父母没有"备份文件"这个概念，但完全懂"发给家人"。
      这条路径是数据离开这台手机的唯一出口。
   2. 目标值 —— 全部可改，因为医生的个体化目标往往和通用值不一样。
   3. 参考范围说明 —— 把依据、以及哪几项不是指南条目，都写清楚。
   ========================================================================== */

import { TYPES, DEFAULT_TARGETS, setSetting, getAllRecords } from './db.js';
import { el, replace, trim, confirmDialog, alertDialog, dateCN, relDay } from './ui.js';
import {
  prepareExport, shareNow, canShare, exportInfo,
  parseBackupFile, importRecords, writeSnapshot, listSnapshots,
} from './export.js';

const INSTALLED_KEY = 'installed';

/** 是否已经"添加到主屏幕"。这决定了 IndexedDB 会不会被 7 天清理规则干掉。 */
export function isInstalled() {
  return window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

/* -------------------------------------------------------------------------
   目标值编辑
   ------------------------------------------------------------------------- */

const TARGET_FIELDS = [
  { key: 'glucoseFastingLow', label: '空腹血糖下限', unit: 'mmol/L' },
  { key: 'glucoseFastingHigh', label: '空腹血糖上限', unit: 'mmol/L' },
  { key: 'glucosePostHigh', label: '餐后血糖上限', unit: 'mmol/L' },
  { key: 'glucoseHypo', label: '低血糖警戒线', unit: 'mmol/L' },
  { key: 'hba1cHigh', label: '糖化血红蛋白上限', unit: '%' },
  { key: 'bpSystolicHigh', label: '血压目标（高压）', unit: 'mmHg' },
  { key: 'bpDiastolicHigh', label: '血压目标（低压）', unit: 'mmHg' },
  { key: 'bpHomeSystolic', label: '家庭自测偏高界值（高压）', unit: 'mmHg' },
  { key: 'bpHomeDiastolic', label: '家庭自测偏高界值（低压）', unit: 'mmHg' },
];

function targetEditor(settings, onChange) {
  const inputs = {};
  const changed = settings.targets;

  const rows = TARGET_FIELDS.map((f) => {
    const input = el('input', {
      class: 'field-input set-input',
      inputMode: 'decimal',
      inputmode: 'decimal',
      value: String(settings.targets[f.key] ?? ''),
      oninput: () => {
        const cleaned = input.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
        if (cleaned !== input.value) input.value = cleaned;
      },
    });
    inputs[f.key] = input;
    return el('div', { class: 'set-row set-row-edit' },
      el('div', {},
        el('div', { class: 'set-label', text: f.label }),
        el('div', { class: 'set-hint', text: f.unit }),
      ),
      input,
    );
  });

  const saveBtn = el('button', {
    type: 'button',
    class: 'btn-secondary btn-block',
    text: '保存目标值',
    onclick: async () => {
      const next = { ...settings.targets };
      for (const f of TARGET_FIELDS) {
        const v = Number(inputs[f.key].value);
        if (Number.isFinite(v)) next[f.key] = v;
      }
      // 上限低于下限的话图表上的目标区间会翻转，直接挡掉
      if (next.glucoseFastingLow >= next.glucoseFastingHigh) {
        await alertDialog('空腹血糖的下限应该比上限小，请检查一下。');
        return;
      }
      if (next.bpDiastolicHigh >= next.bpSystolicHigh) {
        await alertDialog('血压的低压目标应该比高压目标小，请检查一下。');
        return;
      }
      await setSetting('targets', next);
      Object.assign(settings.targets, next);
      await onChange();
    },
  });

  const resetBtn = el('button', {
    type: 'button',
    class: 'btn-plain btn-block',
    text: '恢复指南默认值',
    onclick: async () => {
      const ok = await confirmDialog('确定要把所有目标值恢复成默认值吗？', { yes: '恢复', no: '取消' });
      if (!ok) return;
      for (const f of TARGET_FIELDS) inputs[f.key].value = String(DEFAULT_TARGETS[f.key]);
      replace(saveBtn, '保存目标值');
      void changed;
      await saveBtn.click();
    },
  });

  return el('div', { class: 'set-group' },
    el('h2', { text: '我的目标值' }),
    el('p', { class: 'set-note', text: '这里填医生给你定的目标。填好之后，图表上的参考线和"高于/低于目标"的提示都会按你的数值来算。' }),
    el('div', {}, rows),
    el('div', { style: { marginTop: '14px' } }, saveBtn),
    el('div', { style: { marginTop: '10px' } }, resetBtn),
  );
}

/* -------------------------------------------------------------------------
   常用药名
   ------------------------------------------------------------------------- */

function medNamesEditor(settings, onChange) {
  const input = el('input', {
    class: 'field-input set-input',
    placeholder: '输入药名',
    autocomplete: 'off',
  });

  const addBtn = el('button', {
    type: 'button',
    class: 'btn-secondary',
    text: '添加',
    onclick: async () => {
      const name = input.value.trim();
      if (!name) return;
      if (settings.medNames.includes(name)) { input.value = ''; return; }
      settings.medNames = [...settings.medNames, name];
      await setSetting('medNames', settings.medNames);
      input.value = '';
      await onChange();
    },
  });

  const chips = settings.medNames.map((name) => el('button', {
    type: 'button',
    class: 'choice',
    text: `${name} ✕`,
    onclick: async () => {
      settings.medNames = settings.medNames.filter((n) => n !== name);
      await setSetting('medNames', settings.medNames);
      await onChange();
    },
  }));

  return el('div', { class: 'set-group' },
    el('h2', { text: '常用药名' }),
    el('p', { class: 'set-note', text: '加进来之后，记录用药时点一下就填上了，不用每次打字。点药名可以删掉。' }),
    settings.medNames.length ? el('div', { class: 'choices', style: { marginBottom: '12px' } }, chips) : null,
    el('div', { class: 'field-row' }, input, addBtn),
  );
}

/* -------------------------------------------------------------------------
   数据检查
   ------------------------------------------------------------------------- */

async function dataCheck(settings) {
  const records = await getAllRecords();
  const snapshots = await listSnapshots();

  const counts = Object.values(TYPES).map((t) =>
    `${({ [TYPES.EXERCISE]: '运动', [TYPES.GLUCOSE]: '血糖', [TYPES.BP]: '血压', [TYPES.WEIGHT]: '体重', [TYPES.HBA1C]: '糖化', [TYPES.MED]: '用药' })[t]} ${records.filter((r) => r.type === t).length}`,
  ).join(' · ');

  const oldest = records.length
    ? new Date(Math.min(...records.map((r) => r.timestamp)))
    : null;

  return el('div', { class: 'set-group' },
    el('h2', { text: '数据检查' }),
    el('div', {},
      el('div', { class: 'set-row' },
        el('span', { class: 'set-label', text: '共保存了' }),
        el('span', { class: 'set-value', text: `${records.length} 条记录` }),
      ),
      el('div', { class: 'set-row' },
        el('div', {},
          el('div', { class: 'set-label', text: '各类记录' }),
          el('div', { class: 'set-hint', text: counts }),
        ),
        null,
      ),
      records.length ? el('div', { class: 'set-row' },
        el('span', { class: 'set-label', text: '最早一条' }),
        el('span', { class: 'set-value', text: dateCN(`${oldest.getFullYear()}-${String(oldest.getMonth() + 1).padStart(2, '0')}-${String(oldest.getDate()).padStart(2, '0')}`) }),
      ) : null,
      el('div', { class: 'set-row' },
        el('span', { class: 'set-label', text: '是否已添加到主屏幕' }),
        el('span', { class: `set-value ${isInstalled() ? 'is-ok' : 'is-warn'}`, text: isInstalled() ? '已添加' : '未添加' }),
      ),
      el('div', { class: 'set-row' },
        el('span', { class: 'set-label', text: '本地快照' }),
        el('span', { class: 'set-value', text: snapshots.length ? `有 ${snapshots.length} 份` : '暂无' }),
      ),
    ),
    el('p', { class: 'set-note', text: '快照是本应用自己留的保险，能防住误删和数据库出错，但防不住"清除网站数据"和丢手机。真正能保住数据的只有下面的备份。' }),
  );
}

/* -------------------------------------------------------------------------
   入口
   ------------------------------------------------------------------------- */

export async function renderSettings(host, { settings, onChanged }) {
  const rerender = async () => {
    await onChanged();
  };

  // ---- 备份 ----
  const backupStatus = el('p', { class: 'set-note' });

  const describeLastBackup = () => {
    const at = settings.lastBackupAt;
    if (!at) return '还没有备份过。数据目前只在这台手机上。';
    const days = Math.floor((Date.now() - at) / 86400000);
    const d = new Date(at);
    const ds = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    return `上次备份：${ds}（${days === 0 ? '今天' : days + ' 天前'}）`;
  };

  const backupBtn = el('button', {
    type: 'button',
    class: 'btn-primary btn-xl',
    text: '把记录发给家人',
    // 这个点击处理器里绝不能有 await：navigator.share 需要瞬时用户激活，
    // 一旦让出执行权手势就失效了，调用会静默失败。数据在页面渲染时
    // 就已经预取好了，这里只做同步调用。
    onclick: async () => {
      const info = exportInfo();
      if (!info) {
        replace(backupStatus, '正在整理数据，请稍等两秒再点一次。');
        void prepareExport();
        return;
      }
      const res = await shareNow();
      if (res.reason === 'cancelled') {
        replace(backupStatus, '已取消。数据还没有发出去。');
        return;
      }
      if (!res.ok) {
        await alertDialog('分享没有成功。可以再试一次，或者在电脑上打开这个应用导出。');
        return;
      }
      // 分享面板正常关闭 ≠ 文件确实保存到了某处，
      // 所以措辞是"已发送"而不是"数据已安全备份"
      await setSetting('lastBackupAt', Date.now());
      settings.lastBackupAt = Date.now();
      replace(backupStatus, `已发送。${describeLastBackup()}`);
      await writeSnapshot();
    },
  });

  if (!canShare()) {
    replace(backupStatus, '这台设备不能直接分享文件，点下面的按钮会把文件下载下来（电脑上可用）。');
  } else {
    void prepareExport().then(() => {
      replace(backupStatus, describeLastBackup());
    });
  }

  // ---- 从文件恢复 ----
  const fileInput = el('input', {
    type: 'file',
    accept: '.json,application/json',
    style: { display: 'none' },
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;

    let parsed;
    try {
      parsed = await parseBackupFile(file);
    } catch (err) {
      await alertDialog(err.message);
      return;
    }

    const when = parsed.exportedAt ? `（导出于 ${parsed.exportedAt.slice(0, 10)}）` : '';
    const skipped = parsed.skipped ? `，另有 ${parsed.skipped} 条数据不完整已跳过` : '';

    const replaceAll = await confirmDialog(
      `这个文件里有 ${parsed.records.length} 条记录${when}${skipped}。\n\n`
      + '点「合并」会把它们加进来，原来的记录都保留。\n'
      + '点「先清空」，则会先删掉现有全部记录再导入。',
      { yes: '合并', no: '先清空' },
    );

    const mode = replaceAll ? 'merge' : 'replace';
    if (mode === 'replace') {
      const sure = await confirmDialog('确定要先删除现有全部记录吗？这一步不能撤销。', { yes: '确定删除', no: '取消' });
      if (!sure) return;
    }

    try {
      const n = await importRecords(parsed.records, mode);
      if (parsed.settings?.targets) await setSetting('targets', parsed.settings.targets);
      if (parsed.settings?.medNames) await setSetting('medNames', parsed.settings.medNames);
      await alertDialog(`已导入 ${n} 条记录。`);
      await writeSnapshot();
      await rerender();
    } catch (err) {
      await alertDialog(`导入没有成功：${err.message}`);
    }
  });

  const restoreBtn = el('button', {
    type: 'button',
    class: 'btn-plain btn-block',
    text: '从备份文件恢复',
    onclick: () => fileInput.click(),
  });

  // ---- 参考范围说明 ----
  const referenceNote = el('div', { class: 'set-group' },
    el('h2', { text: '参考范围说明' }),
    el('div', {},
      el('div', { class: 'set-row' },
        el('div', {},
          el('div', { class: 'set-label', text: '空腹血糖 4.4 – 7.0、餐后 < 10.0' }),
          el('div', { class: 'set-hint', text: '依据：中国2型糖尿病防治指南' }),
        ), null),
      el('div', { class: 'set-row' },
        el('div', {},
          el('div', { class: 'set-label', text: '糖化血红蛋白 < 7.0%' }),
          el('div', { class: 'set-hint', text: '依据：中国2型糖尿病防治指南' }),
        ), null),
      el('div', { class: 'set-row' },
        el('div', {},
          el('div', { class: 'set-label', text: '家庭自测血压 ≥ 135/85 提示偏高' }),
          el('div', { class: 'set-hint', text: '依据：中国高血压防治指南。家庭自测值通常低于诊室值，两者标准不同' }),
        ), null),
      el('div', { class: 'set-row' },
        el('div', {},
          el('div', { class: 'set-label', text: '合并糖尿病的降压目标 < 130/80' }),
          el('div', { class: 'set-hint', text: '临床常用参考，非指南条目' }),
        ), null),
    ),
    el('p', { class: 'set-note' },
      '本应用的数值来自《中国2型糖尿病防治指南》和《中国高血压防治指南》，'
      + '仅供记录和对照参考，不构成诊疗建议。请以医生为你设定的个体化目标为准。',
    ),
  );

  const about = el('div', { class: 'set-group' },
    el('h2', { text: '关于' }),
    el('p', { class: 'set-note' },
      '健康日记 —— 数据全部保存在这台手机上，不联网、不上传、不经过任何服务器。'
      + '卸载应用或清除浏览器数据会丢失记录，请定期用上面的按钮把记录发给家人保存。',
    ),
  );

  replace(host,
    el('div', { class: 'set-group' },
      el('h2', { text: '备份' }),
      el('p', { class: 'set-note', text: '记录只存在这台手机上。把记录发给家人保存一份，手机丢了或换手机也不会丢。' }),
      backupStatus,
      el('div', { style: { marginTop: '12px' } }, backupBtn),
      el('div', { style: { marginTop: '12px' } }, restoreBtn),
      fileInput,
    ),
    targetEditor(settings, rerender),
    medNamesEditor(settings, rerender),
    await dataCheck(settings),
    referenceNote,
    about,
  );
}

export { relDay, trim };
