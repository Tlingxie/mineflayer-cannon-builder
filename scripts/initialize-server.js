#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { initializeNatural, checkCount } = require('../lib/naturalInitialization')
const { rconCommand } = require('./server-local')
const { verifyWorldSnapshot } = require('./server-backup')

const ROOT = path.resolve(__dirname, '../.runtime/server')
const STATE = path.join(ROOT, 'run.json')
const INITIALIZATION_STATE = path.join(ROOT, 'natural-initialization.json')
const CANNON = Object.freeze({ sha256: '8c2d8bf4dc8059cb083a28368da2efa1be2bd2dd4999d8b8062d115c4c758632', blocks: 12694, air: 37110, containers: 316, minecarts: 4 })
const IDENTITY_FIELDS = ['directory', 'host', 'port', 'version', 'pid', 'startedAt']
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const identity = state => Object.fromEntries(IDENTITY_FIELDS.map(field => [field, state[field]]))

function validateState (state) {
  if (state?.host !== '127.0.0.1' || state.port !== 25566 || state.rconPort !== 25576 || state.version !== '1.21.4' || state.directory !== ROOT ||
      !Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.startedAt !== 'string' || !state.startedAt || typeof state.password !== 'string' || !state.password) throw new Error('Invalid fixed managed server identity')
  return state
}

function validateAssembly (assembly, state) {
  validateState(state)
  const { proof, manifest } = assembly || {}
  if (!path.isAbsolute(assembly?.path || '') || !/^[a-f0-9]{64}$/.test(assembly?.sha256 || '') || proof?.version !== state.version || proof.activeAssemblyVerified !== true) throw new Error('A verified frozen assembly proof is required')
  if (!path.isAbsolute(proof.provenance?.schematic || '') || assembly.sourceSha256 !== CANNON.sha256 || (proof.provenance.schematicSha256 !== undefined && proof.provenance.schematicSha256 !== CANNON.sha256)) throw new Error('Assembly source hash does not match this cannon')
  if (!Array.isArray(proof.containers) || proof.strictContainersVerified !== CANNON.containers || proof.containers.length !== CANNON.containers || new Set(proof.containers.map(item => item.id)).size !== CANNON.containers || !proof.containers.every(item => typeof item.id === 'string' && item.id && item.verified === true && item.mode === 'exact-slots')) throw new Error('Assembly proof has incomplete strict cannon container verification')
  if (!Array.isArray(proof.minecarts) || proof.minecartsVerified !== CANNON.minecarts || proof.minecarts.length !== CANNON.minecarts || new Set(proof.minecarts.map(item => item.id)).size !== CANNON.minecarts || !proof.minecarts.every(item => typeof item.id === 'string' && item.id && item.emptyItemsVerified === true)) throw new Error('Assembly proof has incomplete cannon minecart verification')
  const audit = proof.worldAudit
  if (audit?.checkedBlocks !== CANNON.blocks || audit.checkedAir !== CANNON.air) throw new Error('Assembly proof has incomplete cannon target coverage')
  if (audit?.backend !== 'saved-region-files' || audit.version !== state.version || audit.completeBlueprint !== true || !Array.isArray(audit.activeMismatches) || audit.activeMismatches.length || !Array.isArray(audit.occupiedAir) || audit.occupiedAir.length) throw new Error('Assembly proof does not verify the complete active structure')
  const ticks = proof.tickState
  if (ticks?.unchanged !== true || !Number.isSafeInteger(ticks.gameTime) || ticks.gameTime < 0 || ticks.gameTime >= 2147483647 ||
      ![ticks.before, ticks.after].every(tick => tick?.frozen === true && tick.quiescent === true && tick.tickRate === 20 && tick.gameTime === ticks.gameTime)) throw new Error('Assembly proof does not attest unchanged frozen gametime')
  const source = proof.provenance?.backup
  if (manifest?.constructionFrozen !== true || !IDENTITY_FIELDS.every(field => manifest.server?.[field] === state[field] && source?.server?.[field] === state[field])) throw new Error('Assembly backup identity differs from the current managed process')
  if (!path.isAbsolute(source?.directory || '') || !/^[a-f0-9]{64}$/.test(source.manifestSha256 || '') || proof.provenance.world !== path.join(source.directory, 'world')) throw new Error('Assembly proof has invalid backup provenance')
  if (!isDeepStrictEqual(proof.provenance.origin, { x: 64, y: -60, z: 0 })) throw new Error('Assembly origin must match the fixed cannon force-loading region')
  return proof
}

