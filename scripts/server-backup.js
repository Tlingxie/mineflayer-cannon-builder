#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { rconCommand } = require('./server-local')

const RUNTIME = path.resolve(__dirname, '../.runtime/server')
const BACKUPS = path.resolve(__dirname, '../.runtime/backups')
const stamp = () => new Date().toISOString().replaceAll(':', '-')

async function indexWorld (world) {
  const files = []
  async function visit (directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name)
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(filename, name)
      else if (entry.isFile()) {
        const bytes = await fs.readFile(filename)
        files.push({ path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
      } else throw new Error(`World contains a symbolic link or non-regular file: ${name}`)
    }
  }
  if (!(await fs.lstat(world)).isDirectory()) throw new Error('World must be a regular directory')
  await visit(world)
  if (!files.some(file => file.path === 'level.dat' && file.bytes > 0)) throw new Error('World is missing level.dat')
  return files
}

async function writeManifest (directory, manifest) {
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}

async function snapshotWorld (world, target, metadata) {
  const before = await indexWorld(world)
  await fs.mkdir(target, { recursive: false, mode: 0o700 })
  await fs.cp(world, path.join(target, 'world'), { recursive: true, errorOnExist: true, force: false })
  const files = await indexWorld(path.join(target, 'world'))
  const after = await indexWorld(world)
  if (JSON.stringify(before) !== JSON.stringify(files) || JSON.stringify(after) !== JSON.stringify(files)) throw new Error('World changed during snapshot copy; no complete manifest was written')
  const manifest = { schema: 1, createdAt: new Date().toISOString(), ...metadata, files }
  await writeManifest(target, manifest)
  return manifest
}

