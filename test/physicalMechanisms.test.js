const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { normalizeMinecartEntities, findPortalFrames, assertPortalFrame, placeMinecart, verifyMinecarts } = require('../lib/physicalMechanisms')
const { resolveState } = require('../lib/strictSchematic')

function task (name, x, y, z, properties = {}) {
  const block = resolveState(name, properties, '1.21.4')
  return { id: `${x},${y},${z}`, name, state: block.stateId, pos: new Vec3(x, y, z) }
}

test('explicit decoration support retains original minecart IDs and still rejects unknown entities', () => {
  const plan = {
    version: '1.21.4',
    origin: { x: 0, y: 0, z: 0 },
    sourceMin: { x: 0, y: 0, z: 0 },
    tasks: [task('stone', 0, 0, 0), task('rail', 3, 0, 0)],
    entities: [
      { regionPosition: { x: 0, y: 0, z: 0 }, data: { id: 'minecraft:armor_stand', Pos: [0.5, 1, 0.5], Rotation: [0, 0] } },
      { regionPosition: { x: 0, y: 0, z: 0 }, data: { id: 'minecraft:minecart', Pos: [3.5, 0.0625, 0.5] } }
    ]
  }
  assert.throws(() => normalizeMinecartEntities(plan), /Unsupported entity/)
  const carts = normalizeMinecartEntities(plan, { allowDecorations: true })
  assert.equal(carts.length, 1)
  assert.equal(carts[0].id, 'entity:1:minecart')
  plan.entities.push({ regionPosition: { x: 0, y: 0, z: 0 }, data: { id: 'minecraft:pig', Pos: [1.5, 1, 0.5] } })
  assert.throws(() => normalizeMinecartEntities(plan, { allowDecorations: true }), /Unsupported entity/)
})

test('explicit decoration support accepts direct Sponge entities and glowing frames', () => {
  const plan = {
    version: '1.21.4',
    origin: { x: 0, y: 0, z: 0 },
    sourceMin: { x: 0, y: 0, z: 0 },
    tasks: [],
    entities: [{ id: 'minecraft:armor_stand', Pos: [0.5, 1, 0.5] }, { regionPosition: { x: 0, y: 0, z: 0 }, data: { id: 'minecraft:glow_item_frame', Pos: [2.5, 1.5, 0.03125], Facing: 2 } }]
  }
  assert.deepEqual(normalizeMinecartEntities(plan, { allowDecorations: true }), [])
})

test('projects negative-size region entities from Position and associates the physical rail layer', () => {
  const plan = {
    version: '1.21.4',
    origin: { x: 0, y: -60, z: 0 },
    sourceMin: { x: -27, y: -5, z: -26 },
    tasks: [task('powered_rail', 10, -43, 43, { shape: 'ascending_east' }), task('powered_rail', 44, -43, 9, { shape: 'ascending_south' })],
    entities: [
      { regionPosition: { x: -18, y: 17, z: 16 }, regionMin: { x: -18, y: 10, z: 16 }, data: { id: 'minecraft:hopper_minecart', Pos: [1.4275, -4.51, 1.5], Items: [] } },
      { regionPosition: { x: 16, y: 10, z: -14 }, regionMin: { x: 16, y: 10, z: -18 }, data: { id: 'minecraft:hopper_minecart', Pos: [1.5, 2.49, -2.5725], Items: [] } }
    ]
  }
  const entities = normalizeMinecartEntities(plan)
  assert.ok(entities[0].pos.distanceTo(new Vec3(10.4275, -42.51, 43.5)) < 1e-9)
  assert.deepEqual(entities[0].railPos, new Vec3(10, -43, 43))
  assert.equal(entities[0].layer, -43)
  assert.equal(entities[0].railLayer, -43)
  assert.ok(entities[1].pos.distanceTo(new Vec3(44.5, -42.51, 9.4275)) < 1e-9)
  assert.deepEqual(entities[1].railPos, new Vec3(44, -43, 9))
  delete plan.entities[0].regionPosition
  assert.throws(() => normalizeMinecartEntities(plan), /regionPosition/)
})

