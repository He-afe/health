/* ==========================================================================
   记录的展示与对照

   措辞上有一条硬规矩：只用"在目标内 / 高于目标 / 低于目标"这类
   事实性表述，绝不用"正常 / 异常 / 危险 / 不达标"。
   本应用的工作是拿数值和一条线做比较，不是下判断。
   界面上也不出现"应该""建议您"这类祈使句。
   ========================================================================== */

import { TYPES, GLUCOSE_TAGS } from './db.js';
import { el, trim, clock, pace, speed, relDay, dateCN } from './ui.js';

/** 每种类型对应的录入图标，和 forms.js 里保持一致 */
export const TYPE_ICON = {
  [TYPES.EXERCISE]: '🚶',
  [TYPES.GLUCOSE]: '🩸',
  [TYPES.BP]: '💗',
  [TYPES.WEIGHT]: '⚖️',
  [TYPES.HBA1C]: '🧪',
  [TYPES.MED]: '💊',
};

export const TYPE_NAME = {
  [TYPES.EXERCISE]: '运动',
  [TYPES.GLUCOSE]: '血糖',
  [TYPES.BP]: '血压',
  [TYPES.WEIGHT]: '体重',
  [TYPES.HBA1C]: '糖化血红蛋白',
  [TYPES.MED]: '用药',
};

/* -------------------------------------------------------------------------
   血糖对照
   ------------------------------------------------------------------------- */

/** 空腹类时点用空腹目标，其余用非空腹上限 */
const isFastingTag = (tag) => tag === '空腹' || tag === '凌晨';

/**
 * 返回 { level, text }。
 * level: 'low' | 'ok' | 'high' | null
 */
export function classifyGlucose(value, tag, targets) {
  if (!Number.isFinite(value)) return { level: null, text: '' };

  if (value < targets.glucoseHypo) {
    return { level: 'low', text: `低于 ${trim(targets.glucoseHypo, 1)}` };
  }
  if (isFastingTag(tag)) {
    if (value > targets.glucoseFastingHigh) return { level: 'high', text: '高于目标' };
    if (value < targets.glucoseFastingLow) return { level: 'low', text: '低于目标' };
    return { level: 'ok', text: '在目标内' };
  }
  if (value > targets.glucosePostHigh) return { level: 'high', text: '高于目标' };
  return { level: 'ok', text: '在目标内' };
}

/* -------------------------------------------------------------------------
   血压对照
   用家庭自测的标准，不是诊室标准——家庭自测值普遍偏低，
   拿 140/90 去套家庭数据会明显过度判读。
   ------------------------------------------------------------------------- */

export function classifyBP(systolic, diastolic, targets) {
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) {
    return { level: null, text: '' };
  }
  if (systolic >= targets.bpHomeSystolic || diastolic >= targets.bpHomeDiastolic) {
    return { level: 'high', text: '偏高' };
  }
  if (systolic >= targets.bpSystolicHigh || diastolic >= targets.bpDiastolicHigh) {
    return { level: 'high', text: '略高于目标' };
  }
  return { level: 'ok', text: '在目标内' };
}

/* -------------------------------------------------------------------------
   把一条记录整理成可展示的字段
   ------------------------------------------------------------------------- */

export function describe(rec, targets) {
  switch (rec.type) {
    case TYPES.EXERCISE: {
      const p = pace(rec.distanceKm, rec.durationMin);
      const v = speed(rec.distanceKm, rec.durationMin);
      return {
        icon: TYPE_ICON[rec.type],
        name: rec.kind || '运动',
        value: trim(rec.distanceKm, 2),
        unit: '公里',
        sub: [
          rec.durationMin ? `${trim(rec.durationMin, 0)} 分钟` : null,
          p ? `配速 ${p}/公里` : null,
          v ? `${trim(v, 1)} 公里/小时` : null,
        ].filter(Boolean).join(' · '),
        extra: [
          rec.calories ? `${trim(rec.calories, 0)} 千卡` : null,
          rec.avgHr ? `心率 ${trim(rec.avgHr, 0)}` : null,
        ].filter(Boolean).join(' · '),
        level: null,
        levelText: '',
      };
    }

    case TYPES.GLUCOSE: {
      const c = classifyGlucose(rec.value, rec.tag, targets);
      return {
        icon: TYPE_ICON[rec.type],
        name: '血糖',
        value: trim(rec.value, 1),
        unit: 'mmol/L',
        sub: rec.tag || '',
        extra: '',
        level: c.level,
        levelText: c.text,
      };
    }

    case TYPES.BP: {
      const c = classifyBP(rec.systolic, rec.diastolic, targets);
      return {
        icon: TYPE_ICON[rec.type],
        name: '血压',
        value: `${trim(rec.systolic, 0)}/${trim(rec.diastolic, 0)}`,
        unit: 'mmHg',
        sub: rec.pulse ? `脉搏 ${trim(rec.pulse, 0)}` : '',
        extra: '',
        level: c.level,
        levelText: c.text,
      };
    }

    case TYPES.WEIGHT:
      return {
        icon: TYPE_ICON[rec.type], name: '体重',
        value: trim(rec.value, 1), unit: '公斤',
        sub: '', extra: '', level: null, levelText: '',
      };

    case TYPES.HBA1C: {
      const high = rec.value > targets.hba1cHigh;
      return {
        icon: TYPE_ICON[rec.type], name: '糖化血红蛋白',
        value: trim(rec.value, 1), unit: '%',
        sub: '', extra: '',
        level: high ? 'high' : 'ok',
        levelText: high ? `高于 ${trim(targets.hba1cHigh, 1)}` : `低于 ${trim(targets.hba1cHigh, 1)}`,
      };
    }

    case TYPES.MED:
      return {
        icon: TYPE_ICON[rec.type], name: '用药',
        value: rec.name || '用药',
        unit: rec.dose != null ? `${trim(rec.dose, 2)}${rec.unit || ''}` : '',
        sub: clock(rec.timestamp), extra: '', level: null, levelText: '',
      };

    default:
      return { icon: '📄', name: rec.type, value: '', unit: '', sub: '', extra: '', level: null, levelText: '' };
  }
}

/* -------------------------------------------------------------------------
   记录列表项
   ------------------------------------------------------------------------- */

/**
 * 一行记录。整行可点，点了进编辑。
 * 右侧做成一整块而不是一个小箭头，父母更容易点中。
 */
export function recordRow(rec, targets, { todayStr, onOpen }) {
  const d = describe(rec, targets);

  const levelClass = d.level === 'low' ? 'lv-low'
    : d.level === 'high' ? 'lv-high'
    : d.level === 'ok' ? 'lv-ok' : '';

  return el('button', {
    type: 'button',
    class: 'rec',
    onclick: () => onOpen && onOpen(rec),
  },
    el('span', { class: 'rec-icon', text: d.icon }),
    el('span', { class: 'rec-main' },
      el('span', { class: 'rec-top' },
        el('span', { class: 'rec-val', text: d.value }),
        d.unit ? el('span', { class: 'rec-unit', text: d.unit }) : null,
        d.levelText ? el('span', { class: `rec-flag ${levelClass}`, text: d.levelText }) : null,
      ),
      (d.sub || d.extra)
        ? el('span', { class: 'rec-sub', text: [d.sub, d.extra].filter(Boolean).join(' · ') })
        : null,
    ),
    el('span', { class: 'rec-when', text: `${relDay(rec.date, todayStr)} ${clock(rec.timestamp)}` }),
  );
}

export { isFastingTag, dateCN, GLUCOSE_TAGS };
