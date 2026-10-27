import assert from 'node:assert/strict'
import test from 'node:test'

import { SettleBatcher } from '../lib/batcher.js'

/**
 * @param {number} windowMs
 * @returns {{ batcher: SettleBatcher, events: Array<[object[], string]>, timers: any[], runTimers: Function }}
 */
function makeBatcher(windowMs = 30_000) {
  const events = []
  const timers = []
  const batcher = new SettleBatcher({
    windowMs,
    onFlush: (records, kind) => events.push([records, kind]),
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true
    },
  })
  const runTimers = () => {
    for (const timer of timers) {
      if (timer.cleared) continue
      timer.cleared = true
      timer.fn()
    }
  }
  return { batcher, events, timers, runTimers }
}

/** @param {string} title @param {boolean} [ok] */
const record = (title, ok = true) => ({ taskId: title, title, ok, durationMs: 1000 })

test('successes inside the window leave as one batch', () => {
  const { batcher, events, timers, runTimers } = makeBatcher(30_000)
  assert.equal(batcher.add(record('A')), 'batch')
  assert.equal(batcher.add(record('B')), 'batch')
  assert.equal(batcher.add(record('C')), 'batch')
  assert.equal(batcher.pendingCount, 3)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 30_000)
  runTimers()
  assert.equal(events.length, 1)
  assert.equal(events[0][1], 'batch')
  assert.deepEqual(events[0][0].map((entry) => entry.title), ['A', 'B', 'C'])
  assert.equal(batcher.pendingCount, 0)
})

test('a failure is delivered immediately and never joins the pending batch', () => {
  const { batcher, events, timers } = makeBatcher(30_000)
  batcher.add(record('A'))
  assert.equal(batcher.add(record('boom', false)), 'failure')
  assert.equal(events.length, 1)
  assert.equal(events[0][1], 'failure')
  assert.equal(events[0][0].length, 1)
  assert.equal(events[0][0][0].title, 'boom')
  assert.equal(batcher.pendingCount, 1)
  assert.equal(timers.length, 1)
})

test('the first success opens the window; later successes do not extend it', () => {
  const { batcher, timers, runTimers } = makeBatcher(30_000)
  batcher.add(record('A'))
  const first = timers[0]
  batcher.add(record('B'))
  assert.equal(timers.length, 1)
  assert.equal(timers[0], first)
  runTimers()
  // After the window closed, the next success opens a fresh window.
  batcher.add(record('C'))
  assert.equal(timers.length, 2)
  assert.equal(timers[1].ms, 30_000)
})

test('a zero window flushes on the next timer turn as a single batch', () => {
  const { batcher, events, runTimers } = makeBatcher(0)
  batcher.add(record('A'))
  runTimers()
  assert.equal(events.length, 1)
  assert.deepEqual(events[0][0].map((entry) => entry.title), ['A'])
})

test('flush is idempotent and dispose drops pending successes', () => {
  const { batcher, events } = makeBatcher(30_000)
  batcher.add(record('A'))
  assert.equal(batcher.flush().length, 1)
  assert.equal(batcher.flush().length, 0)
  assert.equal(events.length, 1)

  batcher.add(record('B'))
  batcher.dispose()
  assert.equal(batcher.pendingCount, 0)
  assert.equal(events.length, 1)
})
