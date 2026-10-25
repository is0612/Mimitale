# 单条库接口（2026-10-22）

状态：主进程、preload 及渲染层编辑 / 导入 / 批量 / 关窗保存已接入按变更记录提交。此接口是云同步前置基础，不是云同步功能或冲突解决协议。

## 接口

| 数据 | store 同步读取 | store 异步保存 / 删除 | preload 异步方法 |
| --- | --- | --- | --- |
| 角色 | `loadCharacter(id)` | `saveCharacter(record)` / `deleteCharacter(id)` | `getCharacter` / `saveCharacter` / `deleteCharacter` |
| 世界书 | `loadWorldbook(id)` | `saveWorldbook(record)` / `deleteWorldbook(id)` | `getWorldbook` / `saveWorldbook` / `deleteWorldbook` |
| 预设 | `loadPreset(id)` | `savePreset(record)` / `deletePreset(id)` | `getPreset` / `savePreset` / `deletePreset` |

IPC 为 `<characters|worldbooks|presets>:get-one` / `:save-one` / `:delete-one`。

- ID 必须是非空字符串，不允许两端空白；不自动生成或静默修剪 ID。
- 保存是完整记录的 upsert，不是字段 patch。目标记录走原有归一化白名单，省略字段会按原规则清空或补默认值；更新原位置，新记录追加末尾。
- 保存返回已落盘的规范化记录；读取不存在的记录返回 `null`；删除返回 `{ id, deleted }`，重复删除 `deleted: false`，不写盘。
- 保存会在调用时取得 JSON 快照，之后修改调用方对象不会改变已提交输入；序列化或写盘失败均 reject。
- 操作只修改指定库，不自动联动会话绑定、世界书引用或关联图片，也不是跨文件事务。

## 界面批次接口与退出

- store / preload 提供 `applyCharacterChanges`、`applyWorldbookChanges`、`applyPresetChanges`，同步版各加 `Now`；payload 必须为 `{upserts: [完整记录], deletes: [id]}`。重复 ID、增删交集会拒绝；返回 `{upserts: [归一化记录], deletes: [id]}`。
- 每批先校验全部输入，再在共享队列中读最新库并一次替换文件。容量按删除后的最终数量检查，满额时允许先删后增。未变化或只删不存在 ID 的批次不写文件。
- 界面启动保存各库的已确认基线，后续只发送变化的完整记录和明确删除。不把磁盘后来新增、界面尚未知晓的记录当成删除，也不重发未改过的 peer。成功确认后才推进基线，失败保留差异可重试；保存期间继续编辑不会被旧确认吞掉。
- 关窗 `flushLibrariesNow` 包含全部未确认差异（含正在飞行但还未返回的增删改），使用 `sendSync` 等待写盘回执。同步成功推进每库代次，使更早排队的异步批次以 `ERR_SUPERSEDED` 拒绝且不重放；界面不重试已被成功同步取代的批次。同步失败不推进代次。
- 任一已加载库或会话关窗保存失败，`beforeunload` 阻止关闭并显示真实错误，修复磁盘后可再次关闭重试。预设也纳入关窗补存。会话 `saveConversationsNow` 使用 sendSync 回执，成功使更早排队会话保存以 ERR_SUPERSEDED 退出，失败不取消旧队列。
- 坏 ID 库无法建立基线时隔离该库保存，不中断其他界面启动、不静默重编号。记录仍可能可读，修改会报错；需要备份后修复，不在初始化时覆盖脏库。

## 存储保证

- 单条保存 / 删除与旧异步 `writeJson` 共用主进程队列；读最新文件、合并、写入在同一队列任务内完成，不嵌套排队。
- 同一进程、全用排队单条接口修改不同 ID 时互不覆盖；同 ID 按队列提交顺序最后写胜。失败会传给调用方，但不会阻塞后续任务。
- 原始 JSON 仍整文件原子替换（`.tmp` + rename），物理格式、旧整库接口和备份策略保持兼容；只是业务层不再要求调用者提供整库快照。
- 不重新归一化或截断无关记录，保留其原始字段、次序及根级元信息。世界书已有 200 条、预设已有 `MAX_PRESETS` 条时新增拒绝，不淘汰旧记录；已超限的旧库仍可更新或删除。角色卡沿用现状，没有数量上限。
- 严格读取：主文件和备份都真正不存在才当空库；主文件读权限 / I/O 错误直接拒绝。主文件不可解析或数据结构无效（包括记录缺 ID、重复 ID）时，只能使用可验证的好备份；主备均无有效数据则拒绝，不冒充空库。旧宽松整库读取行为没有改变。
- 主坏 / 备好时可读取备份。修改前必须先成功恢复主文件，防止原有备份逻辑把坏主覆盖到唯一好备份；恢复失败即拒绝修改。