test('defers cannon minecarts until all blueprint blocks intersecting their bodies are built', () => {
  const plan = {
    version: '1.21.4',
    origin: { x: 0, y: 0, z: 0 },
    sourceMin: { x: 0, y: 0, z: 0 },
    tasks: [
      task('powered_rail', 74, -43, 43, { shape: 'ascending_east', waterlogged: true }),
      task('white_concrete', 73, -43, 43), task('obsidian', 74, -42, 43),
      task('powered_rail', 76, -56, 38, { shape: 'ascending_north', powered: true }),
      task('dispenser', 76, -55, 38, { facing: 'down' }),
      task('activator_rail', 76, -51, 39, { shape: 'ascending_east', powered: true }),
      task('hopper', 77, -51, 39, { facing: 'down' }),
      task('iron_trapdoor', 76, -50, 39, { facing: 'east', half: 'top', powered: true, open: true }),
      task('powered_rail', 108, -43, 9, { shape: 'ascending_south', waterlogged: true }),
      task('white_concrete', 108, -43, 8), task('obsidian', 108, -42, 9)
    ],
    entities: [
      { id: 'minecraft:hopper_minecart', Pos: [74.42750000953674, -42.50999999046326, 43.5], Items: [] },
      { id: 'minecraft:chest_minecart', Pos: [76.5, -55.44749999046326, 38.50999999046326], Items: [] },
      { id: 'minecraft:hopper_minecart', Pos: [76.67750000953674, -50.25999999046326, 39.5], Items: [], Enabled: 0 },
      { id: 'minecraft:hopper_minecart', Pos: [108.5, -42.50999999046326, 9.427500009536743], Items: [] }
    ].map(data => ({ regionPosition: { x: 0, y: 0, z: 0 }, data }))
  }
  const entities = normalizeMinecartEntities(plan)
  assert.deepEqual(entities.map(entity => entity.railLayer), [-43, -56, -51, -43])
  assert.deepEqual(entities.map(entity => entity.layer), [-42, -55, -50, -42])
  assert.deepEqual(entities.map(entity => entity.supportLayer), [-44, -57, -52, -44])
  assert.deepEqual(entities[1].collisionTaskIds, ['76,-55,38'])
  assert.deepEqual(entities[2].collisionTaskIds, ['77,-51,39', '76,-50,39'])
  assert.deepEqual(entities[2].spawnPos, new Vec3(76.5, -50.4375, 39.5))
})

test('minecart scheduling uses collision shapes and excludes touching or noncolliding blocks', () => {
  const plan = {
    version: '1.21.4',
    origin: { x: 0, y: 0, z: 0 },
    sourceMin: { x: 0, y: 0, z: 0 },
    tasks: [task('powered_rail', 0, 0, 0, { shape: 'ascending_east' }), task('stone_slab', 0, 1, 0, { type: 'top' }), task('obsidian', 1, 1, 0)],
    entities: [{ regionPosition: { x: 0, y: 0, z: 0 }, data: { id: 'minecraft:minecart', Pos: [0.51, 0.5, 0.5] } }]
  }
  assert.equal(normalizeMinecartEntities(plan)[0].layer, 0)
  plan.tasks[1] = task('stone_slab', 0, 1, 0, { type: 'bottom' })
  assert.equal(normalizeMinecartEntities(plan)[0].layer, 1)
  plan.tasks[1] = task('water', 0, 1, 0)
  assert.equal(normalizeMinecartEntities(plan)[0].layer, 0)
})

test('enclosed carts that would require temporary rail flattening are explicitly unsupported', () => {
  const rail = task('powered_rail', 74, -43, 43, { shape: 'ascending_east', waterlogged: true })
  const plan = {
    version: '1.21.4',
    origin: { x: 0, y: 0, z: 0 },
    sourceMin: { x: 0, y: 0, z: 0 },
    tasks: [rail, task('obsidian', 74, -42, 43), task('dispenser', 74, -44, 43), ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => task('white_concrete', 74 + x, -43, 43 + z))],
    entities: [{ regionPosition: { x: 0, y: 0, z: 0 }, data: { id: 'minecraft:hopper_minecart', Pos: [74.4275, -42.51, 43.5], Items: [] } }]
  }
  assert.equal(normalizeMinecartEntities(plan)[0].layer, -42)
  assert.throws(() => normalizeMinecartEntities(plan, { frozen: true }), /Unsupported frozen minecart staging/)
  const open = { ...plan, tasks: plan.tasks.filter(t => t.id !== '75,-43,43') }
  assert.equal(normalizeMinecartEntities(open, { frozen: true })[0].stagedStrategy, undefined)
})

