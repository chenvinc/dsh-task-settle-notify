/**
 * The host-side watcher.
 *
 * It registers one task-board provider extension (apiVersion 1) and listens to
 * `onExecutionSettled`. Nothing is polled and nothing in the board is patched:
 * when the board retires the extension (its master switch is off, or the plugin
 * unloads) the subscription is released with it.
 *
 * Settlement lifetime:
 *   event -> task lookup -> parse/validate -> dedupe -> parent/child rule
 *         -> failure: deliver now | success: batching window -> deliver
 */
import { classifyTask, summarizeChildren } from './aggregate.js'
import { SettleBatcher } from './batcher.js'
import { createOwnerPeer, deliverPrompt } from './delivery.js'
import { formatBatch, formatSingle } from './format.js'
import { ExecutionDeduper, parseSettlement } from './parse.js'

/** Stable extension id (also the key of this provider's payload). */
export const EXTENSION_ID = 'task-settle-notify'

/** Contract version this plugin was written against. */
export const EXTENSION_API_VERSION = 1

export class TaskBoardWatcher {
  /**
   * @param {object} options
   * @param {any} options.board task-board host face (`ctx.get('taskBoard')`)
   * @param {any} options.gateway `ctx.typertGateway`
   * @param {any} options.ctx plugin context (owns the peer lifetime)
   * @param {() => import('./config.js').TaskSettleNotifyConfig} options.getConfig live settings
   * @param {ReturnType<import('./log.js').createLog>} options.log
   * @param {() => number} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   * @param {Function} [options.delivery] injectable for tests
   */
  constructor(options) {
    this.board = options.board
    this.gateway = options.gateway
    this.ctx = options.ctx
    this.getConfig = options.getConfig
    this.log = options.log
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.delivery = options.delivery ?? deliverPrompt
    this.deduper = new ExecutionDeduper(500)
    /** @type {Map<string, { count: number, titles: string[], failed: number }>} */
    this.childSummaries = new Map()
    this.peer = undefined
    this.host = undefined
    this.unsubscribe = undefined
    this.disposeExtension = undefined
    this.disposed = false
    this.retryTimers = new Set()
    this.startRevision = 0
    this.startedAt = 0
    this.status = {
      extensionActive: false,
      delivered: 0,
      failed: 0,
      duplicate: 0,
      suppressed: 0,
      lastEventAt: undefined,
      lastDelivery: undefined,
      lastError: undefined,
    }
    this.batcher = new SettleBatcher({
      windowMs: this.#windowMs(),
      onFlush: (records, kind) => this.#deliver(records, kind),
      now: this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    })
  }

  /** Start listening; safe to call once per plugin fiber. */
  start() {
    if (this.disposed) return
    try {
      this.startRevision = this.#revision()
      this.startedAt = this.now()
      this.peer = this.#createPeer()
      this.disposeExtension = this.board.registerExtension({
        id: EXTENSION_ID,
        apiVersion: EXTENSION_API_VERSION,
        // Never gate on settings.enabled here: the board would stop reconciling
        // the extension and flipping the switch back on would not restart it.
        start: (host) => this.#activate(host),
        stop: () => this.#deactivate(),
      })
      this.log.trace('watcher-started', {
        revision: this.startRevision,
        extensionId: EXTENSION_ID,
      })
    } catch (error) {
      this.log.error('watcher-start', error)
      this.status.lastError = String(error?.message ?? error)
      this.#scheduleRestart()
    }
  }

  /** Current diagnostics snapshot for the settings card. */
  readStatus() {
    const config = this.getConfig()
    return {
      extensionActive: this.status.extensionActive,
      startRevision: this.startRevision,
      startedAt: this.startedAt,
      pending: this.batcher.pendingCount,
      delivered: this.status.delivered,
      failed: this.status.failed,
      duplicate: this.status.duplicate,
      suppressed: this.status.suppressed,
      lastEventAt: this.status.lastEventAt,
      lastDelivery: this.status.lastDelivery,
      lastError: this.status.lastError,
      settings: config,
    }
  }

