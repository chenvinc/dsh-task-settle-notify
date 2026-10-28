/**
 * Plugin configuration: schema defaults plus a defensive resolver.
 *
 * The Cordis loader validates the exported `Config`, but a linked bundle or a
 * hand-edited patch row is not a trustworthy input. `resolveConfig` therefore
 * coerces every field, clamps numbers and never throws.
 */

/** @typedef {object} TaskSettleNotifyConfig */
/** @type {Required<TaskSettleNotifyConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch for notifications. */
  enabled: true,
  /** Successes that settle inside this window are merged into one message. */
  batchWindowSeconds: 30,
  /**
   * Only notify cards started by a DSH session. When `selfSessionId` is set,
   * narrow that further to that one session.
   */
  onlySelfInitiated: false,
  /** Mention the parent card's subtasks in its settlement message. */
  includeSubtasks: true,
  /** Optional session id used by `onlySelfInitiated`; blank means "any session". */
  selfSessionId: '',
  /**
   * Route a running card's `ask_user_question` to the session that started it,
   * so a card never blocks on a question the human cannot see.
   */
  relayCardQuestions: true,
  /** How long a relayed card question waits for the initiating session. */
  cardQuestionTimeoutSeconds: 600,
})

/** Upper bound accepted for the batching window, in seconds. */
export const MAX_BATCH_WINDOW_SECONDS = 600

/** Bounds accepted for the card-question deadline, in seconds. */
export const MIN_CARD_QUESTION_TIMEOUT_SECONDS = 60
export const MAX_CARD_QUESTION_TIMEOUT_SECONDS = 3600

/**
 * Coerce raw configuration into a complete configuration object.
 * @param {Record<string, unknown> | undefined | null} raw
 * @returns {TaskSettleNotifyConfig}
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const bool = (key) =>
    typeof source[key] === 'boolean' ? source[key] : DEFAULT_CONFIG[key]
  const seconds = Number(source.batchWindowSeconds)
  const batchWindowSeconds = Number.isFinite(seconds)
    ? Math.min(MAX_BATCH_WINDOW_SECONDS, Math.max(5, Math.round(seconds)))
    : DEFAULT_CONFIG.batchWindowSeconds
  const session =
    typeof source.selfSessionId === 'string'
      ? source.selfSessionId.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
      : ''
  const questionWait = Number(source.cardQuestionTimeoutSeconds)
  const cardQuestionTimeoutSeconds = Number.isFinite(questionWait)
    ? Math.min(
        MAX_CARD_QUESTION_TIMEOUT_SECONDS,
        Math.max(MIN_CARD_QUESTION_TIMEOUT_SECONDS, Math.round(questionWait)),
      )
    : DEFAULT_CONFIG.cardQuestionTimeoutSeconds
  return {
    enabled: bool('enabled'),
    batchWindowSeconds,
    onlySelfInitiated: bool('onlySelfInitiated'),
    includeSubtasks: bool('includeSubtasks'),
    selfSessionId: session,
    relayCardQuestions: bool('relayCardQuestions'),
    cardQuestionTimeoutSeconds,
  }
}