function stagedCartFixture () {
  const Block = require('prismarine-block')('1.21.4')
  const rail = task('powered_rail', 0, 0, 0, { shape: 'ascending_east' })
  const flat = task('powered_rail', 0, 0, 0, { shape: 'east_west' })
  const entity = {
    id: 'staged-cart',
    name: 'hopper_minecart',
    pos: new Vec3(0.4275, 0.49, 0.5),
    rail,
    railPos: rail.pos,
    stagedStrategy: { type: 'frozen-flat-rail', flatState: flat.state, restoreState: rail.state, flatPos: new Vec3(0.5, 0.0625, 0.5), capLayer: 1, height: 0.7 }
  }
  const calls = []
  let current = Block.fromStateId(rail.state, 0)
  const bot = {
    version: '1.21.4',
    entity: { position: new Vec3(0.5, 1.2, 0.5), eyeHeight: 1.62 },
    entities: {},
    world: { raycast: () => null },
    blockAt: () => current,
    inventory: { slots: Array(46).fill(null) },
    quickBarSlot: 0,
    creative: { setInventorySlot: async () => {} },
    setQuickBarSlot: () => {},
    setControlState: () => {},
    activateBlock: async () => {
      calls.push('spawn')
      assert.equal(current.getProperties().shape, 'east_west')
      bot.entities[30] = { id: 30, name: entity.name, position: entity.stagedStrategy.flatPos.clone() }
    }
  }
  const executor = {
    reach: async () => {},
    adjustRail: async (_task, wanted) => {
      calls.push(wanted.getProperties().shape)
      current = wanted
      return true
    }
  }
  const assertFrozen = async () => {
    calls.push('frozen')
    return { frozen: true, quiescent: true }
  }
  return { bot, entity, executor, assertFrozen, calls }
}

test('staged minecarts are rejected before freeze reads, rail changes or entity placement', async () => {
  const fixture = stagedCartFixture()
  const events = []
  await assert.rejects(placeMinecart(fixture.bot, fixture.entity, { ...fixture, onEvent: event => events.push(event) }), /Unsupported frozen minecart staging/)
  assert.deepEqual(fixture.calls, [])
  assert.equal(Object.keys(fixture.bot.entities).length, 0)
  assert.equal(fixture.bot.blockAt(fixture.entity.railPos).getProperties().shape, 'ascending_east')
  assert.deepEqual(events, [])
})

test('unrecognized staged strategies cannot fall back to minecart placement', async () => {
  const fixture = stagedCartFixture()
  fixture.entity.stagedStrategy = { type: 'unknown' }
  await assert.rejects(placeMinecart(fixture.bot, fixture.entity, fixture), /Unsupported frozen minecart staging/)
  assert.deepEqual(fixture.calls, [])
  assert.equal(Object.keys(fixture.bot.entities).length, 0)
})

test('historical staged carts are rejected without restoring a remaining flat rail', async () => {
  const fixture = stagedCartFixture()
  const Block = require('prismarine-block')('1.21.4')
  await fixture.executor.adjustRail(fixture.entity.rail, Block.fromStateId(fixture.entity.stagedStrategy.flatState, 0))
  fixture.calls.length = 0
  fixture.bot.entities[30] = { id: 30, name: fixture.entity.name, position: fixture.entity.stagedStrategy.flatPos.clone() }
  const claimedIds = new Set()
  await assert.rejects(placeMinecart(fixture.bot, fixture.entity, { ...fixture, claimedIds }), /Unsupported frozen minecart staging/)
  assert.deepEqual(fixture.calls, [])
  assert.equal(fixture.bot.blockAt(fixture.entity.railPos).getProperties().shape, 'east_west')
  assert.equal(claimedIds.size, 0)
})

