import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyTask, latestExecution, summarizeChildren } from '../lib/aggregate.js'
import { fixtureTasks } from './helpers.mjs'

test('a task without a parent is a root', () => {
  const tasks = fixtureTasks()
  assert.equal(classifyTask(tasks[0], tasks).role, 'root')
})

test('a child stays folded while its parent is still running', () => {
  const tasks = fixtureTasks()
  const parent = tasks.find((entry) => entry.id === 'task-root')
  const child = tasks.find((entry) => entry.id === 'task-child')
  parent.status = 'running'
  assert.equal(classifyTask(child, tasks).role, 'child')
})

test('a child whose parent already settled is an orphan and gets its own notice', () => {
  const tasks = fixtureTasks()
  const child = tasks.find((entry) => entry.id === 'task-orphan-child')
  assert.equal(classifyTask(child, tasks).role, 'orphan')
})

test('a child whose parent vanished from the ledger is an orphan', () => {
  const tasks = fixtureTasks().filter((entry) => entry.id !== 'task-finished-parent')
  const child = tasks.find((entry) => entry.id === 'task-orphan-child')
  assert.equal(classifyTask(child, tasks).role, 'orphan')
})

test('summarizes only children from the same cascade run group', () => {
  const tasks = fixtureTasks()
  const parent = tasks.find((entry) => entry.id === 'task-root')
  const summary = summarizeChildren(parent, tasks, 'group-1')
  assert.equal(summary.count, 1)
  assert.deepEqual(summary.titles, ['M2-B · 子任务：解析器'])
  assert.equal(summary.failed, 0)

  const otherGroup = summarizeChildren(parent, tasks, 'group-other')
  assert.equal(otherGroup.count, 0) // a different cascade is not this parent's summary
})

test('latestExecution picks the newest settled execution', () => {
  const tasks = fixtureTasks()
  const parent = tasks.find((entry) => entry.id === 'task-root')
  assert.equal(latestExecution(parent).id, 'exec-root')
  assert.equal(latestExecution({ executions: [] }), undefined)
  assert.equal(latestExecution(undefined), undefined)
})
