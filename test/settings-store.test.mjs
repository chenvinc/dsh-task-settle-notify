import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  mergeSettings,
  pickSettingsPatch,
  readSettingsFile,
  resolveSettingsPath,
  writeSettingsFile,
} from '../lib/settings-store.js'

test('settings path follows the running profile, then DSH_HOME, then the home dir', () => {
  assert.equal(
    resolveSettingsPath({ profileDir: '/profiles/web' }),
    '/profiles/web/task-settle-notify/settings.json',
  )
  assert.equal(
    resolveSettingsPath({ env: { DSH_HOME: '/opt/dsh', DSH_PROFILE: 'dev' }, home: '/home/me' }),
    '/opt/dsh/profiles/dev/task-settle-notify/settings.json',
  )
  assert.equal(
    resolveSettingsPath({ env: {}, home: '/home/me' }),
    '/home/me/.dsh/profiles/web/task-settle-notify/settings.json',
  )
  assert.equal(
    resolveSettingsPath({ env: { DSH_PROFILE_DIR: '/explicit/profile' }, home: '/home/me' }),
    '/explicit/profile/task-settle-notify/settings.json',
  )
})

test('only writable fields with usable types survive the patch filter', () => {
  assert.deepEqual(
    pickSettingsPatch({
      enabled: false,
      batchWindowSeconds: 45,
      onlySelfInitiated: true,
      includeSubtasks: false,
      relayCardQuestions: false,
      cardQuestionTimeoutSeconds: 120,
      selfSessionId: 'attacker',
      unknown: 1,
    }),
    {
      enabled: false,
      batchWindowSeconds: 45,
      onlySelfInitiated: true,
      includeSubtasks: false,
      relayCardQuestions: false,
      cardQuestionTimeoutSeconds: 120,
    },
  )
  assert.deepEqual(pickSettingsPatch({ batchWindowSeconds: 2 }), { batchWindowSeconds: 5 })
  assert.deepEqual(pickSettingsPatch({ batchWindowSeconds: 900 }), { batchWindowSeconds: 600 })
  assert.deepEqual(pickSettingsPatch({ cardQuestionTimeoutSeconds: 5 }), { cardQuestionTimeoutSeconds: 60 })
  assert.deepEqual(pickSettingsPatch({ cardQuestionTimeoutSeconds: 7200 }), { cardQuestionTimeoutSeconds: 3600 })
  assert.deepEqual(pickSettingsPatch({ enabled: 'yes' }), {})
  assert.deepEqual(pickSettingsPatch(null), {})
  assert.deepEqual(pickSettingsPatch([]), {})
})

test('merge applies the stored layer over the deployment defaults', () => {
  const merged = mergeSettings(
    { enabled: true, batchWindowSeconds: 30, onlySelfInitiated: false, includeSubtasks: true },
    { enabled: false, batchWindowSeconds: 60, selfSessionId: 'x' },
  )
  assert.equal(merged.enabled, false)
  assert.equal(merged.batchWindowSeconds, 60)
  assert.equal(merged.onlySelfInitiated, false)
  assert.equal(merged.selfSessionId, undefined)
})

test('settings round-trip through an atomic write and a corrupt file is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-settle-notify-'))
  try {
    const file = join(dir, 'settings.json')
    assert.equal(readSettingsFile(file), null)
    assert.equal(writeSettingsFile(file, { enabled: false, batchWindowSeconds: 60 }), true)
    assert.deepEqual(readSettingsFile(file), { enabled: false, batchWindowSeconds: 60 })
    assert.match(readFileSync(file, 'utf8'), /\n$/)

    const corrupt = join(dir, 'corrupt.json')
    writeSettingsFile(corrupt, { ok: true })
    // Overwrite with a broken payload; the reader must not throw.
    writeFileSync(corrupt, '{not json', 'utf8')
    assert.equal(readSettingsFile(corrupt), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
