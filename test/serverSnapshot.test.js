const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const server = require('../scripts/server-local')
const { createServerSnapshot, createCloneSnapshot, parseDataResponse } = require('../lib/serverSnapshot')

const options = { host: '127.0.0.1', port: 25566, version: '1.21.4' }
const directory = path.resolve(__dirname, '../.runtime/server')
const position = { x: 70, y: -59, z: 4 }
const task = { name: 'chest', pos: position, blockEntity: { Items: [{ Slot: 2, id: 'minecraft:shears', count: 1, components: { 'minecraft:damage': 17 } }] } }
const containerData = '{id:"minecraft:chest",x:70,y:-59,z:4,Items:[{Slot:2b,id:"minecraft:shears",count:1,components:{"minecraft:damage":17}}]}'
const blockResponse = data => `70, -59, 4 has the following block data: ${data}`

function fixture (t, respond) {
  const state = { ...options, rconPort: 25576, password: 'fixture-rcon-secret', pid: process.pid, directory }
  const commands = []
  t.mock.method(fs, 'readFile', async filename => {
    assert.equal(filename, path.join(directory, 'run.json'))
    return JSON.stringify(state)
  })
  t.mock.method(server, 'rconCommand', async (credentials, command) => {
    assert.deepEqual(credentials, { port: state.rconPort, password: state.password })
    commands.push(command)
    return respond(command)
  })
  return { state, commands }
}

test('fluid fence atomically checks exact block states with readonly predicates and frozen gametime', async t => {
  let mismatch = false
  const f = fixture(t, command => {
    if (command === 'tick query') return 'The game is frozen. Target tick rate: 20.0 per second.'
    if (command === 'time query gametime') return 'The time is 1234'
    if (command.startsWith('execute if block')) return mismatch ? 'Test failed' : 'The time is 1234'
    throw new Error(command)
  })
  const snapshot = await createServerSnapshot(options)
  const Block = require('prismarine-block')('1.21.4')
  const blocks = [{ pos: position, stateId: 0 }, { pos: { ...position, y: -58 }, stateId: Block.fromProperties('cobblestone_slab', { type: 'top', waterlogged: false }, 0).stateId }]
  const proof = await snapshot.verifyBlockStates(blocks)
  assert.equal(proof.verified, true)
  assert.equal(proof.checked, 2)
  assert.ok(f.commands.includes('execute if block 70 -59 4 minecraft:air if block 70 -58 4 minecraft:cobblestone_slab[type=top,waterlogged=false] run time query gametime'))
  mismatch = true
  await assert.rejects(snapshot.verifyBlockStates(blocks), /differs/)
  const count = f.commands.length
  for (const invalid of [[], [...blocks, blocks[0]], [{ pos: position, stateId: -1 }], [{ pos: { ...position, x: '1 run fill' }, stateId: 0 }]]) await assert.rejects(snapshot.verifyBlockStates(invalid))
  assert.equal(f.commands.length, count)
})

test('parses official SNBT suffixes and typed UUID arrays without truncating data', () => {
  const block = parseDataResponse(blockResponse(containerData), 'block', position)
  assert.deepEqual(block.Items[0], task.blockEntity.Items[0])
  const entity = parseDataResponse('Minecart with Hopper has the following entity data: {UUID:[I;1,-2,3,-4],Pos:[70.25d,-55.0625d,4.5d],Enabled:0b,Items:[],Motion:[0.0d,0.0d,0.0d]}', 'entity')
  assert.deepEqual(entity.UUID, [1, -2, 3, -4])
  assert.deepEqual(entity.Pos, [70.25, -55.0625, 4.5])
  assert.equal(entity.Enabled, 0)
  assert.throws(() => parseDataResponse(blockResponse('{Items:[{Slot:0b}'), 'block', position), /SNBT/)
  assert.throws(() => parseDataResponse('No entity was found', 'entity'), /data response/)
  assert.throws(() => parseDataResponse('0, 0, 0 has the following block data: {}', 'block', position), /coordinates/)
  assert.throws(() => parseDataResponse(blockResponse('{value:9223372036854775807L}'), 'block', position), /precision/)
})

