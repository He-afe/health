/* ==========================================================================
   录入表单
   这是父母每天要重复做的动作，所以整个文件的设计目标只有一个：
   把"打开 → 填写 → 保存"压到最少步数。

   几个刻意的取舍：
   - 日期/时间字段默认填好，看得见但不用操作（需要补录昨天数据时又能改）
   - 血糖的测量时点用大按钮平铺，不用下拉框（下拉框在老人手里很难点准）
   - 数字字段全部唤起数字键盘
   - 保存后给满屏大对勾，不给 toast
   ========================================================================== */

import {
  GLUCOSE_TAGS, EXERCISE_KINDS, DOSE_UNITS,
  TYPES, dateKey, daysAgoKey, uid,
} from './db.js';
import { el, replace, trim, pace, speed, confirmDialog } from './ui.js';

/* -------------------------------------------------------------------------
   字段定义
   type: 'date' | 'time' | 'number' | 'choice' | 'text'
   ------------------------------------------------------------------------- */

const F_DATE = {
  key: 'date', label: '日期', type: 'date', required: true,
};

const F_TIME = {
  key: 'time', label: '时间', type: 'time', required: true,
  hint: '默认是现在，不用改',
};

export const FORMS = {
  [TYPES.EXERCISE]: {
    title: '记录运动',
    icon: '🚶',
    fields: [
      F_DATE,
      {
        key: 'kind', label: '运动方式', type: 'choice',
        options: EXERCISE_KINDS, required: true,
      },
      {
        key: 'distanceKm', label: '走了多远', type: 'number', unit: '公里',
        min: 0.01, max: 200, decimals: 2, required: true, placeholder: '如 3.2',
      },
      {
        key: 'durationMin', label: '用了多少时间', type: 'number', unit: '分钟',
        min: 1, max: 1440, decimals: 0, required: true, placeholder: '如 45',
      },
      {
        key: 'calories', label: '消耗热量', type: 'number', unit: '千卡',
        min: 1, max: 5000, decimals: 0, optional: true, placeholder: '不知道可以不填',
      },
      {
        key: 'avgHr', label: '平均心率', type: 'number', unit: '次/分',
        min: 30, max: 220, decimals: 0, optional: true, placeholder: '不知道可以不填',
      },
    ],
  },

  [TYPES.GLUCOSE]: {
    title: '记录血糖',
    icon: '🩸',
    fields: [
      F_DATE,
      F_TIME,
      {
        key: 'value', label: '血糖值', type: 'number', unit: 'mmol/L',
        min: 1.0, max: 33.3, decimals: 1, required: true, placeholder: '如 6.4',
      },
      {
        key: 'tag', label: '什么时候测的', type: 'choice',
        options: GLUCOSE_TAGS, required: true,
        hint: '已按当前时间预选，如果不对请点一下改正',
      },
    ],
  },

  [TYPES.BP]: {
    title: '记录血压',
    icon: '💗',
    fields: [
      F_DATE,
      F_TIME,
      {
        key: 'systolic', label: '高压（收缩压）', type: 'number', unit: 'mmHg',
        min: 60, max: 260, decimals: 0, required: true, placeholder: '如 128',
      },
      {
        key: 'diastolic', label: '低压（舒张压）', type: 'number', unit: 'mmHg',
        min: 30, max: 160, decimals: 0, required: true, placeholder: '如 82',
      },
      {
        key: 'pulse', label: '脉搏', type: 'number', unit: '次/分',
        min: 30, max: 220, decimals: 0, optional: true, placeholder: '不知道可以不填',
      },
    ],
  },

  [TYPES.WEIGHT]: {
    title: '记录体重',
    icon: '⚖️',
    fields: [
      F_DATE,
      {
        key: 'value', label: '体重', type: 'number', unit: '公斤',
        min: 20, max: 200, decimals: 1, required: true, placeholder: '如 65.5',
      },
    ],
  },

  [TYPES.HBA1C]: {
    title: '记录糖化血红蛋白',
    icon: '🧪',
    fields: [
      F_DATE,
      {
        key: 'value', label: '糖化血红蛋白', type: 'number', unit: '%',
        min: 3, max: 20, decimals: 1, required: true, placeholder: '如 6.8',
        hint: '医院化验单上的 HbA1c，一般三个月左右测一次',
      },
    ],
  },

  [TYPES.MED]: {
    title: '记录用药',
    icon: '💊',
    fields: [
      F_DATE,
      F_TIME,
      {
        key: 'name', label: '药名', type: 'text', required: true,
        placeholder: '如 二甲双胍',
        // 有预设药名时点一下就填上，不用打字
        presets: 'medNames',
      },
      {
        key: 'dose', label: '吃了多少', type: 'number', unit: '', decimals: 2,
        min: 0, max: 10000, optional: true, placeholder: '如 1',
      },
      {
        key: 'unit', label: '单位', type: 'choice',
        options: DOSE_UNITS, optional: true,
      },
    ],
  },
};

