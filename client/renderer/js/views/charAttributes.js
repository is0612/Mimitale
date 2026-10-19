'use strict';

// views/charAttributes.js —— 角色属性编辑界面（分组标签 + 字段行）
// 填的是初始值（模板），进游戏后改的是那一局的当前值；分组只是视图键，数据仍是一维数组。

import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { h, button, clear, append } from '../ui/build.js';
// 「＋ 新建分组」用一次性药丸输入框（ui/controls.js）
import { input } from '../ui/controls.js';
import { MAX_PANEL_FIELDS, panelFieldAllowed } from '../data/panel.js';
import { mInput, mSelect, mButton } from '../components/index.js';
import { setCharSectionCount } from './characterEditorLayout.js';

const ATTR_TYPES = [
  { value: 'text', label: '文本' },
  { value: 'meter', label: '数值' },
  { value: 'list', label: '列表' }
];

// ⚠️ 「变了才说」的风险必须写在选项文字上，不能只藏 tooltip（漏更新已踩过两次）。
// 这里不准写死具体字段名（穿着/钱包…），那是用户自己的卡。
const ATTR_MODES = [
  { value: 'dynamic', label: '每轮维护' },
  { value: 'static', label: '变了才说（有漏更新的风险）' }
];

/** 官方互动模板的预设分组；组名与 main/card-import.js 的 TEMPLATE_GROUP_LABELS 对齐 */
const INTERACTIVE_TEMPLATE = [
  {
    group: '状态栏',
    fields: [
      { name: '时间', type: 'text', value: '' },
      { name: '地点', type: 'text', value: '' },
      { name: '心情', type: 'text', value: '' }
    ]
  },
  {
    group: '关系',
    fields: [
      {
        name: '好感度',
        type: 'meter',
        min: 0,
        max: 100,
        value: '0',
        hint: '对方示好时每轮最多加 10，被冒犯时下降'
      },
      {
        name: '关系阶段',
        type: 'text',
        value: '陌生',
        hint: '按好感度自动：低于 30 陌生，30~59 熟人，60 以上亲密'
      }
    ]
  },
  {
    group: '背包',
    fields: [
      { name: '物品', type: 'list', value: '' }
    ]
  }
];

/** 未分组这一桶的标题；数据上它对应 group === '' */
const UNGROUPED_TITLE = '未分组';

/** 「＋ 新建分组…」的哨兵值；铺选项时过滤掉同名真实分组 */
const NEW_GROUP_VALUE = '__new_group__';

// 视图状态（_activeGroup 等）挂在草稿数组上：换角色自然重置，自定义属性也不会被 JSON.stringify 带走。
// ⚠️ 不能挂到字段对象上 —— 保存时字段整体展开写盘，会被写进角色卡（_moreOpen 就是为此手动 delete）。
function activeGroupOf(list) {
  return typeof list._activeGroup === 'string' ? list._activeGroup.trim() : '';
}

