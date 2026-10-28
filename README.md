# dsh-task-settle-notify

> 卡跑完了，消息自己敲门。**发起那张卡的会话，会收到一条结算消息。**

[English](./README.en.md) · [架构](./docs/ARCHITECTURE.md) · [契约](./docs/CONTRACT.md) · [安装](./docs/INSTALL.md) · [验证](./docs/VERIFICATION.md)

[![npm](https://img.shields.io/npm/v/dsh-task-settle-notify?color=CB3837)](https://www.npmjs.com/package/dsh-task-settle-notify)
[![License](https://img.shields.io/github/license/chenvinc/dsh-task-settle-notify?color=4B6EF5)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-60%20passing-brightgreen)](./test)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](./package.json)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](./package.json)
[![Topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

![卡片结算后，通知被送回发起它的会话](docs/assets/settlement-notice.png)

截图是真实投递：卡片在自己的执行会话里跑完，一句话被送回发起它的会话（会话 id 与本地路径已打码）。

## 一个人管七个施工现场

先摆场景。你是这一层的负责人：一个宿主会话（你的办公室），一张任务看板（工地），几路并行推进的卡。

### 没有插件：派完卡，你就成了调度台

```text
你：这三件事派成卡，我出去一趟
agent：派好了（看板 +3 张卡，正在跑）
——这一轮结束，工地继续——
```

然后就没有然后了。工地还在跑，办公室这边一片安静。想知道进度只有两个办法：

- 过一会儿回对话问「卡到哪了」，它去查板，再把结论告诉你；
- 或者临走前设个 20 到 30 分钟的定时唤醒，让它自己回来看看。

这两个都是人肉轮询的变体，烦人但还忍得住。真正难受的是**意外**：卡跑到一半遇到拿不准的事——选 CSV 还是 XLSX、删不删那张旧表、文件放哪个目录——它会调 `ask_user_question`。可看板上跑的卡，那张提问面板没人守着，卡就停在那儿等。

于是你挨个点开每张卡，看清它在问什么，挨个回答，还得记住哪张是哪张。你本来只是想派活，结果派完多了七个要盯的下属。看板把并行做出来了，回程没人接。

### 有插件：工地的事上不来，结论下得去

```text
你：这三件事派成卡，我出去一趟
agent：派好了……（这一轮可以结束）
——卡自己跑，自己结算，中途卡住自己发问——
〔看板〕导出季度报表 已结算 · 成功 · 用时 8 分（会话 session-9f3c…）
产物在 out/report.csv
〔看板〕升级依赖 在推进中向你提问（共 1 问）
1. [锁版本] id=q-pin1 升到哪个大版本？
```

结算和提问都像一条普通用户消息那样被推进发起会话，宿主会话自然醒来：自己能定的当场答（`answer_card_question`），定不了的才回头问你。你必须知道的，一条不少；你不需要知道的，一条不来。

### 隔离是设计出来的，不是碰巧

- **只回发起会话**：卡只对派它出去的那个会话负责，不广播、不全局弹窗。你始终只跟一个窗口说话。
- **排队不抢断**：会话正忙就等它忙完，绝不打断它手上的活。
- **合批与优先级**：30 秒内的成功卡合成一条，失败卡立刻单发；子任务不刷屏，父卡结算时汇总成一行。
- **边界写在明处**：手写卡片没有发起会话，没有回程地址，这类卡不通知——补的是「从对话里派出去的卡」这条线。

一次派 7 张卡，回来的是几条消息，不是七份日报。施工层有几张卡、卡在哪个步骤、谁在等答案，都不出现在你面前，除非需要你拍板。

## 一次标准实战：四段回程，都是真实记录

不是示意图。2026-10-28 的真机一次跑（卡片 `846bb8a7`，执行会话 `session-2b0534b1…`，发起会话 `session-7d8b8d2a…`）：

| 时间 | 发生的事 |
| --- | --- |
| 17:25:22 | 宿主会话派卡，卡开跑 |
| 17:25:27 | 卡中途提问「选 A 还是 B」→ 插件认领 → **问题进发起会话** |
| 17:26:22 | 发起会话用 `answer_card_question` 答 A，卡收到 `{"answers":[{"id":"relay_selftest","selected":["A"]}]}` |
| 17:26:28 | 卡收尾，输出「收到：A」，用时 1 分 6 秒 |
| 17:26:58 | 结算消息进发起会话（合批窗口 30 秒），`delivered: 1, failed: 0` |

中途进会话的那条：

```text
〔看板〕中继自测：卡中途提问 在推进中向你提问（共 1 问）
1. [中继自测] id=relay_selftest 这张卡正在向发起它的会话提问：选 A 还是 B？
   选项：A ｜ B
answers=[{"id":"relay_selftest","selected":[]}]
用 answer_card_question 回答：card_question_id="card-b29ccdfc-…"，answers 里每道题给一项（id 照抄题干里的 id）。
```

收尾进会话的那条：

```text
〔看板〕中继自测：卡中途提问 已结算 · 成功 · 用时 1 分（会话 session-7d8b8d2a…）
下一步：打开看板查看该卡详情
```

要复核，对着三处看：插件 trace 里的 `question-relayed`（带 taskId、initiatorSessionId、questions 数）、`GET /api/task-settle-notify/status` 的 `relayed / answered / delivered` 计数、发起会话日志里的 `agent/inbox/spliced`。

这次跑还照出两个设计点：

- 两条消息都是在**下一轮边界**进会话的，宿主正在干活时它们排队等着，不打断——所以问答可以隔着好几轮完成。
- 先后顺序不保证。中途那条提示如果来得比回答晚，按它给的 id 再答会得到 `{"ok": false, "error": "没有等待中的卡片提问：…"}`：问题已结算，重复回答不会塞进一张已经结束的卡。

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

## 卡片中途提问，也回到这个会话

卡不是只在结算时才需要你。它跑到一半要选方案、要文件路径、要确认一个破坏性操作时，会调用 `ask_user_question`——而在看板上跑的卡，那张提问面板没人守着。

这个插件把这张提问拦下来，原样送进发起它的会话：

```text
〔看板〕季度报表导出 在推进中向你提问（共 1 问）
1. [导出格式] id=q-export-format 导出成 CSV 还是 XLSX？
   选项：CSV ｜ XLSX
answers=[{"id":"q-export-format","selected":[]}]
用 answer_card_question 回答：card_question_id="call-…"，answers 里每道题给一项（id 照抄题干里的 id，selected 用选项文字，或 custom 自由文本）。
```

题干里的 `id=` 是 upstream 原样的 `questions[].id`（不重新生成、不截断），末尾那行 `answers=` 就是可直接回填的骨架——`answer_card_question` 按 id 匹配，没有 id 的转述根本答不上。极少数 upstream 不给 id 的形态，转述会写 `id 未知（upstream 未提供）`，并提示「该形态无法用工具作答，需人工在 GUI 回答」。

宿主会话看到消息，自己能定就自己答；定不了就问你，再把你的答案交回去。卡那边像收到了正常回答一样往下跑。时限内没人答，卡会收到一句「未回答，按最保守的方式继续，并在结果里写明待确认点」，不会永远挂在那里。

开关和时限都在设置卡里：**卡片提问中继**（默认开）、**提问等待时限**（默认 10 分钟，60–3600 秒）。

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

设置卡在 **设置 → 任务结算通知**，六项：总开关、合批窗口（默认 30 秒）、只看自己发起的卡、父卡是否汇总子任务、卡片提问中继（默认开）、提问等待时限（默认 10 分钟）。也可以直接改 `~/.dsh/profiles/web/task-settle-notify/settings.json`。

## 它是怎么知道的

看板每跑完一张卡，会向订阅者广播一次结算。本插件旁路订阅这个公开事件（不改 DSH、不改看板、不写账本），回查「这次执行是谁发起的」，去重、判父子、合批，然后用 `session/prompt` 把消息排队投进那个会话。

没有轮询、没有文件监听，也不打断任何正在进行的回合。想深挖契约和文件行号，看 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 验证

- 60 条单元测试，`node --test` 全绿，不依赖真实看板。
- 真机端到端：结算到投递间隔 **30.012 s**，正好是配置的 30 秒窗口。
- 提问中继的整条链路（认领 → 回到发起会话 → 代答 → 卡收到 → 结算）见上面「一次标准实战」。
- 消息真的落地：发起会话的持久日志里有 `agent/inbox/spliced`（`seq: 1472`），`status` 计数 `delivered` 递增、`failed: 0`。

完整记录（id、时间戳、日志片段、复现步骤）见 [docs/VERIFICATION.md](./docs/VERIFICATION.md)。

## 边界

| 限制 | 说明 |
| --- | --- |
| 只在同一 Host、同一 profile 内 | 会话被删掉或跨机器，投递失败会记进 `error.log` |
| 定时任务不通知 | cron 没有「发起会话」，本来就没人可回 |
| 手动写、或不是会话发起的卡不通知 | 没有「发起会话」，消息无处可投 |
| 投递成功 ≠ 人已读 | 宿主只保证消息进队列；会话一直忙就一直排队 |
| 重启不补发 | 只报「活着时」发生的结算；提问中继同样只在插件活着时生效 |
| 卡片提问中继会「接管」这道题 | 拦下来就不会再弹到看板/GUI 的提问面板，只走发起会话这一条路 |
| 消息正文目前只有中文 | 设置卡已中英双语，消息文案还没做 i18n |
| 自由文本回答要靠模型给 | 中继不解析自然语言，答案由宿主会话调用 `answer_card_question` 结构化交回 |
| upstream 不给 id 的提问不接管 | 不编造 id：转述写「id 未知（upstream 未提供）」，卡片自己的提问面板继续等人，发起会话只收到一条说明 |

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
