# dsh-task-settle-notify

> The card is done — and the message knocks by itself. **The session that started a card gets its settlement.**

[中文](./README.md) · [Architecture](./docs/ARCHITECTURE.md) · [Contract](./docs/CONTRACT.md) · [Install](./docs/INSTALL.md) · [Verification](./docs/VERIFICATION.md)

[![npm](https://img.shields.io/npm/v/dsh-task-settle-notify?color=CB3837)](https://www.npmjs.com/package/dsh-task-settle-notify)
[![License](https://img.shields.io/github/license/chenvinc/dsh-task-settle-notify?color=4B6EF5)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-60%20passing-brightgreen)](./test)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](./package.json)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4B6EF5)](./package.json)
[![Topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

![A settled card's notice arrives in the session that started it](docs/assets/settlement-notice.png)

A real delivery: the card ran in its own execution session, and the notice landed in the session that started it (session id and local path redacted).

## How the job changes

```text
before: ask the agent to dispatch cards from the chat → the card finishes → I go back and tell it "the card is done" → it checks the board
        or: set a 20–30 minute scheduled wake-up so it comes back and looks

after:  ask the agent to dispatch → end the turn → the card settles on its own → the plugin pushes that settlement into the host session like a message → the agent wakes up and reviews
```

Not everyone uses the board the same way. Some people write cards by hand, and a hand-written card has no session that started it — there is nowhere for a settlement message to go. This section is about the line that does have an origin: cards dispatched from a chat. That is exactly the return path this plugin adds.

Dispatch seven cards and walk away. Nothing to refresh: whichever finishes first knocks on its own. For running a build site from the office, this is the missing return line — not another reminder light, but **the card's result arriving where the work is actually discussed**.

- The message carries the title, outcome, duration and one next step you can act on; failures carry the reason too.
- Delivery is queued: a busy session finishes what it is doing first — it is **never interrupted**.
- Successes inside 30 seconds merge into one message; failures go out immediately; children never flood the session, the parent summarises them in a line.

## It proved itself

On the first real acceptance run, the card waiting on the board was this plugin's own wrap-up card. When it settled, the thing that carried "I'm done" into the session was this plugin — reporting its own completion.

The line of thinking under the screenshot keeps the moment: *The plugin card settled, and its own final message came via the plugin — nice recursive proof.*

Once it settles in, manual polling and fallback reminders can go: with the plugin installed, a scheduled self-check is just noise.

## What a message looks like

Single card, success:

```text
〔看板〕M2-B 已结算 · 成功 · 用时 9 分（会话 session-9f3c…）
产物在 src-tauri/src/kp_document.rs
```

Failure (never batched, sent immediately):

```text
〔看板〕构建 Linux 包 已结算 · 失败 · 用时 2 分（会话 session-9f3c…）
原因：cargo build failed: linking with `cc` failed
下一步：查看 ~/.dsh/dsh-task-settle-notify/trace.log，或重跑该卡
```

Several successes inside the window:

```text
〔看板〕3 张卡已结算 · 成功 · 用时合计 21 分（会话 session-9f3c…）
· 修 K 线导出 · 8 分 · 产物在 src/kline.rs
· 补任务看板文档 · 6 分 · 下一步：打开看板查看该卡详情
· 升级依赖 · 7 分 · 产物在 package.json
```

A settling parent card adds one line only: `含 4 个子任务：导出、导入、去重、文档`.

The samples are verbatim output: message text is currently **Chinese only**, while the settings card is bilingual. See [Boundaries](#boundaries).

## A card that stops to ask, asks here

A card does not only need you when it settles. Halfway through it may need a decision, a file path, or confirmation of something destructive — it calls `ask_user_question`, and a card running on the board has nobody watching its question panel.

The plugin claims that question and sends it into the session that dispatched the card:

```text
〔看板〕季度报表导出 在推进中向你提问（共 1 问）
1. [导出格式] 导出成 CSV 还是 XLSX？
   选项：CSV ｜ XLSX
用 answer_card_question 回答：card_question_id="call-…"，answers 里每道题给一项。
```

That session answers when it can; when it cannot, it asks you and hands your answer back. The card carries on as if it had received a normal answer. If nobody answers before the deadline the card is told "unanswered — continue the conservative way and record the open point", so it is never stuck forever.

Both knobs live in the settings card: **Relay card questions** (on by default) and **Question wait limit** (10 minutes by default, 60–3600s).

## Requirements

The market has plenty of task-board plugins, and most of them cover the dispatch side: how cards are created, queued and run, and how the board looks. This one does none of that — it does not dispatch, execute, or write the ledger. It subscribes to a single event, "a card settled", and carries the result back to the session that asked for the card. So it needs a board that can already create and run cards.

| Requirement | Version | Without it |
| --- | --- | --- |
| DSH host | ≥ `0.2.1-rc.2` | Older hosts do not read `dsh.bundle`, so the plugin is never loaded |
| Task board | `@linxin666/dsh-client-ui-task-board` ≥ `0.4.8`, provider extension v1 | No `taskBoard` service means the plugin idles: `extensionActive: false` in `status`, no errors, no effect on the board |
| Session gateway | the host's own `typertGateway` | Delivery fails into `error.log` and is retried at most once |
| Node | ≥ 20 | It will not install or run |
| `@deepseek-ai/cordis` | `~4.0.5` (peer) | Supplied by the host, never bundled |

The board is a hard requirement, but it is **not** in this package's `dependencies`: the plugin imports nothing from the board, never reads `~/.dsh/task-board/ledger-v2.json`, and never patches the board package. Any board implementation that exposes the same `taskBoard` service and the same `registerExtension` / `onExecutionSettled` contract will work — swapping boards needs no change here.

It registers one extension subscription and only reads events, so it can be installed alongside other task-board plugins. Once the above is in place, continue to Install.

## Install

It is on npm as `dsh-task-settle-notify`. Two commands:

```bash
dsh plugin --profile web add dsh-task-settle-notify
# then add "dsh-task-settle-notify" to dsh.profile.bundles in ~/.dsh/profiles/web/package.json
```

To follow the source instead, clone it and use the script (it does both steps, plus a backup and a receipt):

```bash
git clone https://github.com/chenvinc/dsh-task-settle-notify.git
cd dsh-task-settle-notify
node scripts/install.mjs
```

The script backs up the profile files it will touch, then `link:`s the plugin into `dsh.profile.bundles`. It does not touch the DSH source, the board package or the ledger. A profile with live reload hot-mounts it; otherwise restart `dsh web` once. Verify:

```bash
curl -s http://127.0.0.1:3080/api/task-settle-notify/status
# {"ok":true,"status":{"extensionActive":true,"pending":0,"delivered":2,"failed":0,...}}
```

`extensionActive: true` means it is wired up. Uninstall: `node scripts/uninstall.mjs`.

The settings card lives under **Settings → Task settlement notifications** with four switches: master switch, batching window (30 s by default), only cards started by a session, and whether the parent summarises its subtasks. You can also edit `~/.dsh/profiles/web/task-settle-notify/settings.json` directly.

## Where it gets the facts

Every time a card settles, the board broadcasts the settlement to its subscribers. This plugin subscribes to that public event (no DSH patch, no board patch, no ledger writes), looks up which session started the execution, dedupes, applies the parent/child rule, batches, and queues the message into that session with `session/prompt`.

No polling, no file watching, and no turn is ever interrupted. For the exact contract and file line numbers see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Verification

- 45 unit tests, `node --test`, all green, no real board needed.
- On a real host: settlement-to-delivery interval **30.012 s**, exactly the configured window.
- The message really landed: `agent/inbox/spliced` (`seq: 1472`) in the initiating session's durable log, with `status` counting `delivered` up and `failed: 0`.

Full record — ids, timestamps, log excerpts, reproduction steps — in [docs/VERIFICATION.md](./docs/VERIFICATION.md).

## Boundaries

| Limitation | Detail |
| --- | --- |
| Same Host and profile only | A deleted or remote session fails into `error.log` |
| Scheduled runs are not notified | A cron run has no initiating session to answer |
| Hand-written or otherwise unsolicited cards are not notified | There is no initiating session, so there is nowhere to deliver |
| Delivered ≠ read | The host queues the message; a permanently busy session keeps it queued |
| No replay | Only settlements that happen while the plugin is running are reported; the question relay has the same lifetime |
| The relay takes the question over | A claimed question never reaches the board or GUI question panel; it only goes to the initiating session |
| Message text is Chinese only | The settings card is bilingual; the message copy is not localised yet |
| Free-text answers come from the model | The relay does not parse prose: the initiating session returns structure through `answer_card_question` |

The full list, including host-level edges such as subagent sessions being unable to receive, is in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Compatibility

Tested with DSH `0.2.1-rc.2`, board `0.4.8` and Node `24.19.0` on macOS. Pure Node, no native dependencies; other platforms are untested but should work. What it needs is listed under [Requirements](#requirements).

## Development

```bash
npm test     # node --test, 60 tests
```

```
index.js  client.js  lib/ (10 modules)  locale/  test/  scripts/  docs/
```

Module responsibilities, data shapes and self-healing strategy: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). The field-level contract with the board: [docs/CONTRACT.md](./docs/CONTRACT.md).

## License

[MIT](./LICENSE) © chenvinc

Community plugin, not an official DeepSeek project; names such as "DeepSeek Harness" belong to their respective owners.
