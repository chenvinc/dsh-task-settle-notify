import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANSWER_TOOL_NAME,
  MAX_RELAY_CHARS,
  UNANSWERED_CUSTOM,
  CardQuestionRelay,
  findRunnerTask,
  formatRelayMessage,
  normalizeQuestions,
  unansweredBatch,
  validateAnswerBatch,
} from '../lib/questions.js'

const QUESTIONS = normalizeQuestions([
  {
    id: 'q1',
    header: '导出格式',
    question: '导出成 CSV 还是 XLSX？',
    options: [{ label: 'CSV' }, { label: 'XLSX', description: '带格式' }],
  },
  { id: 'q2', question: '文件名用什么？' },
])

function boardWith(tasks) {
  return { snapshot: () => ({ tasks }) }
}

function config(overrides = {}) {
  return {
    enabled: true,
    relayCardQuestions: true,
    cardQuestionTimeoutSeconds: 600,
    ...overrides,
  }
}

/**
 * A relay wired to fakes: no real timers, no real gateway, no real listener bus.
 * @param {object} [options]
 */
function harness(options = {}) {
  const listeners = []
  const timers = []
  const deliveries = []
  const ctx = {
    on(name, listener, opts) {
      listeners.push({ name, listener, opts })
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
    effect() {
      return () => {}
    },
  }
  const relay = new CardQuestionRelay({
    ctx,
    gateway: {},
    getBoard: () => boardWith(options.tasks ?? []),
    getConfig: () => config(options.config),
    log: { trace() {}, warn() {}, error() {} },
    delivery: async (input) => {
      deliveries.push(input)
      if (options.deliveryFails) throw new Error('gateway down')
    },
    now: () => 1_766_000_000_000,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      handle.cleared = true
    },
  })
  relay.start()
  return { relay, listeners, timers, deliveries, ctx }
}

const RUNNING_CARD = [
  {
    id: 'task-1',
    title: '季度报表导出',
    executions: [{ sessionId: 'runner-1', initiatedBy: 'initiator-1' }],
  },
]

function request() {
  return {
    agent: { id: 'runner-1' },
    questions: [
      {
        id: 'q1',
        header: '导出格式',
        question: '导出成 CSV 还是 XLSX？',
        options: [{ label: 'CSV' }, { label: 'XLSX' }],
      },
    ],
    wait: { callId: 'call-1' },
  }
}

test('the relayed message names the card, the call id and every option', () => {
  const text = formatRelayMessage({
    title: '季度报表导出',
    callId: 'call-1',
    questions: QUESTIONS,
    timeoutSeconds: 600,
  })
  assert.match(text, /季度报表导出/)
  assert.match(text, /call-1/)
  assert.match(text, new RegExp(ANSWER_TOOL_NAME))
  assert.match(text, /\[导出格式\] 导出成 CSV 还是 XLSX？/)
  assert.match(text, /CSV ｜ XLSX/)
  assert.match(text, /没有预设选项/)
  assert.match(text, /10 分钟内/)
  assert.ok(text.length <= MAX_RELAY_CHARS)
})

test('the relayed message stays within the delivery budget on long questions', () => {
  const long = normalizeQuestions(
    Array.from({ length: 40 }, (_, index) => ({ id: `q${index}`, question: '很长的问题'.repeat(60) })),
  )
  const text = formatRelayMessage({ title: 'x'.repeat(300), callId: 'c', questions: long, timeoutSeconds: 60 })
  assert.ok(text.length <= MAX_RELAY_CHARS, `length ${text.length}`)
})

test('normalizeQuestions drops malformed items and clips text', () => {
  const questions = normalizeQuestions([
    { id: '', question: 'x' },
    { id: 'a' },
    { id: 'b', question: 'ok', options: [{ label: '' }, { label: 'yes', description: 'y'.repeat(500) }] },
    'nope',
    null,
  ])
  assert.equal(questions.length, 1)
  assert.equal(questions[0].id, 'b')
  assert.equal(questions[0].options.length, 1)
  assert.ok(questions[0].options[0].description.length <= 120)
  assert.deepEqual(normalizeQuestions('nope'), [])
})

test('an unanswered batch carries one explicit answer per question', () => {
  const batch = unansweredBatch(QUESTIONS)
  assert.equal(batch.answers.length, 2)
  assert.equal(batch.answers[0].custom, UNANSWERED_CUSTOM)
  assert.deepEqual(batch.answers[0].selected, [])
})

test('an answer batch must cover every question and only offered labels', () => {
  assert.deepEqual(
    validateAnswerBatch(QUESTIONS, [
      { id: 'q1', selected: ['CSV'] },
      { id: 'q2', custom: 'report-2026' },
    ]),
    { answers: [{ id: 'q1', selected: ['CSV'] }, { id: 'q2', selected: [], custom: 'report-2026' }] },
  )
  assert.throws(() => validateAnswerBatch(QUESTIONS, [{ id: 'q1', selected: ['CSV'] }]), /q2/)
  assert.throws(
    () => validateAnswerBatch(QUESTIONS, [{ id: 'q1', selected: ['PDF'] }, { id: 'q2', custom: 'a' }]),
    /PDF/,
  )
  assert.throws(
    () => validateAnswerBatch(QUESTIONS, [{ id: 'q1', selected: ['CSV', 'XLSX'] }, { id: 'q2', custom: 'a' }]),
    /只能选一项/,
  )
  assert.throws(
    () => validateAnswerBatch(QUESTIONS, [{ id: 'q1', selected: [] }, { id: 'q2', custom: 'a' }]),
    /没有给出答案/,
  )
  assert.throws(
    () =>
      validateAnswerBatch(QUESTIONS, [
        { id: 'q1', selected: ['CSV'] },
        { id: 'q2', custom: 'a' },
        { id: 'q9', custom: 'b' },
      ]),
    /q9/,
  )
})

