'use strict';

// ============================================================================
//  views/redraw.js —— 「全量重绘」的门面
//
//  renderAll 以前装在入口层，于是每个视图想重绘都得由入口层把函数注入进来
//  （initXxx({ rerender })）。可它其实只做一件事：广播一次重绘
//  （真正的绘制名单在 views/refresh.js 的登记表里）。
//
//  既然不含任何「只有入口层才知道」的东西，就单拿出来当一个公开门面：
//  谁要全量重绘就 import 这里的 renderAll()，不必再绕一圈注入。
//  入口层启动时也不必再管它 —— 它自己会去问刷新总线。
//
//  ⚠️ 以前这里还先调一次 dropSuggestionsIfConvoChanged()（撤掉那条临时建议条）。
//     2026-10-20 建议条合进剧情选项后，选项跟着 convo 走、重绘自然就对了 —— 这一步删掉了。
// ============================================================================

import { refreshAll } from './refresh.js';

/**
 * 全量重绘。这里**不再挨个点名视图** —— 具体画哪些由 views/refresh.js 的
 * 登记表决定（见入口层的 registerRefreshListeners）。以前那份名单焊死在这里，
 * 于是 renderAll 认识所有视图、谁改完数据都得认识它，
 * 那是「19 对分区互相调用」里最主要的来源。
 */
export function renderAll(options) {
  refreshAll(options);
}
