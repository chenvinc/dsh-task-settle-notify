# ARCHITECTURE — dsh-task-settle-notify

> 版本 0.1.0 · 勘察时间 2026-10-27/28 · 本机 DSH `0.2.1-rc.2` · 任务看板 `@linxin666/dsh-client-ui-task-board@0.4.8`

## 1. 要解决的问题

任务看板的卡片由 `task_board_run` 启动后，跑在一个**新的执行会话**里。卡片结算（`running → done | failed`）时，发起它的那个会话收不到任何消息：发起者只能人肉刷新看板。本插件旁路订阅看板的结算事件，把一条短消息**投递回发起会话**，并做合批、失败优先、父子聚合。

约束：

- 不修改 DSH 本体，不修改看板插件代码；
- 不改看板账本（账本有单写者锁）；
- 只使用宿主/看板公开的扩展点。

## 2. 勘察结论（含文件与行号）

### 2.1 看板账本

- 路径：`~/.dsh/task-board/ledger-v2.json`，锁文件 `ledger-v2.lock`，调度旁路文件 `scheduler-v2.json`。
  - `@linxin666/dsh-client-ui-task-board/lib/index.js:4418` `constructor(dir = join(dshHome(), "task-board"), ...)`
  - 同文件 `:4427` `this.file = join(dir, "ledger-v2.json")`，`:4428` `this.lockFile = .../ledger-v2.lock`
- `schemaVersion: 6`，带单调递增的 `revision`。
  - `lib/index.js:5462` 读取/校验 revision；
  - `lib/index.js:5546` `commit(bumpRevision = true)` 中 `this.document.revision += 1`；
  - `lib/index.js:7459`、`:7568` 快照与动作返回里带 `revision`。
- 账本没有对外暴露“文件变更事件”，且带单写者文件锁。**因此不直接 fs.watch 账本**：读取方无法保证与写方的锁协议一致，轮询版本号也只能做事后补偿。

结论：用看板**公开的 provider extension 事件**，而不是监听文件。

### 2.2 看板的扩展契约（本插件采用的订阅点）

任务看板在宿主侧提供 `taskBoard` 服务：

```js
// @linxin666/dsh-client-ui-task-board/lib/index.js:11285-11291
ctx.provide(TASK_BOARD_SERVICE_NAME, {
  registerExtension: (extension) => host.registerExtension(extension),
  isExtensionEnabled: (extensionId) => host.extensions.isActive(extensionId),
  snapshot: () => host.snapshot(),
  apply: (requestId, action, initiator) => host.apply(requestId, action, initiator),
  subscribe: (listener) => host.subscribe(listener),
  verificationOptions: () => host.verificationOptions(),
})
```

Provider extension 的契约（`lib/index.js:6859-6897`）：

- `id: string`，同一 id 幂等；
- `apiVersion` 必须为 `1`，否则抛 `TaskBoardExtensionError('api-version-mismatch')`；
- `start(host)` 在板子启用且 provider 启用时调用；`stop()` 在板子停用/插件卸载时调用；
- `host.events` 提供 `onStatusChanged`、`onExecutionSettled`、`onTaskDeleted`（`:7038-7044`），subscribe 返回释放函数；
- `host.tasks` 提供 `list/get/create/patchContent/setStatus/linked`（`:7025-7036`）；
- 回调按 provider 隔离，单个回调抛错只记日志，不拖垮看板（`:6933-6938`）。

结算事件在 `settleAndNotify()` 里发出：

```js
// lib/index.js:7871-7876
this.extensions.emitExecutionSettled({
  taskId,
  executionId,
  outcome,          // 'succeeded' | 'failed' | 'cancelled'
  ...error === void 0 ? {} : { error },
})
```

事件本身只有 4 个字段，**没有 session id**，所以收到事件后必须回查任务：

- `host.tasks.get(taskId)` → task；
- `task.executions[]` 内按 `executionId` 找本次执行；
- 执行记录的字段由 `startExecution()`（`:967-977`）与 `settleExecution()`（`:1011-1027`）写入：
  - `id`、`sessionId`（执行会话）、`startedAt`、`endedAt`、`result`、`error`、`summary`、`runGroupId`；
  - `initiatedBy`（发起会话 id，`:976` 写入；这是**结算通知的收件人**）。

### 2.3 投递消息到会话

宿主 gateway 暴露 `session/prompt`，看板自己的运行器就是这么把卡片 prompt 送进执行会话的：

