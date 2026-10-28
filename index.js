/**
 * dsh-task-settle-notify - host half.
 *
 * The task board already emits a settlement event for every execution it
 * finishes. This plugin subscribes to that event through the board's public
 * extension contract and queues a short user message back into the session that
 * started the card, so the human no longer has to poll the board.
 *
 * Nothing in DSH or in the board package is patched. Failure modes are quiet:
 * a missing board service leaves the plugin idle, a refused gateway call is
 * logged once and retried once, and no exception is allowed to escape into the
 * board's event dispatch.
 */
import { DEFAULT_CONFIG, resolveConfig } from './lib/config.js'
import { API_PREFIX, createRoutes } from './lib/http.js'
import { createLog } from './lib/log.js'
import { mountAnswerTool } from './lib/answer-tool.js'
import { CardQuestionRelay } from './lib/questions.js'
import { mergeSettings, pickSettingsPatch, readSettingsFile, resolveSettingsPath, writeSettingsFile } from './lib/settings-store.js'
import { TaskBoardWatcher } from './lib/watcher.js'

/** Human-facing plugin name. */
export const name = 'task-settle-notify'

/** The board and the gateway are resolved lazily; nothing is mandatory. */
export const inject = []

/** @typedef {import('./lib/config.js').TaskSettleNotifyConfig} TaskSettleNotifyConfig */

/**
 * The running profile's directory, so settings land beside the profile that
 * actually loaded the plugin rather than in a global location.
 * @param {any} ctx
 * @returns {string | undefined}
 */
