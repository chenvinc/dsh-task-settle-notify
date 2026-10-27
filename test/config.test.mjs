import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CONFIG, MAX_BATCH_WINDOW_SECONDS, resolveConfig } from '../lib/config.js'

test('empty input yields the documented defaults', () => {
  assert.deepEqual(resolveConfig(undefined), {
    enabled: true,
    batchWindowSeconds: 30,
    onlySelfInitiated: false,
    includeSubtasks: true,
    selfSessionId: '',
  })
  assert.deepEqual(resolveConfig(null), resolveConfig({}))
  assert.equal(DEFAULT_CONFIG.batchWindowSeconds, 30)
  assert.equal(MAX_BATCH_WINDOW_SECONDS, 600)
})

test('booleans are accepted only when they are real booleans', () => {
  const config = resolveConfig({
    enabled: false,
    onlySelfInitiated: true,
    includeSubtasks: false,
  })
  assert.equal(config.enabled, false)
  assert.equal(config.onlySelfInitiated, true)
  assert.equal(config.includeSubtasks, false)

  const strings = resolveConfig({ enabled: 'false', onlySelfInitiated: 'yes', includeSubtasks: 0 })
  assert.equal(strings.enabled, true)
  assert.equal(strings.onlySelfInitiated, false)
  assert.equal(strings.includeSubtasks, true)
})

test('the batching window is clamped to 5..600 seconds and rounded', () => {
  assert.equal(resolveConfig({ batchWindowSeconds: 2 }).batchWindowSeconds, 5)
  assert.equal(resolveConfig({ batchWindowSeconds: 1000 }).batchWindowSeconds, 600)
  assert.equal(resolveConfig({ batchWindowSeconds: 12.6 }).batchWindowSeconds, 13)
  assert.equal(resolveConfig({ batchWindowSeconds: '45' }).batchWindowSeconds, 45)
  assert.equal(resolveConfig({ batchWindowSeconds: 'nope' }).batchWindowSeconds, 30)
  assert.equal(resolveConfig({ batchWindowSeconds: Infinity }).batchWindowSeconds, 30)
})

test('selfSessionId is trimmed, flattened and capped', () => {
  assert.equal(resolveConfig({ selfSessionId: '  session-a  ' }).selfSessionId, 'session-a')
  assert.equal(resolveConfig({ selfSessionId: 'a\nb' }).selfSessionId, 'a b')
  assert.equal(resolveConfig({ selfSessionId: 'x'.repeat(500) }).selfSessionId.length, 200)
  assert.equal(resolveConfig({ selfSessionId: 42 }).selfSessionId, '')
})

test('an array or primitive cannot be mistaken for a configuration object', () => {
  assert.deepEqual(resolveConfig([]), resolveConfig({}))
  assert.deepEqual(resolveConfig('nope'), resolveConfig({}))
})
