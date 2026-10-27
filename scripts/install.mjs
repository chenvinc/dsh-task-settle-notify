#!/usr/bin/env node
/**
 * Install dsh-task-settle-notify into a DSH profile.
 *
 * What it does, in order:
 *   1. snapshot the files it is about to touch into <repo>/.backup/<stamp>/
 *   2. `dsh plugin --profile <profile> add link:<repo>` (pnpm under the hood)
 *   3. add the package to the profile's `dsh.profile.bundles` list
 *   4. write an install receipt into ~/.dsh/dsh-task-settle-notify/install.json
 *
 * It never edits the DSH checkout, the task-board package or the ledger.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const NAME = 'dsh-task-settle-notify'

function parseArgs(argv) {
  const options = {
    profile: process.env.DSH_PROFILE || 'web',
    dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
    dryRun: false,
    skipInstall: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--dsh-home') options.dshHome = argv[++index]
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--skip-install') options.skipInstall = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/install.mjs [--profile web] [--dsh-home ~/.dsh] [--dry-run] [--skip-install]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  options.dshHome = resolve(options.dshHome)
  return options
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('')
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function ensureBundle(profileDir) {
  const file = join(profileDir, 'package.json')
  const manifest = readJson(file)
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  if (!manifest.dsh.profile.bundles.includes(NAME)) {
    manifest.dsh.profile.bundles.push(NAME)
  }
  writeJson(file, manifest)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const profileDir = join(options.dshHome, 'profiles', options.profile)
  const profileManifest = join(profileDir, 'package.json')
  if (!existsSync(profileManifest)) {
    throw new Error(`profile not found: ${profileDir} (run \`dsh\` once with --profile ${options.profile}?)`)
  }
  if (!existsSync(join(REPO, 'package.json'))) throw new Error(`not a plugin checkout: ${REPO}`)

  const backupDir = join(REPO, '.backup', stamp())
  const stateDir = join(options.dshHome, NAME)
  mkdirSync(backupDir, { recursive: true })

  const candidates = [
    join(profileDir, 'package.json'),
    join(profileDir, 'pnpm-lock.yaml'),
    join(profileDir, 'pnpm-workspace.yaml'),
    join(profileDir, 'cordis.patch.yml'),
    join(profileDir, 'cordis.yml'),
    join(options.dshHome, 'settings.yaml'),
    join(options.dshHome, 'settings.json'),
  ]

  /** @type {{ source: string, backup: string, beforeSha256: string | null }[]} */
  const files = []
  for (const source of candidates) {
    if (!existsSync(source)) continue
    const backup = join(backupDir, source.slice(options.dshHome.length + 1))
    mkdirSync(dirname(backup), { recursive: true })
    cpSync(source, backup, { recursive: true })
    files.push({ source, backup, beforeSha256: sha256(source) })
  }

  const receipt = {
    plugin: NAME,
    version: readJson(join(REPO, 'package.json')).version,
    repo: REPO,
    profile: options.profile,
    profileDir,
    dshHome: options.dshHome,
    backupDir,
    installedAt: new Date().toISOString(),
    files,
  }

  if (options.dryRun) {
    console.log(JSON.stringify({ ...receipt, dryRun: true }, null, 2))
    return
  }

  if (!options.skipInstall) {
    run(process.env.DSH_BIN || 'dsh', ['plugin', '--profile', options.profile, 'add', `link:${REPO}`], profileDir)
  }

  ensureBundle(profileDir)

  for (const entry of receipt.files) entry.afterSha256 = existsSync(entry.source) ? sha256(entry.source) : null
  mkdirSync(stateDir, { recursive: true })
  writeJson(join(stateDir, 'install.json'), receipt)

  const latest = join(REPO, '.backup', 'latest')
  try {
    symlinkSync(backupDir, latest, 'dir')
  } catch {
    writeFileSync(join(REPO, '.backup', 'LATEST'), `${backupDir}\n`, 'utf8')
  }

  console.log('')
  console.log(`installed ${NAME}@${receipt.version} into profile "${options.profile}"`)
  console.log(`backup:  ${backupDir}`)
  console.log(`receipt: ${join(stateDir, 'install.json')}`)
  console.log('')
  console.log('the web host hot-loads bundle changes when dsh.profile.patchReload is "live".')
  console.log('if /api/task-settle-notify/status is still 404 after a few seconds, restart:')
  console.log('  dsh web')
  console.log('')
  console.log('verify:')
  console.log('  curl -s http://127.0.0.1:3080/api/task-settle-notify/status')
}

try {
  main()
} catch (error) {
  console.error(`install failed: ${error?.message ?? error}`)
  process.exitCode = 1
}
