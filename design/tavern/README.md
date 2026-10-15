# 如我所书 · 暗色酒馆 UI 提案

独立设计原型，不接入应用数据或 AI 服务，不修改现有客户端。直接用浏览器打开 index.html 即可预览。

- desktop.png：1440 × 1000 桌面效果图。
- mobile.png：390 × 844 手机效果图。
- index.html / style.css / app.js：独立原型及预览交互。
- capture.cjs：通过项目已安装的 Electron 截图并检查图片加载、横向溢出、参数页签与输入回应。

交互包括页签切换、侧栏收放、快捷建议填入、回应追加、正文编辑与复制。其他入口显示示意弹窗；切换故事只更改标题，不替换正文。刷新即重置预览数据。

视觉方向：炭黑与苔绿、低饱和表面、叙事式正文、角色肖像与场景状态栏。角色照片为位置和构图示意，正式版本应替换为用户角色素材。

图片来源（Unsplash，已下载为本地素材）：
- 肖像：https://unsplash.com/photos/rDEOVtE7vOs （https://images.unsplash.com/photo-1534528741775-53994a69daeb）
- 场景：https://images.unsplash.com/photo-1518709268805-4e9042af9f23
- 品牌图标复用项目 renderer/assets/brand-logo.png。

验证：1440 × 1000、390 × 844 无页面横向溢出；图片加载成功；页签与发送预览检查通过；未发现页面控制台错误。当前模型不支持读图，因此未执行截图视觉审查。