test('findRunnerTask matches only a running, non-external execution', () => {
  const tasks = [
    { id: 'done', executions: [{ sessionId: 'runner-1', endedAt: 5, initiatedBy: 'init' }] },
    { id: 'ext', executions: [{ sessionId: 'runner-1', external: true, initiatedBy: 'init' }] },
    { id: 'live', title: 't', executions: [{ sessionId: 'runner-1', initiatedBy: 'init' }] },
  ]
  const found = findRunnerTask(tasks, 'runner-1')
  assert.equal(found.task.id, 'live')
  assert.equal(findRunnerTask(tasks, 'runner-9'), undefined)
  assert.equal(findRunnerTask(undefined, 'runner-1'), undefined)
})

test('the relay claims a card question and delivers it to the initiator', async () => {
  const { relay, listeners, deliveries } = harness({ tasks: RUNNING_CARD })
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].name, 'user-questions/request')
  assert.deepEqual(listeners[0].opts, { prepend: true })

  let passedDown = false
  const answer = listeners[0].listener(request(), async () => {
    passedDown = true
    return { answers: [] }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(passedDown, false, 'the own UI must not also render this question')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].sessionId, 'initiator-1')
  assert.match(deliveries[0].text, /call-1/)
  assert.match(deliveries[0].text, /季度报表导出/)

  const settled = relay.answer({ sessionId: 'initiator-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['CSV'] }] })
  assert.deepEqual(settled, { ok: true, taskId: 'task-1', title: '季度报表导出' })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['CSV'] }] })
  assert.equal(relay.readStatus().answered, 1)
  assert.equal(relay.readStatus().pending, 0)
})

test('only the initialing session may answer, and only once', async () => {
  const { relay, listeners } = harness({ tasks: RUNNING_CARD })
  const answer = listeners[0].listener(request(), async () => ({ answers: [] }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.throws(
    () => relay.answer({ sessionId: 'someone-else', callId: 'call-1', answers: [{ id: 'q1', selected: ['CSV'] }] }),
    /当前会话/,
  )
  assert.throws(
    () => relay.answer({ sessionId: 'initiator-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['NOPE'] }] }),
    /NOPE/,
  )
  relay.answer({ sessionId: 'initiator-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['CSV'] }] })
  assert.throws(
    () => relay.answer({ sessionId: 'initiator-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['CSV'] }] }),
    /没有等待中/,
  )
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['CSV'] }] })
})

test('a request from a card without an initiator is passed down untouched', async () => {
  const { listeners, deliveries } = harness({
    tasks: [{ id: 'task-2', title: 't', executions: [{ sessionId: 'runner-1' }] }],
  })
  let passedDown = false
  const result = await listeners[0].listener(request(), async () => {
    passedDown = true
    return { answers: [{ id: 'q1', selected: [], custom: 'ui' }] }
  })
  assert.equal(passedDown, true)
  assert.equal(deliveries.length, 0)
  assert.deepEqual(result.answers[0].custom, 'ui')
})

test('the relay stays out of the way when it is switched off', async () => {
  const { listeners } = harness({ tasks: RUNNING_CARD, config: { relayCardQuestions: false } })
  let passedDown = false
  await listeners[0].listener(request(), async () => {
    passedDown = true
    return { answers: [] }
  })
  assert.equal(passedDown, true)
})

test('the deadline settles the claim with an explicit no-answer body', async () => {
  const { relay, listeners, timers } = harness({ tasks: RUNNING_CARD })
  const answer = listeners[0].listener(request(), async () => ({ answers: [] }))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 600_000)
  timers[0].fn()

  const settled = await answer
  assert.equal(settled.answers[0].custom, UNANSWERED_CUSTOM)
  assert.deepEqual(settled.answers[0].selected, [])
  assert.equal(relay.readStatus().timedOut, 1)
  assert.equal(relay.readStatus().pending, 0)
})

test('a failed delivery resolves the card immediately instead of hanging it', async () => {
  const { relay, listeners } = harness({ tasks: RUNNING_CARD, deliveryFails: true })
  const answer = listeners[0].listener(request(), async () => ({ answers: [] }))
  const settled = await answer
  assert.equal(settled.answers[0].custom, UNANSWERED_CUSTOM)
  assert.equal(relay.readStatus().failed, 1)
  assert.equal(relay.readStatus().pending, 0)
})

test('dispose settles every waiting card so none is left blocked', async () => {
  const { relay, listeners } = harness({ tasks: RUNNING_CARD })
  const answer = listeners[0].listener(request(), async () => ({ answers: [] }))
  await new Promise((resolve) => setImmediate(resolve))
  relay.dispose()
  const settled = await answer
  assert.equal(settled.answers[0].custom, UNANSWERED_CUSTOM)
  assert.equal(relay.readStatus().pending, 0)
})

test('the same call id is never claimed twice', async () => {
  const { relay, listeners, deliveries } = harness({ tasks: RUNNING_CARD })
  const first = listeners[0].listener(request(), async () => ({ answers: [] }))
  const second = listeners[0].listener(request(), async () => ({ answers: [] }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deliveries.length, 1)
  assert.equal(relay.readStatus().relayed, 1)
  relay.answer({ sessionId: 'initiator-1', callId: 'call-1', answers: [{ id: 'q1', selected: ['CSV'] }] })
  const expected = { answers: [{ id: 'q1', selected: ['CSV'] }] }
  assert.deepEqual(await first, expected)
  assert.deepEqual(await second, expected)
})
