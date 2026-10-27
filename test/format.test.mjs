import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clean,
  extractArtifact,
  formatBatch,
  formatDuration,
  formatSingle,
  nextStepHint,
} from '../lib/format.js'
import { fixtureTasks } from './helpers.mjs'
import { parseSettlement } from '../lib/parse.js'

/** @param {string} id @param {string} executionId */
function recordFor(id, executionId) {
  const task = fixtureTasks().find((entry) => entry.id === id)
  return parseSettlement(task, executionId)
}

test('formats the human duration shape used in the contract', () => {
  assert.equal(formatDuration(540_000), '9 分')
  assert.equal(formatDuration(9_000), '9 秒')
  assert.equal(formatDuration(3_600_000), '1 小时')
  assert.equal(formatDuration(3_900_000), '1 小时 5 分')
  assert.equal(formatDuration(-5), '1 秒')
  assert.equal(formatDuration(Number.NaN), '1 秒')
})

test('the single-card line matches the documented shape and adds an artifact hint', () => {
  const text = formatSingle(recordFor('task-root', 'exec-root'))
  const lines = text.split('\n')
  assert.equal(lines[0], '〔看板〕M2-B 已结算 · 成功 · 用时 9 分（会话 session-alpha）')
  assert.equal(lines[1], '产物在 src-tauri/src/kp_document.rs')
})

test('a failure message carries the error and no success hint', () => {
  const text = formatSingle(recordFor('task-failed', 'exec-failed'))
  assert.match(text, /^〔看板〕M2-C 已结算 · 失败 · 用时 2 分/)
  assert.match(text, /原因：integration test panicked at tests\/kp\.rs:88/)
  assert.doesNotMatch(text, /产物在/)
  assert.match(text, /^下一步：/m)
})

test('a parent message can carry its child summary', () => {
  const text = formatSingle(recordFor('task-root', 'exec-root'), {
    childSummary: { count: 1, titles: ['M2-B · 子任务：解析器'], failed: 0 },
  })
  assert.match(text, /含 1 个子任务：M2-B · 子任务：解析器/)
})

test('a batch is one message with one line per card and a summed duration', () => {
  const first = recordFor('task-root', 'exec-root')
  const second = recordFor('task-orphan-child', 'exec-orphan-child')
  const text = formatBatch([first, second])
  const lines = text.split('\n')
  assert.match(lines[0], /^〔看板〕2 张卡已结算 · 成功 · 用时合计 11 分（会话 session-alpha）$/)
  assert.match(lines[1], /^· M2-B · 9 分 · 产物在 src-tauri\/src\/kp_document\.rs$/)
  assert.match(lines[2], /^· 孤儿卡的子任务 · 2 分/)
})

test('artifact extraction skips URLs, node_modules and parent-relative paths', () => {
  assert.equal(extractArtifact('see https://example.com/a.ts'), undefined)
  assert.equal(extractArtifact('changed node_modules/pkg/index.js'), undefined)
  assert.equal(extractArtifact('wrote ../outside/file.ts'), undefined)
  assert.equal(extractArtifact('wrote src/app/main.tsx ok'), 'src/app/main.tsx')
  assert.equal(nextStepHint({ summaryText: 'done: src/app/main.tsx' }), '产物在 src/app/main.tsx')
  assert.match(nextStepHint({ summaryText: '', ok: true }), /^下一步：打开看板/)
  assert.match(nextStepHint({ summaryText: 'All tests passed, nothing else to report.' }), /^下一步：/)
})

test('clean caps runaway text with an ellipsis', () => {
  const text = clean('x'.repeat(200), 20)
  assert.equal(text.length, 20)
  assert.ok(text.endsWith('…'))
})
