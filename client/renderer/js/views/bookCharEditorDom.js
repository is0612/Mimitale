'use strict';

// views/bookCharEditorDom.js —— 本书角色编辑页的 DOM 缓存
// 页面里的 id 全部带 bc- 前缀，和「角色卡编辑」那套同名不同节点。
// ⚠️ 键名必须和 core/dom.js 里角色编辑那一段逐字对齐：副本模块是照那套字段名取的，
//    少一个键就是读取 undefined，下一句直接抛错。

const $ = (id) => document.getElementById(`bc-${id}`);

export const el = {
  viewBookCharEditor: document.getElementById('view-book-char-editor'),

  charsTitle: $('chars-title'),
  charsSub: $('chars-sub'),
  charTotalWords: $('char-total-words'),
  charSaveState: $('char-save-state'),

  // 页头返回 / 左栏底部（保存、返回、AI 补充、删除）
  btnCloseChars: $('btn-close-chars'),
  btnBackChar: $('btn-back-char'),
  btnSaveChar: $('btn-save-char'),
  btnDelChar: $('btn-del-char'),
  btnAiFillChar: $('btn-ai-fill-char'),
  // 这两个按钮只在角色卡列表页上，本页没有；留着键是为了不改副本里的分支判断
  btnNewChar: null,
  btnAiChar: null,

  charEmpty: $('char-empty'),
  charForm: $('char-form'),
  charAvatar: $('char-avatar'),
  btnClearAvatar: $('btn-clear-avatar'),
  charPortrait: $('char-portrait'),
  btnClearPortrait: $('btn-clear-portrait'),

  charExprList: $('char-expr-list'),
  btnAddExpr: $('btn-add-expr'),
  btnBatchExpr: $('btn-batch-expr'),
  exprCount: $('expr-count'),

  btnAddAttr: $('btn-add-attr'),

  c: {
    name: $('c-name'),
    tags: $('c-tags'),
    desc: $('c-desc'),
    personality: $('c-personality'),
    scenario: $('c-scenario'),
    first: $('c-first'),
    btnFirstTemplate: $('btn-first-template'),
    altList: $('c-alt-list'),
    altCount: $('c-alt-count'),
    btnAltAdd: $('btn-alt-add'),
    example: $('c-example'),
    system: $('c-system'),
    post: $('c-post'),
    notes: $('c-notes'),
    attrNew: $('c-attr-new'),
    btnAttrTemplate: $('btn-attr-template'),
    attrTabs: $('c-attr-tabs'),
    attrList: $('c-attr-list'),
    attrGroupEdit: $('c-attr-group-edit'),
    btnAttrPaste: $('btn-attr-paste'),
    attrPaste: $('c-attr-paste'),
    showInPanelBox: $('c-show-in-panel-box'),
    showInPanel: $('c-show-in-panel'),
    showInPanelHelp: $('c-show-in-panel-help'),
    wbBox: $('c-worldbook-box'),
    wbList: $('c-wb-list'),
    wbAddBtn: $('c-wb-add-btn'),
    wbNewBtn: $('c-wb-new-btn'),
    wbAiBlock: $('c-wb-ai-block'),
    wbAiBtn: $('c-wb-ai-btn'),
    wbAiList: $('c-wb-ai-list'),
    wbAiStatus: $('c-wb-ai-status'),
    wbDesc: $('c-wb-desc'),
    wbHint: $('c-wb-hint'),
    attrPasteText: $('c-attr-paste-text'),
    btnAttrPasteApply: $('btn-attr-paste-apply')
  }
};