// 分组的创建顺序（挂在草稿数组上，规则同 _activeGroup）。
// 不按字段先后排：那样空组会随字段增删在标签栏里前后跳。
function groupOrderOf(list) {
  if (!Array.isArray(list._groupOrder)) {
    // 首次渲染用「字段里第一次出现的顺序」当初值，空组跟在后面
    const seed = [];
    const seen = new Set();
    const push = (raw) => {
      const id = String(raw || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      seed.push(id);
    };
    for (const attr of list) if (attr) push(attr.group);
    for (const raw of list._extraGroups || []) push(raw);
    list._groupOrder = seed;
  }
  return list._groupOrder;
}

/**
 * 把草稿按分组分桶，按创建顺序铺（语义与 main/panel-fields.js 的 groupPanelFields 一致）。
 */
function bucketsOf(list) {
  const order = groupOrderOf(list);
  const map = new Map();

  for (const attr of list) {
    if (!attr) continue;
    const id = String(attr.group || '').trim();
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(attr);
    // 在「更多」里手打出来的新分组名：补到创建顺序的末尾
    if (id && !order.includes(id)) order.push(id);
  }

  // 空组（还没有字段引用它）只活在 _extraGroups 里，不兜住会被下次重画吃掉
  for (const raw of list._extraGroups || []) {
    const id = String(raw || '').trim();
    if (id && !map.has(id)) map.set(id, []);
  }

  // 顺序表里已经没有的分组（被解散了）直接跳过
  const named = order.filter((id) => id !== '' && map.has(id));
  // 「未分组」只在两种情况下出现：真的有零散字段，或者一个分组都还没有
  // （新建角色就是这种 —— 总得有个地方落笔）。它永远排最后。
  if (map.has('') || !named.length) named.push('');

  return named.map((id) => ({ id, title: id || UNGROUPED_TITLE, fields: map.get(id) || [] }));
}

/** 重画属性区：只铺当前分组的字段、「更多」里的输入框不重画（否则光标会跳走） */
export function renderCharAttrs(list) {
  if (!el.c.attrList) return;
  const draft = Array.isArray(list) ? list : [];

  // 分区导航计数：0 也照显示
  setCharSectionCount('state', String(draft.length));

  const buckets = bucketsOf(draft);
  // 选中的组已不存在（被删空 / 换了角色）时退回第一个桶
  let active = activeGroupOf(draft);
  if (!buckets.some((bucket) => bucket.id === active)) active = buckets[0].id;
  draft._activeGroup = active;

  const current = buckets.find((bucket) => bucket.id === active) || buckets[0];

  renderAttrTabs(draft, buckets, active);
  renderAttrGroupEdit(draft, current);
  renderAttrRows(draft, current);
  renderAttrAddRow(current);
}

/** 切到某个分组；点的就是当前组则不动 —— 白重画会清掉输入框里没提交的字 */
function selectGroup(list, id) {
  if (activeGroupOf(list) === id) return;
  list._activeGroup = id;
  // 换组要收起上一组的改名/删除条与新建输入框
  list._groupEditOpen = false;
  list._movingName = '';
  renderCharAttrs(list);
}

/** 新建一个空分组并切过去；空组只记在 _extraGroups 里（还没有字段引用它） */
function createGroup(list, rawName) {
  const name = String(rawName || '').trim().slice(0, 24);
  if (!name) return;

  if (name === UNGROUPED_TITLE) {
    selectGroup(list, '');
    return;
  }

  const order = groupOrderOf(list);
  if (!order.includes(name)) order.push(name);

  if (!bucketsOf(list).some((bucket) => bucket.id === name)) {
    list._extraGroups = [...(list._extraGroups || []), name];
  }
  selectGroup(list, name);
}

/** 给分组改名：改这一组下所有字段的 group；撞名则并组，改成「未分组」等于解散 */
function renameGroup(list, from, to) {
  const name = String(to || '').trim().slice(0, 24);
  if (!name || name === from) return;

  const target = name === UNGROUPED_TITLE ? '' : name;
  const merging = !!target && bucketsOf(list).some((bucket) => bucket.id === target);

  let moved = 0;
  for (const attr of list) {
    if (!attr) continue;
    if (String(attr.group || '').trim() !== from) continue;
    if (target) attr.group = target;
    else delete attr.group;
    moved += 1;
  }

  const order = groupOrderOf(list);
  const at = order.indexOf(from);
  if (at >= 0) {
    // 并组时被并掉的位置要消失，改成新名字则原地替换
    if (target && !merging) order[at] = target;
    else order.splice(at, 1);
  }

  // 空组也要跟着改名，否则改完就消失了
  const extras = (list._extraGroups || []).filter((g) => String(g || '').trim() !== from);
  if (target && !merging && !moved && !extras.includes(target)) extras.push(target);
  list._extraGroups = extras;

  list._activeGroup = target;
  list._groupEditOpen = false;
  renderCharAttrs(list);

  if (merging) showToast(`已并入「${target}」`, 'ok');
  else if (target) showToast(`分组已改名为「${target}」`, 'ok');
  else showToast(`「${from}」已解散，${moved} 个属性退回「未分组」`, 'ok');
}

/** 解散分组：字段不删，退回「未分组」；组里有字段时先确认 */
async function deleteGroup(list, id) {
  const group = String(id || '').trim();
  if (!group) return; // 「未分组」不能删 —— 字段总得有地方落

  const bucket = bucketsOf(list).find((b) => b.id === group);
  const count = bucket ? bucket.fields.length : 0;

  if (count) {
    const ok = await confirmDialog({
      title: '解散分组',
      message: `「${group}」下面的 ${count} 个属性会退回「未分组」，属性本身不会被删掉。`,
      confirmText: '解散这一组',
      danger: true
    });
    if (!ok) return;
  }

  for (const attr of list) {
    if (!attr) continue;
    if (String(attr.group || '').trim() !== group) continue;
    delete attr.group;
  }
  list._extraGroups = (list._extraGroups || []).filter((g) => String(g || '').trim() !== group);
  const order = groupOrderOf(list);
  const at = order.indexOf(group);
  if (at >= 0) order.splice(at, 1);

  list._activeGroup = '';
  list._groupEditOpen = false;
  renderCharAttrs(list);

  showToast(count ? `已解散「${group}」，${count} 个属性退回「未分组」` : `已删除空分组「${group}」`);
}

/** 分组标签栏：每个标签是「组名 + 字段数」，数字是判断有没有填漏的依据 */
function renderAttrTabs(list, buckets, active) {
  if (!el.c.attrTabs) return;
  clear(el.c.attrTabs);

  for (const bucket of buckets) {
    const tab = button({
      class: ['attr-tab', bucket.id === active && 'active'],
      title: bucket.id ? `分组：${bucket.id}` : '还没有归到任何分组的属性',
      onClick: () => selectGroup(list, bucket.id)
    });

    // ⚠️ 组名与数字之间那个空格不能省、也不能换成 CSS gap：flex 里空白文本节点不参与排版，
    //    但仍算进 textContent，冒烟测试按「关系 3」整串比对。
    append(tab, [
      h('span', { class: 'attr-tab-name', text: bucket.title }),
      ' ',
      h('span', { class: 'attr-tab-count', text: String(bucket.fields.length) })
    ]);

    el.c.attrTabs.appendChild(tab);
  }

  // 「＋ 新建分组」长得像标签但其实是输入框，回车确认
  el.c.attrTabs.appendChild(
    input({
      class: 'attr-tab-new',
      placeholder: '＋ 新建分组',
      'aria-label': '新建分组，回车确认',
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        createGroup(list, event.currentTarget.value);
      }
    })
  );

  // 「⋯ 管理这一组」只在命名分组上出现（未分组不能改名/删除），靠 margin-left:auto 推到最右
  if (active) {
    el.c.attrTabs.appendChild(
      button({
        class: ['attr-tab-edit', list._groupEditOpen === true && 'on'],
        text: '⋯',
        title: `重命名或删除「${active}」`,
        ariaLabel: '重命名或删除当前分组',
        onClick: () => {
          list._groupEditOpen = list._groupEditOpen !== true;
          renderCharAttrs(list);
        }
      })
    );
  }
}

