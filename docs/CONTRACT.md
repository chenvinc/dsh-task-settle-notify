# CONTRACT — dsh-task-settle-notify 0.1.0

本文件定义插件对 DSH、对看板、对用户与对运维的**可观察契约**。实现可以变，这些行为不在 0.1.x 内变。

## 1. 包与模块

- 包名：`dsh-task-settle-notify`，ESM，Node ≥ 20。
- 入口：`index.js`，导出 `name`、`inject`、`apply(ctx, config)`。
- 浏览器入口：`client.js`，由 `dsh.client` 注入，`window.__ModuleLoader__.load({ id: 'dsh-task-settle-notify', factory })`。
- Bundle patch：`cordis.patch.yml`，插入一行

  ```yaml
  - id: task-settle-notify
    name: dsh-task-settle-notify
    config: {}
  ```

- 插件只**读取**看板服务与 gateway；不写账本、不改看板包、不改 DSH。

## 2. 看板侧契约

- 服务名：`taskBoard`；能力：`registerExtension(extension)`。
- `extension.id = "task-settle-notify"`，`apiVersion = 1`。
- 只注册一个 provider extension，订阅 `host.events.onExecutionSettled`。
- 收到 `{ taskId, executionId, outcome, error? }` 后：
  - 用 `host.tasks.get(taskId)` 回查；
  - 只处理 `result === "succeeded" | "failed"` 的**已结束**执行；
  - 按 `executionId` 去重（进程内最近 500 条）。
- 不修改任务、不调用 `host.tasks.create/patchContent/setStatus`。
- 板子停用或插件卸载时，`stop()` 必须释放订阅；再次启用时 `start()` 重新订阅。

## 3. 消息契约

### 3.1 单卡

```
〔看板〕<标题> 已结算 · 成功 · 用时 <时长>（会话 <sessionId>）
<下一步提示>
```

失败：

```
〔看板〕<标题> 已结算 · 失败 · 用时 <时长>（会话 <sessionId>）
原因：<error>
下一步：查看 ~/.dsh/dsh-task-settle-notify/trace.log，或重跑该卡
```

- 成功且能识别产物路径时，第二行是 `产物在 <path>`；否则 `下一步：<summary 首行>`；
  summary 没有可用内容时回退为 `下一步：打开看板查看该卡详情`。
- **每条消息都带一句下一步提示**（成功/失败都不省略），保证发起会话有可执行的后续动作。
- 识别产物的扩展名：`ts tsx js mjs cjs rs py go java kt swift c h cpp hpp css scss html md json toml yaml yml sh`，跳过 URL、`node_modules/`、`../`、绝对路径。
- 失败优先展示 `execution.error`，没有则用 `event.error`。

### 3.2 合批

同一发起会话、30 秒窗口内（第一条成功后起算）的**成功**卡合并为一条：

```
〔看板〕<N> 张卡已结算 · 成功 · 用时合计 <时长>
· <标题> · <时长> · <提示>
· <标题> · <时长> · <提示>
```

- 失败不参与合批，立即单发；一个窗口内的失败各自成条。
- 不同 `initiatedBy` 的卡永不合并进同一条消息。
- 单条消息上限 4000 字符，超出截断。

### 3.3 父子

- 子卡结算且其父卡仍为 `running`：**抑制**，只累加 `suppressed` 诊断计数。
- 父卡结算：若 `includeSubtasks=true`，在父卡消息末尾追加 `含 N 个子任务：<标题…>`，子任务取同一 `runGroupId` 的直接子卡（缺失时取父卡开始后的子卡）。
- 父卡已结算/不存在时，子卡视为孤儿，按普通卡投递，保证不静默。

### 3.4 收件人

- 收件人 = 执行记录的 `initiatedBy`（发起该卡的会话 id）。
- `initiatedBy` 缺失、为空、或该执行是外部记录（`external: true`）→ 跳过并写 trace。
- `onlySelfInitiated=true` 时只投递给 `selfSessionId`；`selfSessionId` 为空则不过滤（文档中说明这是“未配置”的语义）。