/* -------------------------------------------------------------------------
   工具
   ------------------------------------------------------------------------- */

/** 把日期 + 时间字符串合成时间戳（本地时区） */
export function toTimestamp(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let hh = 12, mi = 0;   // 没给时间就用正午，保证排序落在当天中间
  if (timeStr) {
    const parts = timeStr.split(':').map(Number);
    hh = parts[0] || 0;
    mi = parts[1] || 0;
  }
  return new Date(y, m - 1, d, hh, mi, 0, 0).getTime();
}

/** 时间戳 -> "HH:MM"，给 time 输入框用 */
function toTimeInput(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 按当前时间猜一个血糖时点，只是预选，用户随时能改。
 * 对应国内常见的作息：早饭 7-8 点、午饭 12 点、晚饭 18 点，
 * 餐后 2 小时就是 10 / 14 / 20 点左右。
 */
function guessGlucoseTag() {
  const h = new Date().getHours();
  if (h < 6) return '凌晨';
  if (h < 9) return '空腹';
  if (h < 11) return '餐后2h';
  if (h < 12) return '餐前';
  if (h < 15) return '餐后2h';
  if (h < 18) return '餐前';
  if (h < 21) return '餐后2h';
  return '睡前';
}

/* -------------------------------------------------------------------------
   表单渲染
   ------------------------------------------------------------------------- */

let current = null;   // 当前打开的表单状态

/**
 * 打开录入表单。
 * @param {string} type   记录类型
 * @param {object} [record]  传入则是编辑已有记录
 * @param {object} [prefill] 额外预填值，例如从某个卡片点进来时锁定的时点
 * @returns {Promise<object|null>} 保存后的记录；用户取消则返回 null
 */
export function openForm(type, record = null, prefill = {}) {
  const spec = FORMS[type];
  if (!spec) throw new Error(`未知的记录类型：${type}`);

  // 上一个表单还开着就先把它的 Promise 结掉，避免悬空
  if (current) current.finish(null);

  const isEdit = !!record;

  // ---- 初始值 ----
  const values = {};
  for (const f of spec.fields) {
    if (f.type === 'date') values[f.key] = record?.date || dateKey();
    else if (f.type === 'time') values[f.key] = toTimeInput(record?.timestamp || Date.now());
    else if (f.type === 'choice') values[f.key] = record?.[f.key] ?? prefill[f.key] ?? null;
    else values[f.key] = record?.[f.key] ?? prefill[f.key] ?? '';
  }
  if (!isEdit) {
    if (type === TYPES.EXERCISE && !values.kind) values.kind = EXERCISE_KINDS[0];
    if (type === TYPES.GLUCOSE && !values.tag) values.tag = guessGlucoseTag();
  }

  const inputs = {};      // key -> 输入节点，用于回读和标错
  const errors = {};      // key -> 错误提示节点
  const dirtyFlag = { dirty: false };
  const cleanupFns = [];  // 关闭表单时要卸掉的监听器
  let saving = false;     // 防止连点两次保存产生两条记录

  // finish() 定义在下面 openForm 的函数体层级，而 resolve 是 Promise
  // 执行器的参数——两者不在同一个作用域里。所以必须把它捞到外层来，
  // 否则每次保存和取消都会抛 "resolve is not defined"。
  let resolveForm;

  return new Promise((resolve) => {
    resolveForm = resolve;

    const wrap = document.getElementById('sheet');
    const body = document.getElementById('sheetBody');
    const title = document.getElementById('sheetTitle');
    const btnSave = document.getElementById('sheetSave');

    replace(title, isEdit ? `修改${spec.title.slice(2)}` : spec.title);

    // ---- 逐个字段构造 ----
    const fieldNodes = spec.fields.map((f) => {
      const errorNode = el('p', { class: 'field-error', hidden: true });
      errors[f.key] = errorNode;

      let control;
      if (f.type === 'choice') {
        control = buildChoices(f, values, dirtyFlag);
      } else if (f.type === 'date') {
        control = buildDateField(f, values, dirtyFlag, inputs);
      } else {
        control = buildInput(f, values, dirtyFlag, inputs);
      }

      const extra = [errorNode];
      if (f.hint) extra.push(el('p', { class: 'field-hint', text: f.hint }));

      // 运动表单的实时配速显示挂在"用时"字段下面
      const derived = f.key === 'durationMin' ? el('div', { class: 'derived', hidden: true }) : null;
      if (derived) extra.push(derived);

      return el('div', { class: 'field' },
        el('label', { class: 'field-label', for: `f-${f.key}`, text: f.label }),
        control,
        extra,
      );
    });

    replace(body, fieldNodes);

    current = {
      type, record, spec, values, inputs, errors, dirtyFlag, resolve,
      finish,
    };

    // ---- 运动的配速实时计算 ----
    let updateDerived = () => {};
    if (type === TYPES.EXERCISE) {
      const derivedNode = body.querySelector('.derived');
      updateDerived = () => {
        const d = parseFloat(inputs.distanceKm?.value);
        const t = parseFloat(inputs.durationMin?.value);
        const p = pace(d, t);
        const v = speed(d, t);
        if (p) {
          derivedNode.hidden = false;
          replace(derivedNode,
            `平均配速 ${p} / 公里`,
            el('span', { style: { opacity: '.75' }, text: `　（约 ${trim(v, 1)} 公里/小时）` }),
          );
        } else {
          derivedNode.hidden = true;
        }
      };
      inputs.distanceKm?.addEventListener('input', updateDerived);
      inputs.durationMin?.addEventListener('input', updateDerived);
      updateDerived();
    }

    // ---- 按钮 ----
    const btnCancel = document.getElementById('sheetCancel');
    const onCancel = async () => {
      // 填了一半就退出的话先问一句，避免父母误触丢失输入
      if (dirtyFlag.dirty) {
        const ok = await confirmDialog('刚填的内容还没有保存，确定要退出吗？', { yes: '退出', no: '继续填' });
        if (!ok) return;
      }
      finish(null);
    };
    const onSave = () => {
      // 连点两次会存成两条一模一样的记录，直接锁住
      if (saving) return;

      const vals = readValues(spec, inputs, values);
      const problem = validate(type, spec, vals);
      if (problem) {
        markError(problem.key, problem.message);
        document.getElementById(`f-${problem.key}`)?.focus();
        return;
      }
      clearErrors(spec, errors);

      saving = true;
      btnSave.disabled = true;
      finish(buildRecord(type, vals, record));
    };

    btnCancel.addEventListener('click', onCancel);
    btnSave.addEventListener('click', onSave);

    // ---- 编辑时的删除入口 ----
    // 刻意不做"列表里左滑删除"：这种手势对老人基本不可发现，
    // 而且误触的代价很高。放在编辑页里，一步一确认，看得见也退得回。
    const foot = btnSave.parentElement;
    foot.querySelector('.btn-delete-rec')?.remove();
    if (isEdit) {
      foot.insertBefore(el('button', {
        type: 'button',
        class: 'btn-plain btn-delete-rec',
        text: '删除这条记录',
        onclick: async () => {
          const ok = await confirmDialog('确定要删除这条记录吗？删掉之后不能恢复。', { yes: '删除', no: '取消' });
          if (!ok) return;
          finish({ __delete: true, id: record.id });
        },
      }), btnSave);
    }

    // ---- 键盘避让 ----
    // iOS 弹出键盘时只缩小 visual viewport，布局视口不变，
    // 所以 bottom:0 的固定 footer 会被键盘整个盖住——而数字键盘又没有回车键
    // 可以把它收起来，不处理的话父母会卡在"填完了但按不到保存"。
    const vv = window.visualViewport;
    const fit = () => { if (vv) wrap.style.height = `${vv.height}px`; };
    fit();
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    cleanupFns.push(() => {
      vv?.removeEventListener('resize', fit);
      vv?.removeEventListener('scroll', fit);
      wrap.style.height = '';
    });

    wrap.hidden = false;
    // 刻意不自动聚焦第一个输入框：键盘会立刻弹出来挡住上面还没填的字段
  });

  /* ---------- 内部函数 ---------- */

  function finish(result) {
    const w = document.getElementById('sheet');
    w.hidden = true;
    replace(document.getElementById('sheetBody'));
    // 卸掉键盘监听，免得表单关掉之后还在改 DOM
    for (const fn of cleanupFns) fn();
    cleanupFns.length = 0;
    document.getElementById('sheetSave').disabled = false;
    saving = false;
    current = null;
    resolveForm(result);
  }

  function markError(key, message) {
    const node = errors[key];
    if (!node) return;
    node.hidden = false;
    replace(node, message);
    inputs[key]?.classList.add('is-bad');
    // 出错的字段滚动到可见位置
    node.closest('.field')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* -------------------------------------------------------------------------
   控件构造
   ------------------------------------------------------------------------- */

/**
 * 日期字段：上面三个快捷按钮，下面一个原生日期框。
 *
 * 为什么非要加这三个按钮：这个年龄段最常见的录入错误，是
 * 第二天早上补录昨晚的数据、结果顺手记成了今天。
 * 多给一个「昨天」按钮，比事后在图表里发现异常要划算得多。
 */
function buildDateField(f, values, dirtyFlag, inputs) {
  const input = el('input', {
    id: `f-${f.key}`,
    class: 'field-input',
    type: 'date',
    value: values[f.key] || dateKey(),
  });
  inputs[f.key] = input;

  const buttons = [
    { label: '今天', days: 0 },
    { label: '昨天', days: 1 },
    { label: '前天', days: 2 },
  ].map(({ label, days }) => {
    const key = daysAgoKey(days);
    return el('button', {
      type: 'button',
      class: 'choice' + (values[f.key] === key ? ' is-on' : ''),
      text: label,
      dataset: { key },
      onclick: () => {
        values[f.key] = key;
        input.value = key;
        dirtyFlag.dirty = true;
        for (const b of buttons) b.classList.toggle('is-on', b.dataset.key === key);
      },
    });
  });

  const sync = () => {
    const v = input.value;
    if (!v) return;
    values[f.key] = v;
    dirtyFlag.dirty = true;
    for (const b of buttons) b.classList.toggle('is-on', b.dataset.key === v);
  };
  // iOS 上图省事的键盘/滚轮都可能只触发其中一个，两个都听
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);

  return el('div', {},
    el('div', { class: 'choices' }, buttons),
    el('div', { class: 'field-row', style: { marginTop: '10px' } }, input),
  );
}

function buildInput(f, values, dirtyFlag, inputs) {
  const type = f.type === 'number' ? 'text' : f.type;
  // 数字字段用 text + inputmode，而不是 type=number。
  // iOS 上 type=number 会带上下箭头、且允许输入 e/+-，还容易滚轮误改。
  const attr = {
    id: `f-${f.key}`,
    class: 'field-input',
    value: values[f.key] ?? '',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: false,
  };
  if (f.type === 'number') {
    attr.inputMode = 'decimal';
    attr.inputmode = 'decimal';
  }
  if (f.placeholder) attr.placeholder = f.placeholder;

  const input = el('input', attr);
  inputs[f.key] = input;

  input.addEventListener('input', () => {
    dirtyFlag.dirty = true;
    input.classList.remove('is-bad');
    // 数字字段只保留数字和小数点，避免父母按到别的键
    if (f.type === 'number') {
      const cleaned = input.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
      if (cleaned !== input.value) input.value = cleaned;
    }
  });

  const row = el('div', { class: 'field-row' }, input);
  if (f.unit) row.appendChild(el('span', { class: 'field-unit', text: f.unit }));
  return row;
}

function buildChoices(f, values, dirtyFlag) {
  const wrap = el('div', { class: 'choices', id: `f-${f.key}` });
  const buttons = [];

  for (const opt of f.options) {
    const btn = el('button', {
      type: 'button',
      class: 'choice' + (values[f.key] === opt ? ' is-on' : ''),
      text: opt,
      onclick: () => {
        values[f.key] = values[f.key] === opt ? null : opt;
        dirtyFlag.dirty = true;
        for (const b of buttons) b.classList.toggle('is-on', b.textContent === values[f.key]);
      },
    });
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  return wrap;
}

/* -------------------------------------------------------------------------
   读值、校验、组装记录
   ------------------------------------------------------------------------- */

function readValues(spec, inputs, values) {
  const out = {};
  for (const f of spec.fields) {
    if (f.type === 'choice') out[f.key] = values[f.key];
    else if (f.type === 'text') out[f.key] = (inputs[f.key]?.value || '').trim();
    else if (f.type === 'number') {
      const raw = (inputs[f.key]?.value || '').trim();
      out[f.key] = raw === '' ? null : Number(raw);
    } else out[f.key] = inputs[f.key]?.value || '';
  }
  return out;
}

function clearErrors(spec, errors) {
  for (const f of spec.fields) {
    const node = errors[f.key];
    if (node) node.hidden = true;
  }
}

/** 返回第一条错误 {key, message}，全部通过则返回 null */
export function validate(type, spec, v) {
  for (const f of spec.fields) {
    const value = v[f.key];

    if (f.required && (value == null || value === '')) {
      return { key: f.key, message: `请填写${f.label}` };
    }
    if (f.type === 'number' && value != null) {
      // 用 isFinite 而不是 isNaN：NaN 和 ±Infinity 都会让后面的图表坐标算出 NaN，
      // 结果是整张图静默消失、且不报任何错
      if (!Number.isFinite(value)) return { key: f.key, message: `${f.label}请填数字` };
      if (value < f.min || value > f.max) {
        return {
          key: f.key,
          message: `${f.label}应该在 ${trim(f.min, f.decimals)} 到 ${trim(f.max, f.decimals)} 之间，请检查一下`,
        };
      }
    }
  }

  // 血压的高低压是相关的，单独校验
  if (type === TYPES.BP && v.systolic != null && v.diastolic != null) {
    if (v.systolic <= v.diastolic) {
      return { key: 'systolic', message: '高压应该比低压大，请检查是不是填反了' };
    }
  }

  return null;
}

/** 把表单值组装成入库的记录 */
function buildRecord(type, v, existing) {
  const rec = {
    id: existing?.id || uid(),
    type,
    date: v.date,
    timestamp: toTimestamp(v.date, v.time),
  };
  if (existing?.note) rec.note = existing.note;

  switch (type) {
    case TYPES.EXERCISE:
      rec.kind = v.kind;
      rec.distanceKm = v.distanceKm;
      rec.durationMin = v.durationMin;
      if (v.calories != null) rec.calories = v.calories;
      if (v.avgHr != null) rec.avgHr = v.avgHr;
      break;
    case TYPES.GLUCOSE:
      rec.value = v.value;
      rec.tag = v.tag;
      break;
    case TYPES.BP:
      rec.systolic = v.systolic;
      rec.diastolic = v.diastolic;
      if (v.pulse != null) rec.pulse = v.pulse;
      break;
    case TYPES.WEIGHT:
    case TYPES.HBA1C:
      rec.value = v.value;
      break;
    case TYPES.MED:
      rec.name = v.name;
      if (v.dose != null) rec.dose = v.dose;
      if (v.unit) rec.unit = v.unit;
      break;
  }
  return rec;
}