test('requires an exact matching managed loopback endpoint before any RCON operation', async t => {
  const f = fixture(t, () => blockResponse(containerData))
  for (const mismatch of [{ host: 'localhost' }, { host: '192.0.2.1' }, { port: 25565 }, { version: '1.21.5' }]) {
    await assert.rejects(createServerSnapshot({ ...options, ...mismatch }), { code: 'SNAPSHOT_UNAVAILABLE' })
  }
  f.state.directory = '/different/runtime'
  await assert.rejects(createServerSnapshot(options), /managed/)
  assert.equal(f.commands.length, 0)
})

test('reads actual per-block slots with damage metadata and records only read-only evidence', async t => {
  const f = fixture(t, () => blockResponse(containerData))
  const snapshot = await createServerSnapshot(options)
  const observed = await snapshot.readContainer(task)
  assert.equal(observed.entries[0].item.durabilityUsed, 17)
  assert.equal(observed.entries[0].slot, 2)
  assert.equal(observed.evidence.command, 'data get block 70 -59 4')
  assert.equal(observed.evidence.response, blockResponse(containerData))
  const verified = await snapshot.verifyContainer(task)
  assert.equal(verified.verified, true)
  assert.equal(verified.slots, 1)
  assert.equal(verified.items, 1)
  assert.ok(f.commands.every(command => command === 'data get block 70 -59 4'))
  assert.equal(JSON.stringify(snapshot).includes(f.state.password), false)
})

test('checks explicit empty containers and rejects mismatches without changing them', async t => {
  const f = fixture(t, () => blockResponse(containerData))
  const snapshot = await createServerSnapshot(options)
  await assert.rejects(snapshot.verifyContainer({ ...task, blockEntity: { Items: [] } }), error => {
    assert.match(error.message, /slot 2/)
    assert.equal(error.evidence[0].command, 'data get block 70 -59 4')
    return true
  })
  assert.equal(f.commands.length, 1)
})

test('accepts an actually empty server container and rejects different block entity identity', async t => {
  let response = blockResponse('{id:"minecraft:chest",x:70,y:-59,z:4,Items:[]}')
  fixture(t, () => response)
  const snapshot = await createServerSnapshot(options)
  const empty = { ...task, blockEntity: { Items: [] } }
  assert.equal((await snapshot.verifyContainer(empty)).items, 0)
  response = blockResponse('{id:"minecraft:chest",x:71,y:-59,z:4,Items:[]}')
  await assert.rejects(snapshot.verifyContainer(empty), /identity differs/)
  response = blockResponse('{id:"minecraft:hopper",x:70,y:-59,z:4,Items:[]}')
  await assert.rejects(snapshot.verifyContainer(empty), /identity differs/)
})

test('rejects unsupported item data and command injection through coordinates', async t => {
  const f = fixture(t, () => blockResponse(containerData.replace('"minecraft:damage":17', '"minecraft:custom_data":{value:1}')))
  const snapshot = await createServerSnapshot(options)
  await assert.rejects(snapshot.readContainer(task), /Unsupported item component/)
  await assert.rejects(snapshot.readContainer({ ...task, pos: { ...position, x: '70 run setblock' } }), /coordinate/)
  assert.equal(f.commands.length, 1)
})

test('reads minecart type-constrained selectors, UUID, position, inventory and Enabled', async t => {
  const f = fixture(t, () => 'Minecart with Hopper has the following entity data: {UUID:[I;1,-2,3,-4],Pos:[70.25d,-55.0625d,4.5d],Enabled:0b,Items:[]}')
  const snapshot = await createServerSnapshot(options)
  const expected = { id: 'first', name: 'hopper_minecart', pos: { x: 70.25, y: -55.0625, z: 4.5 }, expectedEnabled: false, source: { data: { Items: [] } } }
  const observed = await snapshot.readMinecart(expected)
  assert.equal(observed.name, 'hopper_minecart')
  assert.equal(observed.uuid, '00000001-ffff-fffe-0000-0003fffffffc')
  assert.equal(observed.enabled, false)
  assert.ok(f.commands[0].startsWith('data get entity @e[type=minecraft:hopper_minecart,'))
  const verified = await snapshot.verifyMinecarts([expected])
  assert.equal(verified.verified, true)
  await assert.rejects(snapshot.verifyMinecarts([expected, { ...expected, id: 'second' }]), /same UUID/)
  await assert.rejects(snapshot.verifyMinecarts([{ ...expected, expectedEnabled: true }]), /Enabled/)
})