## 必须遵守的边界

1. **完整记录冲突仍是最后写胜**：`persistCharacters` / `persistLibrary` / `persistPresets` 已走差异批次，不再重发整库。但外部改动同一 ID 与界面本地修改仍会互相覆盖，未实现字段合并或版本检测；界面不会自动实时吸收外部新增。
2. **旧整库 API 仍是替换**：排队保证执行顺序，不替旧快照做合并。`immediate` 同步写绕过队列；同栈先排队 A、再 immediate B，实际可能先 B 后 A。不承诺混用无覆盖。
3. **读不等待队列**：store 的同步 `loadOne` 可能读到待执行写之前的值；先 `await saveOne` 再读。preload 的读取是异步 IPC，但调用方同样应等待保存完成。
4. **无跨进程锁 / 云冲突检查**：不同进程、手动改文件、网盘同步、服务端版本冲突、删除 tombstone 都未实现；不要因此开放远端同步。
5. **旧脏 ID 不自动重编号**：任一记录缺 ID、ID 两端带空白或重复，就不能使用这份文件进行单条操作。若存在可验证的备份，按已有恢复策略使用备份（意味着坏主中新于备份的内容不在恢复结果里）；主备均无有效数据则拒绝。需单独诊断与备份迁移，不在一次保存中悄悄重编号。

6. **角色 / 世界书联库恢复**：两库成功加载时，界面改用 `applyLibraryChanges({characters:changes,worldbooks:changes})`（同步版加 Now）。先计划并校验两库，再将两份原始字节写入 `library-save.pending.json`，两文件全部写成且删除恢复记录后才确认，两边基线一起前进。任一写入失败立即 undo；undo 也失败则保留记录，下次读取或写入前必须恢复，失败会阻断而不返回混合数据。进程写到一半退出，重开读取也先恢复未提交前的原值。备份仍保留，恢复记录固定两路径、不读取其 backup。只覆盖角色 / 世界书这一组；预设和会话引用不纳入同一事务，也没有跨进程锁或 fsync 级断电保证。
7. **同步屏障只作用于新批次**：保留的旧 whole-save / immediate、直接 `writeJson` 及单条 saveOne/deleteOne 不受批次代次取消。应用三库路径已不调用旧整库接口；开发者混用仍可能覆盖。同步关闭会阻塞等待本地 IO，大库仍须后续性能评估。

8. **接口混用边界**：联库 Now 会取代较早排队的联库批次及角色 / 世界书单库批次；反向混用（单库 Now 后仍有较早联库队列）不保证取代。正常界面两库已加载时统一用联库接口，不走反向混用。

本轮仅修现有本地保存可靠性，不开发远端同步。已有旧 API 不改为通用事务；跨进程同时改文件仍不受保护。

## 验证

在 `client/` 运行：

```text
npm run test:records
npm run test:records:ipc
npm run test:library-changes
npm run test:library-close
npm run test:conversation-close
npm run test:library-recovery
npm run test:delete-persist
npm run smoke
```

`test:records` 使用 Node 和临时目录；`test:records:ipc` 使用真实 Electron、preload 和 IPC，数据隔离在临时 userData，不加载主应用界面或调用模型。IPC 负向用例会产生预期的 handler 错误日志，验收看断言和退出码。

`test:delete-persist` 走真实主进程 + 真实窗口，覆盖编辑页删角色、删整本世界书、关编辑器、关窗重开、只读失败回滚、只读解除后自动重试六段，同时比对界面状态与磁盘内容；WebContents 的 console-message 仍会打印预期内的写盘失败日志，验收同样看断言和退出码。

若终端继承了 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 测试前应仅在该终端清除它，例如 PowerShell `$env:ELECTRON_RUN_AS_NODE=$null`，不要删改应用代码来绕过该环境变量。
