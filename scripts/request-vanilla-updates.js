#!/usr/bin/env node
const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { ROOT, STATE, validateState, readJson, inspectObserverGate } = require('./server-clone')

const SOURCE_SHA256 = '8c2d8bf4dc8059cb083a28368da2efa1be2bd2dd4999d8b8062d115c4c758632'
const bytes = syncFs.readFileSync(path.resolve(__dirname, '../server-tools/observer-gate/allowlist.txt'))
if (crypto.createHash('sha256').update(bytes).digest('hex') !== 'cfab00df298d498acbe8779ca01655ed4427f8edc234693c04c3c9d4c4162f96') throw new Error('Pinned source update allowlist hash mismatch')
const allowed = new Set(bytes.toString('utf8').trim().split('\n').slice(1).map(line => line.split(' ').slice(0, 4).join(' ')))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const checkSignal = signal => { if (signal?.aborted) throw signal.reason || new Error('Update request cancelled') }

function encodeRequest (operations, { status, expectedGameTime, requestId = crypto.randomUUID() }) {
  if (!Number.isSafeInteger(status?.pid) || status.pid <= 0 || !uuid.test(status.session) || status.hooksReady !== true || status.activeMode !== 'HOLD' || status.controlValid !== true) throw new Error('A verified HOLD observer gate is required')
  if (status.worldReady !== true) throw new Error('The clone world has not been captured by an observer hook')
  if (status.requestPending || status.requestHalted) throw new Error('Pending or halted update request requires inspection')
  if (!Number.isSafeInteger(expectedGameTime) || expectedGameTime < 0 || !uuid.test(requestId)) throw new Error('Invalid gametime or request UUID')
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 80) throw new Error('Expected 1 through 80 explicit update operations')
  const unique = new Set()
  const lines = operations.map(op => {
    if (!op || ![op.x, op.y, op.z].every(Number.isSafeInteger)) throw new Error('Invalid target coordinate')
    const line = `${op.type} ${op.x} ${op.y} ${op.z}`
    if (!allowed.has(line)) throw new Error('Target is outside the pinned source allowlist')
    if (unique.has(line)) throw new Error('Duplicate update target')
    unique.add(line)
    return line
  })
  return ['OG_UPDATE_V1', status.pid, status.session, requestId, expectedGameTime, SOURCE_SHA256, ...lines, ''].join('\n')
}

async function requestVanillaUpdates (operations, { expectedGameTime, signal, timeoutMs = 15000 } = {}) {
  checkSignal(signal)
  const lockPath = path.join(ROOT, '.operation-lock')
  const lock = await fs.open(lockPath, 'wx', 0o600)
  let published = false
  let requestId
  let temporary
  try {
    const state = validateState(await readJson(STATE))
    if (!state.initialized || state.pendingStep || state.initialization?.pendingTick || state.initialization?.halted) throw new Error('Clone initialization state is not idle')
    const attest = async () => {
      checkSignal(signal)
      const current = validateState(await readJson(STATE))
      if (!['pid', 'startedAt', 'directory', 'password', 'host', 'port', 'version'].every(key => current[key] === state[key])) throw new Error('Clone identity changed')
      process.kill(state.pid, 0)
      return inspectObserverGate(state)
    }
    const status = await attest()
    requestId = crypto.randomUUID()
    const body = encodeRequest(operations, { status, expectedGameTime, requestId })
    const requestPath = path.join(state.directory, 'observer-gate-request.txt')
    try {
      const old = (await fs.readFile(requestPath, 'utf8')).split('\n')
      if (!uuid.test(old[3])) throw new Error('Existing request file is invalid')
      const result = await readJson(path.join(state.directory, `observer-gate-request-${old[3]}.json`))
      if (result?.pid !== state.pid || result.session !== status.session || result.status !== 'succeeded') throw new Error('Existing request has no successful result in this JVM; inspect before continuing')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    temporary = `${requestPath}.${requestId}.tmp`
    const file = await fs.open(temporary, 'wx', 0o600)
    try { await file.writeFile(body); await file.sync() } finally { await file.close() }
    const currentStatus = await attest()
    if (currentStatus.session !== status.session) throw new Error('Observer gate session changed')
    encodeRequest(operations, { status: currentStatus, expectedGameTime, requestId })
    checkSignal(signal)
    await fs.rename(temporary, requestPath)
    published = true
    const resultPath = path.join(state.directory, `observer-gate-request-${requestId}.json`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await attest()
      const result = await readJson(resultPath)
      if (result) {
        if (result.pid !== state.pid || result.session !== status.session || result.requestId !== requestId || result.sourceSha256 !== SOURCE_SHA256 || result.gameTime !== expectedGameTime) throw new Error('Update result identity mismatch')
        if (result.status !== 'succeeded') throw Object.assign(new Error('Vanilla update request failed; inspect retained intent and result'), { result })
        checkSignal(signal)
        return { ...result, resultPath, meaning: 'Vanilla callbacks completed; no ticks were advanced and no generated blocks have been verified.' }
      }
      if ((await inspectObserverGate(state))?.requestHalted) throw new Error('Observer update channel halted; inspect its retained journal')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for vanilla callbacks; do not automatically retry')
  } catch (error) {
    if (published) { error.requestId = requestId; error.requestPublished = true }
    throw error
  } finally {
    if (temporary && !published) await fs.rm(temporary, { force: true })
    await lock.close()
    await fs.unlink(lockPath)
  }
}

async function main (args = process.argv.slice(2)) {
  if (args.length !== 4 || args[0] !== '--game-time' || !/^(0|[1-9]\d*)$/.test(args[1]) || args[2] !== '--operations') throw new Error('Usage: node scripts/request-vanilla-updates.js --game-time <expected gametime> --operations <JSON array file>')
  const operations = JSON.parse(await fs.readFile(path.resolve(args[3]), 'utf8'))
  return requestVanillaUpdates(operations, { expectedGameTime: Number(args[1]) })
}
if (require.main === module) main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); if (error.requestPublished) console.error(`Request ${error.requestId} was published; inspect before retrying.`); process.exitCode = 1 })
module.exports = { encodeRequest, requestVanillaUpdates, SOURCE_SHA256 }
