/**
 * Pure parsing of one board execution into the record the notifier works with.
 *
 * The board event only carries ids; the task and its execution history come
 * from the extension host face. Keeping this conversion pure is what lets the
 * unit tests drive it from a hand-written ledger fixture.
 */

/**
 * Find one execution attempt on a task.
 * @param {object | undefined} task
 * @param {string} executionId
 * @returns {object | undefined}
 */
export function findExecution(task, executionId) {
  if (!task || !Array.isArray(task.executions)) return undefined
  return task.executions.find((entry) => entry && entry.id === executionId)
}

/**
 * Convert a settled execution into a notification record.
 *
 * `initiatedBy` is the session that asked the board to run the card; it is the
 * delivery target. `sessionId` is the session that actually executed the card
 * and is kept for diagnostics only.
 *
 * @param {object | undefined} task
 * @param {string} executionId
 * @param {{ outcome?: string, error?: string }} [event]
 * @returns {null | {
 *   executionId: string, taskId: string, title: string, outcome: string,
 *   ok: boolean, parentId: string | undefined, initiatedBy: string | undefined,
 *   runnerSessionId: string | undefined, startedAt: number, endedAt: number,
 *   durationMs: number, error: string | undefined, summaryText: string,
 *   runGroupId: string | undefined, external: boolean, description: string
 * }}
 */
export function parseSettlement(task, executionId, event = {}) {
  if (!task || typeof task.id !== 'string' || typeof task.title !== 'string') return null
  const execution = findExecution(task, executionId)
  if (!execution) return null
  const outcome = String(event.outcome ?? execution.result ?? '')
  if (outcome !== 'succeeded' && outcome !== 'failed') return null
  if (!Number.isFinite(execution.endedAt)) return null
  const endedAt = execution.endedAt
  const startedAt = Number.isFinite(execution.startedAt) ? execution.startedAt : endedAt
  const summaryText =
    execution.summary && typeof execution.summary.text === 'string'
      ? execution.summary.text
      : typeof execution.summary === 'string'
        ? execution.summary
        : ''
  return {
    executionId: String(execution.id),
    taskId: task.id,
    title: task.title,
    outcome,
    ok: outcome === 'succeeded',
    parentId: typeof task.parentId === 'string' ? task.parentId : undefined,
    initiatedBy:
      typeof execution.initiatedBy === 'string' && execution.initiatedBy.trim()
        ? execution.initiatedBy.trim()
        : undefined,
    runnerSessionId:
      typeof execution.sessionId === 'string' && execution.sessionId ? execution.sessionId : undefined,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    error:
      typeof execution.error === 'string' && execution.error.trim()
        ? execution.error.trim()
        : typeof event.error === 'string' && event.error.trim()
          ? event.error.trim()
          : undefined,
    summaryText,
    runGroupId:
      typeof execution.runGroupId === 'string' && execution.runGroupId
        ? execution.runGroupId
        : undefined,
    external: execution.external === true,
    description: typeof task.description === 'string' ? task.description : '',
  }
}

/**
 * A bounded set of execution ids already handled. A hot reload or a duplicated
 * event must not send the same settlement twice.
 */
export class ExecutionDeduper {
  /** @param {number} [limit] */
  constructor(limit = 500) {
    this.limit = Math.max(1, limit)
    /** @type {Set<string>} */
    this.seen = new Set()
  }

  /**
   * Record an id.
   * @param {string} id
   * @returns {boolean} false when it was already present
   */
  first(id) {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > this.limit) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return true
  }

  /** Forget every id (used when the extension is torn down). */
  clear() {
    this.seen.clear()
  }
}