async function verifyWorldSnapshot (directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'))
  if (manifest.schema !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid world snapshot manifest')
  const files = await indexWorld(path.join(directory, 'world'))
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('World snapshot checksum does not match manifest')
  return manifest
}

async function restoreWorld (world, snapshot, archive, beforeReplace = async () => {}) {
  const manifest = await verifyWorldSnapshot(snapshot)
  const staging = `${world}.restore-${crypto.randomUUID()}`
  await fs.cp(path.join(snapshot, 'world'), staging, { recursive: true, errorOnExist: true, force: false })
  const files = await indexWorld(staging)
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('Restore staging checksum mismatch')
  await fs.mkdir(archive, { recursive: false, mode: 0o700 })
  await beforeReplace()
  await fs.rename(world, path.join(archive, 'world'))
  try {
    const previousFiles = await indexWorld(path.join(archive, 'world'))
    await writeManifest(archive, { schema: 1, createdAt: new Date().toISOString(), reason: 'preserved-before-restore', files: previousFiles })
    await fs.rename(staging, world)
  } catch (error) {
    await fs.rename(path.join(archive, 'world'), world)
    throw error
  }
  return { restored: snapshot, preserved: archive, files: files.length }
}

async function managedState () {
  const state = JSON.parse(await fs.readFile(path.join(RUNTIME, 'run.json'), 'utf8'))
  if (state.directory !== RUNTIME || state.host !== '127.0.0.1' || state.version !== '1.21.4' ||
      ![state.port, state.rconPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) ||
      !Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.password !== 'string' || !state.password.length) throw new Error('Invalid local managed server identity')
  return state
}

function running (pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function sourceInfo (state) {
  return { directory: RUNTIME, host: state.host, port: state.port, version: state.version, pid: state.pid, startedAt: state.startedAt }
}

async function backupManagedServer () {
  const state = await managedState()
  if (!running(state.pid)) throw new Error('Managed server must be running for a flushed backup')
  const evidence = []
  const command = async text => {
    try {
      const response = await rconCommand({ port: state.rconPort, password: state.password }, text)
      evidence.push({ command: text, response, at: new Date().toISOString() })
      return response
    } catch (error) {
      evidence.push({ command: text, outcome: 'unknown', error: error.message, at: new Date().toISOString() })
      error.evidence = evidence
      throw error
    }
  }
  if (!(await command('tick query')).includes('The game is frozen')) throw new Error('Construction must be frozen before taking this backup')
  let resumeSaving = false
  let priorSavingUnknown = false
  let savingRestored = false
  let target
  let result
  let failure
  const restoreSaving = async () => {
    if (!resumeSaving) return
    try {
      const on = await command('save-on')
      if (!on.includes('Automatic saving is now enabled') && !on.includes('Saving is already turned on')) throw new Error('Server did not confirm save-on')
      savingRestored = true
    } catch (error) {
      throw new Error(`Automatic saving status is uncertain; run save-on on the managed server: ${error.message}`, { cause: error })
    }
  }
  try {
    // A lost reply cannot reveal the prior state. Prefer enabled saving in that case.
    resumeSaving = true
    priorSavingUnknown = true
    const off = await command('save-off')
    if (off.includes('Saving is already turned off')) resumeSaving = false
    else if (!off.includes('Automatic saving is now disabled')) throw new Error('Server did not confirm disabled automatic saving')
    priorSavingUnknown = false
    if (!(await command('save-all flush')).includes('Saved the game')) throw new Error('Server did not confirm a flushed save')
    target = path.join(BACKUPS, `construction-${stamp()}-${crypto.randomBytes(3).toString('hex')}`)
    const manifest = await snapshotWorld(path.join(RUNTIME, 'world'), target, { server: sourceInfo(state), constructionFrozen: true, evidence: [...evidence] })
    result = { directory: target, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), createdAt: manifest.createdAt, constructionFrozen: true }
  } catch (error) {
    failure = error
  } finally {
    try {
      await restoreSaving()
      if (target) await fs.writeFile(path.join(target, 'operations.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    } catch (error) {
      if (failure) failure.message += `; cleanup failed: ${error.message}`
      else failure = error
    }
  }
  if (failure) {
    if (priorSavingUnknown) failure.message += `; save-off outcome is unknown and prior automatic saving state is unknown; ${savingRestored ? 'automatic saving was confirmed enabled as the recovery policy' : 'automatic saving status remains uncertain'}`
    failure.evidence = evidence
    throw failure
  }
  return result
}

async function runAction () {
  const [action = 'backup', name] = process.argv.slice(2)
  await fs.mkdir(BACKUPS, { recursive: true, mode: 0o700 })
  const lock = await fs.open(path.join(BACKUPS, '.operation-lock'), 'wx', 0o600)
  try {
    if (action === 'backup') console.log(JSON.stringify(await backupManagedServer(), null, 2))
    else if (['verify', 'restore'].includes(action)) {
      if (!name) throw new Error('Supply a snapshot directory')
      const directory = await fs.realpath(path.resolve(BACKUPS, name))
      const relative = path.relative(await fs.realpath(BACKUPS), directory)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Snapshot must be inside this project backup directory')
      const manifest = await verifyWorldSnapshot(directory)
      if (action === 'verify') console.log(JSON.stringify({ verified: true, directory, files: manifest.files.length, createdAt: manifest.createdAt }, null, 2))
      else {
        const state = await managedState()
        if (manifest.server?.directory !== RUNTIME || manifest.server?.host !== state.host || manifest.server?.port !== state.port || manifest.server?.version !== state.version) throw new Error('Snapshot does not belong to this managed server')
        const ensureStopped = async () => {
          const current = await managedState()
          if (current.pid !== state.pid || running(current.pid)) throw new Error('Stop only the managed server with server:stop before restoring its world')
        }
        await ensureStopped()
        const preserved = path.join(BACKUPS, `before-restore-${stamp()}-${crypto.randomBytes(3).toString('hex')}`)
        console.log(JSON.stringify(await restoreWorld(path.join(RUNTIME, 'world'), directory, preserved, ensureStopped), null, 2))
      }
    } else throw new Error('Usage: node scripts/server-backup.js backup | verify <snapshot> | restore <snapshot>')
  } finally {
    await lock.close()
    await fs.unlink(path.join(BACKUPS, '.operation-lock'))
  }
}

async function main () {
  return require('../lib/serverOperationLock').withServerOperation(runAction)
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { snapshotWorld, verifyWorldSnapshot, restoreWorld, backupManagedServer }
