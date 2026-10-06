#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { ROOT, STATE, validateState, commandForState, readJson, saveJson, stepFrozen } = require('./server-clone')

const TNT_QUERY = 'data get entity @e[type=minecraft:tnt,limit=1]'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clone = value => JSON.parse(JSON.stringify(value))

function checkCount (count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 512) throw new Error('Initialization tick count must be an integer from 1 through 512')
}

function checkSignal (signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Clone initialization cancelled'), { name: 'AbortError' })
}

async function initializeClone (state, count, { command, saveState, record, signal, wait = sleep, now = Date.now } = {}) {
  checkCount(count)
  validateState(state)
  if (!state.initialized) throw new Error('Clone startup has not been verified')
  if (state.pendingStep || state.initialization?.pendingTick || state.initialization?.halted) throw new Error('Pending or halted clone initialization requires explicit inspection')
  if (![command, saveState, record].every(value => typeof value === 'function')) throw new Error('Attested command, durable state and evidence writers are required')
  checkSignal(signal)
  const redact = text => String(text).split(state.password).join('[redacted]')
  const log = event => record({ time: new Date().toISOString(), ...event })
  const query = async (text, { emergency = false } = {}) => {
    const cleanup = ['tick freeze', 'tick step stop'].includes(text)
    if (!cleanup) checkSignal(signal)
    try { await log({ type: 'command-intent', command: text }) } catch (error) {
      if (!emergency || !cleanup) throw error
    }
    try {
      if (!cleanup) checkSignal(signal)
      const response = await command(text)
      if (typeof response !== 'string') throw new Error('Clone command returned a non-text response')
      try { await log({ type: 'command-result', command: text, response: redact(response) }) } catch (error) {
        if (!emergency || !cleanup) throw error
      }
      return response.trim()
    } catch (error) {
      error.message = redact(error.message)
      try { await log({ type: 'command-error', command: text, error: error.message }) } catch {}
      throw error
    }
  }
  const frozen = async () => {
    if (!(await query('tick query')).includes('The game is frozen')) throw new Error('Clone must remain frozen during initialization')
  }
  const noTnt = async phase => {
    const response = await query(TNT_QUERY)
    if (response === 'No entity was found') return
    const present = /^.+ has the following entity data: \{/.test(response)
    await log({ type: 'tnt-check-failed', phase, response: redact(response) })
    throw Object.assign(new Error(present ? 'Detected primed TNT; clone initialization stopped' : 'Invalid TNT query response; clone initialization stopped'), { code: present ? 'PRIMED_TNT' : 'TNT_READ_INVALID' })
  }
  state.initialization = { schema: 1, completedTicks: state.initialization?.completedTicks || 0, lastRequestAt: new Date().toISOString(), requestedTicks: count, pendingTick: null }
  let pendingIntent
  let stepIntent
  try {
    await saveState(state)
    await log({ type: 'initialization-start', requestedTicks: count, host: state.host, port: state.port, version: state.version, pid: state.pid, directory: state.directory, startedAt: state.startedAt })
    await frozen()
    const stopped = await query('tick step stop')
    if (stopped === 'Interrupted the current tick step') throw new Error('An existing live step was stopped; refusing new initialization')
    if (stopped !== 'No tick step in progress') throw new Error('Unable to prove no existing tick step is in progress')
    const loaded = await query('forceload add 64 0 127 47')
    if (loaded !== 'Marked 12 chunks in minecraft:overworld from [4, 0] to [7, 2] to be force loaded' && loaded !== 'No chunks were marked for force loading' && !/^Marked (?:[1-9]|1[0-2]) chunks in minecraft:overworld from \[4, 0\] to \[7, 2\] to be force loaded$/.test(loaded)) throw new Error('Clone did not confirm the cannon forceload region')
    const chunks = []
    for (let x = 4; x <= 7; x++) {
      for (let z = 0; z <= 2; z++) {
        const response = await query(`forceload query ${x * 16} ${z * 16}`)
        if (response !== `Chunk at [${x}, ${z}] in minecraft:overworld is marked for force loading`) throw new Error(`Clone did not confirm forced chunk ${x},${z}`)
        chunks.push([x, z])
      }
    }
    const deadline = now() + 10000
    let remaining = chunks
    while (remaining.length) {
      await frozen()
      const missing = []
      for (const [x, z] of remaining) {
        const response = await query(`execute if loaded ${x * 16} -60 ${z * 16}`)
        if (response === 'Test failed') missing.push([x, z])
        else if (response !== 'Test passed' && response !== 'Test passed, count: 1') throw new Error('Invalid chunk-loaded response')
      }
      remaining = missing
      if (!remaining.length) break
      if (now() >= deadline) throw new Error('Cannon chunks did not load while frozen')
      await wait(50)
    }
    await frozen()
    for (let completedTicks = 0; completedTicks < count; completedTicks++) {
      checkSignal(signal)
      await noTnt('before')
      pendingIntent = { index: state.initialization.completedTicks + 1, requestedAt: new Date().toISOString(), ticks: 1 }
      state.initialization.pendingTick = pendingIntent
      await log({ type: 'tick-intent', ...pendingIntent })
      await saveState(state)
      stepIntent = undefined
      const result = await stepFrozen(state, 1, {
        command: query,
        wait,
        now,
        saveState: async value => {
          if (value.pendingStep) stepIntent = clone(value.pendingStep)
          else if (stepIntent) value.pendingStep = { ...stepIntent, awaitingTntCheck: true }
          await saveState(value)
          await log({ type: 'tick-state', index: pendingIntent.index, pendingStep: value.pendingStep, lastStep: value.lastStep })
        }
      })
      await noTnt('after')
      await log({ type: 'tick-result', index: pendingIntent.index, ...result, tntAbsent: true })
      checkSignal(signal)
      state.initialization.completedTicks++
      state.initialization.lastResult = result
      state.initialization.pendingTick = null
      state.pendingStep = null
      await saveState(state)
      checkSignal(signal)
      pendingIntent = undefined
      stepIntent = undefined
    }
    const result = { completedTicks: count, totalTicks: state.initialization.completedTicks, gametime: state.lastStep.after, frozen: true, primedTntObserved: false }
    checkSignal(signal)
    await log({ type: 'initialization-complete', ...result })
    checkSignal(signal)
    return result
  } catch (error) {
    error.message = redact(error.message)
    if (pendingIntent) state.initialization.pendingTick = pendingIntent
    if (stepIntent && !state.pendingStep) state.pendingStep = { ...stepIntent, awaitingTntCheck: true }
    for (const text of ['tick freeze', 'tick step stop']) {
      try { await query(text, { emergency: true }) } catch (cleanupError) { error.message += `; ${text} failed: ${redact(cleanupError.message)}` }
    }
    state.initialization.halted = { at: new Date().toISOString(), code: error.code || error.name || 'INITIALIZATION_FAILED', message: error.message }
    try { await saveState(state) } catch (saveError) { error.message += `; state persistence failed: ${redact(saveError.message)}` }
    try { await log({ type: 'initialization-halted', ...state.initialization.halted, pendingTick: state.initialization.pendingTick, pendingStep: state.pendingStep }) } catch (logError) { error.message += `; evidence persistence failed: ${redact(logError.message)}` }
    throw error
  }
}

async function main (args = process.argv.slice(2)) {
  if (args.length !== 1 || !/^\d+$/.test(args[0])) throw new Error('Usage: node scripts/initialize-clone.js <count:1..512>')
  const count = Number(args[0])
  checkCount(count)
  const lock = await fs.open(path.join(ROOT, '.operation-lock'), 'wx', 0o600)
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Clone initialization interrupted'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let journal
  try {
    const state = validateState(await readJson(STATE))
    const logFile = path.join(state.directory, `initialize-${Date.now()}-${randomUUID()}.jsonl`)
    journal = await fs.open(logFile, 'wx', 0o600)
    const result = await initializeClone(state, count, {
      command: text => commandForState(state, text),
      saveState: value => saveJson(STATE, value),
      record: async event => { await journal.writeFile(JSON.stringify(event) + '\n'); await journal.sync() },
      signal: controller.signal
    })
    console.log(JSON.stringify({ ...result, logFile }, null, 2))
    return result
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    if (journal) await journal.close()
    await lock.close()
    await fs.unlink(path.join(ROOT, '.operation-lock'))
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { initializeClone, main }
