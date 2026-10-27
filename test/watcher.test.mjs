import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskBoardWatcher } from '../lib/watcher.js'
import { createHarness, fixtureTasks, settle } from './helpers.mjs'

const NOW = 1_700_000_091_000

/** @param {object} [options] */
function harness(options = {}) {
  return createHarness({ TaskBoardWatcher, now: NOW, ...options })
}

test('a settled success opens the window, then delivers the contract line', async () => {
  const h = harness()
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.watcher.readStatus().pending, 1)
  assert.equal(h.pendingTimers().length, 1)
  assert.equal(h.pendingTimers()[0].ms, 30_000)

  h.runTimers()
  await settle()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].sessionId, 'session-alpha')
  const lines = h.deliveries[0].text.split('\n')
  assert.equal(lines[0], '〔看板〕M2-B 已结算 · 成功 · 用时 9 分（会话 session-alpha）')
  assert.equal(lines[1], '产物在 src-tauri/src/kp_document.rs')
  assert.equal(h.watcher.readStatus().delivered, 1)
  h.watcher.dispose()
})

test('two successes for one initiating session become one message', async () => {
  const h = harness()
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  h.fire({ taskId: 'task-orphan-child', executionId: 'exec-orphan-child', outcome: 'succeeded' })
  assert.equal(h.watcher.readStatus().pending, 2)
  h.runTimers()
  await settle()
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].text, /^〔看板〕2 张卡已结算 · 成功/)
  assert.match(h.deliveries[0].text, /M2-B/)
  assert.match(h.deliveries[0].text, /孤儿卡的子任务/)
  h.watcher.dispose()
})

test('a failure is sent immediately, alone, with its reason', async () => {
  const h = harness()
  h.fire({ taskId: 'task-failed', executionId: 'exec-failed', outcome: 'failed' })
  await settle()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.watcher.readStatus().pending, 0)
  assert.match(h.deliveries[0].text, /^〔看板〕M2-C 已结算 · 失败/)
  assert.match(h.deliveries[0].text, /原因：integration test panicked/)
  h.watcher.dispose()
})

test('a child is folded while its parent runs; the parent carries the summary', async () => {
  const tasks = fixtureTasks()
  tasks.find((entry) => entry.id === 'task-root').status = 'running'
  const h = harness({ tasks })
  h.fire({ taskId: 'task-child', executionId: 'exec-child', outcome: 'succeeded' })
  await settle()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.watcher.readStatus().suppressed, 1)

  tasks.find((entry) => entry.id === 'task-root').status = 'done'
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  h.runTimers()
  await settle()
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].text, /含 1 个子任务：M2-B · 子任务：解析器/)
  h.watcher.dispose()
})

test('a repeated event for the same execution is delivered once', async () => {
  const h = harness()
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  assert.equal(h.watcher.readStatus().duplicate, 1)
  assert.equal(h.watcher.readStatus().pending, 1)
  h.runTimers()
  await settle()
  assert.equal(h.deliveries.length, 1)
  assert.match(h.deliveries[0].text, /^〔看板〕M2-B/)
  h.watcher.dispose()
})

test('a settlement older than this plugin run is never replayed', async () => {
  const h = harness({ now: NOW + 10_000_000 })
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  await settle()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.watcher.readStatus().pending, 0)
  assert.ok(h.logLines.some((line) => line.stage === 'stale-skipped'))
  h.watcher.dispose()
})

test('onlySelfInitiated narrows delivery to the configured session', async () => {
  const h = harness({ config: { onlySelfInitiated: true, selfSessionId: 'session-beta' } })
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  h.runTimers()
  await settle()
  assert.equal(h.deliveries.length, 0)
  h.watcher.dispose()
})

test('external outcomes and runs without an initiating session are skipped', async () => {
  const tasks = fixtureTasks()
  const root = tasks.find((entry) => entry.id === 'task-root')
  tasks.push({
    ...structuredClone(root),
    id: 'task-cron',
    executions: [{ ...structuredClone(root.executions[0]), id: 'exec-cron', initiatedBy: undefined }],
  })
  const h = harness({ tasks })
  h.fire({ taskId: 'task-external', executionId: 'exec-external', outcome: 'succeeded' })
  h.fire({ taskId: 'task-cron', executionId: 'exec-cron', outcome: 'succeeded' })
  h.runTimers()
  await settle()
  assert.equal(h.deliveries.length, 0)
  assert.ok(h.logLines.some((line) => line.stage === 'external-skipped'))
  assert.ok(h.logLines.some((line) => line.stage === 'no-initiator-skipped'))
  h.watcher.dispose()
})

test('the master switch stops all delivery without unregistering', async () => {
  const h = harness({ config: { enabled: false } })
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  h.runTimers()
  await settle()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.watcher.readStatus().extensionActive, true)
  h.watcher.dispose()
})

test('includeSubtasks=false keeps the parent message clean', async () => {
  const h = harness({ config: { includeSubtasks: false } })
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  h.runTimers()
  await settle()
  assert.doesNotMatch(h.deliveries[0].text, /子任务/)
  h.watcher.dispose()
})

test('dispose releases the board subscription and drops pending successes', async () => {
  const h = harness()
  assert.equal(h.listenerCount(), 1)
  h.fire({ taskId: 'task-root', executionId: 'exec-root', outcome: 'succeeded' })
  h.watcher.dispose()
  assert.equal(h.listenerCount(), 0)
  assert.equal(h.watcher.readStatus().pending, 0)
  h.runTimers()
  await settle()
  assert.equal(h.deliveries.length, 0)
})
