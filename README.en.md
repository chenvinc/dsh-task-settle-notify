# dsh-task-settle-notify

> When a DSH task-board card settles, deliver a short message **back to the session that started it** — no more manual polling.

[中文](./README.md) · [Architecture](./docs/ARCHITECTURE.md) · [Contract](./docs/CONTRACT.md) · [Install](./docs/INSTALL.md) · [Verification](./docs/VERIFICATION.md)

```
〔看板〕M2-B settled · succeeded · 9 min (session session-9f3c…)
artifact at src-tauri/src/kp_document.rs
```

## Features

- **Settle-time delivery**: on `running → done | failed`, queue a `session/prompt` into the initiator session. `mode: "queue"` never interrupts it.
- **30 s batching**: successes inside the window become one message; one message per initiating session.
- **Failures first**: failed cards are sent immediately and never join a batch.
- **Parent/child folding**: children stay quiet while the parent runs; the parent message carries a one-line child summary. Orphans still notify.
- **Four settings**: master switch, batch window, only-my-cards, include-subtasks; with a browser settings card.
- **Side-car**: no DSH patch, no board patch, no ledger writes; only the board's public provider-extension events.
- **Self-healing**: callback errors never reach the host, one retry, capped logs, no replay after restart.

## Install

```bash
git clone https://github.com/chenvinc/dsh-task-settle-notify.git
cd dsh-task-settle-notify
node scripts/install.mjs
```

When the profile sets `dsh.profile.patchReload: live`, the host hot-loads the bundle
without a restart. If the status route is still 404 after a few seconds, restart `dsh web`:

```bash
curl -s http://127.0.0.1:3080/api/task-settle-notify/status
```

Uninstall:

```bash
node scripts/uninstall.mjs
```

See [docs/INSTALL.md](./docs/INSTALL.md).

## Settings

Settings → Task settlement notifications:

| Setting | Default | Notes |
| --- | --- | --- |
| Enabled | on | master switch |
| Batch window (s) | 30 | clamped 5..600 |
| Only my cards | off | paired with `selfSessionId` |
| Include subtasks | on | parent message gets a child summary |

They can also be set in `cordis.patch.yml` under `config`, or overridden by `~/.dsh/profiles/web/task-settle-notify/settings.json`.

## How it works

The board broadcasts a settlement to provider extensions:

```js
{ taskId, executionId, outcome, error? }
```

The plugin looks the execution up through `host.tasks.get(taskId)`, reads `execution.initiatedBy`, then dedupes, folds children, batches, and calls:

```js
gateway.invoke({
  namespace: 'session',
  method: 'prompt',
  args: { request: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } },
})
```

No polling, no file watching, no ledger writes. Details in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Known limitations

- Only sessions that still exist in this Host/profile; a deleted session fails into `error.log`.
- cron runs and `record-external-outcome` have no initiating session and are skipped.
- "Delivered" means the host accepted and queued the prompt, not that a human read it.
- Settlements from before a plugin restart are not replayed.
- Requires task board ≥ 0.4.8 (provider extension v1).
- Subagent sessions cannot be recipients: the gateway rejects them (`owned by subagent routing`); the failure is logged and never escalated to the parent session.
- Verified end-to-end against a real task board on this machine; see [docs/VERIFICATION.md](./docs/VERIFICATION.md).

## Development

```bash
npm test          # node --test, 45 tests
```

Layout:

```
index.js / client.js / cordis.patch.yml
lib/              parsing, aggregation, batching, formatting, delivery, HTTP, logs
test/             node:test + hand-written ledger fixtures
scripts/          install.mjs / uninstall.mjs
docs/             architecture, contract, install, verification
```

## License

MIT
