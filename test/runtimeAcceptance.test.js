const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const Block = require('prismarine-block')('1.21.4')
const { normalizeItems } = require('../lib/physicalInventory')
const { identifyClosedHopperPairs, verifyRuntimeContainers } = require('../lib/runtimeAcceptance')

const key = pos => `${pos.x},${pos.y},${pos.z}`
const shears = (Slot, damage = 0) => ({ Slot, id: 'minecraft:shears', count: 1, components: { 'minecraft:damage': damage } })
const settings = { quiescent: true, strictInitialSnapshot: { validated: true, path: '/evidence/initial.json', sha256: 'fixture-hash' } }

function fixture (pairCount = 1) {
  const tasks = []
  const plan = { version: '1.21.4', tasks, air: [], entities: [], origin: new Vec3(0, 0, 0), sourceMin: { x: 0, y: 0, z: 0 } }
  const add = (name, pos, properties = {}, Items) => {
    const task = { id: key(pos), name, pos, state: Block.fromProperties(name, properties, 0).stateId }
    if (Items !== undefined) task.blockEntity = { Items }
    plan.tasks.push(task)
    return task
  }
  for (let index = 0; index < pairCount; index++) {
    const x = index * 10
    add('hopper', new Vec3(x, 1, 0), { facing: 'south' }, [shears(0)])
    add('hopper', new Vec3(x, 1, 1), { facing: 'north' }, [shears(1)])
    for (const y of [0, 2]) for (const z of [0, 1]) add('white_concrete', new Vec3(x, y, z))
    for (const [dx, z] of [[0, -1], [0, 2], [-1, 0], [-1, 1], [1, 0], [1, 1]]) plan.air.push(new Vec3(x + dx, 1, z))
  }
  const observed = new Map(tasks.filter(task => task.blockEntity).map(task => [task.id, structuredClone(task.blockEntity.Items)]))
  const calls = []
  const snapshot = {
    readContainer: async task => {
      calls.push(task.id)
      return { name: task.name, pos: task.pos, entries: normalizeItems(observed.get(task.id), plan.version), evidence: { command: `data get block ${task.pos.x} ${task.pos.y} ${task.pos.z}` } }
    }
  }
  return { plan, add, observed, calls, snapshot }
}

test('identifies sealed mutual hopper pairs from geometry at arbitrary coordinates', () => {
  const f = fixture(2)
  const pairs = identifyClosedHopperPairs(f.plan)
  assert.equal(pairs.length, 2)
  assert.deepEqual(pairs.map(pair => pair.members), [['0,1,0', '0,1,1'], ['10,1,0', '10,1,1']])
  assert.ok(pairs.every(pair => pair.geometry.caps.length === 4))
})

test('rejects an unproved boundary, missing cap, inventory cap, and external input', () => {
  for (const mutation of [
    f => f.plan.air.pop(),
    f => { f.plan.tasks = f.plan.tasks.filter(task => task.id !== '0,2,0') },
    f => {
      f.plan.tasks = f.plan.tasks.filter(task => task.id !== '0,2,0')
      f.add('barrel', new Vec3(0, 2, 0), {}, [])
    },
    f => f.add('hopper', new Vec3(-1, 1, 0), { facing: 'east' }, []),
    f => f.add('dropper', new Vec3(1, 1, 0), { facing: 'west' }, []),
    f => f.add('dispenser', new Vec3(1, 1, 0), { facing: 'west' }, [])
  ]) {
    const f = fixture()
    mutation(f)
    assert.equal(identifyClosedHopperPairs(f.plan).length, 0)
  }
})

test('one-way hoppers and nearby inventory entities never receive a pair allowance', () => {
  const f = fixture()
  f.plan.tasks[1].state = Block.fromProperties('hopper', { facing: 'down' }, 0).stateId
  assert.deepEqual(identifyClosedHopperPairs(f.plan), [])
  const other = fixture()
  other.plan.entities = [{ regionPosition: { x: 0, y: 0, z: 0 }, data: { id: 'minecraft:hopper_minecart', Pos: [0.5, 0.8, 0.5] } }]
  assert.deepEqual(identifyClosedHopperPairs(other.plan), [])
})

test('accepts only pair-local redistribution and discloses exact item totals and provenance', async () => {
  const f = fixture()
  f.observed.set('0,1,0', [])
  f.observed.set('0,1,1', [shears(2), shears(4)])
  const initial = structuredClone(settings.strictInitialSnapshot)
  const result = await verifyRuntimeContainers(f.plan, f.snapshot, settings)
  assert.equal(result.verified, true)
  assert.equal(result.pairs.length, 1)
  assert.deepEqual(result.pairs[0].expectedTotals, result.pairs[0].actualTotals)
  assert.equal(result.pairs[0].actualTotals[0].count, 2)
  assert.equal(result.pairs[0].runtimePhaseAllowance, 'closed-pair-item-redistribution')
  assert.equal(result.pairs[0].memberContents[0].exactSlotsMatched, false)
  assert.deepEqual(result.strictInitialSnapshot, initial)
  assert.deepEqual(settings.strictInitialSnapshot, initial)
  assert.deepEqual(f.calls, ['0,1,0', '0,1,1'])
})

