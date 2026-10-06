#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const nbt = require('prismarine-nbt')
const { selectPort, rconCommand } = require('./server-local')
const { verifyWorldSnapshot, snapshotWorld } = require('./server-backup')

const SOURCE = path.resolve(__dirname, '../.runtime/server')
const ROOT = path.resolve(__dirname, '../.runtime/clones')
const STATE = path.join(ROOT, 'run.json')
const BACKUPS = path.resolve(__dirname, '../.runtime/backups')
const MODULUS = 2147483647
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function readJson (filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function saveJson (filename, value) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, filename)
}

async function readNbt (filename) {
  return nbt.simplify((await nbt.parse(await fs.readFile(filename))).parsed)
}

async function prepareClone (backup, directory, { sourceDirectory = SOURCE, runtimeDirectory = sourceDirectory, expectedJarSha1, validateOnly = false } = {}) {
  backup = await fs.realpath(backup)
  directory = path.resolve(directory)
  sourceDirectory = await fs.realpath(sourceDirectory)
  runtimeDirectory = await fs.realpath(runtimeDirectory)
  const manifest = await verifyWorldSnapshot(backup)
  if (manifest.server?.version !== '1.21.4' || manifest.server?.host !== '127.0.0.1' || typeof manifest.server?.directory !== 'string' || manifest.constructionFrozen !== true || await fs.realpath(manifest.server.directory) !== sourceDirectory) throw new Error('Backup is not a frozen snapshot of this managed 1.21.4 server')
  const data = (await readNbt(path.join(backup, 'world/level.dat'))).Data
  if (data?.GameRules?.spawnChunkRadius !== '0' || data.SpawnX !== 0 || data.SpawnZ !== 0) throw new Error('Clone startup requires spawnChunkRadius=0 and the distant spawn at 0,0')
  if (JSON.stringify(data.DataPacks?.Enabled) !== JSON.stringify(['vanilla'])) throw new Error('Clone startup requires only the vanilla datapack')
  if ((data.ScheduledEvents || []).length) throw new Error('Clone startup refuses scheduled command functions')
  for (const file of manifest.files.filter(file => /(^|[\\/])data[\\/]chunks\.dat$/.test(file.path))) {
    const forced = (await readNbt(path.join(backup, 'world', file.path))).data?.Forced
    if (!Array.isArray(forced) || forced.length) throw new Error(`Clone startup refuses persisted forced chunks: ${file.path}`)
  }
  const metadata = await readJson(path.join(runtimeDirectory, 'download.json'))
  const jar = path.join(runtimeDirectory, 'minecraft_server.1.21.4.jar')
  const bytes = await fs.readFile(jar)
  const jarSha1 = crypto.createHash('sha1').update(bytes).digest('hex')
  if (metadata?.version !== '1.21.4' || metadata.size !== bytes.length || metadata.sha1 !== jarSha1 || (expectedJarSha1 !== undefined && expectedJarSha1 !== jarSha1)) throw new Error('Cached official server JAR checksum mismatch')
  if (!/^eula=true\s*$/m.test(await fs.readFile(path.join(runtimeDirectory, 'eula.txt'), 'utf8'))) throw new Error('The managed server EULA has not been accepted')
  const properties = {}
  for (const line of (await fs.readFile(path.join(sourceDirectory, 'server.properties'), 'utf8')).split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#!]/.test(line)) continue
    const split = line.indexOf('=')
    if (split <= 0) throw new Error('Unsupported managed server property syntax')
    properties[line.slice(0, split).trim()] = line.slice(split + 1).trim()
  }
  if (validateOnly) return { backup, sourceDirectory, runtimeDirectory, jar, jarSha1, manifest }
  const password = crypto.randomBytes(24).toString('hex')
  Object.assign(properties, {
    'server-ip': '127.0.0.1',
    'server-port': 25567,
    'rcon.port': 25577,
    'rcon.password': password,
    'enable-rcon': true,
    'enable-query': false,
    'level-name': 'world',
    'pause-when-empty-seconds': -1,
    'white-list': true,
    'enforce-whitelist': true,
    'enable-command-block': false,
    'initial-enabled-packs': 'vanilla',
    motd: 'Isolated cannon initialization clone | 1.21.4'
  })
  await fs.mkdir(directory, { recursive: false, mode: 0o700 })
  await fs.cp(path.join(backup, 'world'), path.join(directory, 'world'), { recursive: true, errorOnExist: true, force: false })
  await saveJson(path.join(directory, 'manifest.json'), manifest)
  await verifyWorldSnapshot(directory)
  await fs.writeFile(path.join(directory, 'server.properties'), Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
  await fs.writeFile(path.join(directory, 'eula.txt'), 'eula=true\n')
  await saveJson(path.join(directory, 'ops.json'), [])
  await saveJson(path.join(directory, 'whitelist.json'), [])
  return { kind: 'initialization-clone', version: '1.21.4', host: '127.0.0.1', port: 25567, rconPort: 25577, password, directory, jar, backup, initialized: false, pendingStep: null, caveat: 'Disk snapshots do not preserve the live ServerLevel blockEvents queue; clone results do not prove identical first-tick piston behavior on the main server.' }
}

function gameTime (response) {
  const match = /^The time is (\d+)\s*$/.exec(response)
  const value = Number(match?.[1])
  if (!match || !Number.isInteger(value) || value < 0 || value >= MODULUS) throw new Error('Invalid gametime response')
  return value
}

// The caller attests the endpoint and holds its operation lock. No server is selected here.
async function stepFrozen (state, ticks, { command, saveState, wait = sleep, now = Date.now, timeoutMs = Math.max(30000, ticks * 100 + 5000) } = {}) {
  if (state.host !== '127.0.0.1' || state.version !== '1.21.4' || typeof command !== 'function' || typeof saveState !== 'function') throw new Error('An attested local 1.21.4 state, command and durable saveState are required')
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 10000) throw new Error('Tick count must be an integer from 1 through 10000')
  if (state.pendingStep) throw new Error('A previous pending step must be inspected before another step')
  if (!(await command('tick query')).includes('The game is frozen')) throw new Error('The server must already be frozen')
  const stopped = (await command('tick step stop')).trim()
  if (stopped === 'Interrupted the current tick step') throw new Error('An existing step was in progress and has been interrupted; no new ticks were requested')
  if (stopped !== 'No tick step in progress') throw new Error('Unable to prove that no previous step is in progress')
  const before = gameTime(await command('time query gametime'))
  const intent = { before, ticks, target: (before + ticks) % MODULUS, requestedAt: new Date().toISOString() }
  state.pendingStep = intent
  await saveState(state)
  try {
    if ((await command(`tick step ${ticks}`)).trim() !== `Stepping ${ticks} tick(s)`) throw new Error('The server did not confirm the requested tick step')
    const deadline = now() + timeoutMs
    while (now() <= deadline) {
      const after = gameTime(await command('time query gametime'))
      const delta = (after - before + MODULUS) % MODULUS
      if (delta > ticks) throw new Error('Gametime advanced beyond the requested tick count')
      if (delta === ticks) {
        await wait(100)
        if (!(await command('tick query')).includes('The game is frozen')) throw new Error('The server is no longer frozen after stepping')
        if (gameTime(await command('time query gametime')) !== after) throw new Error('Gametime did not remain at the requested tick count')
        const result = { before, after, ticks, verifiedAt: new Date().toISOString() }
        state.lastStep = result
        state.pendingStep = null
        await saveState(state)
        return result
      }
      await wait(50)
    }
    throw new Error('Tick step timed out before its exact gametime target')
  } catch (error) {
    state.pendingStep = intent
    try { await command('tick freeze') } catch (freezeError) { error.message += `; unable to confirm frozen state: ${freezeError.message}` }
    try { error.stopResult = await command('tick step stop') } catch (stopError) { error.message += `; unable to stop pending ticks: ${stopError.message}` }
    throw error
  }
}

