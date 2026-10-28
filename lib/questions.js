/**
 * Route a running card's questions back to the session that started it.
 *
 * The board's extension contract only reports status changes, settlements and
 * deletions: a card that stops to ask the human is invisible to it. The
 * question itself is a session-level event — `ask_user_question` dispatches
 * `user-questions/request` through the Agent-scoped answerer waterfall — so
 * this module claims that request on its way to the card's own UI and hands it
 * to the initiating conversation instead.
 *
 * The claim has to be complete: a legacy `ask_user_question` call does not time
 * out, so a request that is held and never answered would freeze the card
 * forever. Every path therefore settles — an answer from the initiator, the
 * configured deadline, an aborted call, or plugin unload — and a settlement the
 * initiator missed carries an explicit "no answer" body the card can act on.
 */
import { randomUUID } from 'node:crypto'
import { createOwnerPeer, deliverPrompt } from './delivery.js'

/** Model-facing tool the initiating conversation calls to answer. */
export const ANSWER_TOOL_NAME = 'answer_card_question'

/** Longest relayed message, in characters (the delivery channel truncates). */
export const MAX_RELAY_CHARS = 3500

/** What the card is told when nobody answered before the deadline. */
export const UNANSWERED_CUSTOM =
  '发起这张卡的会话没有在时限内回答。不要替用户假设答案：按最保守的方式继续，并在最终结果里写明这个待确认点。'

const QUESTION_LIMIT = 400
const OPTION_LIMIT = 120

/**
 * What the relay prints when upstream supplied no question id.
 *
 * A relayed question is only answerable through `answer_card_question` when the
 * message carries the exact id the user-questions service expects; the relay
 * never invents one (a fabricated id is rejected by the service, which is how a
 * question ends up silently timing out).
 */
export const UNKNOWN_ID_LABEL = 'id 未知（upstream 未提供）'

/**
 * Clip one line of model-supplied text so a relayed message stays readable.
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Normalize questions into the shape the relay, the message and the answer
 * validator all agree on.
 *
 * A question without text is unusable and dropped. A question without an id is
 * kept with `id === ''`: it cannot be claimed (no valid answers batch exists for
 * it), but the initiator still deserves to see that the card is waiting, so the
 * message names it and says it has to be answered by hand.
 *
 * @param {unknown} raw
 * @returns {{ id: string, question: string, header: string | undefined, options: { label: string, description: string | undefined }[], multiSelect: boolean }[]}
 */
export function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const question = clip(item.question, QUESTION_LIMIT)
    if (!question) continue
    const options = Array.isArray(item.options)
      ? item.options
          .map((option) => {
            const label = clip(option?.label, OPTION_LIMIT)
            return label ? { label, description: option?.description ? clip(option.description, OPTION_LIMIT) : undefined } : undefined
          })
          .filter(Boolean)
      : []
    out.push({
      id,
      question,
      header: item.header ? clip(item.header, OPTION_LIMIT) : undefined,
      options,
      multiSelect: item.multiSelect === true,
    })
  }
  return out
}

/**
 * Render one question's identity exactly as upstream sent it.
 * @param {{ id: string }} question
 * @returns {string} `id=<upstream id>`, or an explicit "unknown" marker
 */
export function questionIdLabel(question) {
  return question?.id ? `id=${question.id}` : UNKNOWN_ID_LABEL
}

/**
 * Build the user message the initiating conversation receives.
 *
 * Every question is tagged with its **upstream** id (never regenerated, clipped
 * or re-cased) and the message ends with a copy-pasteable `answers=[…]`
 * skeleton, because `answer_card_question` matches answers by id: a relay that
 * omits the id cannot be answered by the tool at all, and the card then times
 * out with a human proxy that was never actually reachable.
 *
 * @param {object} input
 * @param {string} input.title card title
 * @param {string} input.callId identity the answer tool takes
 * @param {ReturnType<typeof normalizeQuestions>} input.questions
 * @param {number} input.timeoutSeconds
 * @returns {string}
 */
