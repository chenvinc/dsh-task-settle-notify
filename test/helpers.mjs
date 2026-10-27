/**
 * Test-only helpers: a fake task-board host, a fake clock and a delivery sink.
 * No real Host, ledger or gateway is touched by the unit suite.
 */
import { readFileSync } from 'node:fs'

/**
 * Read the hand-written ledger fixture.
 * @returns {{ schemaVersion: number, revision: number, tasks: object[] }}
 */
export function readLedgerFixture() {
  return JSON.parse(readFileSync(new URL('./fixtures/ledger.json', import.meta.url), 'utf8'))
}

/**
 * A fresh copy of the fixture tasks, so one test cannot mutate another.
 * @returns {object[]}
 */
export function fixtureTasks() {
  return structuredClone(readLedgerFixture().tasks)
}

/**
 * Minimal Cordis-like context for the peer helper.
 * @returns {any}
 */
export function fakeCtx() {
  return {
    effect(callback) {
      return callback()
    },
  }
}

/**
 * Build a watcher wired to a fake board and a recording delivery sink.
 *
 * @param {object} [options]
 * @param {object[]} [options.tasks]
 * @param {object} [options.config]
 * @param {number} [options.now]
 * @param {number} [options.revision]
 */
export function createHarness(options = {}) {
  const tasks = options.tasks ?? fixtureTasks()
  const config = {
    enabled: true,
    batchWindowSeconds: 30,
    onlySelfInitiated: false,
    includeSubtasks: true,
    selfSessionId: '',
    ...(options.config ?? {}),
  }
  const revision = options.revision ?? 42
  const now = options.now ?? 1_700_000_060_000
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set()
  /** @type {object | undefined} */
  let extension
  const host = {
    tasks: {
      get(taskId) {
        return tasks.find((task) => task.id === taskId)
      },
      list() {
        return tasks
      },
    },
    events: {
      onExecutionSettled(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  const board = {
    snapshot() {
      return { revision }
    },
    registerExtension(candidate) {
      extension = candidate
      candidate.start(host)
      return () => {
        if (typeof candidate.stop === 'function') candidate.stop()
      }
    },
  }

  /** @type {Array<{ fn: Function, ms: number, cleared: boolean }>} */
  const timers = []
  /** @type {Array<{ sessionId: string, text: string }>} */
  const deliveries = []
  const logLines = []
  const log = {
    trace: (stage, detail) => logLines.push({ stage, detail }),
    warn: (stage, detail) => logLines.push({ stage: `warn:${stage}`, detail }),
    error: (stage, detail) => logLines.push({ stage: `error:${stage}`, detail }),
    errorLogPath: '/tmp/test-error.log',
    traceLogPath: '/tmp/test-trace.log',
  }

  const TaskBoardWatcher = /** @type {any} */ (options.TaskBoardWatcher)
  const watcher = new TaskBoardWatcher({
    board,
    gateway: { invoke: async () => ({ ok: true }) },
    ctx: fakeCtx(),
    getConfig: () => config,
    log,
    now: () => now,
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true
    },
    async delivery(request) {
      deliveries.push({ sessionId: request.sessionId, text: request.text })
    },
  })
  watcher.start()

  return {
    watcher,
    config,
    tasks,
    deliveries,
    timers,
    logLines,
    extension: () => extension,
    fire(event) {
      for (const listener of listeners) listener(event)
    },
    listenerCount: () => listeners.size,
    pendingTimers: () => timers.filter((timer) => !timer.cleared),
    /** Run every pending timer once. */
    runTimers() {
      for (const timer of timers) {
        if (timer.cleared) continue
        timer.cleared = true
        timer.fn()
      }
    },
  }
}

/** Let queued promise continuations run. */
export async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