function running (pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function validateState (state) {
  if (!state || state.kind !== 'initialization-clone' || state.host !== '127.0.0.1' || state.version !== '1.21.4' || state.port !== 25567 || state.rconPort !== 25577 || path.dirname(state.directory || '') !== ROOT || !path.basename(state.directory).startsWith('run-') || typeof state.password !== 'string' || !state.password.length || !Number.isSafeInteger(state.pid) || state.pid <= 0) throw new Error('Invalid isolated clone state')
  return state
}

function publicState (state, extra = {}) {
  const { password, ...result } = state
  return { ...result, ...extra }
}

async function inspectObserverGate (state) {
  if (!state.observerGate) return null
  const gate = state.observerGate
  if (gate.controlFile !== path.join(state.directory, 'observer-gate.control') || gate.statusFile !== path.join(state.directory, 'observer-gate-status.json')) throw new Error('Observer gate paths differ from the owned clone')
  const control = await fs.readFile(gate.controlFile, 'utf8')
  if (!['HOLD\n', 'OFF\n'].includes(control)) throw new Error('Invalid observer gate control')
  const status = await readJson(gate.statusFile)
  if (status?.pid !== state.pid || status.hooksReady !== true || status.controlValid !== true || status.activeMode !== control.trim()) throw new Error('Observer gate hooks, process identity or control status are not verified')
  return status
}

async function commandForState (state, command) {
  validateState(state)
  if (!running(state.pid)) throw new Error('The isolated clone is not running')
  const current = validateState(await readJson(STATE))
  if (current.pid !== state.pid || current.password !== state.password || current.startedAt !== state.startedAt || current.directory !== state.directory) throw new Error('The isolated clone identity changed')
  if (/^tick step \d+$/.test(command)) await inspectObserverGate(state)
  try { return await rconCommand({ port: state.rconPort, password: state.password }, command) } catch (error) {
    error.message = error.message.split(state.password).join('[redacted]')
    throw error
  }
}

async function cloneStatus () {
  const saved = await readJson(STATE)
  if (!saved) return { running: false, directory: ROOT }
  const state = validateState(saved)
  if (!running(state.pid)) return publicState(state, { running: false })
  const tick = await commandForState(state, 'tick query')
  return publicState(state, { running: true, frozen: tick.includes('The game is frozen'), gametime: gameTime(await commandForState(state, 'time query gametime')), ...(state.observerGate ? { gateStatus: await inspectObserverGate(state) } : {}) })
}

async function startClone (backup, { observerHold = false, sourceDirectory = SOURCE, runtimeDirectory = sourceDirectory, expectedJarSha1, expectedManifestSha256 } = {}) {
  if (!backup) throw new Error('Supply a verified managed backup directory')
  const previous = await readJson(STATE)
  if (previous && running(validateState(previous).pid)) throw new Error('An isolated clone is already running; stop it before starting a fresh snapshot')
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' })
  const major = Number(`${java.stdout || ''}${java.stderr || ''}`.match(/version "(\d+)/)?.[1])
  if (java.status !== 0 || !Number.isFinite(major) || major < 21) throw new Error('Java 21 or newer is required')
  await selectPort([25567])
  await selectPort([25577])
  if (expectedManifestSha256 !== undefined && crypto.createHash('sha256').update(await fs.readFile(path.join(backup, 'manifest.json'))).digest('hex') !== expectedManifestSha256) throw new Error('Clone backup manifest changed after restart preflight')
  const directory = path.join(ROOT, `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`)
  const state = await prepareClone(backup, directory, { sourceDirectory, runtimeDirectory, expectedJarSha1 })
  const agentArguments = []
  if (observerHold) {
    const artifact = await require('./build-observer-gate').buildObserverGate()
    const controlFile = path.join(directory, 'observer-gate.control')
    await fs.writeFile(controlFile, 'HOLD\n', { flag: 'wx', mode: 0o600 })
    state.observerGate = { ...artifact, controlFile, statusFile: path.join(directory, 'observer-gate-status.json'), eventsFile: path.join(directory, 'observer-gate-events.jsonl'), initialMode: 'HOLD' }
    agentArguments.push(`-javaagent:${artifact.agentJar}=${controlFile}`)
  }
  state.logFile = path.join(directory, 'server.log')
  const log = await fs.open(state.logFile, 'a', 0o600)
  let child
  try {
    child = spawn('java', ['-Xms512M', '-Xmx2G', '-XX:ActiveProcessorCount=4', '-Dio.netty.eventLoopThreads=4', ...agentArguments, '-jar', state.jar, 'nogui'], { cwd: directory, detached: true, stdio: ['ignore', log.fd, log.fd] })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    state.pid = child.pid
    state.startedAt = new Date().toISOString()
    await saveJson(STATE, state)
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      if (!running(state.pid)) throw new Error(`Clone exited during startup; inspect ${state.logFile}`)
      if ((await fs.readFile(state.logFile, 'utf8')).includes('Done (')) {
        try {
          await commandForState(state, 'tick freeze')
          if (!(await commandForState(state, 'tick query')).includes('The game is frozen')) throw new Error('Clone did not confirm frozen ticks')
          const gateStatus = await inspectObserverGate(state)
          // No players, spawn tickets, forced tickets or functions may load the machine before freeze.
          for (let x = 4; x <= 7; x++) {
            for (let z = 0; z <= 2; z++) {
              const response = await commandForState(state, `execute if loaded ${x * 16} -60 ${z * 16}`)
              if (response.trim() !== 'Test failed') throw new Error(`Machine chunk ${x},${z} was loaded before explicit clone initialization: ${response}`)
            }
          }
          state.initialized = true
          state.frozenAtGametime = gameTime(await commandForState(state, 'time query gametime'))
          await saveJson(STATE, state)
          return publicState(state, { running: true, frozen: true, ...(gateStatus ? { gateStatus } : {}) })
        } catch (error) {
          if (error.code !== 'ECONNREFUSED') throw error
        }
      }
      await sleep(250)
    }
    throw new Error(`Clone startup timed out; inspect ${state.logFile}`)
  } catch (error) {
    if (child?.pid) child.kill('SIGTERM')
    throw error
  } finally { await log.close() }
}

async function stopClone () {
  const state = validateState(await readJson(STATE))
  if (!running(state.pid)) return publicState(state, { running: false })
  await commandForState(state, 'tick freeze')
  await commandForState(state, 'tick step stop')
  await commandForState(state, 'save-all flush')
  try { await commandForState(state, 'stop') } catch (error) {
    if (!error.message.includes('closed before')) throw error
  }
  const deadline = Date.now() + 30000
  while (running(state.pid) && Date.now() < deadline) await sleep(100)
  if (running(state.pid)) throw new Error('Clone has not exited after stop; no other process was signalled')
  return publicState(state, { running: false })
}

async function backupClone ({ wait = sleep, now = Date.now } = {}) {
  const state = validateState(await readJson(STATE))
  const evidence = []
  const redact = text => String(text).split(state.password).join('[redacted]')
  const command = async text => {
    try {
      const response = await commandForState(state, text)
      evidence.push({ command: text, response: redact(response), at: new Date().toISOString() })
      return response.trim()
    } catch (error) {
      error.message = redact(error.message)
      evidence.push({ command: text, outcome: 'unknown', error: error.message, at: new Date().toISOString() })
      error.evidence = evidence
      throw error
    }
  }
  let resumeSaving = false
  let priorSavingUnknown = false
  let savingRestored = false
  let target
  let result
  let failure
  const restoreSaving = async () => {
    if (!resumeSaving) return
    try {
      const response = await command('save-on')
      if (response !== 'Automatic saving is now enabled' && response !== 'Saving is already turned on') throw new Error('Clone did not confirm enabled automatic saving')
      savingRestored = true
    } catch (error) {
      throw new Error(`Clone automatic saving status is uncertain: ${error.message}`, { cause: error })
    }
  }
  try {
    if (!(await command('tick query')).includes('The game is frozen')) throw new Error('Clone must already be frozen before backup')
    const tickStop = await command('tick step stop')
    if (!['No tick step in progress', 'Interrupted the current tick step'].includes(tickStop)) throw new Error('Clone did not confirm stopped tick stepping')
    const before = gameTime(await command('time query gametime'))
    const sampledAt = now()
    await wait(150)
    const after = gameTime(await command('time query gametime'))
    if (before !== after) throw new Error('Clone gametime changed during quiescence verification')
    if (!(await command('tick query')).includes('The game is frozen')) throw new Error('Clone did not remain frozen before backup')
    const quiescence = { before, after, sampleMs: now() - sampledAt, tickStop }
    resumeSaving = true
    priorSavingUnknown = true
    const off = await command('save-off')
    if (off === 'Saving is already turned off') resumeSaving = false
    else if (off !== 'Automatic saving is now disabled') throw new Error('Clone did not confirm disabled automatic saving')
    priorSavingUnknown = false
    if (!(await command('save-all flush')).includes('Saved the game')) throw new Error('Clone did not confirm a flushed save')
    await fs.mkdir(BACKUPS, { recursive: true, mode: 0o700 })
    target = path.join(BACKUPS, `clone-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomBytes(3).toString('hex')}`)
    const pending = { step: state.pendingStep || null, initializationTick: state.initialization?.pendingTick || null, halted: state.initialization?.halted || null }
    const manifest = await snapshotWorld(path.join(state.directory, 'world'), target, {
      server: { kind: state.kind, host: state.host, port: state.port, version: state.version, pid: state.pid, startedAt: state.startedAt, directory: state.directory },
      constructionFrozen: true,
      quiescence,
      pending,
      ...(state.observerGate ? { constructionRules: { observerGate: { ...state.observerGate, status: await inspectObserverGate(state) } } } : {}),
      evidence: [...evidence]
    })
    result = { directory: target, files: manifest.files.length, bytes: manifest.files.reduce((total, file) => total + file.bytes, 0), createdAt: manifest.createdAt, constructionFrozen: true, gametime: after, tickStop, pendingPreserved: Boolean(pending.step || pending.initializationTick || pending.halted) }
  } catch (error) {
    error.message = redact(error.message)
    failure = error
  } finally {
    try {
      await restoreSaving()
      if (target) await fs.writeFile(path.join(target, 'operations.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    } catch (error) {
      if (failure) failure.message += `; cleanup failed: ${redact(error.message)}`
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

async function main (args = process.argv.slice(2)) {
  const [action = 'status', value, ...extra] = args
  const observerHold = action === 'start' && extra.length === 1 && extra[0] === '--observer-hold'
  if ((extra.length && !observerHold) || !['start', 'status', 'step', 'stop', 'backup'].includes(action) || (['status', 'stop', 'backup'].includes(action) && value !== undefined)) throw new Error('Usage: node scripts/server-clone.js start <backup> [--observer-hold] | status | step <ticks> | stop | backup')
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 })
  const lock = await fs.open(path.join(ROOT, '.operation-lock'), 'wx', 0o600)
  try {
    let result
    if (action === 'start') result = await startClone(value, { observerHold })
    else if (action === 'status') result = await cloneStatus()
    else if (action === 'stop') result = await stopClone()
    else if (action === 'backup') result = await backupClone()
    else {
      const state = validateState(await readJson(STATE))
      if (!state.initialized) throw new Error('Clone startup has not been verified')
      result = await stepFrozen(state, Number(value), { command: text => commandForState(state, text), saveState: state => saveJson(STATE, state) })
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  } finally {
    await lock.close()
    await fs.unlink(path.join(ROOT, '.operation-lock'))
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { prepareClone, stepFrozen, startClone, cloneStatus, stopClone, backupClone, inspectObserverGate, main, ROOT, STATE, validateState, commandForState, readJson, saveJson }
