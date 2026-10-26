'use strict';

// ============================================================================
//  views/worldbookPerson.js —— 「识别世界书人物」：从条目的字面结构里把人找出来
//
//  不靠 AI、不做语义理解：只数结构。酒馆世界书是机器写给机器看的，痕迹在明面上 ——
//  条目标题有词表（「人物档案 - 某某」）、正文有 Markdown 层级（# 名字 → ## 身份与外貌）、
//  变量树有 YAML 缩进（角色名: → 好感度: 0）。这些信号每次跑都一样，能写死。
//
//  产物是一份「建议清单」：强信号默认勾上、疑似默认不勾、一组多人的只提示不转。
//  点「转换」才真正写副本 —— 识别永不默默改数据。
// ============================================================================

import { now } from '../core/util.js';
import { h } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { characters, worldbookCharacters, newWorldbookCharId } from '../data/library.js';
import { normalizePanelField } from '../core/panel-fields.js';
import { persistLibrary } from '../data/persist.js';
import { mButton } from '../components/index.js';

// --- 识别信号（写死的词表 / 指纹）---

// 正文里 ≥2 个这样的小标题 = 人物档案（描述性写法）
const PERSON_SECTIONS = [
  '身份与外貌', '外貌', '身份', '背景', '性格', '能力', '能力与弱点', '弱点',
  '言谈', '言谈与行为', '语言示例', '关系', '喜好', '经历', '过往'
];
// 冒号列表体的「人物档案专属键」：正文里 ≥3 个这样的「键: 值」= 人物档案
// （如「核心身份: … 外貌: … 性格: … 目标动机: …」）
const PERSON_FIELDS = ['核心身份', '外貌', '性格', '目标动机', '能力', '弱点', '身份', '喜好', '关系', '背景'];
// 条目标题命中这些 → 一票否决（不是人）
const NOT_PERSON_TITLE = /世界|地点|势力|组织|种族|生物|历史|简史|规则|阶段|变量|语料|输出格式|正文格式|系统|事件|日程|地图|区域|概览|说明|指南|详情|设定集|更新/i;
// 条目标题命中这些 → 直接是人（名字取「- / :」后半段，或正文 # 人名）
const PERSON_TITLE = /^(人物档案|角色档案|人物卡|角色卡|人设|人物)\s*[-—:：]?\s*(.+)$/;
// 「一组多人」：条目标题是 NPC 组，正文里是一串名字，拆不成单个人
const NPC_GROUP_TITLE = /NPC|配角|路人|群像|角色组|人物组|多人/i;
// initvar 顶层键命中这些 → 不是人（世界/时间/地点/玩家）
const NOT_PERSON_VAR = /^世界$|^时间$|^地点$|^场景$|^user$|^player$|^_/i;

// 一本书最多建议多少条（防超长书把清单撑爆）
const MAX_SUGGEST = 40;

/**
 * 扫一本书，返回「建议转成人物」的清单。
 *
 * 返回数组，每项：
 *   { key, kind, name, source, note, entries }
 *   - kind: 'person'（可转的人）| 'self'（等于卡名，应并进卡）| 'group'（一组多人，只提示）
 *   - key:   建议唯一键（标题 + 索引，去重用）
 *   - name:  识别出的名字（kind='person' 才有）
 *   - source: 依据（标题词表 / 小标题指纹 / initvar 键名）
 *   - note:  给用户看的备注
 *   - entries: 命中哪些条目（转换时拿正文 + 停用它们）
 * 纯函数：只读 book，不写任何东西。
 */