```js
// lib/index.js:6174-6183
await this.invoke("session", "prompt", {
  sessionId,
  requestId: "task-board-" + crypto.randomUUID(),
  mode: "queue",
  content: [{ type: "text", text: promptText(task, context) }],
})
```

`invoke` 的线格式（`lib/index.js:5990-6001`）：

```js
gateway.invoke({
  namespace: "session",
  method: "prompt",
  args: { request },   // 其余 namespace 也统一是 { request }
  peer: this.ownerPeer,
  signal,
})
```

`session/prompt` 会恢复冷会话、写入一条用户消息并启动一轮 agent turn。`mode: "queue"` 表示若目标会话正忙，消息排队而不是抢断（`steer` 才是插话）。本插件用 `queue`，避免打断发起会话正在做的事。

`ownerPeer` 必须是绑定在本插件 fiber 上的 owner 身份。看板用 `createOwnerPeer(ctx)` 创建（`lib/index.js:11263`），本插件照做（见 `lib/delivery.js`）。

### 2.4 浏览器侧

参照 `dsh-2-atoll-notice`：它的 `client.js` 也是 `window.__ModuleLoader__.load({ id, factory })`，在 `factory` 里用 `ctx.slots.inject("settings.section", ...)` 注册设置卡，POST 到 `api/atoll-notice/settings`。本插件的 `client.js` 复刻同一模式，只保留四个配置项。

## 3. 本插件的结构

```
index.js              插件入口：读配置、挂 HTTP、等 taskBoard 服务、建 watcher
client.js             浏览器设置卡（settings.section）
lib/config.js         默认值与边界归一化
lib/parse.js          事件 → task/execution → 结算记录；执行 id 去重
lib/aggregate.js      父子判定、同一 runGroup 的子任务汇总
lib/batcher.js        30 秒窗口、失败立即单发
lib/format.js         消息文案与“产物在 …”提示
lib/delivery.js       session/prompt 投递 + owner peer
lib/watcher.js        注册 provider extension、订阅事件、编排以上模块
lib/settings-store.js 用户设置 JSON（原子写）
lib/http.js           GET/POST 设置、GET 诊断
lib/log.js            error.log / trace.log（带大小上限）
```

数据流：

```
board.settleAndNotify
  → emitExecutionSettled({taskId, executionId, outcome})
  → TaskBoardWatcher#handle
      → tasks.get(taskId) / parseSettlement / 去重 / stale 过滤
      → classifyTask: child（父卡 running）→ 抑制；否则继续
      → 失败：立即 #deliver；成功：SettleBatcher(30s)
  → #deliver 按 initiatedBy 分组
  → gateway.invoke session/prompt (mode=queue)
```

### 3.1 合批与优先级

- 成功：第一条成功后开一个固定 30 秒窗口（不滑动），窗口内同一起始会话的成功卡合并成一条；
- 失败：不进窗口，立即单发；
- 批次按 `initiatedBy` 再分组：一次窗口里可能有多张卡来自不同发起会话，各收各的消息；
- 去重：`executionId` 只处理一次，防重复事件；
- 父子：子卡在父卡 `running` 时被抑制（`suppressed` 计数）；父卡结算时把同一 `runGroupId`（缺省用时间窗）的直接子卡汇总成一行。父卡已不在 running 的“孤儿卡”按根卡处理，避免静默丢失。

### 3.2 重启语义

`watcher.start()` 记录 `startRevision = board.snapshot().revision` 与 `startedAt = now()`。事件都是实时的，不存在补发；另外对 `endedAt < startedAt - 1000` 的结算直接丢弃，防止极端乱序把历史结算当新事件。**重启不补发历史消息**。

### 3.3 失败自愈

- provider 回调包裹 `try/catch`，异常只写 `error.log`；
- `start()` 注册失败时 5 秒后重试一次，不抛给宿主；
- `session/prompt` 失败 1.5 秒后重试一次；
- 所有 timer `unref()`，不阻止宿主退出；
- 插件卸载时释放 extension 订阅、批次、重试 timer 与 peer。

## 4. 已知限制（明确不硬造）

