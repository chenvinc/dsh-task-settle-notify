#!/usr/bin/env node
/**
 * Remove dsh-task-settle-notify from a DSH profile and restore what the
 * installer touched.
 *
 * Default behaviour is surgical:
 *   - `dsh plugin remove` (pnpm removes the link)
 *   - drop the package from `dsh.profile.bundles`
 *   - restore each backed-up file only when its current bytes still equal the
 *     bytes the installer left behind (so a file edited after install is never
 *     clobbered)
 *
 * `--restore` additionally copies the full pre-install snapshot back. Use it
 * only when you are sure nothing else changed the profile after the install.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const NAME = 'dsh-task-settle-notify'

function parseArgs(argv) {
  const options = {
    profile: process.env.DSH_PROFILE || 'web',
    dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
    restore: false,
    skipRemove: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--dsh-home') options.dshHome = argv[++index]
    else if (arg === '--restore') options.restore = true
    else if (arg === '--skip-remove') options.skipRemove = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/uninstall.mjs [--profile web] [--dsh-home ~/.dsh] [--restore] [--skip-remove]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  options.dshHome = resolve(options.dshHome)
  return options
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  return result.status ?? 1
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function dropBundle(profileDir) {
  const file = join(profileDir, 'package.json')
  if (!existsSync(file)) return
  const manifest = readJson(file)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return
  const next = bundles.filter((entry) => entry !== NAME)
  if (next.length === bundles.length) return
  manifest.dsh.profile.bundles = next
  writeJson(file, manifest)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const stateDir = join(options.dshHome, NAME)
  const receiptFile = join(stateDir, 'install.json')
  const receipt = existsSync(receiptFile) ? readJson(receiptFile) : undefined

  if (!receipt) {
    console.warn(`no install receipt at ${receiptFile}; falling back to profile-only cleanup`)
  }

  if (!options.skipRemove) {
    const status = run(
      process.env.DSH_BIN || 'dsh',
      ['plugin', '--profile', options.profile, 'remove', NAME],
      profileDir,
    )
    if (status !== 0) console.warn(`warning: dsh plugin remove exited with ${status}`)
  }

  dropBundle(profileDir)

  if (receipt && Array.isArray(receipt.files)) {
    for (const entry of receipt.files) {
      if (!existsSync(entry.backup)) continue
      if (options.restore) {
        copyFileSync(entry.backup, entry.source)
        console.log(`restored (forced): ${entry.source}`)
        continue
      }
      if (!existsSync(entry.source)) continue
      const after = entry.afterSha256
      if (typeof after !== 'string') continue
      if (sha256(entry.source) !== after) {
        console.warn(`kept (changed after install): ${entry.source}`)
        continue
      }
      if (entry.beforeSha256 === after) continue
      copyFileSync(entry.backup, entry.source)
      console.log(`restored: ${entry.source}`)
    }
  }

  const logs = join(stateDir, 'error.log')
  if (existsSync(receiptFile)) {
    const retired = `${receiptFile}.removed-${Date.now()}`
    renameSync(receiptFile, retired)
    console.log(`receipt retired: ${retired}`)
  }
  console.log('')
  console.log(`removed ${NAME} from profile "${options.profile}"`)
  if (existsSync(logs)) console.log(`logs kept at ${stateDir} (delete manually if you want a clean slate)`)
  console.log('restart the web host: dsh web')
}

try {
  main()
} catch (error) {
  console.error(`uninstall failed: ${error?.message ?? error}`)
  process.exitCode = 1
}
