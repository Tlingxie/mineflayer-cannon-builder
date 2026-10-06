const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const crypto = require('node:crypto')
const CANNON_SHA256 = '8c2d8bf4dc8059cb083a28368da2efa1be2bd2dd4999d8b8062d115c4c758632'

function implementation () {
  let result
  try { result = require('../scripts/initialize-server') } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  assert.ok(result, 'The main-server initialization entrypoint is implemented')
  return result
}

function fixture () {
  const state = { host: '127.0.0.1', port: 25566, rconPort: 25576, version: '1.21.4', pid: 123, startedAt: '2026-10-03T00:00:00Z', directory: path.resolve(__dirname, '../.runtime/server'), password: 'private-fixture' }
  const { password, rconPort, ...server } = state
  const tick = { frozen: true, quiescent: true, tickRate: 20, gameTime: 100 }
  const manifest = { constructionFrozen: true, server, files: [] }
  const proof = {
    version: state.version,
    activeAssemblyVerified: true,
    strictContainersVerified: 316,
    containers: Array.from({ length: 316 }, (_, i) => ({ id: `chest:${i}`, mode: 'exact-slots', verified: true })),
    minecartsVerified: 4,
    minecarts: Array.from({ length: 4 }, (_, i) => ({ id: `cart:${i}`, emptyItemsVerified: true })),
    tickState: { before: tick, after: tick, unchanged: true, gameTime: 100 },
    worldAudit: { backend: 'saved-region-files', completeBlueprint: true, version: state.version, checkedBlocks: 12694, checkedAir: 37110, activeMismatches: [], occupiedAir: [] },
    provenance: { origin: { x: 64, y: -60, z: 0 }, schematic: '/fixture.litematic', world: '/backup/world', backup: { directory: '/backup', server, manifestSha256: 'a'.repeat(64) } }
  }
  return { state, assembly: { path: '/proof.json', sha256: 'b'.repeat(64), sourceSha256: CANNON_SHA256, proof, manifest } }
}

function harness () {
  const f = fixture()
  const sent = []
  const saved = []
  const records = []
  let time = 100
  const options = {
    assembly: f.assembly,
    wait: async () => {},
    saveState: async value => saved.push(structuredClone(value)),
    record: async event => records.push(event),
    command: async text => {
      sent.push(text)
      if (text === 'tick query' || text === 'tick freeze') return 'The game is frozen'
      if (text === 'tick step stop') return 'No tick step in progress'
      if (text === 'time query gametime') return `The time is ${time}`
      if (text === 'forceload add 64 0 127 47') return 'No chunks were marked for force loading'
      if (text.startsWith('forceload query ')) {
        const [, , x, z] = text.split(' ')
        return `Chunk at [${Number(x) / 16}, ${Number(z) / 16}] in minecraft:overworld is marked for force loading`
      }
      if (text.startsWith('execute if loaded ')) return 'Test passed'
      if (text.startsWith('data get entity ')) return 'No entity was found'
      if (text === 'tick step 1') { time++; return 'Stepping 1 tick(s)' }
      throw new Error(`Unexpected command: ${text}`)
    }
  }
  return { ...f, options, sent, saved, records, setTime: value => { time = value } }
}

test('main initialization reuses the guarded single-tick core and persists no server credentials', async () => {
  const { initializeServer } = implementation()
  const h = harness()
  const original = structuredClone(h.state)
  const result = await initializeServer(h.state, 2, h.options)
  assert.equal(result.completedTicks, 2)
  assert.equal(result.gametime, 102)
  assert.equal(result.completeBlueprintVerified, undefined)
  assert.equal(h.sent.filter(command => command === 'tick step 1').length, 2)
  assert.equal(h.sent.filter(command => command.startsWith('data get entity ')).length, 4)
  assert.deepEqual(h.state, original)
  assert.equal(JSON.stringify(h.saved).includes(original.password), false)
  assert.equal(JSON.stringify(h.saved).includes('"password"'), false)
  assert.equal(h.saved.at(-1).assembly.sha256, h.assembly.sha256)
  h.options.durableState = h.saved.at(-1)
  const next = await initializeServer(h.state, 1, h.options)
  assert.equal(next.totalTicks, 3)
  assert.equal(next.gametime, 103)
})

