/**
 * Message text for a settlement notification.
 *
 * The single-card line is the contract users see:
 *   〔看板〕M2-B 已结算 · 成功 · 用时 9 分（会话 session-xxx）
 * followed by one actionable hint when the run left a file path behind.
 */

const SUCCESS = '成功'
const FAILURE = '失败'

/**
 * Human duration, matching the example shape ("9 分").
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))} 秒`
  if (value < 3_600_000) return `${Math.max(1, Math.round(value / 60_000))} 分`
  const hours = Math.floor(value / 3_600_000)
  const minutes = Math.round((value % 3_600_000) / 60_000)
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
}

/**
 * Collapse whitespace and cap a fragment so one runaway summary cannot produce
 * an unbounded message.
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
export function clean(value, limit = 120) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** File extensions worth surfacing as a "where is the artifact" hint. */
const ARTIFACT_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|kts|rb|php|cs|swift|m|mm|md|mdx|json|ya?ml|toml|css|scss|less|html|vue|svelte|sql|sh|zsh|fish|proto|graphql|lock'

/**
 * Pick the first plausible project file path out of a run summary.
 * URLs and dependency directories are skipped.
 * @param {string} text
 * @returns {string | undefined}
 */
export function extractArtifact(text) {
  if (typeof text !== 'string' || !text) return undefined
  const pattern = new RegExp(
    `(?:^|[\\s(（"'\`：:])((?:[\\w.@-]+/)*[\\w.@-]+\\.(?:${ARTIFACT_EXTENSIONS}))(?=$|[\\s)）"'\`,，。;；:：])`,
    'g',
  )
  let match
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1]
    if (/^https?:/i.test(candidate)) continue
    if (candidate.includes('node_modules/')) continue
    if (candidate.startsWith('../')) continue
    return candidate
  }
  return undefined
}

/**
 * One short "next step" line. Every settlement message carries one so the
 * initiating session always has an actionable follow-up, even when the run
 * summary is just "OK".
 * @param {{ summaryText?: string, description?: string, ok?: boolean }} record
 * @returns {string}
 */
export function nextStepHint(record) {
  const artifact = extractArtifact(record?.summaryText ?? '')
  if (artifact) return `产物在 ${artifact}`
  const first = String(record?.summaryText ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length >= 8)
  if (first) return `下一步：${clean(first, 100)}`
  return record?.ok === false
    ? '下一步：查看 ~/.dsh/dsh-task-settle-notify/trace.log，或重跑该卡'
    : '下一步：打开看板查看该卡详情'
}

/**
 * The single-card message.
 * @param {object} record settlement record
 * @param {{ childSummary?: { count: number, titles: string[], failed: number } }} [extra]
 * @returns {string}
 */
export function formatSingle(record, extra = {}) {
  const lines = [
    `〔看板〕${clean(record.title, 60)} 已结算 · ${record.ok ? SUCCESS : FAILURE} · 用时 ${formatDuration(record.durationMs)}（会话 ${clean(record.initiatedBy ?? '未知', 80)}）`,
  ]
  if (!record.ok) {
    lines.push(`原因：${clean(record.error ?? '执行失败', 180)}`)
    lines.push(nextStepHint(record))
  } else {
    lines.push(nextStepHint(record))
  }
  const summary = extra.childSummary
  if (summary && summary.count > 0) {
    const names = summary.titles.slice(0, 5).map((title) => clean(title, 40)).join('、')
    const more = summary.count > 5 ? ` 等 ${summary.count} 个` : ''
    lines.push(`含 ${summary.count} 个子任务：${names}${more}`)
  }
  return lines.join('\n')
}

/**
 * One message for several successes that settled inside the batching window.
 * Failures never reach this function (they are sent alone, immediately).
 * @param {object[]} records all records belong to the same initiating session
 * @param {{ childSummaries?: Map<string, { count: number, titles: string[], failed: number }> }} [extra]
 * @returns {string}
 */
export function formatBatch(records, extra = {}) {
  const list = Array.isArray(records) ? records : []
  const totalMs = list.reduce((sum, record) => sum + (record.durationMs ?? 0), 0)
  const lines = [
    `〔看板〕${list.length} 张卡已结算 · ${SUCCESS} · 用时合计 ${formatDuration(totalMs)}（会话 ${clean(list[0]?.initiatedBy ?? '未知', 80)}）`,
  ]
  for (const record of list) {
    const hint = nextStepHint(record)
    const summary = extra.childSummaries?.get(record.taskId)
    const parts = [clean(record.title, 60), formatDuration(record.durationMs)]
    if (summary && summary.count > 0) parts.push(`含 ${summary.count} 个子任务`)
    parts.push(hint)
    lines.push(`· ${parts.join(' · ')}`)
  }
  return lines.join('\n')
}
