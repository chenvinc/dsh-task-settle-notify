/**
 * Durable user settings for the notifier.
 *
 * The bundle patch carries deployment defaults; this file carries what the
 * human toggled in the settings card. A missing or corrupt file is not an
 * error: the caller falls back to the patch defaults.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Fields the browser half may change. */
export const WRITABLE_FIELDS = Object.freeze([
  'enabled',
  'batchWindowSeconds',
  'onlySelfInitiated',
  'includeSubtasks',
])

/**
 * Resolve the settings file for the active DSH profile.
 * @param {object} [options]
 * @param {string} [options.profileDir] directory of the running profile
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @returns {string} absolute path
 */
export function resolveSettingsPath(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const profileDir = String(options.profileDir ?? '').trim() || env.DSH_PROFILE_DIR?.trim()
  if (profileDir) return join(profileDir, 'task-settle-notify', 'settings.json')
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  const profile = env.DSH_PROFILE?.trim() || 'web'
  return join(dshHome, 'profiles', profile, 'task-settle-notify', 'settings.json')
}

/**
 * Read persisted settings synchronously (the watcher reads them on every event).
 * @param {string} filePath
 * @returns {Record<string, unknown> | null}
 */
export function readSettingsFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Persist settings atomically (temp file + rename).
 * @param {string} filePath
 * @param {Record<string, unknown>} settings
 * @returns {boolean} whether the write landed
 */
export function writeSettingsFile(filePath, settings) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    renameSync(temporary, filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Keep only writable fields that carry a usable type.
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
export function pickSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const patch = {}
  for (const field of WRITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue
    const value = input[field]
    if (field === 'batchWindowSeconds') {
      const seconds = Number(value)
      if (Number.isFinite(seconds)) {
        patch[field] = Math.min(600, Math.max(5, Math.round(seconds)))
      }
    } else if (typeof value === 'boolean') {
      patch[field] = value
    }
  }
  return patch
}

/**
 * Overlay a stored layer over the deployment defaults.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown> | null} [layer]
 * @returns {Record<string, unknown>}
 */
export function mergeSettings(base, layer) {
  return { ...base, ...pickSettingsPatch(layer ?? {}) }
}
