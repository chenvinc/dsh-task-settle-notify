# dsh-task-settle-notify

> 任务看板结算后，**自动把消息送回发起它的 DSH 会话**。不用再人肉轮询看板。

[English](./README.en.md) · [架构](./docs/ARCHITECTURE.md) · [契约](./docs/CONTRACT.md) · [安装](./docs/INSTALL.md) · [验证](./docs/VERIFICATION.md)

```
〔看板〕M2-B 已结算 · 成功 · 用时 9 分（会话 session-9f3c…）
产物在 src-tauri/src/kp_document.rs
```

## 功能

- **结算即通知**：`running → done | failed` 时向 `initiatedBy` 会话投递一条 `session/prompt`，排队执行，不打断它正在做的事。
- **30 秒合批**：窗口内的成功卡合并成一条；不同发起会话各自成条。
- **失败优先**：失败卡立刻单发，不参与合批。
- **父子聚合**：子卡不刷屏，父卡结算时汇总一行；父卡已结束的孤儿卡照常通知，不静默。
- **四个开关**：总开关、合批窗口、只看自己发起的卡、是否包含子任务；带浏览器设置卡。
- **旁路**：不改 DSH、不改看板包、不写账本；只订阅看板公开的 provider extension 事件。
- **自愈**：回调异常不拖垮宿主；失败重试一次；日志有大小上限；重启不补发历史。

## 安装

```bash
git clone <this-repo> dsh-task-settle-notify
cd dsh-task-settle-notify
node scripts/install.mjs
```

profile 的 `dsh.profile.patchReload` 为 `live` 时宿主会自动热挂载，无需重启；
若状态接口仍是 404，再重启 `dsh web`。随后：

```bash
curl -s http://127.0.0.1:3080/api/task-settle-notify/status
```

卸载：

```bash
node scripts/uninstall.mjs
```

详见 [docs/INSTALL.md](./docs/INSTALL.md)。

## 配置

设置 → 任务结算通知：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 启用通知 | 开 | 总开关 |
| 合批窗口（秒） | 30 | 5..600 |
| 只通知我发起的卡 | 关 | 配合 `selfSessionId` |
| 包含子任务摘要 | 开 | 父卡消息带子任务 |

也可写在 `cordis.patch.yml` 的 `config` 里，或用 `~/.dsh/profiles/web/task-settle-notify/settings.json` 覆盖。

## 工作原理

看板在每次 execution 结算时向 provider extension 广播：

```js
{ taskId, executionId, outcome, error? }
```

插件用 `host.tasks.get(taskId)` 找回 `execution.initiatedBy`，再做去重、父子判定、合批，最后：

```js
gateway.invoke({
  namespace: 'session',
  method: 'prompt',
  args: { request: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } },
})
```

没有轮询、没有文件监听、没有改账本。细节见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 已知限制

- 只覆盖本 Host、本 profile 内仍存在的会话；会话被删除时投递失败进 `error.log`。
- cron / `record-external-outcome` 没有发起会话，跳过。
- 投递成功只代表宿主接受并排队，不代表人已读。
- 插件重启前的结算不补发。
- 需要任务看板 ≥ 0.4.8（provider extension v1）。
- 子代理（subagent）会话不能作为收件人，gateway 会拒绝（`owned by subagent routing`）；插件记录失败，不改投父会话。
- 本机已用真实看板完成端到端验证，证据见 [docs/VERIFICATION.md](./docs/VERIFICATION.md)。

## 开发

```bash
npm test          # node --test，45 条
```

结构：

```
index.js / client.js / cordis.patch.yml
lib/              解析、聚合、合批、格式化、投递、HTTP、日志
test/             node:test + 手写账本 fixture
scripts/          install.mjs / uninstall.mjs
docs/             架构、契约、安装、验证
```

## License

MIT