  /** Release the extension, pending window and retry timers. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      this.disposeExtension?.()
    } catch (error) {
      this.log.warn('extension-dispose', String(error))
    }
    this.disposeExtension = undefined
    this.#deactivate()
    this.batcher.dispose()
    for (const timer of this.retryTimers) {
      try {
        this.clearTimer(timer)
      } catch {
        /* ignore */
      }
    }
    this.retryTimers.clear()
    try {
      this.peer?.dispose?.()
    } catch {
      /* ignore */
    }
    this.log.trace('watcher-disposed')
  }

  // --------------------------------------------------------------- internals

  /** @param {any} host */
  #activate(host) {
    if (this.disposed) return
    this.#deactivate()
    try {
      this.host = host
      this.unsubscribe = host?.events?.onExecutionSettled?.((event) => this.#safeHandle(event))
      this.status.extensionActive = true
      this.log.trace('extension-active', { revision: this.#revision() })
    } catch (error) {
      this.status.extensionActive = false
      this.log.error('extension-activate', error)
    }
  }

  #deactivate() {
    try {
      this.unsubscribe?.()
    } catch {
      /* ignore */
    }
    this.unsubscribe = undefined
    this.host = undefined
    this.status.extensionActive = false
  }

  /** @param {any} event */
  #safeHandle(event) {
    try {
      this.#handle(event)
    } catch (error) {
      this.status.lastError = String(error?.message ?? error)
      this.log.error('settlement-handler', error)
    }
  }

  /** @param {{ taskId?: string, executionId?: string, outcome?: string, error?: string }} event */
  #handle(event) {
    const config = this.getConfig()
    if (!config.enabled) return
    if (!event || typeof event.taskId !== 'string' || typeof event.executionId !== 'string') return
    this.status.lastEventAt = new Date(this.now()).toISOString()
    if (!this.deduper.first(event.executionId)) {
      this.status.duplicate += 1
      this.log.trace('duplicate-skipped', { executionId: event.executionId })
      return
    }
    const task = this.host?.tasks?.get(event.taskId)
    if (!task) {
      this.log.trace('task-missing', { taskId: event.taskId })
      return
    }
    const record = parseSettlement(task, event.executionId, event)
    if (!record) {
      this.log.trace('not-settled', { executionId: event.executionId, outcome: event.outcome })
      return
    }
    // A plugin restart starts at the ledger revision it found: never replay a
    // settlement that predates this process.
    if (record.endedAt < this.startedAt - 1000) {
      this.log.trace('stale-skipped', { executionId: record.executionId, endedAt: record.endedAt })
      return
    }
    if (record.external) {
      this.log.trace('external-skipped', { executionId: record.executionId })
      return
    }
    if (!record.initiatedBy) {
      this.log.trace('no-initiator-skipped', { executionId: record.executionId })
      return
    }
    if (
      config.onlySelfInitiated &&
      config.selfSessionId &&
      record.initiatedBy !== config.selfSessionId
    ) {
      this.log.trace('not-self-skipped', {
        executionId: record.executionId,
        initiatedBy: record.initiatedBy,
      })
      return
    }

    const tasks = this.host?.tasks?.list?.() ?? []
    const classification = classifyTask(task, tasks)
    if (classification.role === 'child') {
      this.status.suppressed += 1
      this.log.trace('child-suppressed', {
        executionId: record.executionId,
        taskId: record.taskId,
        parentId: record.parentId,
      })
      return
    }

    const childSummary =
      config.includeSubtasks && this.#hasDirectChildren(task.id, tasks)
        ? summarizeChildren(task, tasks, record.runGroupId)
        : undefined
    if (childSummary) this.childSummaries.set(record.taskId, childSummary)

    this.log.trace('settlement', {
      executionId: record.executionId,
      taskId: record.taskId,
      outcome: record.outcome,
      initiatedBy: record.initiatedBy,
      durationMs: record.durationMs,
      parentId: record.parentId,
      childCount: childSummary?.count ?? 0,
    })

    if (!record.ok) {
      this.#deliver([record], 'failure')
      return
    }
    this.batcher.windowMs = this.#windowMs()
    this.batcher.add(record)
  }

  /**
   * Deliver one group. A batch may contain successes from several initiating
   * sessions, so it is split per session here.
   * @param {object[]} records
   * @param {'batch' | 'failure'} kind
   */
  #deliver(records, kind) {
    const groups = new Map()
    for (const record of records) {
      if (!record?.initiatedBy) continue
      const key = record.initiatedBy
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(record)
    }
    for (const [sessionId, group] of groups) {
      const text =
        group.length === 1
          ? formatSingle(group[0], { childSummary: this.childSummaries.get(group[0].taskId) })
          : formatBatch(group, { childSummaries: this.childSummaries })
      for (const record of group) this.childSummaries.delete(record.taskId)
      void this.#send(sessionId, text, kind, group)
    }
  }

  /**
   * One gateway call, with one delayed retry. Every failure is logged; nothing
   * is allowed to reject into the board's event dispatch.
   * @param {string} sessionId
   * @param {string} text
   * @param {string} kind
   * @param {object[]} records
   * @param {boolean} [retrying]
   */
  async #send(sessionId, text, kind, records, retrying = false) {
    try {
      await this.delivery({
        gateway: this.gateway,
        peer: this.peer,
        sessionId,
        text,
        signal: AbortSignal.timeout(15_000),
      })
      this.status.delivered += 1
      this.status.lastDelivery = {
        at: new Date(this.now()).toISOString(),
        sessionId,
        kind,
        tasks: records.map((record) => record.taskId),
        preview: text.split('\n')[0],
      }
      this.log.trace('delivered', {
        sessionId,
        kind,
        tasks: records.map((record) => record.taskId),
        preview: text.split('\n')[0],
      })
    } catch (error) {
      const message = String(error?.message ?? error)
      this.status.failed += 1
      this.status.lastError = message
      this.log.error(`deliver${retrying ? '-retry' : ''} ${sessionId}`, error)
      if (retrying || this.disposed) return
      const timer = this.setTimer(() => {
        this.retryTimers.delete(timer)
        if (!this.disposed) void this.#send(sessionId, text, kind, records, true)
      }, 1500)
      if (timer && typeof timer.unref === 'function') timer.unref()
      this.retryTimers.add(timer)
    }
  }

  #windowMs() {
    return this.getConfig().batchWindowSeconds * 1000
  }

  #revision() {
    try {
      return Number(this.board?.snapshot?.()?.revision ?? 0)
    } catch {
      return 0
    }
  }

  #hasDirectChildren(taskId, tasks) {
    return Array.isArray(tasks) && tasks.some((entry) => entry?.parentId === taskId)
  }

  /** One delayed restart if the board refused the registration. */
  #scheduleRestart() {
    if (this.disposed) return
    const timer = this.setTimer(() => {
      this.retryTimers.delete(timer)
      if (!this.disposed) this.start()
    }, 5000)
    if (timer && typeof timer.unref === 'function') timer.unref()
    this.retryTimers.add(timer)
  }

  #createPeer() {
    return createOwnerPeer(this.ctx)
  }
}
