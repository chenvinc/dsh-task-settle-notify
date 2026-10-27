/**
 * Parent/child aggregation rules.
 *
 * A cascade run settles every child before the parent. Children are therefore
 * suppressed while their parent is still running; the parent's own message
 * carries a one-line summary of the children instead. A child whose parent is
 * NOT running (an orphan run, a parent moved by hand, a tree the cascade never
 * opened) is treated as a root so its settlement is not silently lost.
 */

/**
 * Decide how a settled task should be notified.
 * @param {object} task
 * @param {readonly object[]} tasks
 * @returns {{ role: 'root' | 'child' | 'orphan', parent?: object }}
 */
export function classifyTask(task, tasks) {
  if (!task || typeof task.parentId !== 'string' || !task.parentId) return { role: 'root' }
  const parent = Array.isArray(tasks) ? tasks.find((entry) => entry?.id === task.parentId) : undefined
  if (!parent) return { role: 'orphan' }
  if (parent.status === 'running') return { role: 'child', parent }
  return { role: 'orphan', parent }
}

/**
 * Direct children that belonged to the same cascade as the parent execution.
 * @param {object} parent
 * @param {readonly object[]} tasks
 * @param {string | undefined} runGroupId
 * @returns {{ count: number, titles: string[], failed: number }}
 */
export function summarizeChildren(parent, tasks, runGroupId) {
  const empty = { count: 0, titles: [], failed: 0 }
  if (!parent || !Array.isArray(tasks)) return empty
  const parentExecution = latestExecution(parent)
  const since = parentExecution?.startedAt ?? 0
  const children = tasks.filter((entry) => entry && entry.parentId === parent.id)
  const relevant = children.filter((child) => {
    const execution = latestExecution(child)
    if (!execution || !Number.isFinite(execution.endedAt)) return false
    if (runGroupId && typeof execution.runGroupId === 'string') {
      return execution.runGroupId === runGroupId
    }
    return Number(execution.endedAt) >= since
  })
  return {
    count: relevant.length,
    titles: relevant.map((child) => String(child.title ?? '')),
    failed: relevant.filter((child) => latestExecution(child)?.result === 'failed').length,
  }
}

/**
 * Newest settled execution on a task, or undefined.
 * @param {object | undefined} task
 * @returns {object | undefined}
 */
export function latestExecution(task) {
  if (!task || !Array.isArray(task.executions)) return undefined
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const execution = task.executions[index]
    if (execution && Number.isFinite(execution.endedAt)) return execution
  }
  return undefined
}