test('cancellation precedes staged minecart rejection and performs no operation', async () => {
  const fixture = stagedCartFixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(placeMinecart(fixture.bot, fixture.entity, {
    executor: fixture.executor,
    signal: controller.signal,
    assertFrozen: fixture.assertFrozen
  }), { name: 'AbortError' })
  assert.deepEqual(fixture.calls, [])
  assert.equal(Object.keys(fixture.bot.entities).length, 0)
})

test('does not silently drop unknown entity types or container payloads', () => {
  const plan = { version: '1.21.4', origin: { x: 0, y: 0, z: 0 }, sourceMin: { x: 0, y: 0, z: 0 }, tasks: [], entities: [{ regionPosition: { x: 0, y: 0, z: 0 }, data: { id: 'minecraft:armor_stand', Pos: [0, 0, 0] } }] }
  assert.throws(() => normalizeMinecartEntities(plan), /Unsupported entity/)
  plan.entities[0].data = { id: 'minecraft:hopper_minecart', Pos: [0.5, 0.0625, 0.5], Items: [{ id: 'minecraft:stone', count: 1, Slot: 0 }] }
  assert.throws(() => normalizeMinecartEntities(plan), /inventory/)
})

function portalPlan (axis = 'x', offset = 0) {
  const tasks = []
  const add = (name, u, y) => tasks.push(axis === 'x' ? task(name, u + offset, y, 0, name === 'nether_portal' ? { axis } : {}) : task(name, offset, y, u, name === 'nether_portal' ? { axis } : {}))
  for (let u = 1; u <= 2; u++) {
    add('obsidian', u, 0)
    add('obsidian', u, 4)
    for (let y = 1; y <= 3; y++) add('nether_portal', u, y)
  }
  for (let y = 1; y <= 3; y++) { add('obsidian', 0, y); add('obsidian', 3, y) }
  return { version: '1.21.4', tasks }
}

test('finds both portal planes and excludes optional corners from the required frame', () => {
  const x = portalPlan()
  const z = portalPlan('z', 10)
  const frames = findPortalFrames({ version: '1.21.4', tasks: [...x.tasks, ...z.tasks] })
  assert.equal(frames.length, 2)
  assert.deepEqual(frames.map(f => f.positions.length), [6, 6])
  assert.deepEqual(frames.map(f => f.frame.length), [10, 10])
  assert.deepEqual(frames[0].bottom[0], new Vec3(1, 0, 0))
  assert.equal(frames[0].layer, 4)
})

test('rejects nonrectangular portal targets and missing upper frame before ignition', () => {
  const plan = portalPlan()
  assert.throws(() => findPortalFrames({ ...plan, tasks: plan.tasks.filter(t => t.id !== '1,2,0') }), /rectangle/)
  assert.throws(() => findPortalFrames({ ...plan, tasks: plan.tasks.filter(t => t.id !== '1,4,0') }), /obsidian/)
  const frame = findPortalFrames(plan)[0]
  const map = new Map(plan.tasks.map(t => [t.id, { name: t.name === 'nether_portal' ? 'air' : t.name }]))
  assertPortalFrame({ blockAt: p => map.get(`${p.x},${p.y},${p.z}`) }, frame)
  map.set('1,4,0', { name: 'air' })
  assert.throws(() => assertPortalFrame({ blockAt: p => map.get(`${p.x},${p.y},${p.z}`) }, frame), /Incomplete obsidian/)
  map.set('1,4,0', { name: 'obsidian' })
  map.set('1,1,0', { name: 'tnt' })
  assert.throws(() => assertPortalFrame({ blockAt: p => map.get(`${p.x},${p.y},${p.z}`) }, frame), /obstructed/)
})