test('main initialization rejects incomplete proof, foreign endpoint and changed process before commands', async () => {
  const { initializeServer } = implementation()
  const mutations = [
    h => { h.assembly.proof.activeAssemblyVerified = false },
    h => { h.assembly.proof.strictContainersVerified = 0 },
    h => { h.assembly.proof.minecarts[0].emptyItemsVerified = false },
    h => { h.assembly.proof.tickState.after = { ...h.assembly.proof.tickState.after, gameTime: 101 } },
    h => { h.assembly.manifest.server = { ...h.assembly.manifest.server, pid: 124 } },
    h => { h.state.port = 25567 },
    h => { h.assembly.proof.provenance.origin.x = 0 }
  ]
  for (const mutate of mutations) {
    const h = harness()
    mutate(h)
    await assert.rejects(initializeServer(h.state, 1, h.options), /proof|assembly|identity|managed|origin/i)
    assert.deepEqual(h.sent, [])
  }
})

test('same-origin single-block proofs cannot authorize cannon initialization', async () => {
  const h = harness()
  Object.assign(h.assembly.proof, { strictContainersVerified: 0, containers: [], minecartsVerified: 0, minecarts: [] })
  Object.assign(h.assembly.proof.worldAudit, { checkedBlocks: 1, checkedAir: 0 })
  await assert.rejects(implementation().initializeServer(h.state, 1, h.options), /cannon|container|minecart|coverage/i)
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.saved, [])
})

test('the full cannon proof requires its exact source hash, target counts and unique content records', async () => {
  const mutations = [
    h => { h.assembly.sourceSha256 = 'c'.repeat(64) },
    h => { delete h.assembly.sourceSha256 },
    h => { h.assembly.proof.provenance.schematicSha256 = 'd'.repeat(64) },
    h => { h.assembly.proof.worldAudit.checkedBlocks-- },
    h => { h.assembly.proof.worldAudit.checkedAir-- },
    h => { h.assembly.proof.containers.pop(); h.assembly.proof.strictContainersVerified-- },
    h => { h.assembly.proof.minecarts.pop(); h.assembly.proof.minecartsVerified-- },
    h => { h.assembly.proof.containers[1].id = h.assembly.proof.containers[0].id },
    h => { h.assembly.proof.minecarts[1].id = h.assembly.proof.minecarts[0].id }
  ]
  for (const mutate of mutations) {
    const h = harness()
    mutate(h)
    await assert.rejects(implementation().initializeServer(h.state, 1, h.options), /cannon|hash|coverage|container|minecart/i)
    assert.deepEqual(h.sent, [])
  }
})

test('a stale proof gametime stops before force-loading or advancing the main server', async () => {
  const h = harness()
  h.setTime(101)
  await assert.rejects(implementation().initializeServer(h.state, 1, h.options), /gametime/i)
  assert.equal(h.sent.some(command => command.startsWith('forceload') || command === 'tick step 1'), false)
  assert.ok(h.saved.at(-1).initialization.halted)
})

test('unknown pending, halted or differently bound main batches never retry', async () => {
  const { initializeServer } = implementation()
  const h = harness()
  await initializeServer(h.state, 1, h.options)
  const prior = h.saved.at(-1)
  for (const mutate of [s => { s.pendingStep = { before: 101 } }, s => { s.initialization.pendingTick = { index: 2 } }, s => { s.initialization.halted = { message: 'uncertain' } }, s => { s.assembly.sha256 = 'c'.repeat(64) }, s => { s.identity.pid++ }]) {
    const durableState = structuredClone(prior)
    mutate(durableState)
    h.sent.length = 0
    await assert.rejects(initializeServer(h.state, 1, { ...h.options, durableState }), /pending|halted|identity|proof|assembly/i)
    assert.deepEqual(h.sent, [])
  }
})

test('proof loading checks the exact backup manifest hash and complete snapshot integrity', async t => {
  const { loadAssembly } = implementation()
  const f = fixture()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'initialization-proof-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'proof.json')
  const bytes = JSON.stringify(f.assembly.manifest)
  f.assembly.proof.provenance.backup.directory = directory
  f.assembly.proof.provenance.world = path.join(directory, 'world')
  f.assembly.proof.provenance.backup.manifestSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  await fs.writeFile(path.join(directory, 'manifest.json'), bytes)
  await fs.writeFile(filename, JSON.stringify(f.assembly.proof))
  let verified = 0
  const verifySnapshot = async target => { assert.equal(target, directory); verified++; return f.assembly.manifest }
  let sourceReads = 0
  const readSourceHash = async target => { assert.equal(target, '/fixture.litematic'); sourceReads++; return CANNON_SHA256 }
  const result = await loadAssembly(filename, f.state, { verifySnapshot, readSourceHash })
  assert.equal(verified, 1)
  assert.equal(sourceReads, 1)
  assert.equal(result.sourceSha256, CANNON_SHA256)
  assert.equal(result.sha256.length, 64)
  await fs.appendFile(path.join(directory, 'manifest.json'), ' ')
  await assert.rejects(loadAssembly(filename, f.state, { verifySnapshot, readSourceHash }), /manifest.*hash/i)
})

