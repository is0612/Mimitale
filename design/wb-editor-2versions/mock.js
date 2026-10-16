'use strict';

// 两版稿的切换与条目列表铺行。只动 .active / aria-selected / aria-current / 文案，
// 不改结构。
//   地址栏写法：#a/entries · #a/book · #a/chars · #b/entries · #b/book · #b/chars
//
// 条目数据取自真客户端那一本「阿多利翁」的形态（51 条，别名用 / 分隔，
// 元信息是「字数 · 顺序」），不是随手编的假字。

// ------------------------------ 条目数据 ------------------------------
// [名称, 关键词, 字数, 顺序, 常驻, 停用]
const ENTRIES = [
  ['阿多利翁', '阿多利翁 / Adolion / adolion', 51, 100, true, false],
  ['圣盾城', '圣盾城 / Aegis City / Aegis / Holy City', 39, 100, true, false],
  ['冒险者公会', "冒险者公会 / Adventurer's Guild / guild", 67, 100, true, false],
  ['波赫圣教会', '波赫圣教会 / 圣教会 / Holy Church / Church of Bohe', 50, 100, true, false],
  ['冒险者等级', '冒险者等级 / Rank / Guild Rank', 35, 100, false, false],
  ['精灵', '精灵 / Elf / Elves', 44, 90, false, false],
  ['矮人', '矮人 / Dwarf / Dwarves', 41, 90, false, false],
  ['哥布林', '哥布林 / Goblin / Goblins', 33, 90, false, false],
  ['恶魔', '恶魔 / Demon / Devils', 58, 90, false, false],
  ['人类', '人类 / Human / Humans', 26, 90, false, false],
  ['魔导学院', '魔导学院 / Magic Academy / Arcanum', 72, 85, false, false],
  ['北境冰原', '北境冰原 / Northern Wastes / Frostland', 48, 85, false, false],
  ['龙脊山脉', "龙脊山脉 / Dragon's Spine / 龙脊", 37, 85, false, false],
  ['黑市', '黑市 / Black Market / Underworld', 55, 80, false, false],
  ['商队', '商队 / Caravan / Trade Route', 42, 80, false, false],
  ['王国议会', '王国议会 / Council / High Council', 61, 80, true, false],
  ['星辉历', '星辉历 / Star Calendar / Astral Reckoning', 68, 78, false, false],
  ['魔法体系', '魔法体系 / Magic System / Mana', 94, 78, true, false],
  ['神术', '神术 / Divine Magic / Miracle', 46, 76, false, false],
  ['炼金术', '炼金术 / Alchemy / Transmutation', 53, 76, false, false],
  ['佣兵行会', '佣兵行会 / Mercenary Guild / 佣兵', 49, 74, false, false],
  ['古代遗迹', '古代遗迹 / Ruins / Ancient Ruins', 57, 74, false, false],
  ['深渊回廊', '深渊回廊 / Abyss Hall / Deep Corridor', 63, 72, false, false],
  ['银月湖', '银月湖 / Silvermoon Lake', 31, 72, false, false],
  ['白鸦港', '白鸦港 / Whitecrow Port / 白鸦', 66, 70, true, false],
  ['铁炉堡', '铁炉堡 / Ironforge / Iron Hold', 38, 70, false, false],
  ['风语高原', '风语高原 / Whispering Plateau', 29, 68, false, false],
  ['骑士团', '骑士团 / Knights Order / Paladins', 52, 68, false, false],
  ['灰烬兄弟会', '灰烬兄弟会 / Ashen Brotherhood / 灰烬会', 71, 66, false, false],
  ['古代帝国', '古代帝国 / Old Empire / Ancient Empire', 85, 66, false, false],
  ['失落王座', '失落王座 / Lost Throne', 60, 64, false, false],
  ['龙族', '龙族 / Dragon / Dragons', 76, 64, false, false],
  ['半身人', '半身人 / Halfling', 24, 62, false, false],
  ['兽人', '兽人 / Orc / Orcs', 36, 62, false, false],
  ['亡灵', '亡灵 / Undead / Wraith', 43, 60, false, false],
  ['召唤术', '召唤术 / Summoning / Conjuration', 47, 60, false, false],
  ['附魔', '附魔 / Enchantment / 强化', 34, 58, false, false],
  ['符文', '符文 / Rune / Runecraft', 45, 58, false, false],
  ['药剂', '药剂 / Potion', 28, 56, false, false],
  ['魔兽', '魔兽 / Beast / Magical Beast', 39, 56, false, false],
  ['世界树', '世界树 / World Tree / Yggdrasil', 65, 54, false, false],
  ['月神教', '月神教 / Moon Cult / Lunar Faith', 54, 54, false, false],
  ['火神信仰', '火神信仰 / Fire Faith / Flame Cult', 51, 52, false, false],
  ['冬神', '冬神 / Winter God / Frost Deity', 40, 52, false, false],
  ['契约魔法', '契约魔法 / Pact Magic / Contract', 62, 50, false, false],
  ['血脉觉醒', '血脉觉醒 / Bloodline Awakening', 58, 50, false, false],
  ['传送门', '传送门 / Portal / Gate', 44, 48, false, false],
  ['天空城', '天空城 / Sky City / Floating Isle', 69, 48, false, false],
  ['地底城', '地底城 / Undercity / Underdark', 57, 46, false, true],
  ['沙海', '沙海 / Sand Sea / Desert', 33, 46, false, false],
  ['旧版设定（待重写）', '旧世界设定 / legacy', 18, 44, false, true]
];