test('cannot hide losses in one pair with excess items in another pair', async () => {
  const f = fixture(2)
  f.observed.set('0,1,0', [])
  f.observed.set('10,1,0', [shears(0), shears(1)])
  const result = await verifyRuntimeContainers(f.plan, f.snapshot, settings)
  assert.equal(result.verified, false)
  assert.equal(result.errors.length, 2)
  assert.ok(result.pairs.every(pair => pair.verified === false))
})

test('pair totals preserve damage, repair cost, item identity, and count', async () => {
  for (const replacement of [
    [shears(0, 1)],
    [{ ...shears(0), components: { 'minecraft:repair_cost': 2 } }],
    [{ Slot: 0, id: 'minecraft:stone', count: 1 }],
    []
  ]) {
    const f = fixture()
    f.observed.set('0,1,0', replacement)
    const result = await verifyRuntimeContainers(f.plan, f.snapshot, settings)
    assert.equal(result.verified, false)
  }
})

test('pair comparison preserves metadata and canonicalizes component ordering', async () => {
  const f = fixture()
  const raw = { ...shears(0, 17), components: { 'minecraft:damage': 17, 'minecraft:repair_cost': 3 } }
  f.plan.tasks[0].blockEntity.Items = [raw]
  f.observed.set('0,1,0', [{ ...raw, components: { 'minecraft:repair_cost': 3, 'minecraft:damage': 17 } }])
  assert.equal((await verifyRuntimeContainers(f.plan, f.snapshot, settings)).verified, true)
  const read = f.snapshot.readContainer
  f.snapshot.readContainer = async task => {
    const result = await read(task)
    if (task.id === '0,1,0') result.entries[0].item.metadata = 7
    return result
  }
  assert.equal((await verifyRuntimeContainers(f.plan, f.snapshot, settings)).verified, false)
})

test('ordinary containers remain exact by slot including explicit empty containers', async () => {
  const f = fixture(0)
  const chest = f.add('chest', new Vec3(20, 1, 0), {}, [shears(0)])
  const barrel = f.add('barrel', new Vec3(21, 1, 0), {}, [])
  f.observed.set(chest.id, [shears(1)])
  f.observed.set(barrel.id, [shears(0)])
  const result = await verifyRuntimeContainers(f.plan, f.snapshot, settings)
  assert.equal(result.verified, false)
  assert.equal(result.containers.length, 2)
  assert.equal(result.pairs.length, 0)
  assert.equal(result.errors.length, 2)
  assert.ok(result.containers.every(container => container.mode === 'exact-slots'))
})

test('an unsealed hopper pair falls back to exact slots rather than global totals', async () => {
  const f = fixture()
  f.plan.air.pop()
  f.observed.set('0,1,0', [])
  f.observed.set('0,1,1', [shears(0), shears(1)])
  const result = await verifyRuntimeContainers(f.plan, f.snapshot, settings)
  assert.equal(result.verified, false)
  assert.equal(result.pairs.length, 0)
  assert.equal(result.containers.length, 2)
})

test('requires validated initial provenance and a quiescent snapshot before allowing pair changes', async () => {
  for (const invalid of [
    {},
    { ...settings, strictInitialSnapshot: { path: '/evidence/initial.json', validated: false } },
    { ...settings, strictInitialSnapshot: { validated: true } },
    { ...settings, quiescent: false }
  ]) {
    const f = fixture()
    await assert.rejects(verifyRuntimeContainers(f.plan, f.snapshot, invalid), /initial|quiescent/i)
    assert.deepEqual(f.calls, [])
  }
})

test('snapshot failure propagates and never downgrades to a partial successful result', async () => {
  const f = fixture()
  const failure = new Error('RCON unavailable')
  f.snapshot.readContainer = async () => { throw failure }
  await assert.rejects(verifyRuntimeContainers(f.plan, f.snapshot, settings), error => error === failure)
})

test('invalid expected slots and missing Items fail closed before snapshot reads', async () => {
  for (const Items of [undefined, [shears(5)]]) {
    const f = fixture()
    f.plan.tasks[0].blockEntity.Items = Items
    await assert.rejects(verifyRuntimeContainers(f.plan, f.snapshot, settings), /Items|capacity/i)
    assert.deepEqual(f.calls, [])
  }
})

test('reports empty non-container Items explicitly and rejects non-default unsupported inventories', async () => {
  const f = fixture(0)
  const campfire = f.add('campfire', new Vec3(20, 1, 0), {}, [])
  const result = await verifyRuntimeContainers(f.plan, f.snapshot, settings)
  assert.equal(result.verified, true)
  assert.equal(result.containerCount, 0)
  assert.deepEqual(result.emptyNonContainers, [{ id: campfire.id, name: 'campfire', reason: 'empty-non-container-items' }])
  assert.deepEqual(f.calls, [])
  for (const Items of [[shears(0)], {}, null]) {
    campfire.blockEntity.Items = Items
    await assert.rejects(verifyRuntimeContainers(f.plan, f.snapshot, settings), /Unsupported runtime inventory/)
    assert.deepEqual(f.calls, [])
  }
})

test('rejects wrong snapshot identity and aborted reads without changing any state', async () => {
  const f = fixture()
  await assert.rejects(verifyRuntimeContainers(f.plan, f.snapshot, { ...settings, signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.deepEqual(f.calls, [])
  const read = f.snapshot.readContainer
  f.snapshot.readContainer = async task => ({ ...await read(task), pos: new Vec3(99, 99, 99) })
  await assert.rejects(verifyRuntimeContainers(f.plan, f.snapshot, settings), /identity/i)
})
