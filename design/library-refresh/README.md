# 创作空间界面预览

直接用浏览器打开 `index.html`，无需服务、联网或安装依赖。默认进入角色编辑器。

- `#editor`：窄身份栏、分区导航和主写作区；支持五种文本标签、字数统计、放大编辑、属性、世界书及高级设置。
- `#presets`：无头像的紧凑文字行；支持搜索、状态筛选、选择、编辑侧栏、复制、更多菜单和导出。
- `#characters` / `#worldbooks`：作为创作空间的上下文列表。
- `#worldbook-editor`：条目列表与正文双栏，独立书籍设置和本书角色分区；支持关键词、常驻、递归、附加条件、模板、条目增删、导出与本地模拟命中。
- 角色与世界书保存写入本预览独有的浏览器存储，不读取或修改客户端数据。世界书切换条目保留草稿，所有条目与书籍信息统一保存。Ctrl/Cmd+S 保存，Esc 关闭侧栏。

采用现有木炭灰／苔绿配色。本地图片来自 `design/tavern/assets`，标志来自实际 renderer，`icons.js` 是现有图标注册文件的经典脚本副本。

这份预览**只用于对照设计、不参与客户端运行**：它不读也不写客户端数据。上面几套版式后来已按同样的结构落到实际客户端（角色编辑器、预设列表、世界书编辑器），改那边的样式时可以直接开这份预览比对。

部分 AI 辅助、导入、游玩流程为轻量交互演示；尚未接入客户端数据或模型。

`capture.cjs` 可使用客户端已安装的 Electron 执行桌面／390px 截图与布局检查，并跑一遍原型里的交互断言（切分区保留草稿、统一保存、命中预览）：

```
client/node_modules/electron/dist/electron.exe --no-sandbox design/library-refresh/capture.cjs
client/node_modules/electron/dist/electron.exe --no-sandbox design/library-refresh/capture.cjs --worldbook-only
```

样式表的重复选择器体检在实际客户端那边：`node client/tools/check-css.js`。
