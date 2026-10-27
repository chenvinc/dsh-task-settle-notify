# dsh-task-settle-notify

> 卡跑完了，消息自己敲门。**发起那张卡的会话，会收到一条结算消息。**

[English](./README.en.md) · [架构](./docs/ARCHITECTURE.md) · [契约](./docs/CONTRACT.md) · [安装](./docs/INSTALL.md) · [验证](./docs/VERIFICATION.md)

[![npm](https://img.shields.io/npm/v/dsh-task-settle-notify?color=CB3837)](https://www.npmjs.com/package/dsh-task-settle-notify)
[![License](https://img.shields.io/github/license/chenvinc/dsh-task-settle-notify?color=4B6EF5)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-45%20passing-brightgreen)](./test)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](./package.json)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](./package.json)
[![Topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

![卡片结算后，通知被送回发起它的会话](docs/assets/settlement-notice.png)

截图是真实投递：卡片在自己的执行会话里跑完，一句话被送回发起它的会话（会话 id 与本地路径已打码）。

## 从今天起，工作方式变了

```text
以前：我让 agent 在对话里往看板派卡 → 卡跑完 → 我回对话说“卡结束了” → 它再去查板验收
      或者，设个 20 到 30 分钟的定时唤醒，让它自己回来看看

现在：我让 agent 派卡 → 结束这一轮 → 卡自己结算 → 插件像发消息一样把结算推进宿主会话 → agent 自然地醒来验收
```

看板怎么用，每个人不一样。有人习惯手写卡片，那种卡没有「发起它的会话」，结算消息也就没地方送——这一段说的是“从对话里派出去的卡”这条线，本插件补的正是这条线的回程。

一次派出去 7 张卡，不用坐在那儿守着刷新——派完就能收工，哪张先回来，它自己敲门。要在「办公室遥控施工现场」这种模式下干活，缺的正是这根回线：不是多一个提醒灯，而是**卡的结果真的回到了说话的地方**。

- 消息里带标题、成败、耗时，和一句能直接照着做的「下一步」；失败卡还带原因。
- 排队投递：会话正忙就等它忙完，**绝不抢断**它手上的活。
- 30 秒内的成功卡合成一条；失败卡立刻单发；子任务不刷屏，父卡结算时汇总成一行。

## 它用自己证明了自己

第一次真实验收，看板上躺着的恰好是这个插件自己的收尾卡。那张卡结算时，把「我完成了」送进会话的，就是这个插件——它报告的是它自己的完工。

截图底部那行思考留着这个瞬间：*The plugin card settled, and its own final message came via the plugin — nice recursive proof.*

装稳之后，人肉轮询和兜底定时提醒都可以撤掉：插件在，定时自检只是多余的噪音。

## 一条消息长什么样

单卡成功：

```text
〔看板〕M2-B 已结算 · 成功 · 用时 9 分（会话 session-9f3c…）
产物在 src-tauri/src/kp_document.rs
```

失败卡（不参与合批，立刻发）：

```text
〔看板〕构建 Linux 包 已结算 · 失败 · 用时 2 分（会话 session-9f3c…）
原因：cargo build failed: linking with `cc` failed
下一步：查看 ~/.dsh/dsh-task-settle-notify/trace.log，或重跑该卡
```

窗口内多张成功卡：

```text
〔看板〕3 张卡已结算 · 成功 · 用时合计 21 分（会话 session-9f3c…）
· 修 K 线导出 · 8 分 · 产物在 src/kline.rs
· 补任务看板文档 · 6 分 · 下一步：打开看板查看该卡详情
· 升级依赖 · 7 分 · 产物在 package.json
```

父卡结算时只多一行摘要：`含 4 个子任务：导出、导入、去重、文档`。

## 依赖

市场里做任务看板的插件不少，多数管的是派卡与执行这一段：卡怎么建、怎么排队、怎么跑、界面怎么摆。这一只不碰这些——它不派卡、不执行、不写账本，只订阅「卡结算了」一个事件，把结果送回发起它的那个会话。所以它要的是一张**已经能派卡、能跑卡**的看板。

| 依赖 | 要求 | 缺了会怎样 |
| --- | --- | --- |
| DSH 宿主 | ≥ `0.2.1-rc.2` | 老宿主不认 `dsh.bundle`，插件不会加载 |
| 任务看板 | `@linxin666/dsh-client-ui-task-board` ≥ `0.4.8`，提供 provider extension v1 | 没有 `taskBoard` 服务时插件静默待命：`status` 里 `extensionActive: false`，不报错，也不影响看板 |
| 会话网关 | 宿主自带的 `typertGateway` | 消息投不进发起会话，`error.log` 记一条，最多重试一次 |
| Node | ≥ 20 | 装不上，也跑不起来 |
| `@deepseek-ai/cordis` | `~4.0.5`（peer 依赖） | 由宿主提供，不随本插件安装 |

看板是硬依赖，但它**不在**本插件的 `dependencies` 里：插件不从看板 import 任何东西、不读 `~/.dsh/task-board/ledger-v2.json`、不改看板包。只要某个看板实现提供同名的 `taskBoard` 服务、并实现同一版 `registerExtension` / `onExecutionSettled` 契约，就能接上——换实现不用改本插件。

它只注册一个扩展订阅、只读事件，所以能和别的看板类插件一起装。上面这些凑齐，再往下看安装。

## 装上它

包在 npm 上：`dsh-task-settle-notify`。两条命令装完：

```bash
dsh plugin --profile web add dsh-task-settle-notify
# 再把 "dsh-task-settle-notify" 加进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
```

想跟着源码改，就 clone 下来用脚本装（上面两步它一次做完，外加备份和回执）：

```bash
git clone https://github.com/chenvinc/dsh-task-settle-notify.git
cd dsh-task-settle-notify
node scripts/install.mjs
```

脚本会先备份要改的 profile 文件，再 `link:` 进 profile 的 `dsh.profile.bundles`；不碰 DSH 源码、看板包和账本。profile 开了 live reload 就热挂载，否则重启一次 `dsh web`。验证：

```bash
curl -s http://127.0.0.1:3080/api/task-settle-notify/status
# {"ok":true,"status":{"extensionActive":true,"pending":0,"delivered":2,"failed":0,...}}
```

`extensionActive: true` 就是接上了。卸载：`node scripts/uninstall.mjs`。

设置卡在 **设置 → 任务结算通知**，四项：总开关、合批窗口（默认 30 秒）、只看自己发起的卡、父卡是否汇总子任务。也可以直接改 `~/.dsh/profiles/web/task-settle-notify/settings.json`。

## 它是怎么知道的

看板每跑完一张卡，会向订阅者广播一次结算。本插件旁路订阅这个公开事件（不改 DSH、不改看板、不写账本），回查「这次执行是谁发起的」，去重、判父子、合批，然后用 `session/prompt` 把消息排队投进那个会话。

没有轮询、没有文件监听，也不打断任何正在进行的回合。想深挖契约和文件行号，看 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 验证

- 45 条单元测试，`node --test` 全绿，不依赖真实看板。
- 真机端到端：结算到投递间隔 **30.012 s**，正好是配置的 30 秒窗口。
- 消息真的落地：发起会话的持久日志里有 `agent/inbox/spliced`（`seq: 1472`），`status` 计数 `delivered` 递增、`failed: 0`。

完整记录（id、时间戳、日志片段、复现步骤）见 [docs/VERIFICATION.md](./docs/VERIFICATION.md)。

## 边界

| 限制 | 说明 |
| --- | --- |
| 只在同一 Host、同一 profile 内 | 会话被删掉或跨机器，投递失败会记进 `error.log` |
| 定时任务不通知 | cron 没有「发起会话」，本来就没人可回 |
| 手动写、或不是会话发起的卡不通知 | 没有「发起会话」，消息无处可投 |
| 投递成功 ≠ 人已读 | 宿主只保证消息进队列；会话一直忙就一直排队 |
| 重启不补发 | 只报「活着时」发生的结算 |
| 消息正文目前只有中文 | 设置卡已中英双语，消息文案还没做 i18n |

完整清单（含「子代理会话不能收件」这类宿主边界）见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 兼容

已实测：DSH `0.2.1-rc.2` + 看板 `0.4.8` + Node `24.19.0`，macOS。纯 Node，无原生依赖；其它平台没测过，理论上能跑。上面「依赖」一节列的是要求，这里是实际验证过的组合。

## 开发

```bash
npm test     # node --test，45 条
```

```
index.js  client.js  lib/（10 个模块）  locale/  test/  scripts/  docs/
```

模块职责、数据结构与失败自愈策略见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)，插件与看板之间的字段契约见 [docs/CONTRACT.md](./docs/CONTRACT.md)。

## License

[MIT](./LICENSE) © chenvinc

社区插件，非 DeepSeek 官方项目；「DeepSeek Harness」等名称归其各自权利人所有。
