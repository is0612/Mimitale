'use strict';

// 状态面板字段的「类型 / 范围 / 变化规则」。
// ⚠️ 必须能同时被两种环境加载：主进程 require（CommonJS）、渲染层 <script> 后读 window.PanelFields（浏览器没有具名导出，不能 import）。

const MAX_FIELD_NAME = 24;
const MAX_FIELD_VALUE = 500;
const MAX_FIELD_HINT = 200;
const MAX_FIELDS = 120;
const MAX_GROUP_TITLE = 24;

const FIELD_TYPES = ['text', 'meter', 'list'];

// 更新频率：dynamic 每轮维护（默认）/ static 变了才说；老数据没有这个键，一律按 dynamic。
const FIELD_MODES = ['dynamic', 'static'];
const DEFAULT_FIELD_MODE = 'dynamic';

/** 把「可能是数字」的值转成有限数字；null / 空串 / 非数字都返回 null */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 一个字段值是不是「数字」或「数字/数字」这种分数写法 */
function parseNumericValue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;

  // 50、50.5、-3
  if (/^[-+]?\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? { n, total: null } : null;
  }

  // 50/100 —— 面板里最常见的写法，斜杠两边都是数字才算
  const m = text.match(/^([-+]?\d+(?:\.\d+)?)\s*\/\s*([-+]?\d+(?:\.\d+)?)$/);
  if (m) {
    const n = Number(m[1]);
    const total = Number(m[2]);
    if (Number.isFinite(n) && Number.isFinite(total)) return { n, total };
  }

  return null;
}

/** 去掉多余的小数点：50.0 → 50，50.50 → 50.5 */
function trimNumber(n) {
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

function clampNumber(n, min, max) {
  let out = n;
  if (Number.isFinite(min)) out = Math.max(min, out);
  if (Number.isFinite(max)) out = Math.min(max, out);
  return out;
}

/** 把模型写的值夹回范围内并保留原写法（'150/100' → '100/100'）。
 *  解析不出数字就原样返回 —— 宁可不管，也不要因为模型写了个中文就把值抹掉；分母不动。 */
function clampFieldValue(value, field) {
  const text = String(value == null ? '' : value).trim();
  const f = field || {};
  if (f.type !== 'meter') return { value: text, clamped: false };

  const parsed = parseNumericValue(text);
  if (!parsed) return { value: text, clamped: false };

  const n = clampNumber(parsed.n, f.min, f.max);
  if (n === parsed.n) return { value: text, clamped: false };

  const out = parsed.total === null ? trimNumber(n) : `${trimNumber(n)}/${trimNumber(parsed.total)}`;
  return { value: out, clamped: true };
}

/** 归一化一个字段定义。类型不认识就退回 text —— 丢字段是静默失效，退类型至少还能用。 */
function normalizePanelField(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(raw.name == null ? '' : raw.name).trim().slice(0, MAX_FIELD_NAME);
  if (!name) return null;

  const type = FIELD_TYPES.includes(raw.type) ? raw.type : 'text';

  const field = {
    name,
    type,
    value: String(raw.value == null ? '' : raw.value).slice(0, MAX_FIELD_VALUE)
  };

  if (type === 'meter') {
    // 只认真正的数字：没有范围时 min/max 都不写，clampFieldValue 自然什么都不做。
    const min = toFiniteNumber(raw.min);
    const max = toFiniteNumber(raw.max);
    const hasMin = min !== null;
    const hasMax = max !== null;
    if (hasMin) field.min = min;
    if (hasMax) field.max = max;
    // 两个都有但写反了：换过来，别让范围变成空集
    if (hasMin && hasMax && field.min > field.max) {
      const t = field.min;
      field.min = field.max;
      field.max = t;
    }
  }

  const hint = String(raw.hint == null ? '' : raw.hint).trim().slice(0, MAX_FIELD_HINT);
  if (hint) field.hint = hint;

  const mode = FIELD_MODES.includes(raw.mode) ? raw.mode : DEFAULT_FIELD_MODE;
  if (mode !== DEFAULT_FIELD_MODE) field.mode = mode;

  // 分组：字段属于哪个命名面板。空 = 不分组（扁平清单）。
  const group = String(raw.group == null ? '' : raw.group).trim().slice(0, MAX_GROUP_TITLE);
  if (group) field.group = group;

  // 归属：'player' = 玩家自己；角色卡 id = 那个角色；空 = 场景 / 不归属。
  const owner = String(raw.owner == null ? '' : raw.owner).trim().slice(0, 40);
  if (owner) field.owner = owner;

  return field;
}

/** 数值字段的进度（percent 0~100），算不出来返回 null —— 调用方据此不画条。
 *  分母优先用值里写的（60/100 就是 100），没有就用字段的 max。 */
function fieldProgress(value, field) {
  const f = field || {};
  if (f.type !== 'meter') return null;

  const parsed = parseNumericValue(value);
  if (!parsed) return null;

  const total = parsed.total !== null ? parsed.total : Number.isFinite(f.max) ? f.max : null;
  if (total === null) return null;

  const base = Number.isFinite(f.min) ? f.min : 0;
  const span = total - base;
  // 满值 == 下限（范围是个点）时没有「进度」可言，直接给 0 而不是除零
  if (!Number.isFinite(span) || span === 0) return { n: parsed.n, total, percent: 0 };

  const percent = Math.max(0, Math.min(100, Math.round(((parsed.n - base) / span) * 100)));
  return { n: parsed.n, total, percent };
}

/** 按 group 分桶，返回 [{ id, title, fields }]，次序按字段第一次出现的顺序。
 *  id 空串那桶（没分组的）永远排最后 —— 不然零散字段会插在命名面板中间。 */
function groupPanelFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  const order = [];
  const buckets = new Map();

  for (const field of list) {
    if (!field) continue;
    const id = typeof field.group === 'string' ? field.group : '';
    if (!buckets.has(id)) {
      buckets.set(id, []);
      order.push(id);
    }
    buckets.get(id).push(field);
  }

  // 没分组的排到最后
  const named = order.filter((id) => id !== '');
  if (order.includes('')) named.push('');

  return named.map((id) => ({ id, title: id, fields: buckets.get(id) || [] }));
}