export function formatRelayMessage({ title, callId, questions, timeoutSeconds }) {
  const idLess = questions.filter((question) => !question.id)
  const answerable = questions.length > 0 && idLess.length === 0
  const head = `〔看板〕${clip(title, 120)} 在推进中向你提问（共 ${questions.length} 问）`

  const groups = questions.map((question, index) => {
    const lines = [
      `${index + 1}. ${question.header ? `[${question.header}] ` : ''}${questionIdLabel(question)} ${question.question}`,
    ]
    if (question.options.length > 0) {
      const labels = question.options.map((option) => option.label).join(' ｜ ')
      lines.push(`   选项：${labels}${question.multiSelect ? '（可多选）' : ''}`)
    } else if (!question.multiSelect) {
      lines.push('   这道题没有预设选项，请自由作答。')
    }
    return lines.join('\n')
  })

  const tail = []
  if (answerable) {
    tail.push(`answers=${JSON.stringify(questions.map((question) => ({ id: question.id, selected: [] })))}`)
    tail.push(
      `用 ${ANSWER_TOOL_NAME} 回答：card_question_id="${callId}"，answers 里每道题给一项（id 照抄上面题干里的 id，selected 用选项文字，或 custom 自由文本）。`,
    )
    tail.push(
      `你自己能定就直接答；定不了就先问用户，再回来答。${Math.round(timeoutSeconds / 60)} 分钟内没有回答，这张卡会收到「未回答」并自行判断。`,
    )
  } else {
    tail.push(
      `${idLess.length} 道题 upstream 没有给 id：该形态无法用工具作答，需人工在 GUI 回答。不要调用 ${ANSWER_TOOL_NAME}，也不要自己编 id。`,
    )
    tail.push('中继没有接管这道题，卡片自己的提问面板仍在等着；请在 GUI 上直接作答。')
  }

  // The tail carries the ids and the instructions, so it is reserved first and
  // the question bodies give way: a truncated instruction is the original bug.
  const tailText = tail.join('\n')
  const budget = MAX_RELAY_CHARS - head.length - tailText.length - 2
  const kept = []
  let used = 0
  for (const group of groups) {
    if (used + group.length + 1 > budget) break
    kept.push(group)
    used += group.length + 1
  }
  const dropped = groups.length - kept.length
  if (dropped > 0) {
    kept.push(`…（还有 ${dropped} 道题因长度省略；${answerable ? '它们的 id 见下面 answers 骨架' : '请直接看卡片的提问面板'}）`)
  }
  return [head, ...kept, tailText].join('\n').slice(0, MAX_RELAY_CHARS)
}

/**
 * The settlement a card gets when the initiator never answered.
 * @param {ReturnType<typeof normalizeQuestions>} questions
 * @returns {{ answers: { id: string, selected: string[], custom: string }[] }}
 */
export function unansweredBatch(questions) {
  return {
    answers: questions
      .filter((question) => Boolean(question.id))
      .map((question) => ({ id: question.id, selected: [], custom: UNANSWERED_CUSTOM })),
  }
}

/**
 * Validate a model-supplied answer batch against the questions it answers.
 *
 * The user-questions service requires one item per question of the call, and
 * rejects labels the card never offered — a silently mangled answer is worse
 * than a refused tool call.
 *
 * @param {ReturnType<typeof normalizeQuestions>} questions
 * @param {unknown} raw
 * @returns {{ answers: { id: string, selected: string[], custom?: string }[] }}
 */
export function validateAnswerBatch(questions, raw) {
  if (questions.some((question) => !question.id)) {
    throw new Error('这次提问里有问题没有 upstream id，无法用工具作答，需人工在 GUI 回答')
  }
  const items = Array.isArray(raw) ? raw : []
  const byId = new Map()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) continue
    if (byId.has(id)) throw new Error(`问题 ${id} 被回答了两次`)
    byId.set(id, item)
  }
  const extra = [...byId.keys()].filter((id) => !questions.some((question) => question.id === id))
  if (extra.length > 0) throw new Error(`answers 里的问题 id 不属于这次提问：${extra.join(', ')}`)
  const answers = questions.map((question) => {
    const item = byId.get(question.id)
    if (!item) throw new Error(`问题 ${question.id} 还没有回答；answers 必须每题一项`)
    const offered = question.options.map((option) => option.label)
    const selectedRaw = Array.isArray(item.selected) ? item.selected : []
    const selected = selectedRaw.map((label) => String(label))
    for (const label of selected) {
      if (offered.length > 0 && !offered.includes(label)) {
        throw new Error(`问题 ${question.id} 没有选项 ${JSON.stringify(label)}；可选：${offered.join(' ｜ ')}`)
      }
    }
    if (!question.multiSelect && selected.length > 1) {
      throw new Error(`问题 ${question.id} 只能选一项`)
    }
    const customText = typeof item.custom === 'string' ? item.custom.trim() : ''
    if (selected.length === 0 && !customText) throw new Error(`问题 ${question.id} 没有给出答案`)
    return {
      id: question.id,
      selected,
      ...(customText ? { custom: customText } : {}),
    }
  })
  return { answers }
}

/**
 * Find the task whose running execution belongs to one session.
 * @param {unknown} tasks
 * @param {string} sessionId
 * @returns {{ task: any, execution: any } | undefined}
 */