export function scanPersons(book) {
  const out = [];
  if (!book) return out;

  const entries = worldbookEntries(book);
  if (!entries.length) return out;

  const cardName = boundCardName(book);
  // initvar 顶层键 → 叶子值（{ 人名: { 属性名: 值 } }），用来交叉验证 + 转属性
  const varTree = parseInitVar(entries);

  const seen = new Set();

  for (const entry of entries) {
    const title = String(entry.title || '').trim();
    const text = String(entry.content || '');
    if (!title && !text.trim()) continue;

    // 一票否决：规则 / 变量 / 地点 / 势力…… 这些标题直接跳过
    if (NOT_PERSON_TITLE.test(title)) continue;

    // --- 一组多人：只提示，不拆 ---
    if (NPC_GROUP_TITLE.test(title)) {
      const key = `group:${entry.id || title}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ key, kind: 'group', name: '', source: '条目标题像是一组人', note: `「${title}」里是一串 NPC，需要手动拆开再转`, entries: [entry] });
      }
      continue;
    }

    // --- 标题直接是人 ---
    const pm = title.match(PERSON_TITLE);
    if (pm) {
      const name = pickPersonName(pm[2], text);
      pushPerson(out, seen, { name, source: '条目标题词表', entry, cardName, varTree });
      continue;
    }

    // --- 正文小标题指纹 ---
    // 先看整块是不是「单人档案」：# 名字 + 一堆「## 身份/性格」小节。
    // 不是的话，再看是不是「一条多人」：## 人名 各带小节，按 ## 拆。
    if (singleProfile(text)) {
      const name = firstH1Name(text) || title;
      pushPerson(out, seen, { name, source: '正文小标题指纹', entry, cardName, varTree });
      continue;
    }

    // --- 正文 H1 是「人物档案: X」+ 冒号列表体（职称+人名的标题，比如「皇家学者某某」）---
    const h1 = String(text).match(/^#\s+(.+)$/m);
    if (h1 && /人物档案|角色档案/.test(h1[1]) && colonListIsPerson(text)) {
      const name = pickPersonName(h1[1], text);
      pushPerson(out, seen, { name, source: '正文小标题指纹', entry, cardName, varTree });
      continue;
    }

    const sections = splitByH2(text);
    // 只要拆出人名段（哪怕就一个「其他角色 → 某某」），逐段看是不是人物档案
    if (sections.length >= 1) {
      for (const sec of sections) {
        if (sectionIsPerson(sec)) {
          pushPerson(out, seen, { name: secName(sec), source: '正文小标题指纹', entry, cardName, varTree });
        }
      }
    }
  }

  // initvar 里有人名、但没有任何条目命中 → 单独拎出来（有数值没档案，至少能建个带属性的空副本）
  for (const varName of Object.keys(varTree)) {
    if (NOT_PERSON_VAR.test(varName)) continue;
    if (seen.has(`person:${varName}`)) continue;
    // 是卡本人的话照旧判 self（属性写卡上），不是才建空副本
    pushPerson(out, seen, { name: varName, source: 'initvar 变量键名', entry: null, cardName, varTree });
  }

  return out.slice(0, MAX_SUGGEST);
}

// --- 内部工具 ---

function worldbookEntries(book) {
  return Array.isArray(book.entries) ? book.entries : [];
}

// 这本书挂在某张卡上吗？卡名用来判「这个人是不是卡本人」
function boundCardName(book) {
  const card = characters().find((c) => asArray(c.worldbookIds).includes(book.id));
  return card ? String(card.name || '').trim() : '';
}
function asArray(x) { return Array.isArray(x) ? x : []; }

function pushPerson(out, seen, { name, source, entry, cardName, varTree }) {
  name = String(name || '').trim();
  if (!name) return;
  // 同名去重：同一个人拆在多条里，只列一次（转换时把命中它的条目一起带上）
  const key = `person:${name}`;
  if (seen.has(key)) {
    const prev = out.find((o) => o.key === key);
    if (prev && entry && !prev.entries.includes(entry)) prev.entries.push(entry);
    return;
  }
  seen.add(key);

  if (name === cardName) {
    out.push({ key, kind: 'self', name, source, note: '就是这张卡本人 —— 不建副本，属性写到卡上、正文并进卡描述', entries: entry ? [entry] : [], vars: varTree[name] });
    return;
  }
  out.push({ key, kind: 'person', name, source, note: '', entries: entry ? [entry] : [], vars: varTree[name] });
}

// 「人物档案 - 某某」→ 某某；「人物档案：某某 」→ 某某；带注释的剥掉
function pickPersonName(suffix, text) {
  let n = String(suffix || '').trim();
  // 「人物档案: 某某」这种 H1 前缀剥掉，只留人名
  n = n.replace(/^(人物档案|角色档案|人物卡|角色卡|人设|人物)\s*[-—:：]\s*/, '').trim();
  // 「某某（女仆）」这种括号备注剥掉
  n = n.replace(/[（(].*?[)）]/g, '').trim();
  if (n) return n;
  // 后缀空了 → 回正文 # 人名
  return firstH1Name(text) || '';
}

function firstH1Name(text) {
  const m = String(text || '').match(/^#\s+(.+)$/m);
  if (!m) return '';
  let n = m[1].trim();
  // 「某某（旁白用姓氏某某来称呼）」→ 去空格 + 剥括号
  n = n.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '').trim();
  return n;
}

// 按 ## 拆成多段；没 ## 就整块
function splitByH2(text) {
  const parts = String(text || '').split(/^##\s+/m);
  if (parts.length <= 1) return [{ heading: '', body: text || '' }];
  return parts.slice(1).map((p) => {
    const nl = p.indexOf('\n');
    const heading = nl >= 0 ? p.slice(0, nl).trim() : p.trim();
    return { heading, body: p };
  });
}

// 单人档案 = # 名字 + 一堆「## 身份与外貌 / ## 性格」这种**小节**；
// 一条多人 = # 其他角色 + 一堆「## 甲 / ## 乙」这种**人名**（人名下面才是 ### 小节）。
// 区分靠「## 后紧跟的词在不在人物小节词表里」：在 = 单人档案的小节，不在 = 人名。
function singleProfile(text) {
  const body = String(text || '');
  // 取所有 ## 标题
  const h2s = [];
  const re = /^##\s+([^\n]+)$/gm;
  let m;
  while ((m = re.exec(body))) h2s.push(m[1].trim());
  if (h2s.length < 2) return false;
  const isSection = (h) => PERSON_SECTIONS.some((s) => h === s || h.startsWith(s + '：') || h.startsWith(s + ':'));
  return h2s.every(isSection);
}

function sectionIsPerson(sec) {
  const body = String(sec && sec.body || '');
  const hits = PERSON_SECTIONS.filter((s) => {
    // ⚠️ 不用 \b：中文标题后面跟着换行/冒号，\b 只认 ASCII 单词边界，中文那里永远不命中
    const re = new RegExp(`^#+\\s*${s}(?:\\s|:|：|$)`, 'm');
    return re.test(body);
  });
  return hits.length >= 2;
}