/** 分组操作条：改名 + 解散，只在当前组有名字时铺 */
function renderAttrGroupEdit(list, bucket) {
  if (!el.c.attrGroupEdit) return;
  clear(el.c.attrGroupEdit);

  const open = list._groupEditOpen === true && !!bucket.id;
  el.c.attrGroupEdit.classList.toggle('hidden', !open);
  if (!open) return;

  const nameInput = mInput({
    class: 'attr-group-name',
    size: 'sm',
    value: bucket.id,
    maxlength: '24',
    placeholder: '分组名',
    'aria-label': '分组名',
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        nameInput.blur(); // 失焦触发下面的 change，提交走同一条路
      } else if (event.key === 'Escape') {
        // 必须 stopPropagation：全局 Esc 链会顺手把整个角色编辑器关掉
        event.preventDefault();
        event.stopPropagation();
        list._groupEditOpen = false;
        renderCharAttrs(list);
      }
    },
    // 用 change 而不是 input：每敲一个字重画会踢走光标
    onchange: () => {
      const next = nameInput.value.trim().slice(0, 24);
      if (!next || next === bucket.id) {
        nameInput.value = bucket.id;
        return;
      }
      renameGroup(list, bucket.id, next);
    }
  });

  append(el.c.attrGroupEdit, [
    h('span', { class: 'attr-group-edit-label', text: '分组名' }),
    nameInput,
    mButton({
      variant: 'danger',
      size: 'sm',
      text: '解散这一组',
      title: bucket.fields.length
        ? `把这 ${bucket.fields.length} 个属性退回「未分组」`
        : '删掉这个空分组',
      onClick: () => deleteGroup(list, bucket.id)
    })
  ]);
}