test('proof loading hashes source bytes instead of trusting a claimed cannon hash', async t => {
  const f = fixture()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'initialization-wrong-source-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'proof.json')
  const schematic = path.join(directory, 'one-block.litematic')
  await fs.writeFile(schematic, 'not-the-cannon-source')
  f.assembly.proof.provenance.schematic = schematic
  f.assembly.proof.provenance.schematicSha256 = CANNON_SHA256
  const bytes = JSON.stringify(f.assembly.manifest)
  Object.assign(f.assembly.proof.provenance.backup, { directory, manifestSha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  f.assembly.proof.provenance.world = path.join(directory, 'world')
  await fs.writeFile(path.join(directory, 'manifest.json'), bytes)
  await fs.writeFile(filename, JSON.stringify(f.assembly.proof))
  await assert.rejects(implementation().loadAssembly(filename, f.state, { verifySnapshot: async () => f.assembly.manifest }), /source.*hash|cannon/i)
})

test('common natural initialization is exported without selecting any server', () => {
  let result
  try { result = require('../lib/naturalInitialization') } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  assert.equal(typeof result?.initializeNatural, 'function')
  assert.equal(typeof result?.stepFrozen, 'function')
})

test('main-server TNT detection after a tick preserves durable guards and never dispatches the next tick', async () => {
  const h = harness()
  const original = h.options.command
  h.options.command = async text => {
    if (text.startsWith('data get entity ') && h.sent.includes('tick step 1')) return 'TNT has the following entity data: {fuse:80s}'
    return original(text)
  }
  await assert.rejects(implementation().initializeServer(h.state, 2, h.options), { code: 'PRIMED_TNT' })
  assert.equal(h.sent.filter(text => text === 'tick step 1').length, 1)
  assert.ok(h.saved.at(-1).pendingStep)
  assert.ok(h.saved.at(-1).initialization.pendingTick)
  assert.equal(h.saved.at(-1).initialization.completedTicks, 0)
  assert.ok(h.sent.includes('tick freeze'))
})

test('main cancellation during durable command intent prevents mutation and remains halted', async () => {
  const h = harness()
  const controller = new AbortController()
  const original = h.options.record
  h.options.record = async event => {
    await original(event)
    if (event.type === 'command-intent' && event.command === 'tick step 1') controller.abort(new Error('cancel while journaling'))
  }
  await assert.rejects(implementation().initializeServer(h.state, 1, { ...h.options, signal: controller.signal }), /cancel while journaling/)
  assert.equal(h.sent.includes('tick step 1'), false)
  assert.ok(h.saved.at(-1).initialization.halted)
  assert.ok(h.saved.at(-1).pendingStep)
})

test('main cancellation at the final result cannot be reported as success', async () => {
  const h = harness()
  const controller = new AbortController()
  h.options.record = async event => { if (event.type === 'tick-result') controller.abort(new Error('cancel final result')) }
  await assert.rejects(implementation().initializeServer(h.state, 1, { ...h.options, signal: controller.signal }), /cancel final result/)
  assert.ok(h.saved.at(-1).initialization.halted)
  assert.ok(h.saved.at(-1).initialization.pendingTick)
})

test('main commands attest the fixed process on every call and redact transport errors', async () => {
  const { commandForState } = implementation()
  const { state } = fixture()
  let current = { ...state }
  const sent = []
  const settings = {
    readState: async () => current,
    assertRunning: pid => assert.equal(pid, state.pid),
    send: async (config, command) => { sent.push({ config, command }); return 'OK' }
  }
  assert.equal(await commandForState(state, 'tick query', settings), 'OK')
  current = { ...state, pid: state.pid + 1 }
  await assert.rejects(commandForState(state, 'tick step 1', settings), /identity changed/)
  assert.equal(sent.length, 1)
  current = { ...state }
  await assert.rejects(commandForState(state, 'tick query', { ...settings, send: async () => { throw new Error(`transport ${state.password}`) } }), error => !error.message.includes(state.password))
})
