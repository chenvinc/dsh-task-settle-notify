import assert from 'node:assert/strict'
import test from 'node:test'

import { ExecutionDeduper, findExecution, parseSettlement } from '../lib/parse.js'
import { fixtureTasks } from './helpers.mjs'

test('parses one settled execution from a hand-written ledger', () => {
  const task = fixtureTasks().find((entry) => entry.id === 'task-root')
  const record = parseSettlement(task, 'exec-root')
  assert.ok(record)
  assert.equal(record.taskId, 'task-root')
  assert.equal(record.title, 'M2-B')
  assert.equal(record.outcome, 'succeeded')
  assert.equal(record.ok, true)
  assert.equal(record.durationMs, 540_000)
  assert.equal(record.initiatedBy, 'session-alpha')
  assert.equal(record.runnerSessionId, 'session-runner-root')
  assert.equal(record.runGroupId, 'group-1')
  assert.equal(record.external, false)
  assert.match(record.summaryText, /kp_document\.rs/)
})

test('parses a failure and keeps the error text', () => {
  const task = fixtureTasks().find((entry) => entry.id === 'task-failed')
  const record = parseSettlement(task, 'exec-failed')
  assert.ok(record)
  assert.equal(record.ok, false)
  assert.equal(record.outcome, 'failed')
  assert.match(record.error, /integration test panicked/)
})

test('ignores an execution that has not ended yet', () => {
  const task = fixtureTasks().find((entry) => entry.id === 'task-running')
  assert.equal(parseSettlement(task, 'exec-running'), null)
})

test('ignores cancelled/unknown outcomes and missing executions', () => {
  const task = fixtureTasks().find((entry) => entry.id === 'task-root')
  assert.equal(parseSettlement(task, 'exec-root', { outcome: 'cancelled' }), null)
  assert.equal(parseSettlement(task, 'does-not-exist'), null)
  assert.equal(parseSettlement(undefined, 'exec-root'), null)
})

test('marks an externally recorded execution as external', () => {
  const task = fixtureTasks().find((entry) => entry.id === 'task-external')
  const record = parseSettlement(task, 'exec-external')
  assert.ok(record)
  assert.equal(record.external, true)
  assert.equal(record.initiatedBy, 'agent-outside-host')
})

test('finds an execution by id and tolerates malformed task payloads', () => {
  const task = fixtureTasks()[0]
  assert.equal(findExecution(task, 'exec-root').id, 'exec-root')
  assert.equal(findExecution({ executions: null }, 'exec-root'), undefined)
  assert.equal(findExecution(undefined, 'exec-root'), undefined)
})

test('deduper accepts an execution once and forgets old ids beyond its bound', () => {
  const deduper = new ExecutionDeduper(2)
  assert.equal(deduper.first('exec-root'), true)
  assert.equal(deduper.first('exec-root'), false)
  assert.equal(deduper.first('exec-child'), true)
  assert.equal(deduper.first('exec-failed'), true)
  // The oldest id (exec-root) was evicted at the bound.
  assert.equal(deduper.first('exec-root'), true)
  deduper.clear()
  assert.equal(deduper.first('exec-root'), true)
})