test('refuses minecart placement on absent rails or after cancellation', async () => {
  const entity = { name: 'hopper_minecart', pos: new Vec3(0.5, 0.0625, 0.5), railPos: new Vec3(0, 0, 0), rail: task('rail', 0, 0, 0), id: 'cart' }
  const bot = { entities: {}, version: '1.21.4', blockAt: () => ({ name: 'air' }) }
  await assert.rejects(placeMinecart(bot, entity), /rail/)
  await assert.rejects(placeMinecart(bot, entity, { signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('capped ascending rails receive minecarts through an exposed side without changing the cap', async () => {
  const WorldSync = require('prismarine-world/src/worldsync')
  const Block = require('prismarine-block')('1.21.4')
  for (const [x, z, shape] of [[74, 43, 'ascending_east'], [108, 9, 'ascending_south']]) {
    const rail = task('powered_rail', x, -43, z, { shape, waterlogged: true })
    const cap = task('obsidian', x, -42, z)
    const blocks = new Map([rail, cap].map(task => [task.id, task]))
    const blockAt = pos => {
      const position = pos.floored()
      const task = blocks.get(`${position.x},${position.y},${position.z}`)
      const block = task ? Block.fromStateId(task.state, 0) : resolveState('air', {}, '1.21.4')
      block.position = position
      return block
    }
    const entity = { id: `capped:${x}`, name: 'hopper_minecart', pos: rail.pos.offset(0.5, 0.5625, 0.5), railPos: rail.pos, rail }
    const world = { getBlock: blockAt, raycast: WorldSync.prototype.raycast }
    const eye = rail.pos.offset(2.5, 0.3125, 0.5)
    const clicks = []
    const bot = {
      version: '1.21.4',
      world,
      blockAt,
      entities: {},
      entity: { position: eye.offset(0, -1.62, 0), eyeHeight: 1.62 },
      inventory: { slots: Array(46).fill(null) },
      quickBarSlot: 0,
      creative: { setInventorySlot: async () => {} },
      setQuickBarSlot: () => {},
      setControlState: () => {},
      activateBlock: async (block, face, delta) => {
        assert.equal(block.name, 'powered_rail')
        assert.deepEqual(face, new Vec3(1, 0, 0))
        assert.deepEqual(delta, new Vec3(1, 0.3125, 0.5))
        clicks.push({ face, delta })
        bot.entities[20] = { id: 20, name: entity.name, position: entity.pos.clone() }
      }
    }
    const executor = { reach: async goal => assert.ok(goal.getFaceAndRef(eye), 'the side eye must see the rail below the cap') }
    const result = await placeMinecart(bot, entity, { executor })
    assert.equal(result.entityId, 20)
    assert.equal(clicks.length, 1)
    assert.equal(blockAt(cap.pos).name, 'obsidian')
    const obstruction = task('stone', x + 1, -43, z)
    blocks.set(obstruction.id, obstruction)
    bot.entities = {}
    executor.reach = async goal => assert.equal(goal.getFaceAndRef(eye), null)
    await assert.rejects(placeMinecart(bot, entity, { executor }), /No unobstructed reachable rail face/)
    assert.equal(clicks.length, 1)
  }
})

test('rechecks existing minecarts after flying into entity tracking range', async () => {
  const rail = task('rail', 0, 0, 0)
  const entity = { name: 'hopper_minecart', pos: new Vec3(0.5, 0.0625, 0.5), railPos: rail.pos, rail, id: 'tracked-cart' }
  const bot = {
    version: '1.21.4',
    entity: { position: new Vec3(0.5, 0, 2.5), eyeHeight: 1.62 },
    world: { raycast: () => null },
    entities: {},
    blockAt: () => ({ name: 'rail', getProperties: () => ({ shape: 'north_south' }) })
  }
  const executor = { async reach () { bot.entities[12] = { id: 12, name: 'hopper_minecart', position: new Vec3(0.5, 0.0625, 0.5) } } }
  const result = await placeMinecart(bot, entity, { executor })
  assert.equal(result.reused, true)
  assert.equal(result.entityId, 12)
})

test('placement cannot claim the same observed minecart for two blueprint entities', async () => {
  const rail = task('rail', 0, 0, 0)
  const entity = { name: 'hopper_minecart', pos: new Vec3(0.5, 0.0625, 0.5), railPos: rail.pos, rail, id: 'first' }
  const bot = {
    entity: { position: new Vec3(0.5, 0, 2.5) },
    world: { raycast: () => null },
    entities: { 7: { id: 7, name: entity.name, position: entity.pos.clone() } },
    blockAt: () => ({ name: 'rail', getProperties: () => ({ shape: 'north_south' }) })
  }
  const claimedIds = new Set()
  assert.equal((await placeMinecart(bot, entity, { claimedIds })).entityId, 7)
  assert.equal(claimedIds.has(7), true)
  await assert.rejects(placeMinecart(bot, { ...entity, id: 'second' }, { claimedIds }), /already claimed/)
})

test('final verification flies into tracking range and rejects an entity removed after placement', async () => {
  const expected = { id: 'cart', name: 'hopper_minecart', pos: new Vec3(80.5, 0.0625, 0.5), railPos: new Vec3(80, 0, 0) }
  const observed = { id: 7, name: expected.name, position: expected.pos.clone() }
  const bot = { entity: { position: new Vec3(0, 0, 0) }, entities: {} }
  let moves = 0
  const executor = {
    pathing: { positionClear: () => true, findFlightPath: (from, to) => [to.clone()] },
    async move (point) {
      assert.ok(bot.entity.position.distanceTo(point) <= 8.001)
      moves++
      bot.entity.position = point.clone()
    },
    async reach () {
      assert.ok(bot.entity.position.distanceTo(expected.pos) < 16)
      bot.entities[7] = observed
    }
  }
  const workers = [{ id: 'builder00', bot, executor }]
  const result = await verifyMinecarts(workers, [expected])
  assert.equal(result.verified, true)
  assert.equal(result.entities, 1)
  assert.equal(result.matches[0].entityId, 7)
  assert.ok(moves > 0)
  delete bot.entities[7]
  executor.reach = async () => {}
  await assert.rejects(verifyMinecarts(workers, [expected]), /Missing minecart/)
})

test('minecart interaction descends fifty blocks through bounded flight segments before reaching the rail', async () => {
  const rail = task('rail', 0, 0, 0)
  const entity = { name: 'hopper_minecart', pos: new Vec3(0.5, 0.0625, 0.5), railPos: rail.pos, rail, id: 'low-cart' }
  const bot = {
    entity: { position: new Vec3(0.5, 50, 2.5), eyeHeight: 1.62 },
    world: { raycast: () => null },
    entities: {},
    blockAt: () => ({ name: 'rail', getProperties: () => ({ shape: 'north_south' }) })
  }
  let moves = 0
  const executor = {
    pathing: { positionClear: () => true, findFlightPath: (from, to) => [to.clone()] },
    async move (point) {
      assert.ok(bot.entity.position.distanceTo(point) <= 8.001)
      bot.entity.position = point.clone()
      moves++
    },
    async reach (goal) {
      assert.ok(goal.getFaceAndRef(bot.entity.position.offset(0, 1.62, 0)))
      bot.entities[12] = { id: 12, name: entity.name, position: entity.pos.clone() }
    }
  }
  assert.equal((await placeMinecart(bot, entity, { executor })).entityId, 12)
  assert.ok(moves >= 6)
})

test('final matching uses unique IDs and resolves overlapping target tolerances', async () => {
  const targets = [
    { id: 'first', name: 'minecart', pos: new Vec3(0, 0, 0), railPos: new Vec3(0, 0, 0) },
    { id: 'second', name: 'minecart', pos: new Vec3(1, 0, 0), railPos: new Vec3(1, 0, 0) }
  ]
  const bot = { entity: { position: new Vec3(0, 2, 2) }, entities: { 7: { id: 7, name: 'minecart', position: new Vec3(0.5, 0, 0) } } }
  await assert.rejects(verifyMinecarts([{ bot }], targets), /unique/)
  bot.entities[8] = { id: 8, name: 'minecart', position: new Vec3(-0.5, 0, 0) }
  const result = await verifyMinecarts([{ bot }], targets)
  assert.deepEqual(result.matches.map(match => match.entityId), [8, 7])
  await assert.rejects(verifyMinecarts([{ bot }], targets, { signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('final verification does not accept stale distant entity caches without a flight executor', async () => {
  const expected = { id: 'distant', name: 'minecart', pos: new Vec3(80, 0, 0), railPos: new Vec3(80, 0, 0) }
  const bot = { entity: { position: new Vec3(0, 0, 0) }, entities: { 7: { id: 7, name: 'minecart', position: expected.pos.clone() } } }
  await assert.rejects(verifyMinecarts([{ bot }], [expected]), /tracking range/)
})