export function findRunnerTask(tasks, sessionId) {
  if (!Array.isArray(tasks)) return undefined
  for (const task of tasks) {
    if (!task || !Array.isArray(task.executions)) continue
    for (const execution of task.executions) {
      if (!execution || execution.sessionId !== sessionId) continue
      if (execution.external === true) continue
      if (Number.isFinite(execution.endedAt)) continue
      return { task, execution }
    }
  }
  return undefined
}

/** One claimed question request. */
export class CardQuestionRelay {
  /**
   * @param {object} options
   * @param {any} options.ctx plugin context (listener + owner peer lifetime)
   * @param {any} options.gateway `ctx.typertGateway`
   * @param {() => any} options.getBoard resolves `ctx.get('taskBoard')`
   * @param {() => import('./config.js').TaskSettleNotifyConfig} options.getConfig
   * @param {ReturnType<import('./log.js').createLog>} options.log
   * @param {() => any} [options.getAgent] liveness probe for a session
   * @param {Function} [options.delivery] injectable gateway delivery
   * @param {Function} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor(options) {
    this.ctx = options.ctx
    this.gateway = options.gateway
    this.getBoard = options.getBoard
    this.getConfig = options.getConfig
    this.log = options.log
    this.getAgent = options.getAgent ?? (() => true)
    this.delivery = options.delivery ?? deliverPrompt
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    /** @type {Map<string, any>} */
    this.pending = new Map()
    this.disposeListener = undefined
    this.peer = createOwnerPeer(this.ctx)
    this.disposed = false
    this.status = { relayed: 0, answered: 0, timedOut: 0, failed: 0, lastAt: undefined, lastError: undefined }
  }

  /** Claim requests from now on. Safe to call once. */
  start() {
    if (this.disposed || this.disposeListener !== undefined) return
    try {
      this.disposeListener = this.ctx.on(
        'user-questions/request',
        (request, next) => this.#onRequest(request, next),
        { prepend: true },
      )
      this.log.trace('question-relay-started')
    } catch (error) {
      this.log.error('question-relay-start', error)
    }
  }

  /** Pending count plus counters, for the settings card. */
  readStatus() {
    return {
      pending: this.pending.size,
      relayed: this.status.relayed,
      answered: this.status.answered,
      timedOut: this.status.timedOut,
      failed: this.status.failed,
      lastAt: this.status.lastAt,
      lastError: this.status.lastError,
    }
  }

  /**
   * Answer one claimed question from the initiating conversation.
   * @param {{ sessionId: string, callId: string, answers: unknown }} input
   * @returns {{ ok: true, taskId: string, title: string }}
   */
  answer(input) {
    const callId = String(input?.callId ?? '').trim()
    const entry = this.pending.get(callId)
    if (!entry) throw new Error(`没有等待中的卡片提问：${callId || '(空)'}`)
    const sessionId = String(input?.sessionId ?? '').trim()
    if (!sessionId || entry.initiatorSessionId !== sessionId) {
      throw new Error('这个问题不是当前会话派出的卡片提的，不能回答')
    }
    const batch = validateAnswerBatch(entry.questions, input?.answers)
    this.#settle(entry, batch, 'answered')
    return { ok: true, taskId: entry.taskId, title: entry.title }
  }

  /** Settle every claim, so no card is left waiting on a plugin that is going away. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      this.disposeListener?.()
    } catch {
      /* ignore */
    }
    this.disposeListener = undefined
    for (const entry of [...this.pending.values()]) {
      this.#settle(entry, unansweredBatch(entry.questions), 'timedOut')
    }
    try {
      this.peer?.dispose?.()
    } catch {
      /* ignore */
    }
    this.log.trace('question-relay-disposed')
  }

  // --------------------------------------------------------------- internals

  /**
   * Claim one request when it belongs to a running card with a live initiator
   * and upstream gave every question an id (an id is what the answer tool
   * matches on; without it the request is noticed, not claimed).
   * @param {any} request
   * @param {() => Promise<any>} next
   * @returns {Promise<any>}
   */
  async #onRequest(request, next) {
    try {
      const config = this.getConfig()
      if (!config.enabled || !config.relayCardQuestions) return next()
      const agent = request?.agent
      if (!agent || typeof agent.id !== 'string') return next()
      const questions = normalizeQuestions(request?.questions)
      if (questions.length === 0) return next()

      const board = this.#board()
      const found = findRunnerTask(board?.snapshot?.()?.tasks, agent.id)
      if (!found) return next()
      const initiatorSessionId = typeof found.execution.initiatedBy === 'string' ? found.execution.initiatedBy.trim() : ''
      if (!initiatorSessionId || initiatorSessionId === agent.id) return next()
      if (!this.getAgent(initiatorSessionId)) return next()

      const idLess = questions.filter((question) => !question.id)
      if (idLess.length > 0) {
        // No upstream id means no answers batch the service would accept:
        // claiming would freeze the card for the whole timeout. Keep the card's
        // own panel in charge and tell the initiator why it cannot answer.
        this.log.trace('question-relay-no-id', {
          taskId: String(found.task.id),
          initiatorSessionId,
          questions: questions.length,
          questionsWithoutId: idLess.length,
          questionIds: questions.map((question) => question.id || null),
        })
        void this.#deliverNotice(
          initiatorSessionId,
          formatRelayMessage({
            title: String(found.task.title ?? '任务卡片'),
            callId: '',
            questions,
            timeoutSeconds: config.cardQuestionTimeoutSeconds,
          }),
        )
        return next()
      }

      const callId = String(request?.wait?.callId ?? `card-${randomUUID()}`)
      const existing = this.pending.get(callId)
      if (existing) return existing.promise

      const entry = {
        callId,
        taskId: String(found.task.id),
        title: String(found.task.title ?? '任务卡片'),
        runnerSessionId: agent.id,
        initiatorSessionId,
        questions,
        createdAt: this.now(),
        resolve: undefined,
        promise: undefined,
        timer: undefined,
        onAbort: undefined,
        settled: false,
      }
      entry.promise = new Promise((resolve) => {
        entry.resolve = resolve
      })
      this.pending.set(callId, entry)
      this.status.relayed += 1
      this.status.lastAt = new Date(this.now()).toISOString()

      const timeoutSeconds = config.cardQuestionTimeoutSeconds
      entry.timer = this.setTimer(() => {
        this.log.trace('question-timeout', { callId, taskId: entry.taskId })
        this.status.timedOut += 1
        this.#settle(entry, unansweredBatch(questions), 'timedOut')
      }, timeoutSeconds * 1000)
      entry.timer?.unref?.()

      if (request?.signal) {
        entry.onAbort = () => {
          this.log.trace('question-aborted', { callId })
          this.#settle(entry, unansweredBatch(questions), 'timedOut')
        }
        request.signal.addEventListener?.('abort', entry.onAbort, { once: true })
      }

      const text = formatRelayMessage({
        title: entry.title,
        callId,
        questions,
        timeoutSeconds,
      })
      this.log.trace('question-relayed', {
        callId,
        taskId: entry.taskId,
        initiatorSessionId,
        questions: questions.length,
        questionIds: questions.map((question) => question.id),
      })
      void this.#deliver(entry, text)
      return entry.promise
    } catch (error) {
      this.status.lastError = String(error?.message ?? error)
      this.log.error('question-relay', error)
      return next()
    }
  }

  /**
   * Send the relayed question; a channel failure settles the claim at once so
   * the card is never left waiting on a message nobody received.
   * @param {any} entry
   * @param {string} text
   */
  async #deliver(entry, text) {
    try {
      await this.delivery({
        gateway: this.gateway,
        peer: this.peer,
        sessionId: entry.initiatorSessionId,
        text,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      this.status.failed += 1
      this.status.lastError = String(error?.message ?? error)
      this.log.error('question-deliver', error)
      this.#settle(entry, unansweredBatch(entry.questions), 'failed')
    }
  }

  /**
   * Inform the initiator about a question the relay did not claim.
   *
   * Nothing waits on this message — the card's own panel is still the answerer —
   * so a delivery failure is logged and never settles or blocks anything.
   * @param {string} sessionId
   * @param {string} text
   */
  async #deliverNotice(sessionId, text) {
    try {
      await this.delivery({
        gateway: this.gateway,
        peer: this.peer,
        sessionId,
        text,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      this.status.failed += 1
      this.status.lastError = String(error?.message ?? error)
      this.log.error('question-notice-deliver', error)
    }
  }

  /**
   * Resolve one claim exactly once.
   * @param {any} entry
   * @param {{ answers: { id: string, selected: string[], custom?: string }[] }} batch
   * @param {'answered' | 'timedOut' | 'failed'} reason
   */
  #settle(entry, batch, reason) {
    if (!entry || entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) {
      try {
        this.clearTimer(entry.timer)
      } catch {
        /* ignore */
      }
      entry.timer = undefined
    }
    if (entry.onAbort !== undefined) {
      entry.onAbort = undefined
    }
    this.pending.delete(entry.callId)
    if (reason === 'answered') {
      this.status.answered += 1
      this.status.lastAt = new Date(this.now()).toISOString()
    }
    this.log.trace('question-settled', { callId: entry.callId, reason })
    try {
      entry.resolve(batch)
    } catch (error) {
      this.log.error('question-resolve', error)
    }
  }

  /** @returns {any} the board service, if it is up right now */
  #board() {
    try {
      return this.getBoard()
    } catch {
      return undefined
    }
  }
}