/** 铺当前分组的字段行：名字 + 初始值 + 类型 + 更多 */
function renderAttrRows(list, bucket) {
  clear(el.c.attrList);

  // 空组给句话，否则看不出是空的还是坏了
  if (!bucket.fields.length) {
    el.c.attrList.appendChild(
      h('div', {
        class: 'attr-empty',
        text: bucket.id
          ? `「${bucket.title}」这一组还是空的 —— 在下面加一个属性`
          : '还没有属性 —— 在下面加一个，比如「金币」'
      })
    );
    return;
  }

  for (const attr of bucket.fields) {
    const valueInput = mInput({
      class: 'attr-value',
      size: 'sm',
      value: attr.value,
      placeholder: '初始值（可以留空）',
      'aria-label': `${attr.name} 的初始值`,
      oninput: () => {
        attr.value = valueInput.value;
      }
    });

    const typeSelect = mSelect(
      {
        class: 'attr-type',
        size: 'xs',
        'aria-label': `${attr.name} 的类型`,
        title: '字段类型：数值可以设范围，超出范围时程序会拉回来',
        onchange: () => {
          const next = typeSelect.value;
          // 切到「数值」自动展开「更多」，否则找不到范围输入框
          if (next === 'meter' && attr.type !== 'meter') attr._moreOpen = true;
          attr.type = next;
          renderCharAttrs(list);
        }
      },
    );
    // 选项挂在宿主上，组件会搬进里层那颗原生 select（声明式写法）
    for (const t of ATTR_TYPES) typeSelect.appendChild(h('option', { value: t.value, text: t.label }));
    typeSelect.value = attr.type || 'text';

    // 「更多」默认按「已有范围/变化规则」展开；手动收展过则以 _moreOpen 为准
    const hasMore = typeof attr.min === 'number' || typeof attr.max === 'number' || !!attr.hint;
    const moreOpen = attr._moreOpen === undefined ? hasMore : attr._moreOpen === true;

    const row = h(
      'div',
      { class: 'attr-row' },
      h('span', { class: 'attr-name', text: attr.name, title: attr.name }),
      valueInput,
      typeSelect,
      button({
        class: ['attr-more-btn', moreOpen && 'on'],
        text: moreOpen ? '收起' : '更多',
        title: '范围与变化规则',
        onClick: () => {
          attr._moreOpen = !moreOpen;
          renderCharAttrs(list);
        }
      }),
      button({
        class: 'panel-del',
        text: '✕',
        title: bucket.id ? `从「${bucket.title}」里删掉这个属性` : '删掉这个属性',
        onClick: () => {
          // 按字段本身定位，不用下标：列表已按分组过滤，行号 ≠ 数组下标
          const at = list.indexOf(attr);
          if (at >= 0) list.splice(at, 1);
          renderCharAttrs(list);
        }
      })
    );

    const wrap = h('div', { class: 'attr-item' }, row);
    if (moreOpen) wrap.appendChild(buildMoreBox(list, attr));

    el.c.attrList.appendChild(wrap);
  }
}