1. **只覆盖本 Host、本 profile 内的会话**。`initiatedBy` 是当前 Host 的 session id；跨 Host、远程会话、已被彻底删除的会话无法投递，失败会写 `error.log`。
2. **定时/外部结算没有发起会话**。cron 触发的 run 在 `startExecution` 时没有 `initiatedBy`；`record-external-outcome` 的 `initiatedBy` 是“谁在外部完成”的标签，不一定是会话。两类都跳过并在 trace 记录原因。
3. **投递成功 ≠ 人已看到**。宿主只保证 `session/prompt` 接受并排队；目标会话若长期忙碌，消息会一直排队。插件不提供已读回执。
4. **不补发**。插件启动/重启前的结算不会补消息（按需求）。
5. **看板必须支持 provider extension（本机 0.4.8 满足）**；旧版看板没有 `registerExtension` 时插件保持空闲，不报错。
6. **看板总开关关闭时** provider 会被 stop，期间的结算不会有人收到；重新开启后也不会补。
7. 合批窗口按“第一条成功”起算，不做滑动窗口；这是为了“30 秒内结算的合并、超过 30 秒单发”的可预测语义。
8. 消息最长 4000 字符，超出截断；极端大量卡合并时提示会变短。
9. **子代理（subagent）会话不能作为收件人**。实测 gateway 会拒绝：
   `session "<id>" is owned by subagent routing`。若 `initiatedBy` 指向子代理会话，
   插件只写 `error.log` 并计入 `failed`，不会改投给父会话（避免把内部子任务噪声
   送到用户面前）。普通会话、卡片自己的执行会话不受影响。

### 4.1 卡片提问中继（v0.2）

看板的扩展契约只有 `onStatusChanged` / `onExecutionSettled` / `onTaskDeleted` 三个事件，**它不知道"提问"这件事**。所以提问必须从会话层拿：

- 提问是 `ask_user_question` 工具的一次调用，它经 `ctx.userQuestions.ask()` 走 `user-questions/request` 瀑布（`ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...request, agent}, noAnswerer)`）。未打 scope 标签的监听者是全局可接收的——浏览器侧 `dsh-client-ui-user-questions/lib/client.js:1932` 正是这么接的。
- 本插件用 `ctx.on('user-questions/request', listener, { prepend: true })` 抢在卡片 UI 之前认领：`request.agent.id` 反查 `board.snapshot().tasks[].executions[]` 里 `sessionId` 相同、未结束、非 external 的那条执行，取它的 `initiatedBy`；找不到发起会话就 `next()` 让给下家，卡片行为完全不变。
- 认领后必须**自己兜底**：legacy 模式的 `ask()` 没有超时，`dispose`/到期/abort/投递失败任一路径都要 resolve 一个 `unansweredBatch`，否则卡片永远卡住。
- 代答走插件自己注册的 `answer_card_question` 工具：模型拿到中继消息里的 `card_question_id`，按 `answers: [{ id, selected, custom }]` 结构化回答；`validateAnswerBatch` 会拒绝不属于本次提问的 id、没提供的选项、单选多答、空答案。只有 `initiatedBy` 那个会话能答。
- 工具注册有两条路：能 `import('@deepseek-ai/dsh-tools')` 就用 `defineTool` 编译；否则退化成同一形状的普通定义（`parameters` 直接是 JSON Schema）。插件用 `link:` 装在 profile 里时宿主包不一定可解析，第二条路是常态。

## 5. 为什么不用轮询

- 账本有 `ledger-v2.lock`，第三方读文件无法参与锁协议，容易读到半写状态；
- 账本只在 `commit()` 时整体重写，fs.watch 会拿到 rename/临时文件噪声；
- revision 只能告诉你“变了”，仍要自己算 diff、判断结算，并且有丢事件窗口；
- 看板已经提供带事务语义的 `onExecutionSettled`，是唯一权威且零侵入的入口。

因此 host 侧订阅方式为：**provider extension 事件订阅**（`onExecutionSettled`），不是轮询。

## 6. 参考文件

- `@linxin666/dsh-client-ui-task-board/lib/index.js`（v0.4.8）：`4418`、`4427`、`5546`、`5993`、`6146`、`6174`、`6793`、`6859`、`6915`、`6933`、`7038`、`7871`、`11285`
- `dsh-2-atoll-notice/package.json:48-61`（`dsh.bundle.patch`、`dsh.client.inject`）
- `dsh-2-atoll-notice/index.js:92`、`:480-484`（`ctx.inject(['webServer'], …)`）
- `dsh-2-atoll-notice/client.js:16`、`:665-701`（`__ModuleLoader__`、`settings.section`）