test('rechecks managed identity for every read and never exposes RCON credentials', async t => {
  const f = fixture(t, () => blockResponse(containerData))
  const snapshot = await createServerSnapshot(options)
  f.state.port++
  await assert.rejects(snapshot.readContainer(task), /managed/)
  assert.equal(f.commands.length, 0)
  f.state.port--
  f.state.pid++
  await assert.rejects(snapshot.readContainer(task), /changed/)
  assert.equal(f.commands.length, 0)
})

test('aborted snapshots do not issue data commands', async t => {
  const f = fixture(t, () => blockResponse(containerData))
  const snapshot = await createServerSnapshot(options)
  await assert.rejects(snapshot.verifyContainer(task, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.equal(f.commands.length, 0)
})

test('transport errors redact managed credentials while retaining the attempted read command', async t => {
  const f = fixture(t, () => { throw new Error('Rejected fixture-rcon-secret') })
  const snapshot = await createServerSnapshot(options)
  await assert.rejects(snapshot.readContainer(task), error => {
    assert.equal(error.message.includes(f.state.password), false)
    assert.equal(error.evidence[0].command, 'data get block 70 -59 4')
    return true
  })
})

test('primed TNT inspection is read-only and distinguishes absent entities from remaining fuse', async t => {
  let response = 'No entity was found'
  const f = fixture(t, () => response)
  const snapshot = await createServerSnapshot(options)
  assert.equal((await snapshot.readPrimedTnt()).present, false)
  response = 'Primed TNT has the following entity data: {UUID:[I;1,2,3,4],Pos:[80.5d,-50.0d,25.5d],fuse:79s}'
  const present = await snapshot.readPrimedTnt()
  assert.equal(present.present, true)
  assert.equal(present.fuse, 79)
  assert.deepEqual(present.pos, { x: 80.5, y: -50, z: 25.5 })
  assert.ok(f.commands.every(command => command === 'data get entity @e[type=minecraft:tnt,limit=1]'))
  response = 'Unknown command'
  await assert.rejects(snapshot.readPrimedTnt(), /data response/)
})

const frozenTickQuery = 'The game is frozen\nTarget tick rate: 20.0 per second.\nAverage time per tick: 1.0ms (Target: 50.0ms)\nPercentiles: P50: 1.0ms P95: 2.0ms P99: 3.0ms, sample: 100'

test('decoration snapshots distinguish absence, verify full data and reject reused UUIDs', async t => {
  let response = 'No entity was found'
  const f = fixture(t, () => response)
  const snapshot = await createServerSnapshot(options)
  const { normalizeDecorationEntities } = require('../lib/physicalDecorationsData')
  const { Vec3 } = require('vec3')
  const [expected] = normalizeDecorationEntities({ origin: new Vec3(0, 0, 0), sourceMin: new Vec3(0, 0, 0), entities: [{ regionPosition: new Vec3(0, 0, 0), data: { id: 'minecraft:painting', Pos: [70.5, 64.5, 4.03125], TileX: 70, TileY: 64, TileZ: 4, facing: 0, variant: 'minecraft:wasteland', Rotation: [0, 0] } }] })
  assert.equal(await snapshot.readDecoration(expected), null)
  response = 'Painting has the following entity data: {UUID:[I;1,2,3,4],Pos:[70.5d,64.5d,4.03125d],block_pos:[I;70,64,4],facing:0b,variant:"minecraft:wasteland",Rotation:[0.0f,0.0f],Invisible:0b,Invulnerable:0b,NoGravity:0b}'
  assert.deepEqual((await snapshot.readDecoration(expected)).differences, [])
  assert.equal((await snapshot.verifyDecorations([expected])).checked, 1)
  await assert.rejects(snapshot.verifyDecorations([expected, { ...expected, id: 'second' }]), /same UUID/)
  response = response.replace('wasteland', 'kebab')
  await assert.rejects(snapshot.verifyDecorations([expected]), /variant|decoration/i)
  assert.ok(f.commands.every(command => command.includes('distance=..0.04,sort=nearest,limit=1]')))
})

test('construction tick inspection requires frozen 20 TPS and unchanged gametime across at least 150ms', async t => {
  const samples = []
  const f = fixture(t, command => {
    if (command === 'tick query') return frozenTickQuery
    assert.equal(command, 'time query gametime')
    samples.push(performance.now())
    return 'The time is 12345'
  })
  const snapshot = await createServerSnapshot(options)
  assert.equal(typeof snapshot.readTickState, 'function')
  const result = await snapshot.readTickState()
  assert.equal(result.frozen, true)
  assert.equal(result.quiescent, true)
  assert.equal(result.tickRate, 20)
  assert.equal(result.gameTime, 12345)
  assert.ok(samples[1] - samples[0] >= 150)
  assert.ok(result.sampleMs >= 150)
  assert.deepEqual(f.commands, ['tick query', 'time query gametime', 'time query gametime', 'tick query'])
  assert.equal(result.evidence.length, 4)
  assert.equal(JSON.stringify(result).includes(f.state.password), false)
})

test('frozen query alone cannot pass while step ticks advance gametime', async t => {
  let time = 100
  fixture(t, command => command === 'tick query' ? frozenTickQuery : `The time is ${time++}`)
  const snapshot = await createServerSnapshot(options)
  assert.equal(typeof snapshot.readTickState, 'function')
  await assert.rejects(snapshot.readTickState(), error => {
    assert.match(error.message, /gametime.*advanced|not quiescent/i)
    assert.equal(error.evidence.filter(item => item.command === 'time query gametime').length, 2)
    return true
  })
})

test('tick inspection fails closed for unfrozen state, slow tick rate and missing rate', async t => {
  let response = frozenTickQuery.replace('The game is frozen', 'The game is running normally')
  const f = fixture(t, () => response)
  const snapshot = await createServerSnapshot(options)
  assert.equal(typeof snapshot.readTickState, 'function')
  await assert.rejects(snapshot.readTickState(), /frozen/i)
  response = frozenTickQuery.replace('20.0 per second', '1.0 per second')
  await assert.rejects(snapshot.readTickState(), /20.*tick|tick.*20/i)
  response = 'The game is frozen'
  await assert.rejects(snapshot.readTickState(), /tick rate/i)
  assert.ok(f.commands.every(command => command === 'tick query'))
})

test('tick inspection rechecks frozen state after observing stable gametime', async t => {
  let reads = 0
  fixture(t, command => {
    if (command === 'time query gametime') return 'The time is 100'
    return ++reads === 1 ? frozenTickQuery : frozenTickQuery.replace('The game is frozen', 'The game is running normally')
  })
  const snapshot = await createServerSnapshot(options)
  assert.equal(typeof snapshot.readTickState, 'function')
  await assert.rejects(snapshot.readTickState(), error => {
    assert.match(error.message, /frozen/i)
    assert.equal(error.evidence.length, 4)
    return true
  })
})

test('tick inspection aborts without a second gametime read and preserves the collected evidence', async t => {
  const controller = new AbortController()
  const f = fixture(t, command => {
    if (command === 'tick query') return frozenTickQuery
    setTimeout(() => controller.abort(), 20)
    return 'The time is 100'
  })
  const snapshot = await createServerSnapshot(options)
  assert.equal(typeof snapshot.readTickState, 'function')
  await assert.rejects(snapshot.readTickState({ signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.evidence.length, 2)
    return true
  })
  assert.equal(f.commands.filter(command => command === 'time query gametime').length, 1)
})

test('tick inspection rejects changed managed identity between samples without using the changed endpoint', async t => {
  const f = fixture(t, command => {
    if (command === 'tick query') return frozenTickQuery
    f.state.pid++
    return 'The time is 100'
  })
  const snapshot = await createServerSnapshot(options)
  assert.equal(typeof snapshot.readTickState, 'function')
  await assert.rejects(snapshot.readTickState(), /identity changed/i)
  assert.deepEqual(f.commands, ['tick query', 'time query gametime'])
})

function cloneFixture (t, respond) {
  const root = path.resolve(__dirname, '../.runtime/clones')
  const state = { kind: 'initialization-clone', host: '127.0.0.1', port: 25567, version: '1.21.4', rconPort: 25577, password: 'clone-only-secret', pid: process.pid, startedAt: '2026-10-03T01:02:03.000Z', directory: path.join(root, 'run-12345-abcdef') }
  const reads = []
  const commands = []
  t.mock.method(fs, 'readFile', async filename => {
    assert.equal(filename, path.join(root, 'run.json'))
    reads.push(filename)
    return JSON.stringify(state)
  })
  t.mock.method(server, 'rconCommand', async (credentials, command) => {
    assert.deepEqual(credentials, { port: 25577, password: 'clone-only-secret' })
    commands.push(command)
    return respond(command)
  })
  return { state, root, reads, commands }
}

test('clone snapshot reuses every read API only through the fixed clone endpoint', async t => {
  const f = cloneFixture(t, command => {
    if (command === 'tick query') return frozenTickQuery
    if (command === 'time query gametime') return 'The time is 400'
    if (command.startsWith('data get block')) return blockResponse(containerData)
    if (command === 'data get entity @e[type=minecraft:tnt,limit=1]') return 'No entity was found'
    return 'Minecart with Hopper has the following entity data: {UUID:[I;1,-2,3,-4],Pos:[70.25d,-55.0625d,4.5d],Enabled:0b,Items:[]}'
  })
  const snapshot = await createCloneSnapshot()
  assert.equal(snapshot.backend, 'clone-rcon')
  assert.equal(snapshot.port, 25567)
  assert.equal((await snapshot.readContainer(task)).entries[0].slot, 2)
  assert.equal((await snapshot.verifyContainer(task)).verified, true)
  const expected = { id: 'cart', name: 'hopper_minecart', pos: { x: 70.25, y: -55.0625, z: 4.5 }, expectedEnabled: false, source: { data: { Items: [] } } }
  assert.equal((await snapshot.readMinecart(expected)).enabled, false)
  assert.equal((await snapshot.verifyMinecarts([expected])).entities, 1)
  assert.equal((await snapshot.readPrimedTnt()).present, false)
  assert.equal((await snapshot.readTickState()).gameTime, 400)
  assert.ok(f.commands.every(command => command.startsWith('data get ') || ['tick query', 'time query gametime'].includes(command)))
  assert.equal(JSON.stringify(snapshot).includes(f.state.password), false)
})

test('clone snapshot refuses main endpoints and caller-supplied state files', async t => {
  const f = cloneFixture(t, () => '')
  for (const options of [{ host: 'localhost' }, { port: 25566 }, { version: '1.21.5' }, { stateFile: '/other/run.json' }, { directory: '/other' }, { rconPort: 25576 }]) {
    await assert.rejects(createCloneSnapshot(options), { code: 'SNAPSHOT_UNAVAILABLE' })
  }
  assert.deepEqual(f.commands, [])
})

test('clone snapshot validates kind, normalized directory, PID, startedAt and credentials before reading', async t => {
  const f = cloneFixture(t, () => '')
  const original = { ...f.state }
  for (const patch of [
    { kind: 'managed-server' }, { directory }, { directory: path.join(f.root, 'other') },
    { directory: `${f.root}/run-a/../run-b` }, { pid: 0 }, { startedAt: undefined },
    { startedAt: 'invalid' }, { password: '' }, { rconPort: 25576 }
  ]) {
    Object.assign(f.state, original, patch)
    await assert.rejects(createCloneSnapshot(), /clone/i)
    assert.deepEqual(f.commands, [])
  }
})

test('clone snapshot reattests its identity for every query without falling back to main', async t => {
  const f = cloneFixture(t, () => blockResponse(containerData))
  const original = { ...f.state }
  const snapshot = await createCloneSnapshot()
  for (const patch of [
    { directory: path.join(f.root, 'run-other') }, { pid: process.pid + 1 },
    { startedAt: '2026-10-03T01:02:04.000Z' }, { password: 'different' },
    { kind: 'managed-server' }, { port: 25566 }, { rconPort: 25576 }
  ]) {
    Object.assign(f.state, original, patch)
    await assert.rejects(snapshot.readContainer(task), /identity|clone/i)
    assert.deepEqual(f.commands, [])
  }
})

test('clone read failures redact secrets, preserve read evidence and honor cancellation', async t => {
  const f = cloneFixture(t, () => { throw new Error('Rejected clone-only-secret') })
  const snapshot = await createCloneSnapshot()
  await assert.rejects(snapshot.readContainer(task, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.deepEqual(f.commands, [])
  await assert.rejects(snapshot.readContainer(task), error => {
    assert.equal(JSON.stringify({ message: error.message, evidence: error.evidence }).includes(f.state.password), false)
    assert.equal(error.evidence[0].backend, 'clone-rcon')
    assert.equal(error.evidence[0].command, 'data get block 70 -59 4')
    return true
  })
})