/** 「更多」展开区：数值范围 + 变化规则 + 分组 */
function buildMoreBox(list, attr) {
  const more = h('div', { class: 'attr-more' });

  // 范围只对 meter 有意义；别的类型露出来会误导（clampFieldValue 只处理 meter）
  if ((attr.type || 'text') === 'meter') {
    const numInput = (key, placeholder, label) =>
      mInput({
        type: 'number',
        class: 'attr-num',
        size: 'xs',
        value: typeof attr[key] === 'number' ? String(attr[key]) : '',
        placeholder,
        'aria-label': `${attr.name} 的${label}`,
        oninput: (event) => {
          const raw = String(event.target.value || '').trim();
          if (raw === '' || !Number.isFinite(Number(raw))) delete attr[key];
          else attr[key] = Number(raw);
        }
      });

    more.appendChild(
      h(
        'div',
        { class: 'attr-range' },
        h('span', { class: 'attr-range-label', text: '数值范围' }),
        numInput('min', '下限', '最小值'),
        h('span', { class: 'attr-range-sep', text: '~' }),
        numInput('max', '上限', '最大值')
      )
    );
  }

  const hintInput = mInput({
    class: 'attr-hint',
    size: 'xs',
    value: attr.hint || '',
    placeholder: '变化规则（给模型看，比如「示好时每轮最多加 10」）',
    'aria-label': `${attr.name} 的变化规则`,
    oninput: () => {
      const text = hintInput.value;
      if (text.trim()) attr.hint = text;
      else delete attr.hint;
    }
  });
  more.appendChild(hintInput);

  more.appendChild(buildModeRow(attr));

  more.appendChild(buildGroupRow(list, attr));

  return more;
}

function buildModeRow(attr) {
  const row = h('div', { class: 'attr-mode-row' }, h('span', { class: 'attr-range-label', text: '更新频率' }));

  const modeSelect = mSelect(
    {
      class: 'attr-mode',
      size: 'xs',
      'aria-label': `${attr.name} 的更新频率`,
      title:
        '每轮维护：AI 每轮都会照抄一遍，值一定是最新的。\n' +
        '变了才说：把「这一轮要不要写」交给 AI 判断 —— 它经常整行省掉，值就不更新了。\n' +
        '只有几乎不动的设定才选它。',
      onchange: () => {
        if (modeSelect.value === 'static') attr.mode = 'static';
        else delete attr.mode; // dynamic 是默认，不写进盘，保持数据干净
      }
    }
  );
  for (const m of ATTR_MODES) modeSelect.appendChild(h('option', { value: m.value, text: m.label }));
  modeSelect.value = attr.mode || 'dynamic';

  row.appendChild(modeSelect);
  return row;
}

/** 分组行：下拉搬到别组，末尾「＋ 新建分组…」可建组并搬过去 */
function buildGroupRow(list, attr) {
  const row = h('div', { class: 'attr-group-row' }, h('span', { class: 'attr-range-label', text: '分组' }));

  // 「＋ 新建分组…」的输入框模式：等这一行铺完再聚焦（节点这会儿还没进文档）
  if (list._movingName === attr.name) {
    const nameInput = mInput({
      class: 'attr-group-new',
      size: 'xs',
      maxlength: '24',
      placeholder: '新分组名，回车确认',
      'aria-label': '新建分组，并把这个属性搬过去',
      onkeydown: (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          createGroupAndMove(list, attr, nameInput.value);
        } else if (event.key === 'Escape') {
          // 同上：不 stopPropagation 会连带关掉整个角色编辑器
          event.preventDefault();
          event.stopPropagation();
          list._movingName = '';
          renderCharAttrs(list);
        }
      }
    });
    row.appendChild(nameInput);
    queueMicrotask(() => nameInput.focus());
    return row;
  }

  const current = String(attr.group || '').trim();
  // ⚠️ 「未分组」必须永远在选项里：bucketsOf 只在有零散字段或没有命名分组时才铺它，
  //    否则属性全归组后再也拿不出来。
  const named = bucketsOf(list)
    .filter((bucket) => bucket.id && bucket.id !== NEW_GROUP_VALUE)
    .map((bucket) => bucket.id);

  const groupSelect = mSelect(
    {
      class: 'attr-group',
      size: 'xs',
      'aria-label': `${attr.name} 的分组`,
      title: `${attr.name} 现在在「${current || UNGROUPED_TITLE}」，在这里把它搬到别的组`,
      onchange: () => {
        const next = groupSelect.value;
        if (next === NEW_GROUP_VALUE) {
          waitForNewGroupName(list, attr);
          return;
        }
        if (next) attr.group = next;
        else delete attr.group;
        list._movingName = '';
        renderCharAttrs(list);
      }
    }
  );
  for (const id of named) groupSelect.appendChild(h('option', { value: id, text: id }));
  groupSelect.appendChild(h('option', { value: '', text: UNGROUPED_TITLE }));
  groupSelect.appendChild(h('option', { value: NEW_GROUP_VALUE, text: '＋ 新建分组…' }));
  groupSelect.value = current;

  row.appendChild(groupSelect);
  return row;
}