## 4. 投递契约

- API：`ctx.typertGateway.invoke({ namespace: "session", method: "prompt", args: { request }, peer, signal })`。
- `request`：

  ```js
  {
    sessionId,
    requestId: `task-settle-notify-${randomUUID()}`,
    mode: "queue",
    content: [{ type: "text", text }],
  }
  ```

- 15 秒超时；失败 1.5 秒后重试一次；再失败只记日志，不抛出。
- `peer` 为插件 fiber 上的 owner peer；插件卸载时 dispose。
- 插件不创建会话、不改会话权限/模型、不读会话内容。

## 5. 配置契约

### 5.1 部署 config（`cordis.patch.yml` 的 `config`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关 |
| `batchWindowSeconds` | number | `30` | 成功合批窗口，夹到 5..600 |
| `onlySelfInitiated` | boolean | `false` | 只通知 `selfSessionId` |
| `includeSubtasks` | boolean | `true` | 父卡消息带子任务摘要 |
| `selfSessionId` | string | `""` | 配合上一项；空表示不过滤 |

### 5.2 用户设置层

- 路径：`<profileDir>/task-settle-notify/settings.json`；无 profile 时回退 `$DSH_HOME/profiles/<profile>/…`，再回退 `~/.dsh/…`。
- 只允许写入上表五个字段；布尔必须是真布尔，窗口夹到 5..600 并取整。
- 原子写（临时文件 + rename）；损坏的 JSON 被忽略并回退默认值，不崩溃。
- 优先级：用户设置层 > 部署 config > 内置默认值。

### 5.3 HTTP（浏览器设置卡使用）

前缀 `/api/task-settle-notify`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/settings` | 返回 `{ settings, settingsPath, errorLogPath, traceLogPath }` |
| POST | `/settings` | body 为部分字段，返回更新后的同一结构 |
| GET | `/status` | 运行诊断：`extensionActive/startRevision/pending/delivered/failed/duplicate/suppressed/lastEventAt/lastDelivery/lastError` |

- 请求体上限 64 KiB；非 JSON 或非对象返回 400。
- 只监听同源；不做鉴权（与 DSH 其他本地插件一致）。

## 6. 日志契约

- 目录：`~/.dsh/dsh-task-settle-notify/`（可用 `DSH_TASK_SETTLE_NOTIFY_DIR` 覆盖）。
- `error.log`：JSON Lines，单文件上限 512 KiB，超限轮转为 `error.log.1`。
- `trace.log`：JSON Lines，单文件上限 1 MiB，超限轮转为 `trace.log.1`；只记阶段与 id，不记消息全文。
- 每行至少 `{ at, level, stage, ...detail }`；`stage` 取值包括 `module-loaded`、`apply-complete`、`routes-mounted`、`watcher-started`、`extension-active`、`settlement`、`delivered`、`stale-skipped`、`external-skipped`、`no-initiator-skipped`、`child-suppressed`、`duplicate-skipped`、`delivery-failed`。

## 7. 生命周期与线程模型

- `apply()` 只做装配，不阻塞；board/gateway 通过 `ctx.inject` 延迟解析。
- 使用 `ctx.effect` 管理 HTTP 路由、watcher、peer 的释放。
- 所有事件回调、timer 回调都不得把异常抛回宿主。
- 同一进程只应加载一份插件；重复加载时看板按 extension id 幂等，第二份不会重复订阅。

## 8. 兼容性

- DSH `>= 0.2.1-rc.2`（`session/prompt`、`typertGateway`、`ctx.inject`）。
- 任务看板 `>= 0.4.8`（provider extension v1）。更老版本没有 `registerExtension`，插件静默空闲。
- 不承诺跨大版本的看板内部字段；只依赖本文第 2 节列出的公开面。