async function loadAssembly (filename, state, { verifySnapshot = verifyWorldSnapshot, readSourceHash = async filename => hash(await fs.readFile(filename)) } = {}) {
  filename = await fs.realpath(filename)
  const bytes = await fs.readFile(filename)
  const proof = JSON.parse(bytes)
  if (!path.isAbsolute(proof.provenance?.schematic || '')) throw new Error('Assembly proof has no absolute cannon source path')
  const sourceSha256 = await readSourceHash(proof.provenance.schematic)
  if (sourceSha256 !== CANNON.sha256) throw new Error('Assembly source hash does not match this cannon')
  const backup = proof.provenance?.backup
  if (!path.isAbsolute(backup?.directory || '')) throw new Error('Assembly proof has no absolute backup source')
  const manifestBytes = await fs.readFile(path.join(backup.directory, 'manifest.json'))
  if (hash(manifestBytes) !== backup.manifestSha256) throw new Error('Assembly backup manifest hash differs from the verified proof')
  const manifest = await verifySnapshot(backup.directory)
  const result = { path: filename, sha256: hash(bytes), sourceSha256, proof, manifest }
  validateAssembly(result, state)
  return result
}

async function initializeServer (server, count, { assembly, durableState, command, saveState, record, ...options } = {}) {
  checkCount(count)
  const proof = validateAssembly(assembly, server)
  const binding = { path: assembly.path, sha256: assembly.sha256, sourceSha256: assembly.sourceSha256, backupDirectory: proof.provenance.backup.directory, manifestSha256: proof.provenance.backup.manifestSha256 }
  if (durableState && (durableState.schema !== 1 || !isDeepStrictEqual(durableState.identity, identity(server)) || !isDeepStrictEqual(durableState.assembly, binding))) throw new Error('Durable initialization belongs to another process identity or assembly proof')
  const state = { ...(durableState || {}), ...server, schema: 1, identity: identity(server), assembly: binding }
  const expectedGameTime = state.lastStep?.after ?? proof.tickState.gameTime
  const persist = async value => {
    const { password, rconPort, ...safe } = value
    await saveState(safe)
  }
  return initializeNatural(state, count, { ...options, command, record, saveState: persist, expectedGameTime })
}

async function readJson (filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function saveDurable (value) {
  const temporary = `${INITIALIZATION_STATE}.${crypto.randomUUID()}.tmp`
  const file = await fs.open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  await fs.rename(temporary, INITIALIZATION_STATE)
  const directory = await fs.open(ROOT, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function commandForState (state, text, { signal, readState = () => readJson(STATE), assertRunning = pid => process.kill(pid, 0), send = rconCommand } = {}) {
  validateState(state)
  const current = validateState(await readState())
  if (!IDENTITY_FIELDS.every(field => current[field] === state[field]) || current.password !== state.password || current.rconPort !== state.rconPort) throw new Error('Managed server identity changed during initialization')
  assertRunning(state.pid)
  const cleanup = ['tick freeze', 'tick step stop'].includes(text)
  if (!cleanup && signal?.aborted) throw signal.reason || new Error('Initialization cancelled')
  try { return await send({ port: state.rconPort, password: state.password, signal: cleanup ? undefined : signal }, text) } catch (error) {
    error.message = error.message.split(state.password).join('[redacted]')
    throw error
  }
}

async function runAction (args) {
  if (args.length !== 3 || !/^\d+$/.test(args[0]) || args[1] !== '--assembly') throw new Error('Usage: node scripts/initialize-server.js <count:1..512> --assembly <strict-frozen-proof.json>')
  const count = Number(args[0])
  checkCount(count)
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Main server initialization interrupted'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let journal
  try {
    const state = validateState(await readJson(STATE))
    const assembly = await loadAssembly(args[2], state)
    const durableState = await readJson(INITIALIZATION_STATE)
    const logFile = path.join(ROOT, `initialize-${Date.now()}-${crypto.randomUUID()}.jsonl`)
    journal = await fs.open(logFile, 'wx', 0o600)
    const result = await initializeServer(state, count, {
      assembly,
      durableState,
      command: text => commandForState(state, text, { signal: controller.signal }),
      saveState: saveDurable,
      record: async event => { await journal.writeFile(JSON.stringify(event) + '\n'); await journal.sync() },
      signal: controller.signal
    })
    console.log(JSON.stringify({ ...result, logFile, stateFile: INITIALIZATION_STATE }, null, 2))
    return result
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    if (journal) await journal.close()
  }
}

async function main (args = process.argv.slice(2)) {
  return require('../lib/serverOperationLock').withServerOperation(() => runAction(args))
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { initializeServer, loadAssembly, validateAssembly, validateState, commandForState, main }
