/**
 * Small capped log files beside the plugin's own state.
 *
 * The Host keeps its log in the launching terminal, which a GUI user cannot
 * easily hand back. Two files are enough: `trace.log` for the delivery
 * breadcrumb and `error.log` for exceptions. Both are size-capped so a watcher
 * stuck in a retry loop cannot fill the disk.
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Default cap for the error log, in bytes. */
export const ERROR_LOG_MAX_BYTES = 512 * 1024
/** Default cap for the trace log, in bytes. */
export const TRACE_LOG_MAX_BYTES = 1024 * 1024

/**
 * Resolve the plugin's state directory.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {string}
 */
export function resolveStateDir(env = process.env, home = homedir()) {
  if (env.DSH_TASK_SETTLE_NOTIFY_DIR?.trim()) return env.DSH_TASK_SETTLE_NOTIFY_DIR.trim()
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  return join(dshHome, 'dsh-task-settle-notify')
}

/**
 * Append one line, rotating the file once it would exceed `maxBytes`.
 * Never throws: diagnostics must not break the plugin.
 * @param {string} file
 * @param {string} line
 * @param {number} maxBytes
 */
function appendCapped(file, line, maxBytes) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      size = 0
    }
    if (size + Buffer.byteLength(line) > maxBytes) {
      const rotated = `${file}.1`
      try {
        unlinkSync(rotated)
      } catch {
        /* absent is fine */
      }
      try {
        renameSync(file, rotated)
      } catch {
        /* a racing rotation is harmless */
      }
    }
    appendFileSync(file, line, 'utf8')
  } catch {
    /* never propagate a filesystem failure */
  }
}

/**
 * Create the plugin's logger.
 * @param {object} [options]
 * @param {string} [options.dir] state directory
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @returns {{ dir: string, errorLogPath: string, traceLogPath: string, trace: Function, error: Function, warn: Function }}
 */
export function createLog(options = {}) {
  const dir = options.dir ?? resolveStateDir(options.env, options.home)
  const errorLogPath = join(dir, 'error.log')
  const traceLogPath = join(dir, 'trace.log')
  const trace = (stage, detail) => {
    const suffix =
      detail === undefined
        ? ''
        : ` ${JSON.stringify(detail, (_key, value) => (value instanceof Error ? String(value) : value))}`
    appendCapped(traceLogPath, `${new Date().toISOString()} ${stage}${suffix}\n`, TRACE_LOG_MAX_BYTES)
  }
  const error = (stage, cause) => {
    const detail =
      cause instanceof Error ? `${cause.stack ?? cause.message}` : String(cause ?? '')
    appendCapped(
      errorLogPath,
      `${new Date().toISOString()} ERROR ${stage}\n${detail}\n`,
      ERROR_LOG_MAX_BYTES,
    )
  }
  const warn = (stage, cause) => {
    appendCapped(
      traceLogPath,
      `${new Date().toISOString()} WARN ${stage}${cause === undefined ? '' : ` ${String(cause)}`}\n`,
      TRACE_LOG_MAX_BYTES,
    )
  }
  return { dir, errorLogPath, traceLogPath, trace, error, warn }
}
