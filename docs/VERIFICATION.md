# VERIFICATION — 端到端验证记录（真实看板，非 fixture）

本文件记录 2026-10-28 在**本机真实 DSH 宿主 + 真实任务看板**上完成的端到端验证。
所有 id、时间戳与消息文本均来自实际日志，不是构造样例。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 宿主 | 正在运行的 `dsh web`，`http://127.0.0.1:3080` |
| DSH | `0.2.1-rc.2` |
| 任务看板 | `@linxin666/dsh-client-ui-task-board` `0.4.8`（provider extension v1） |
| profile | `~/.dsh/profiles/web` |
| 插件 | `dsh-task-settle-notify` 0.1.0，`dsh.profile.bundles` 加载 |
| 测试卡 | id `b789d88d-5ff3-4e73-90b3-f52164411384`，标题 `插件端到端测试`，prompt `回复 OK 即可` |
| 发起会话（收件人） | `session-54f7bc64-17a2-4eb9-8989-209bc3079191` |
| 最终 execution | `1f7806ea-5c6e-462b-bd1f-43b02b8b967f` |

安装/重载：`node scripts/install.mjs` 之后无需重启（profile 的 `patchReload: live`），
看板 bundle 变化会触发 HMR 重载；本次验证前插件已于
`2026-10-28T00:53:38.202+08:00` 重新挂载（`startRevision: 252`）。

## 2. 执行与结算

最终一次 run 由**发起会话自己**调用 `task_board_run({ taskId, rerun: true })`，
因此 `initiatedBy` 就是该会话，符合「投递给发起该卡的会话」的场景。

看板记录：

```json
{
  "taskId": "b789d88d-5ff3-4e73-90b3-f52164411384",
  "title": "插件端到端测试",
  "executionId": "1f7806ea-5c6e-462b-bd1f-43b02b8b967f",
  "initiatedBy": "session-54f7bc64-17a2-4eb9-8989-209bc3079191",
  "result": "succeeded",
  "taskStatus": "done",
  "startedAt": 1793120029599,
  "endedAt": 1793120037829,
  "durationMs": 8228
}
```

插件 trace（`~/.dsh/dsh-task-settle-notify/trace.log`）：

```text
2026-10-27T16:53:57.835Z settlement {"executionId":"1f7806ea-5c6e-462b-bd1f-43b02b8b967f","taskId":"b789d88d-5ff3-4e73-90b3-f52164411384","outcome":"succeeded","initiatedBy":"session-54f7bc64-17a2-4eb9-8989-209bc3079191","durationMs":8228,"childCount":0}
2026-10-27T16:54:27.847Z delivered {"sessionId":"session-54f7bc64-17a2-4eb9-8989-209bc3079191","kind":"batch","tasks":["b789d88d-5ff3-4e73-90b3-f52164411384"],"preview":"〔看板〕插件端到端测试 已结算 · 成功 · 用时 8 秒（会话 session-54f7bc64-17a2-4eb9-8989-209bc3079191）"}
```

结算到投递间隔 **30.012 s**，即配置的 30 秒合批窗口（单张成功卡也走窗口）。

## 3. 收到的消息（durable 证据）

`session/prompt`（`mode: "queue"`）会把消息作为 `agent/inbox/spliced` 事件立即写入
发起会话的持久日志：

```text
~/.dsh/sessions/--Users-chy-Desktop-~8BBE~8BA1~63A2~7D22--/
  session-54f7bc64-17a2-4eb9-8989-209bc3079191/session.v4.jsonl.zstd
```

解码命令：

```bash
zstd -dc ~/.dsh/sessions/--Users-chy-Desktop-~8BBE~8BA1~63A2~7D22--/session-54f7bc64-17a2-4eb9-8989-209bc3079191/session.v4.jsonl.zstd \
  | grep 'task-settle-notify'
```

实际事件（`seq: 1472`，`2026-10-28T00:54:27.846+08:00`）：

```json
{
  "type": "agent/inbox/spliced",
  "seq": 1472,
  "time": 1793120067846,
  "data": {
    "target": "next-turn",
    "inserted": [{
      "role": "user",
      "content": [{
        "type": "text",
        "text": "〔看板〕插件端到端测试 已结算 · 成功 · 用时 8 秒（会话 session-54f7bc64-17a2-4eb9-8989-209bc3079191）\n下一步：打开看板查看该卡详情"
      }],
      "source": {
        "kind": "user",
        "rpcId": "task-settle-notify-<uuid>"
      }
    }]
  }
}
```

**结论：发起会话确实收到了这条消息**，消息包含契约首行 + 一句下一步提示。

## 4. 运行诊断

```bash
curl -s http://127.0.0.1:3080/api/task-settle-notify/status
```

```json
{
  "extensionActive": true,
  "startRevision": 252,
  "pending": 0,
  "delivered": 1,
  "failed": 0,
  "duplicate": 0,
  "suppressed": 0,
  "lastEventAt": "2026-10-27T16:53:57.835Z",
  "lastDelivery": {
    "at": "2026-10-27T16:54:27.847Z",
    "sessionId": "session-54f7bc64-17a2-4eb9-8989-209bc3079191",
    "kind": "batch",
    "tasks": ["b789d88d-5ff3-4e73-90b3-f52164411384"]
  }
}
```

## 5. 一次已知失败（作为限制记录）

更早的一次验证使用了**子代理（subagent）会话**发起测试卡：

- 结算被正确捕获（execution `6b08ac3c-4d3c-44e0-bafc-407839e094bd`，`initiatedBy` `5d54608e-…`）；
- 投递被 gateway 拒绝：`session "5d54608e-2d1a-4078-9ce2-dfb8e0a1c32d" is owned by subagent routing`；
- 插件按设计只写 `error.log` 并计入 `failed`，不重试、不拖垮宿主。

这是 DSH 的会话路由边界，不是插件可绕过的：**子代理会话不能作为通知收件人**。
普通会话（含卡片自己的执行会话）可正常接收。已写入 `docs/ARCHITECTURE.md` 的 Known limitations。

## 6. 清理

验证卡已删除：

```text
task_board_manage({ taskId: "b789d88d-5ff3-4e73-90b3-f52164411384", action: "delete" })
→ { "ok": true, "action": "delete", "taskId": "b789d88d-5ff3-4e73-90b3-f52164411384" }
```

看板中不再有 `插件端到端测试`；`~/.dsh/task-board/ledger-v2.json` 的下一次读取可确认
该 id 已不存在。测试产生的 trace / error 日志保留在
`~/.dsh/dsh-task-settle-notify/`，供复查。

## 7. 一键复现

```bash
# 1) 安装（首次）
cd /Users/chy/projects/taskboard_plugins/dsh-task-settle-notify
node scripts/install.mjs

# 2) 确认插件已挂载
curl -s http://127.0.0.1:3080/api/task-settle-notify/status | grep extensionActive

# 3) 建卡并运行（用你希望收到通知的那个会话执行）
#    task_board_create({ title: "插件端到端测试", prompt: "回复 OK 即可" })
#    task_board_run({ taskId: "<id>" })

# 4) 30 秒后检查
tail -f ~/.dsh/dsh-task-settle-notify/trace.log
```

单元测试（不依赖真实看板）：

```bash
npm test
# 45 tests, 45 pass, 0 fail
```