function profileContextDir(ctx) {
  try {
    const profile = ctx.get('profileContext')
    return typeof profile?.dir === 'string' && profile.dir.length > 0 ? profile.dir : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the Host logger, falling back to the console.
 * @param {any} ctx
 */
function makeLogger(ctx) {
  try {
    const scoped = typeof ctx?.logger === 'function' ? ctx.logger('task-settle-notify') : undefined
    if (scoped && typeof scoped.warn === 'function') return scoped
  } catch {
    /* fall through */
  }
  return {
    info: (...args) => console.log('[task-settle-notify]', ...args),
    warn: (...args) => console.warn('[task-settle-notify]', ...args),
    debug: () => {},
  }
}

/**
 * Mount the plugin.
 * @param {any} ctx
 * @param {Partial<TaskSettleNotifyConfig>} [config]
 */
export function apply(ctx, config) {
  const hostLogger = makeLogger(ctx)
  const profileDir = profileContextDir(ctx)
  const settingsPath = resolveSettingsPath({ profileDir })
  const log = createLog()
  log.trace('module-loaded', { pid: process.pid, settingsPath })

  const base = resolveConfig(config)
  /** User layer persisted by the settings card. */
  let userLayer = readSettingsFile(settingsPath) ?? {}
  /** Effective settings; recomputed whenever the card saves. */
  let runtime = resolveConfig(mergeSettings(base, userLayer))

  /** @type {TaskBoardWatcher | undefined} */
  let watcher
  /** @type {CardQuestionRelay | undefined} */
  let relay
  let disposed = false

  /** Effective settings, used by the watcher on every event. */
  const getConfig = () => runtime

  /** Public view for the settings card. */
  const publicSettings = () => ({
    enabled: runtime.enabled,
    batchWindowSeconds: runtime.batchWindowSeconds,
    onlySelfInitiated: runtime.onlySelfInitiated,
    includeSubtasks: runtime.includeSubtasks,
    selfSessionId: runtime.selfSessionId,
    relayCardQuestions: runtime.relayCardQuestions,
    cardQuestionTimeoutSeconds: runtime.cardQuestionTimeoutSeconds,
  })

  /**
   * Persist one validated partial update and apply it live.
   * @param {Record<string, unknown>} patch
   */
  const updateSettings = (patch) => {
    const clean = pickSettingsPatch(patch)
    userLayer = { ...userLayer, ...clean }
    runtime = resolveConfig(mergeSettings(base, userLayer))
    const persisted = writeSettingsFile(settingsPath, userLayer)
    if (!persisted) {
      log.warn('settings-not-persisted', settingsPath)
      hostLogger.warn?.(`task-settle-notify: could not persist settings to ${settingsPath}`)
    }
    log.trace('settings-updated', { patch: clean, effective: publicSettings() })
    return publicSettings()
  }

  /** Diagnostics shown under the card. */
  const readStatus = () => {
    const live = watcher?.readStatus()
    return {
      extensionActive: live?.extensionActive ?? false,
      startRevision: live?.startRevision ?? 0,
      startedAt: live?.startedAt ?? 0,
      pending: live?.pending ?? 0,
      delivered: live?.delivered ?? 0,
      failed: live?.failed ?? 0,
      duplicate: live?.duplicate ?? 0,
      suppressed: live?.suppressed ?? 0,
      lastEventAt: live?.lastEventAt,
      lastDelivery: live?.lastDelivery,
      lastError: live?.lastError,
      questions: relay?.readStatus() ?? { pending: 0, relayed: 0, answered: 0, timedOut: 0, failed: 0 },
      settings: live?.settings ?? publicSettings(),
      settingsPath,
      errorLogPath: log.errorLogPath,
      traceLogPath: log.traceLogPath,
    }
  }

  /** @param {any} webCtx */
  const mountRoutes = (webCtx) => {
    try {
      const webServer = webCtx.webServer ?? webCtx.get?.('webServer')
      if (!webServer || typeof webServer.register !== 'function') {
        log.trace('routes-unavailable')
        return
      }
      const routes = createRoutes({
        readSettings: publicSettings,
        writeSettings: updateSettings,
        readStatus,
        logger: hostLogger,
      })
      webCtx.effect(() => {
        const mounted = routes.map((route) => webServer.register(route))
        log.trace('routes-mounted', { count: routes.length, prefix: API_PREFIX })
        return () => {
          for (const dispose of mounted) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* teardown is best effort */
            }
          }
        }
      }, 'task-settle-notify: settings API')
    } catch (error) {
      log.warn('routes-failed', String(error))
      hostLogger.warn?.(`task-settle-notify: settings API unavailable: ${String(error)}`)
    }
  }

  // The watcher starts only once the board service exists. `inject` re-runs
  // this callback if the board is replaced, and the scoped effect disposes the
  // old watcher first.
  try {
    ctx.inject(['taskBoard', 'typertGateway'], (scoped) => {
      if (disposed) return
      const board = scoped.taskBoard ?? scoped.get?.('taskBoard')
      const gateway = scoped.typertGateway ?? scoped.get?.('typertGateway')
      if (!board || typeof board.registerExtension !== 'function') {
        log.warn('board-unavailable')
        return
      }
      scoped.effect(() => {
        watcher = new TaskBoardWatcher({
          board,
          gateway,
          ctx: scoped,
          getConfig,
          log,
        })
        watcher.start()
        return () => {
          watcher?.dispose()
          watcher = undefined
        }
      }, 'task-settle-notify: board watcher')

      // The question relay shares the board face and the gateway. It stays
      // independent of the watcher: a card can ask even when the settlement
      // extension is disabled for another reason.
      scoped.effect(() => {
        relay = new CardQuestionRelay({
          ctx: scoped,
          gateway,
          getBoard: () => (scoped.taskBoard ?? scoped.get?.('taskBoard')),
          getConfig,
          log,
        })
        relay.start()
        return () => {
          relay?.dispose()
          relay = undefined
        }
      }, 'task-settle-notify: card question relay')
    })
  } catch (error) {
    log.error('watcher-mount', error)
    hostLogger.warn?.(`task-settle-notify: cannot mount watcher: ${String(error)}`)
  }

  try {
    ctx.inject(['tools'], (scoped) => {
      const dispose = mountAnswerTool({
        scoped,
        getRelay: () => relay,
        log,
        profileDir,
      })
      scoped.effect(() => dispose, 'task-settle-notify: card question tool')
    })
  } catch (error) {
    log.warn('answer-tool-mount', String(error))
  }

  try {
    ctx.inject(['webServer'], mountRoutes)
  } catch (error) {
    log.warn('routes-mount', String(error))
  }

  // Release everything on plugin unload. The board extension holds its own
  // subscription, so leaving it registered would outlive this fiber.
  ctx.effect(() => () => {
    disposed = true
    watcher?.dispose()
    watcher = undefined
    relay?.dispose()
    relay = undefined
    log.trace('plugin-disposed')
  }, 'task-settle-notify: lifecycle')

  log.trace('apply-complete', {
    enabled: runtime.enabled,
    batchWindowSeconds: runtime.batchWindowSeconds,
    onlySelfInitiated: runtime.onlySelfInitiated,
    includeSubtasks: runtime.includeSubtasks,
    relayCardQuestions: runtime.relayCardQuestions,
    defaults: DEFAULT_CONFIG.enabled,
  })
}
