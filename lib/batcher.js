/**
 * The batching window.
 *
 * Failures are passed to the sink immediately and never enter the pending
 * list. Successes open a window on the first arrival; everything that settles
 * before the window closes leaves as one delivery call, which the caller then
 * splits per initiating session.
 */

/**
 * @typedef {object} SettleBatcherOptions
 * @property {number} windowMs
 * @property {(records: object[], kind: 'batch' | 'failure') => void} onFlush
 * @property {() => number} [now]
 * @property {(callback: Function, ms: number) => any} [setTimer]
 * @property {(timer: any) => void} [clearTimer]
 */

export class SettleBatcher {
  /** @param {SettleBatcherOptions} options */
  constructor(options) {
    this.windowMs = Math.max(0, Number(options?.windowMs) || 0)
    this.onFlush = options.onFlush
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    /** @type {object[]} */
    this.pending = []
    /** @type {any} */
    this.timer = undefined
  }

  /**
   * Feed one record.
   * @param {object} record
   * @returns {'failure' | 'batch'}
   */
  add(record) {
    if (!record || record.ok !== true) {
      this.onFlush([record], 'failure')
      return 'failure'
    }
    this.pending.push(record)
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined
        this.flush()
      }, this.windowMs)
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref()
    }
    return 'batch'
  }

  /**
   * Flush everything pending now. Safe to call from tests and at teardown.
   * @returns {object[]} the records that were flushed
   */
  flush() {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    if (this.pending.length === 0) return []
    const records = this.pending
    this.pending = []
    this.onFlush(records, 'batch')
    return records
  }

  /** Number of successes waiting for the window to close. */
  get pendingCount() {
    return this.pending.length
  }

  /** Drop pending successes without delivering them. */
  dispose() {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    this.pending = []
  }
}