/** 选中「＋ 新建分组…」：把这一行换成输入框，等用户打名字 */
function waitForNewGroupName(list, attr) {
  list._movingName = attr.name;
  renderCharAttrs(list);
}

/** 建新分组并把属性搬进去；刻意不切过去，方便连续搬下一个 */
function createGroupAndMove(list, attr, rawName) {
  const name = String(rawName || '').trim().slice(0, 24);
  list._movingName = '';
  if (!name || name === UNGROUPED_TITLE) {
    renderCharAttrs(list);
    return;
  }

  const order = groupOrderOf(list);
  if (!order.includes(name)) order.push(name);
  attr.group = name;

  // 撞名即并入已有组，提示文案要区分
  const merging = bucketsOf(list).some((bucket) => bucket.id === name && bucket.fields.some((f) => f !== attr));
  renderCharAttrs(list);
  showToast(merging ? `已搬进「${name}」` : `已新建「${name}」并搬了进去`, 'ok');
}

/** 加字段行的占位文案跟着当前分组走 */
function renderAttrAddRow(bucket) {
  if (!el.c.attrNew) return;
  el.c.attrNew.placeholder = bucket.id ? `往「${bucket.title}」里加一个属性` : '属性名，比如 金币';
}

/** 解析粘贴文本：一行一项，认「【名】：值」「名：值」「名 值」；认不出的行跳过并计数 */
function parseAttributesFromText(text) {
  const pairs = [];
  const seen = new Set();
  let skipped = 0;

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim().replace(/^[-*+•]\s*/, '').trim();
    if (!line) continue;

    // 【名字】：值 要先试，否则通用规则会把「【金币】」连括号一起当名字
    let m = line.match(/^【([^】\n]{1,24})】\s*[：:]\s*(.*)$/);
    if (!m) m = line.match(/^([^：:\n]{1,24}?)\s*[：:]\s*(.*)$/);
    if (!m) m = line.match(/^([^\s：:]{1,24})[\s\u3000]+(.+)$/);

    if (!m) {
      skipped++;
      continue;
    }

    const name = m[1].trim().slice(0, 24);
    const value = String(m[2] || '').trim().slice(0, 200);
    if (!name || seen.has(name)) continue;
    if (!panelFieldAllowed(name)) {
      skipped++;
      continue;
    }

    seen.add(name);
    pairs.push({ name, value });
  }

  return { pairs, skipped };
}

/** 把解析结果并进草稿：同名覆盖值，新字段归当前分组 */
function applyParsedAttributes(list, pairs) {
  let added = 0;
  let updated = 0;
  const group = activeGroupOf(list);

  for (const item of pairs) {
    const existing = list.find((a) => a && a.name === item.name);
    if (existing) {
      if (existing.value !== item.value) {
        existing.value = item.value;
        updated++;
      }
      continue;
    }
    if (list.length >= MAX_PANEL_FIELDS) break;

    const attr = { name: item.name, value: item.value };
    if (group) attr.group = group;
    list.push(attr);
    added++;
  }

  renderCharAttrs(list);
  return { added, updated };
}

function toggleAttrPaste(show) {
  const next = typeof show === 'boolean' ? show : el.c.attrPaste.classList.contains('hidden');
  el.c.attrPaste.classList.toggle('hidden', !next);
  if (next) el.c.attrPasteText.focus();
}