// 冒号列表体：正文里 ≥3 个「人物档案专属键:」= 人物档案
function colonListIsPerson(text) {
  const body = String(text || '');
  let hits = 0;
  for (const s of PERSON_FIELDS) {
    const re = new RegExp(`^\\s*${s}\\s*[:：]`, 'm');
    if (re.test(body)) hits += 1;
  }
  return hits >= 3;
}

// 从「## 某某」或正文第一个 H1 取名
function secName(sec) {
  const heading = String(sec && sec.heading || '').trim();
  if (heading) return heading.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '').trim();
  return firstH1Name(sec && sec.body) || '';
}

// 找 [initvar] 那条，把 YAML 缩进解析成 { 顶层键: { 子键: 值 } }
function parseInitVar(entries) {
  // 优先 title 就带 [initvar] 的（content 里提到 initvar 的 EJS 模板条不能算）
  const entry =
    entries.find((e) => /^\[?\s*initvar\s*\]?/i.test(String(e.title || '').trim())) ||
    entries.find((e) => /initvar/i.test(String(e.title || '')));
  if (!entry) return {};

  const tree = {};
  // 只认最简单的「缩进 2 空格」YAML：顶层无缩进，子键缩进 ≥2。
  // ⚠️ 顶层键必须是「短人名」：含 <% / getvar / 空格 / 斜杠的是 EJS 模板代码，不是人。
  const lines = String(entry.content || '').split(/\r?\n/);
  let top = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#') || line.trim().startsWith('---')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const body = line.trim();
    if (indent === 0) {
      const key = body.replace(/:$/, '').trim();
      if (key && isVarKey(key) && !(key in tree)) {
        tree[key] = {};
        top = key;
      } else {
        top = null;
      }
    } else if (top && indent >= 2) {
      const m = body.match(/^(.+?):\s*(.*)$/);
      if (m) tree[top][m[1].trim()] = m[2].trim();
    }
  }
  return tree;
}

// initvar 顶层键是不是人名：短、没有模板/代码特征
function isVarKey(key) {
  if (!key || key.length > 24) return false;
  if (/[<%>\/{}]|getvar|const|function|return|=>/.test(key)) return false;
  if (/\s/.test(key)) return false;
  return true;
}

