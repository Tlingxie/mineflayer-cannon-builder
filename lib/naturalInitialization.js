const MODULUS = 2147483647
const TNT_QUERY = 'data get entity @e[type=minecraft:tnt,limit=1]'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clone = value => JSON.parse(JSON.stringify(value))

function checkCount (count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 512) throw new Error('Initialization tick count must be an integer from 1 through 512')
}

function checkSignal (signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Natural initialization cancelled'), { name: 'AbortError' })
}

async function initializeNatural (state, count, { command, saveState, record, signal, wait = sleep, now = Date.now, expectedGameTime } = {}) {
  checkCount(count)
  if (state.host !== '127.0.0.1' || state.version !== '1.21.4') throw new Error('An attested local 1.21.4 state is required')
  if (state.pendingStep || state.initialization?.pendingTick || state.initialization?.halted) throw new Error('Pending or halted natural initialization requires explicit inspection')
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
      if (typeof response !== 'string') throw new Error('Server command returned a non-text response')
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
    if (!(await query('tick query')).includes('The game is frozen')) throw new Error('Server must remain frozen during initialization')
  }
  const noTnt = async phase => {
    const response = await query(TNT_QUERY)
    if (response === 'No entity was found') return
    const present = /^.+ has the following entity data: \{/.test(response)
    await log({ type: 'tnt-check-failed', phase, response: redact(response) })
    throw Object.assign(new Error(present ? 'Detected primed TNT; natural initialization stopped' : 'Invalid TNT query response; natural initialization stopped'), { code: present ? 'PRIMED_TNT' : 'TNT_READ_INVALID' })
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
    if (expectedGameTime !== undefined && gameTime(await query('time query gametime')) !== expectedGameTime) throw new Error('Server gametime differs from the verified assembly or previous batch')
    const loaded = await query('forceload add 64 0 127 47')
    if (loaded !== 'Marked 12 chunks in minecraft:overworld from [4, 0] to [7, 2] to be force loaded' && loaded !== 'No chunks were marked for force loading' && !/^Marked (?:[1-9]|1[0-2]) chunks in minecraft:overworld from \[4, 0\] to \[7, 2\] to be force loaded$/.test(loaded)) throw new Error('Server did not confirm the cannon forceload region')
    const chunks = []
    for (let x = 4; x <= 7; x++) {
      for (let z = 0; z <= 2; z++) {
        const response = await query(`forceload query ${x * 16} ${z * 16}`)
        if (response !== `Chunk at [${x}, ${z}] in minecraft:overworld is marked for force loading`) throw new Error(`Server did not confirm forced chunk ${x},${z}`)
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
        expectedBefore: expectedGameTime,
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
      expectedGameTime = result.after
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

function gameTime (response) {
  const match = /^The time is (\d+)\s*$/.exec(response)
  const value = Number(match?.[1])
  if (!match || !Number.isInteger(value) || value < 0 || value >= MODULUS) throw new Error('Invalid gametime response')
  return value
}

// The caller attests the endpoint and holds its operation lock. No server is selected here.
async function stepFrozen (state, ticks, { command, saveState, wait = sleep, now = Date.now, timeoutMs = Math.max(30000, ticks * 100 + 5000), expectedBefore } = {}) {
  if (state.host !== '127.0.0.1' || state.version !== '1.21.4' || typeof command !== 'function' || typeof saveState !== 'function') throw new Error('An attested local 1.21.4 state, command and durable saveState are required')
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 10000) throw new Error('Tick count must be an integer from 1 through 10000')
  if (state.pendingStep) throw new Error('A previous pending step must be inspected before another step')
  if (!(await command('tick query')).includes('The game is frozen')) throw new Error('The server must already be frozen')
  const stopped = (await command('tick step stop')).trim()
  if (stopped === 'Interrupted the current tick step') throw new Error('An existing step was in progress and has been interrupted; no new ticks were requested')
  if (stopped !== 'No tick step in progress') throw new Error('Unable to prove that no previous step is in progress')
  const before = gameTime(await command('time query gametime'))
  if (expectedBefore !== undefined && before !== expectedBefore) throw new Error('Server gametime differs from the previous verified tick')
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

module.exports = { initializeNatural, stepFrozen, gameTime, checkCount }
