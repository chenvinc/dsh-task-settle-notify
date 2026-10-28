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
  assert.match(text, /\[导出格式\] id=q1 导出成 CSV 还是 XLSX？/)
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

test('the relayed message carries every upstream id and a copy-pasteable answers skeleton', () => {
  const text = formatRelayMessage({
    title: '季度报表导出',
    callId: 'card-4017d51e',
    questions: QUESTIONS,
    timeoutSeconds: 600,
  })
  assert.match(text, /^1\. \[导出格式\] id=q1 导出成 CSV 还是 XLSX？$/m)
  assert.match(text, /^2\. id=q2 文件名用什么？$/m)

  const skeleton = text.match(/^answers=(\[.*\])$/m)
  assert.ok(skeleton, 'the message must print an answers skeleton')
  const parsed = JSON.parse(skeleton[1])
  assert.deepEqual(
    parsed.map((item) => item.id),
    QUESTIONS.map((question) => question.id),
    'the skeleton ids must be the upstream ids, in order',
  )
  assert.deepEqual(
    parsed.map((item) => item.selected),
    [[], []],
  )
  // The skeleton's ids are exactly what the answer validator accepts.
  assert.deepEqual(
    validateAnswerBatch(QUESTIONS, [
      { id: parsed[0].id, selected: ['CSV'] },
      { id: parsed[1].id, custom: 'report-2026' },
    ]),
    { answers: [{ id: 'q1', selected: ['CSV'] }, { id: 'q2', selected: [], custom: 'report-2026' }] },
  )
})

test('a question without an upstream id says so instead of inventing one', () => {
  const questions = normalizeQuestions([
    { header: '导出格式', question: '导出成 CSV 还是 XLSX？', options: [{ label: 'CSV' }, { label: 'XLSX' }] },
  ])
  const text = formatRelayMessage({ title: '季度报表导出', callId: 'card-4017d51e', questions, timeoutSeconds: 600 })

  assert.match(text, /^1\. \[导出格式\] id 未知（upstream 未提供） 导出成 CSV 还是 XLSX？$/m)
  assert.match(text, /该形态无法用工具作答，需人工在 GUI 回答/)
  assert.doesNotMatch(text, /^answers=/m, 'no skeleton: a fabricated id would only be rejected')
  assert.doesNotMatch(text, /card_question_id=/, 'the tool cannot answer this one')
  assert.ok(text.length <= MAX_RELAY_CHARS)
})

test('the ids survive the length budget when questions are long', () => {
  const long = normalizeQuestions(
    Array.from({ length: 40 }, (_, index) => ({ id: `q-author-${index}`, question: '很长的问题'.repeat(60) })),
  )
  const text = formatRelayMessage({ title: 'x'.repeat(300), callId: 'c', questions: long, timeoutSeconds: 60 })
  assert.ok(text.length <= MAX_RELAY_CHARS, `length ${text.length}`)
  assert.match(text, /^answers=\[/m, 'the skeleton is reserved before the question bodies')
  for (const question of long) assert.ok(text.includes(`"id":"${question.id}"`), `missing ${question.id}`)
})

test('normalizeQuestions keeps an id-less question, drops text-less items and clips text', () => {
  const questions = normalizeQuestions([
    { id: '', question: 'x' },
    { id: 'a' },
    { id: 'b', question: 'ok', options: [{ label: '' }, { label: 'yes', description: 'y'.repeat(500) }] },
    'nope',
    null,
  ])
  assert.equal(questions.length, 2)
  assert.equal(questions[0].id, '')
  assert.equal(questions[0].question, 'x')
  assert.equal(questions[1].id, 'b')
  assert.equal(questions[1].options.length, 1)
  assert.ok(questions[1].options[0].description.length <= 120)
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

test('a request without upstream ids is not claimed, and the initiator is told why', async () => {
  const { relay, listeners, deliveries } = harness({ tasks: RUNNING_CARD })
  let passedDown = false
  const result = await listeners[0].listener(
    {
      agent: { id: 'runner-1' },
      questions: [{ header: '导出格式', question: '导出成 CSV 还是 XLSX？', options: [{ label: 'CSV' }, { label: 'XLSX' }] }],
      wait: { callId: 'call-2' },
    },
    async () => {
      passedDown = true
      return { answers: [{ id: 'ui-answer', selected: [], custom: '在 GUI 里答的' }] }
    },
  )
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(passedDown, true, 'without ids the card keeps its own question panel')
  assert.equal(relay.readStatus().relayed, 0)
  assert.equal(relay.readStatus().pending, 0)
  assert.equal(deliveries.length, 1)
  assert.match(deliveries[0].text, /id 未知（upstream 未提供）/)
  assert.match(deliveries[0].text, /该形态无法用工具作答，需人工在 GUI 回答/)
  assert.equal(result.answers[0].custom, '在 GUI 里答的')
  assert.throws(
    () => relay.answer({ sessionId: 'initiator-1', callId: 'call-2', answers: [{ id: 'x', custom: 'y' }] }),
    /没有等待中/,
  )
})

test('a two-question relay prints both ids, and those ids answer the claim', async () => {
  const { relay, listeners, deliveries } = harness({ tasks: RUNNING_CARD })
  const answer = listeners[0].listener(
    {
      agent: { id: 'runner-1' },
      questions: [
        { id: 'q-author7f2c', header: '署名项口径', question: '作者名写全名还是笔名？', options: [{ label: '全名' }, { label: '笔名' }] },
        { id: 'q-2026-11-02T09:00:00Z', question: '文件放哪个目录？' },
      ],
      wait: { callId: 'call-3' },
    },
    async () => ({ answers: [] }),
  )
  await new Promise((resolve) => setImmediate(resolve))

  const text = deliveries[0].text
  assert.match(text, /^1\. \[署名项口径\] id=q-author7f2c 作者名写全名还是笔名？$/m)
  assert.match(text, /^2\. id=q-2026-11-02T09:00:00Z 文件放哪个目录？$/m)
  assert.match(text, /answers=\[\{"id":"q-author7f2c","selected":\[\]\},\{"id":"q-2026-11-02T09:00:00Z","selected":\[\]\}\]/)

  relay.answer({
    sessionId: 'initiator-1',
    callId: 'call-3',
    answers: [
      { id: 'q-author7f2c', selected: ['笔名'] },
      { id: 'q-2026-11-02T09:00:00Z', custom: 'out/' },
    ],
  })
  assert.deepEqual(await answer, {
    answers: [
      { id: 'q-author7f2c', selected: ['笔名'] },
      { id: 'q-2026-11-02T09:00:00Z', selected: [], custom: 'out/' },
    ],
  })
})