// initvar 叶子值 → 属性字段（数字 → meter 0~100，文本 → text，布尔 → text）
function varsToAttributes(vars) {
  const out = [];
  if (!vars || typeof vars !== 'object') return out;
  for (const name of Object.keys(vars)) {
    const raw = String(vars[name] == null ? '' : vars[name]).trim();
    if (!name || !raw) continue;
    const numeric = /^-?\d+(\.\d+)?$/.test(raw);
    const field = normalizePanelField({
      name: name.slice(0, 40),
      type: numeric ? 'meter' : 'text',
      value: numeric ? raw : raw,
      ...(numeric ? { min: 0, max: 100 } : {}),
      mode: 'dynamic'
    });
    if (field) out.push(field);
  }
  return out;
}

// 条目正文里挑出「## 身份与外貌 / 背景 / 性格」之后的正文，当副本描述；
// 整块拿来也行，副本描述吃长文本。这里直接整块（去掉最顶上的 # 标题行，避免重复）。
function entryToDescription(entry) {
  let text = String(entry && entry.content || '').trim();
  // 去掉第一个 # 标题行（名字已经单独存了）
  text = text.replace(/^#\s+.+$/m, '').trim();
  return text;
}

// --- 清单弹窗 + 转换 ---

let openBookId = null;
let scanResult = null;
let overlay = null;

/** 打开「识别人物」清单。book 由调用方（入口层）传进来，避免这里反向 import worldbook.js。 */
export function openPersonScan(book) {
  if (!book) return;
  openBookId = book.id;
  scanResult = scanPersons(book);
  buildOverlay();
}

function buildOverlay() {
  if (overlay) overlay.remove();

  const people = scanResult.filter((s) => s.kind === 'person');
  const selfs = scanResult.filter((s) => s.kind === 'self');
  const groups = scanResult.filter((s) => s.kind === 'group');

  overlay = h('div', { class: 'modal', id: 'wp-modal' },
    h('div', { class: 'modal-card wp-card', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' },
        h('h2', { text: '识别世界书人物' }),
        h('p', { class: 'modal-sub', text: '按条目里的标题和小标题认出来的，勾上再点「转换」才会写进去 —— 没勾的一条不动。' })
      ),
      h('div', { class: 'modal-body wp-body' },
        !people.length && !selfs.length && !groups.length
          ? h('div', { id: 'wp-none', class: 'wp-none', text: '没认出谁。这本书的条目要么是规则 / 地点 / 势力，要么人物是纯散文写的、没有小标题 —— 手动「＋ 新建」吧。' })
          : h('div', { class: 'wp-list', id: 'wp-list' },
              ...people.map(rowFor('person')),
              ...selfs.map(rowFor('self')),
              ...groups.map(rowFor('group'))
            )
      ),
      h('div', { class: 'modal-foot' },
        mButton({ variant: 'ghost', text: '取消', onClick: close }),
        mButton({ variant: 'primary', text: '转换', class: 'wp-ok', disabled: !people.length && !selfs.length, onClick: () => applyScan() })
      )
    )
  );

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  overlay._esc = esc;
}

function rowFor(kind) {
  return (s) => {
    // person / self 默认勾上（强信号 + 卡本人都是用户要的）；group 只提示、不给勾
    const checked = kind === 'person' || kind === 'self';
    const disabled = kind === 'group';
    const name = s.name || '';
    const text = kind === 'self'
      ? `${s.note}`
      : kind === 'group'
        ? s.note
        : `${s.source || ''}${s.note ? `；${s.note}` : ''}`;
    const label = kind === 'self' ? `${name}（就是这张卡本人）` : kind === 'group' ? s.note : name;

    return h('label', { class: `wp-row wp-row-${kind}` },
      h('input', {
        type: 'checkbox',
        'data-key': s.key,
        checked,
        disabled,
        onchange: () => refreshOk()
      }),
      h('span', { class: 'wp-row-name', text: label }),
      h('span', { class: 'wp-row-src', text })
    );
  };
}

function refreshOk() {
  if (!overlay) return;
  const ok = overlay.querySelector('.wp-ok');
  if (!ok) return;
  const any = Array.from(overlay.querySelectorAll('input[type=checkbox]:checked')).length > 0;
  ok.disabled = !any;
}

function close() {
  if (overlay && overlay._esc) document.removeEventListener('keydown', overlay._esc, true);
  if (overlay) overlay.remove();
  overlay = null;
  openBookId = null;
  scanResult = null;
}

async function applyScan() {
  if (!overlay || !openBookId) return;
  const book = getBookById(openBookId);
  if (!book) { close(); return; }

  const checked = Array.from(overlay.querySelectorAll('input[type=checkbox]:checked'))
    .map((i) => i.getAttribute('data-key'));
  if (!checked.length) { close(); return; }

  const picked = scanResult.filter((s) => checked.includes(s.key));
  const people = picked.filter((s) => s.kind === 'person');
  const selfs = picked.filter((s) => s.kind === 'self');

  if (!people.length && !selfs.length) { close(); return; }

  // 确认框：把要做的说清楚
  const bits = [];
  if (people.length) bits.push(`${people.length} 个人物建成本书角色副本`);
  if (selfs.length) bits.push(`${selfs.length} 个是卡本人，属性写到卡上`);
  const ok = await confirmDialog({
    title: '转换人物',
    message: `把 ${bits.join('，')}？原条目会停用（不删，可反悔）。`,
    confirmText: '转换',
    danger: false
  });
  if (!ok) { close(); return; }

  // --- 改之前的样子（写盘失败回滚用）---
  const beforeChars = worldbookCharacters(book).slice();
  const beforeEntries = worldbookEntries(book).map((e) => ({ ...e }));
  const beforeUpdated = book.updatedAt;

  const existingNames = new Set(worldbookCharacters(book).map((c) => String(c.name || '').trim()));
  let made = 0;

  // 建副本
  for (const s of people) {
    if (!s.name || existingNames.has(s.name)) continue;
    const entry = s.entries[0] || null;
    const attrs = s.vars ? varsToAttributes(s.vars) : [];
    book.characters = [
      ...worldbookCharacters(book),
      {
        id: newWorldbookCharId(),
        name: s.name,
        description: entry ? entryToDescription(entry) : '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: [],
        attributes: attrs,
        showInPanel: true,
        createdAt: now(),
        updatedAt: now()
      }
    ];
    existingNames.add(s.name);
    made += 1;
  }

  // 卡本人：属性写卡上
  let selfAttr = 0;
  if (selfs.length) {
    const card = characters().find((c) => asArray(c.worldbookIds).includes(book.id));
    for (const s of selfs) {
      if (!card) break;
      const attrs = s.vars ? varsToAttributes(s.vars) : [];
      if (attrs.length) {
        card.attributes = [...asArray(card.attributes), ...attrs];
        card.updatedAt = now();
        selfAttr += attrs.length;
      }
      // 正文并进卡描述（去重：已经有了就跳过）
      const desc = s.entries[0] ? entryToDescription(s.entries[0]) : '';
      if (desc && !String(card.description || '').includes(desc.slice(0, 40))) {
        card.description = String(card.description || '').trim() + (String(card.description || '').trim() ? '\n\n' : '') + desc;
        card.updatedAt = now();
      }
    }
  }

  // 停用命中过的原条目（不删）
  const touched = new Set(picked.flatMap((s) => s.entries.map((e) => e.id)));
  for (const e of book.entries) {
    if (touched.has(e.id) && e.enabled !== false) e.enabled = false;
  }
  book.updatedAt = now();

  if (!(await persistLibrary())) {
    book.characters = beforeChars;
    book.entries.splice(0, book.entries.length, ...beforeEntries);
    book.updatedAt = beforeUpdated;
    showToast('转换失败，已还原', 'error');
    close();
    return;
  }

  // 转换完让入口层重绘（人物列表宿主 / 角色编辑页那行「已绑世界书」）—— 这里不反向 import worldbook.js
  if (typeof afterApply === 'function') afterApply(book);

  showToast(made ? `已建 ${made} 个人物` + (selfAttr ? `、卡上写了 ${selfAttr} 个属性` : '') : '已转换', 'ok');
  close();
}

// 由入口层注入取书器：这里不 import worldbook.js，避免成环（同 charBookAi 的路子）。
// worldbook.js 要 import 本模块的 scanPersons（纯函数），本模块不能反向 import 它。
let getBookById = () => null;
let afterApply = null;
export function initWorldbookPerson(opts) {
  const o = opts || {};
  if (typeof o.getBook === 'function') getBookById = o.getBook;
  if (typeof o.afterApply === 'function') afterApply = o.afterApply;
}