/** 归一化一组字段定义 */
function normalizePanelFields(list) {
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();
  for (const item of list) {
    const field = normalizePanelField(item);
    if (!field) continue;
    if (seen.has(field.name)) continue; // 重名只留第一个
    seen.add(field.name);
    out.push(field);
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

/** 字段在提示词里怎么描述自己 —— 范围 + 变化规则都在这 */
function describePanelField(field) {
  const f = field || {};
  const parts = [];

  if (f.type === 'meter') {
    if (typeof f.min === 'number' && typeof f.max === 'number') parts.push(`数值 ${f.min}~${f.max}`);
    else if (typeof f.max === 'number') parts.push(`数值（上限 ${f.max}）`);
    else if (typeof f.min === 'number') parts.push(`数值（下限 ${f.min}）`);
    else parts.push('数值');
  } else if (f.type === 'list') {
    parts.push('列表，多项用「、」隔开');
  }

  if (f.hint) parts.push(f.hint);

  // ⚠️ 不要给静态字段补「只在变化时输出」这类说明：会和上面的「必须输出」措辞打架，
  //    模型自判「没变」就整行省掉，正是「状态卡不更新」的成因之一。

  return parts.join('；');
}

// 渲染层通过 core/panel-fields.js 按需取用内部实现。
const PanelFields = {
  clampFieldValue,
  normalizePanelField,
  normalizePanelFields,
  groupPanelFields,
  fieldProgress,
  describePanelField,
  trimNumber
};

if (typeof module !== 'undefined' && module.exports) module.exports = PanelFields;
// 渲染层：<script> 加载时挂到 window（浏览器没有具名导出，不能 import）
if (typeof window !== 'undefined') window.PanelFields = PanelFields;