// ------------------------------ 铺条目列表 ------------------------------

function rowMarkup(e, seq) {
  const [name, keys, chars, order, constant, disabled] = e;
  const current = seq === 1;
  const flags = [];
  if (constant) flags.push('<span class="flag flag-on">常驻</span>');
  if (disabled) flags.push('<span class="flag">已停用</span>');
  return (
    '<div class="entry-row"' + (current ? ' aria-current="true"' : '') + ' role="button" tabindex="0" title="' + name + '">' +
    '<span class="entry-row-top">' +
    '<span class="entry-row-name">' + name + '</span>' +
    (flags.length ? '<span class="entry-row-flags">' + flags.join('') + '</span>' : '') +
    '<span class="entry-row-meta">' + chars + ' 字 · ' + order + '</span>' +
    '</span>' +
    '<span class="entry-row-keys">' + keys + '</span>' +
    '<button type="button" class="entry-row-del" aria-label="删除条目「' + name + '」">×</button>' +
    '</div>'
  );
}

const html = ENTRIES.map(rowMarkup).join('');
for (const id of ['a-entry-list', 'b-entry-list']) {
  const host = document.getElementById(id);
  if (host) host.innerHTML = html;
}

// ------------------------------ 分区切换 ------------------------------

const SECTIONS = ['entries', 'book', 'chars'];

function show(route) {
  const [variant, section] = route.split('/');
  for (const v of ['a', 'b']) {
    for (const s of SECTIONS) {
      const view = document.getElementById('view-' + v + '-' + s);
      if (view) view.classList.toggle('active', v === variant && s === section);
    }
  }
  // A 稿：分区标签的选中态
  for (const tab of document.querySelectorAll('.a-tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.sec === section));
  }
  // B 稿：左目录的选中态
  for (const btn of document.querySelectorAll('.b-section')) {
    if (btn.dataset.sec === section) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

function fromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, '')) || 'a/entries';
  const route = /^[ab]\/(entries|book|chars)$/.test(raw) ? raw : 'a/entries';
  show(route);
  return route;
}

window.addEventListener('hashchange', fromHash);

// 稿子里点分区标签 / 左目录 = 换一屏（不出真产品，只为看图方便）
document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.a-tab, .b-section');
  if (!tab) return;
  const variant = tab.closest('.view').id.startsWith('view-a') ? 'a' : 'b';
  location.hash = variant + '/' + tab.dataset.sec;
});

// 点条目行 = 切选中态（只为看选中长什么样）
document.addEventListener('click', (ev) => {
  const row = ev.target.closest('.entry-row');
  if (!row) return;
  for (const r of document.querySelectorAll('.entry-row')) r.removeAttribute('aria-current');
  row.setAttribute('aria-current', 'true');
});

// ------------------------------ 出图用 ------------------------------

window.__mock = {
  theme(t) { document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark'); },
  route: fromHash,
  entries: ENTRIES.length
};

fromHash();