/** 点「解析并加入」：解析 + 合并 + 告诉用户结果 */
function applyAttrPaste(list) {
  const text = el.c.attrPasteText.value;
  if (!String(text).trim()) {
    showToast('先把文本粘进来', 'error');
    el.c.attrPasteText.focus();
    return;
  }

  const { pairs, skipped } = parseAttributesFromText(text);
  if (!pairs.length) {
    showToast('没认出任何属性，检查一下格式（一行一项，比如「金币：9900」）', 'error');
    return;
  }

  const { added, updated } = applyParsedAttributes(list, pairs);
  el.c.attrPasteText.value = '';
  toggleAttrPaste(false);

  const bits = [];
  if (added) bits.push(`新增 ${added} 项`);
  if (updated) bits.push(`更新 ${updated} 项`);
  if (skipped) bits.push(`跳过 ${skipped} 行`);
  showToast(`已解析：${bits.join('，')}`, 'ok');
}

/** 加一个属性：保留字拦下，重名跳过，新字段归到当前分组 */
function addCharAttr(list, rawName) {
  const name = String(rawName || '').trim().slice(0, 24);
  if (!name) return;

  if (!panelFieldAllowed(name)) {
    showToast(`「${name}」是状态栏的保留字段名，换一个吧`, 'error');
    return;
  }
  if (list.some((a) => a && a.name === name)) {
    showToast(`已经有「${name}」了`);
    return;
  }
  if (list.length >= MAX_PANEL_FIELDS) return;

  const attr = { name, value: '' };
  // 未分组就不写 group —— 老存盘里本来就没有这个键，保持数据形状一致
  const group = activeGroupOf(list);
  if (group) attr.group = group;

  list.push(attr);
  renderCharAttrs(list);
}

/**
 * 一键套用官方互动模板：已存在的字段跳过、撞字段上限就停，返回 { added, skipped }。
 */
function applyInteractiveTemplate(list) {
  if (!Array.isArray(list)) return { added: 0, skipped: 0 };

  const existing = new Set(list.map((a) => a && a.name));
  let added = 0;
  let skipped = 0;

  for (const panel of INTERACTIVE_TEMPLATE) {
    for (const field of panel.fields) {
      const name = String(field.name || '').trim();
      if (!name || existing.has(name)) {
        skipped += 1;
        continue;
      }
      if (list.length >= MAX_PANEL_FIELDS) {
        skipped += 1;
        continue;
      }
      if (!panelFieldAllowed(name)) {
        skipped += 1;
        continue;
      }

      const attr = {
        name,
        value: String(field.value == null ? '' : field.value),
        type: field.type || 'text',
        group: panel.group
      };
      if (typeof field.min === 'number') attr.min = field.min;
      if (typeof field.max === 'number') attr.max = field.max;
      if (field.hint) attr.hint = field.hint;

      list.push(attr);
      existing.add(name);
      added += 1;
    }
  }

  list._activeGroup = INTERACTIVE_TEMPLATE[0].group;
  renderCharAttrs(list);

  return { added, skipped };
}

// 草稿数组归角色编辑器所有，这里只在需要时向 getList 要
let getDraft = () => [];

/** 绑属性区的按钮（分组标签栏是渲染时就带的，不用绑） */
export function initCharAttrsUi({ getList } = {}) {
  if (typeof getList === 'function') getDraft = getList;

  el.btnAddAttr.addEventListener('click', () => {
    addCharAttr(getDraft(), el.c.attrNew.value);
    el.c.attrNew.value = '';
    el.c.attrNew.focus();
  });

  el.c.attrNew.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCharAttr(getDraft(), el.c.attrNew.value);
    el.c.attrNew.value = '';
  });

  el.c.btnAttrPaste.addEventListener('click', () => toggleAttrPaste());
  el.c.btnAttrPasteApply.addEventListener('click', () => applyAttrPaste(getDraft()));

  if (el.c.btnAttrTemplate) {
    el.c.btnAttrTemplate.addEventListener('click', () => {
      const { added, skipped } = applyInteractiveTemplate(getDraft());
      if (added) showToast(`已套用互动模板：新增 ${added} 个字段`, 'ok');
      else if (skipped) showToast('模板字段都已经有了，没有新增');
    });
  }
}
