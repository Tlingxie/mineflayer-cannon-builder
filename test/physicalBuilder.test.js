const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const Block = require('prismarine-block')('1.21.4')
const registry = require('minecraft-data')('1.21.4')
const Build = require('../lib/Build')

function fixture (name = 'stone', properties = {}) {
  const { PhysicalBuilder } = require('../lib/physicalBuilder')
  const wanted = Block.fromProperties(name, properties, 0)
  const pos = new Vec3(0, 5, 0)
  const cells = new Map()
  const events = []
  const bot = new EventEmitter()
  function block (name, p, props = {}) {
    const b = Block.fromProperties(name, props, 0)
    b.position = p.clone()
    return b
  }
  bot.registry = registry
  bot.version = '1.21.4'
  bot.entity = { id: 1, position: new Vec3(2.5, 5.1, 0.5), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62, yaw: 0, pitch: 0 }
  bot.entities = {}
  bot._client = new EventEmitter()
  bot._client.ended = false
  bot._client.write = (name, packet) => events.push(['packet', name, packet.actionId])
  bot.blockAt = p => cells.get(p.toString()) || block('air', p)
  bot.world = { getBlock: bot.blockAt, raycast: () => null }
  bot.inventory = { slots: Array(46).fill(null) }
  bot.creative = {
    startFlying: () => events.push('fly'),
    setInventorySlot: async (slot, item) => { bot.inventory.slots[slot] = item }
  }
  bot.setQuickBarSlot = slot => { bot.heldItem = bot.inventory.slots[36 + slot] }
  bot.controlState = { sneak: false }
  bot.setControlState = (name, state) => { bot.controlState[name] = state }
  bot.lookAt = async (p, force) => {
    const ray = p.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    bot.entity.yaw = Math.atan2(-ray.x, -ray.z)
    bot.entity.pitch = Math.atan2(ray.y, Math.hypot(ray.x, ray.z))
    events.push(['look', force])
    setImmediate(() => { events.push('physics'); bot.emit('physicsTick') })
  }
  bot._genericPlace = async (ref, face, options) => {
    events.push(['place', ref.position.plus(face).toString(), options.forceLook])
    cells.set(pos.toString(), block(name, pos, properties))
  }
  bot.dig = async b => {
    events.push(['dig', b.position.toString()])
    cells.delete(b.position.toString())
    bot._client.emit('block_change', { location: b.position, type: 0 })
  }
  bot.stopDigging = () => events.push('stop-dig')
  const build = {
    verifyFluidRay: async blocks => ({ verified: true, checked: blocks.length }),
    useBlockStateComponents: false,
    blocks: { [wanted.stateId]: wanted },
    properties: { [wanted.stateId]: wanted.getProperties() },
    getTargetBlock: () => wanted,
    getPossibleDirections: Build.prototype.getPossibleDirections,
    getFacing: Build.prototype.getFacing,
    canInteractToMatch: () => false,
    world: bot.world
  }
  const executor = new PhysicalBuilder(bot, build)
  return { bot, build, executor, wanted, pos, cells, events, block, task: { id: 'target', type: 'place', pos, state: wanted.stateId } }
}

function waterloggedSlabFixture ({ existing, acknowledge = true, multi = false } = {}) {
  const f = fixture('cobblestone_slab', { type: 'top', waterlogged: true })
  f.executor.useStateComponents = true
  f.bot.entity.position = f.pos.offset(0.5, 1.3, 0.5)
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  f.cells.set(f.pos.offset(0, -1, 0).toString(), f.block('stone', f.pos.offset(0, -1, 0)))
  f.cells.set(f.pos.offset(-1, 0, 0).toString(), f.block('stone', f.pos.offset(-1, 0, 0)))
  if (existing !== undefined) f.cells.set(f.pos.toString(), f.block('cobblestone_slab', f.pos, { type: 'top', waterlogged: existing }))
  f.executor.report = event => { if (event.state === 'placing') f.events.push(['audit', event]) }
  f.ack = () => {
    if (multi) f.bot._client.emit('multi_block_change', { chunkCoordinates: { x: 0, y: 0, z: 0 }, records: [f.wanted.stateId * 4096 + 5] })
    else f.bot._client.emit('block_change', { location: f.pos, type: f.wanted.stateId })
  }
  f.bot._genericPlace = async () => {
    const properties = Object.fromEntries(f.bot.heldItem.components.find(component => component.type === 'block_state').data.properties.map(({ name, value }) => [name, value]))
    f.events.push(['slab', properties])
    const actual = f.block('cobblestone_slab', f.pos, properties)
    f.cells.set(f.pos.toString(), actual)
    f.bot._client.emit('block_change', { location: f.pos, type: actual.stateId })
  }
  f.bot.activateItem = () => {
    f.events.push(['bucket', f.bot.heldItem.name])
    f.cells.set(f.pos.toString(), f.block('cobblestone_slab', f.pos, { type: 'top', waterlogged: true }))
    if (acknowledge) f.ack()
    f.bot.emit('test-bucket')
  }
  return f
}

test('creative banner inventory distinguishes ordered pattern components', async () => {
  const f = fixture('black_banner', { rotation: 0 })
  const { bannerItemComponents } = require('../lib/physicalBanners')
  const components = bannerItemComponents({ name: 'black_banner', blockEntity: { Patterns: [{ Pattern: 'bo', Color: 0 }] } })
  await f.executor.equip('black_banner', undefined, {}, components)
  assert.deepEqual(f.bot.heldItem.components, components)
  await f.executor.equip('black_banner')
  assert.equal(f.bot.heldItem.components.some(component => component.type === 'banner_patterns'), false)
})

test('standing banners and signs only use floor clicks to select their standing block variant', () => {
  for (const name of ['light_gray_banner', 'oak_sign']) {
    const f = fixture(name, { rotation: 13 })
    f.executor.useStateComponents = true
    for (const delta of [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(0, 0, 1)]) {
      const pos = f.pos.plus(delta)
      f.cells.set(pos.toString(), f.block('stone', pos))
    }
    const goal = f.executor.makeGoal(f.task)
    assert.ok(goal.facesPos.length)
    assert.ok(goal.facesPos.every(([, , ref]) => ref.equals(f.pos.offset(0, -1, 0))), name)
  }
})

test('banner selection outlines permit ordinary correction of incorrectly wall-placed banners', () => {
  const f = fixture('light_gray_banner', { rotation: 13 })
  const wrong = f.block('light_gray_wall_banner', f.pos, { facing: 'north' })
  assert.deepEqual(f.executor.selectionShapes(wrong), [[0, 0, 14 / 16, 1, 12.5 / 16, 1]])
  assert.deepEqual(f.executor.selectionShapes(f.wanted), [[4 / 16, 0, 4 / 16, 12 / 16, 1, 12 / 16]])
})

test('state-controlled bottom slabs can use the lower floor instead of requiring a side neighbour', () => {
  const f = fixture('smooth_quartz_slab', { type: 'bottom', waterlogged: false })
  f.executor.useStateComponents = true
  const below = f.pos.offset(0, -1, 0)
  f.cells.set(below.toString(), f.block('stone', below))
  const goal = f.executor.makeGoal(f.task)
  assert.ok(goal.facesPos.some(([, , ref]) => ref.equals(below)))
})

test('same-layer matching slabs use the occupied side half without merging the reference', () => {
  const f = fixture('birch_slab', { type: 'bottom', waterlogged: false })
  f.executor.useStateComponents = true
  const side = f.pos.offset(-1, 0, 0)
  f.cells.set(side.toString(), f.block('birch_slab', side, { type: 'bottom', waterlogged: false }))
  const faces = f.executor.makeGoal(f.task).facesPos.filter(([, , ref]) => ref.equals(side))
  assert.ok(faces.length)
  assert.ok(faces.every(([, point]) => point.y < f.pos.y + 0.5))
  assert.equal(f.executor.safeReference(f.bot.blockAt(side), f.wanted), false)
})

test('state-controlled end rods can be placed on the floor independently of their final orientation', () => {
  const f = fixture('end_rod', { facing: 'west' })
  f.executor.useStateComponents = true
  const below = f.pos.offset(0, -1, 0)
  f.cells.set(below.toString(), f.block('stone', below))
  assert.ok(f.executor.makeGoal(f.task).facesPos.some(([, , ref]) => ref.equals(below)))
})

test('state-controlled ceiling levers may start from a supported floor without placing a future ceiling', () => {
  const f = fixture('lever', { face: 'ceiling', facing: 'north', powered: false })
  f.executor.useStateComponents = true
  const below = f.pos.offset(0, -1, 0)
  f.cells.set(below.toString(), f.block('stone', below))
  assert.ok(f.executor.makeGoal(f.task).facesPos.some(([, , ref]) => ref.equals(below)))
})

test('a controlled ceiling lever ignores partial side references and clicks its full temporary support', () => {
  const f = fixture('lever', { face: 'ceiling', facing: 'north', powered: false })
  f.executor.useStateComponents = true
  const rod = f.pos.offset(-1, 0, 0)
  const stair = f.pos.offset(1, 0, 0)
  const support = f.pos.offset(0, 0, 1)
  f.cells.set(rod.toString(), f.block('end_rod', rod, { facing: 'up' }))
  f.cells.set(stair.toString(), f.block('quartz_stairs', stair, { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false }))
  f.cells.set(support.toString(), f.block('dirt', support))
  const leaves = f.pos.offset(0, 0, -1)
  f.cells.set(leaves.toString(), f.block('oak_leaves', leaves, { persistent: true, distance: 1, waterlogged: false }))
  const faces = f.executor.makeGoal(f.task).facesPos
  assert.ok(faces.length)
  assert.ok(faces.every(([, , ref]) => ref.equals(support)))
})

test('pressure plates and signs expose their vanilla selectable outline despite empty collision', () => {
  const f = fixture()
  assert.deepEqual(f.executor.selectionShapes(f.block('heavy_weighted_pressure_plate', f.pos, { power: 1 })), [[1 / 16, 0, 1 / 16, 15 / 16, 0.5 / 16, 15 / 16]])
  assert.deepEqual(f.executor.selectionShapes(f.block('stone_pressure_plate', f.pos, { powered: false })), [[1 / 16, 0, 1 / 16, 15 / 16, 1 / 16, 15 / 16]])
  assert.deepEqual(f.executor.selectionShapes(f.block('cherry_wall_sign', f.pos, { facing: 'north', waterlogged: false })), [[0, 4.5 / 16, 14 / 16, 1, 12.5 / 16, 1]])
})

test('placing against a planted pot sneaks so it cannot remove a plant from a completed lower layer', async () => {
  const f = fixture('flowering_azalea_leaves', { persistent: true, distance: 1, waterlogged: false })
  f.executor.useStateComponents = true
  const below = f.pos.offset(0, -1, 0)
  f.cells.set(below.toString(), f.block('potted_bamboo', below))
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  f.bot.entity.position = f.pos.offset(0.5, 1.1, 2.5)
  const place = f.bot._genericPlace
  f.bot._genericPlace = async (...args) => {
    assert.equal(f.bot.controlState.sneak, true)
    await place(...args)
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(f.bot.blockAt(below).name, 'potted_bamboo')
  assert.equal(f.bot.controlState.sneak, false)
})

test('cake and sign reference interactions are bypassed while placing a block', async () => {
  for (const name of ['cake', 'cherry_wall_sign']) {
    const f = fixture('stone')
    const below = f.pos.offset(0, -1, 0)
    f.cells.set(below.toString(), f.block(name, below))
    f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
    f.bot.entity.position = f.pos.offset(0.5, 1.1, 2.5)
    const place = f.bot._genericPlace
    f.bot._genericPlace = async (...args) => {
      assert.equal(f.bot.controlState.sneak, true, name)
      await place(...args)
    }
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(f.bot.blockAt(below).name, name)
  }
})

test('waterlogged top slabs are dry-placed then filled by an audited water bucket in the same layer', async () => {
  const f = waterloggedSlabFixture()
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.deepEqual(f.events.filter(event => ['slab', 'bucket'].includes(event[0])), [
    ['slab', { type: 'top', waterlogged: 'false' }], ['bucket', 'water_bucket']
  ])
  const audits = f.events.filter(event => event[0] === 'audit').map(event => event[1])
  assert.equal(audits.length, 2)
  assert.ok(audits.every(event => event.pos.equals(f.pos)))
  assert.deepEqual(audits.map(event => event.useItem), [false, true])
  assert.ok(audits[1].referencePos.equals(f.pos))
  assert.equal(audits[1].face, 1)
  assert.ok(f.events.findIndex(event => event[0] === 'audit' && event[1].useItem) < f.events.findIndex(event => event[0] === 'bucket'))
  assert.equal(f.bot.controlState.sneak, false)
})

test('existing dry top slabs receive only water and section packet acknowledgement completes them', async () => {
  const f = waterloggedSlabFixture({ existing: false, multi: true })
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.deepEqual(f.events.filter(event => ['slab', 'bucket', 'dig'].includes(event[0])), [['bucket', 'water_bucket']])
  assert.equal(f.executor.satisfied(f.task), true)
})

test('already waterlogged target slabs are never refilled or replaced', async () => {
  const f = waterloggedSlabFixture({ existing: true })
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.deepEqual(f.events, [])
  await assert.rejects(f.executor.perform(f.task, { layer: 6 }), /outside the active layer/)
  assert.deepEqual(f.events, [])
})

test('waterlogging waits for a fresh server acknowledgement after the bucket, not an optimistic cache value', async () => {
  const f = waterloggedSlabFixture({ existing: false, acknowledge: false })
  f.ack()
  let completed = false
  const sent = new Promise(resolve => f.bot.once('test-bucket', resolve))
  const result = f.executor.perform(f.task, { layer: 5 }).then(value => { completed = true; return value })
  await Promise.race([sent, result])
  assert.ok(f.events.some(event => event[0] === 'bucket'))
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(completed, false)
  assert.equal(f.executor.satisfied(f.task), false)
  f.ack()
  assert.equal(await result, true)
})

test('cancelled unacknowledged waterlogging cannot be replayed onto a cached wet slab', async () => {
  const f = waterloggedSlabFixture({ existing: false, acknowledge: false })
  const controller = new AbortController()
  const activate = f.bot.activateItem
  f.bot.activateItem = () => { activate(); controller.abort() }
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { code: 'FLUID_OUTCOME_UNKNOWN' })
  assert.equal(f.executor.satisfied(f.task), false)
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), { code: 'FLUID_OUTCOME_UNKNOWN' })
  assert.equal(f.events.filter(event => event[0] === 'bucket').length, 1)
})

test('waterlogging layer audits can reject either dry placement or the subsequent bucket', async () => {
  for (const rejectBucket of [false, true]) {
    const f = waterloggedSlabFixture()
    f.executor.report = event => {
      if (event.state === 'placing' && event.useItem === rejectBucket) throw new Error('Layer audit rejected waterlogging')
    }
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Layer audit rejected/)
    assert.equal(f.events.filter(event => event[0] === 'slab').length, rejectBucket ? 1 : 0)
    assert.equal(f.events.filter(event => event[0] === 'bucket').length, 0)
  }
})

test('cancellation while equipping the water bucket sends no fill packet', async () => {
  const f = waterloggedSlabFixture({ existing: false })
  const controller = new AbortController()
  f.bot.creative.setInventorySlot = async () => controller.abort()
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.events.some(event => ['bucket', 'slab', 'dig'].includes(event[0])), false)
})

test('waterlogging rejects a final ray that misses the slab top and never places adjacent water', async () => {
  for (const face of [null, 4]) {
    const f = waterloggedSlabFixture({ existing: false })
    const orient = f.executor.orient.bind(f.executor)
    f.executor.orient = async (...args) => {
      await orient(...args)
      f.executor.selectionRaycast = () => face === null ? null : { position: f.pos, face }
    }
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Waterlogging aiming ray/)
    assert.equal(f.events.some(event => event[0] === 'bucket'), false)
  }
})

test('rejects tasks outside the active layer before modifying the world', async () => {
  const f = fixture()
  await assert.rejects(f.executor.perform(f.task, { layer: 4 }), /layer/i)
  assert.deepEqual(f.events, [])
})

test('rejects cancelled tasks before equipping, moving, or placing', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(f.events, [])
})

test('rejects unsupported two-block plants and independent bed heads', async () => {
  for (const name of ['tall_grass', 'red_bed']) {
    const f = fixture(name, name === 'red_bed' ? { part: 'head' } : {})
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /multi.block/i)
    assert.deepEqual(f.events, [])
  }
})

test('bed foot placement uses the floor and permits its matching head in the same layer', async () => {
  const f = fixture('red_bed', { part: 'foot', facing: 'north', occupied: false })
  f.executor.useStateComponents = true
  const below = f.pos.offset(0, -1, 0)
  f.cells.set(below.toString(), f.block('stone', below))
  f.cells.set(f.pos.offset(0, -1, -1).toString(), f.block('stone', f.pos.offset(0, -1, -1)))
  f.bot.entity.position = f.pos.offset(0.5, 1.2, 2.5)
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  const goal = f.executor.makeGoal(f.task)
  assert.ok(goal.facesPos.every(([, , ref]) => ref.y === below.y))
  const place = f.bot._genericPlace
  f.bot._genericPlace = async (...args) => {
    await place(...args)
    const head = f.pos.offset(0, 0, -1)
    f.cells.set(head.toString(), f.block('red_bed', head, { part: 'head', facing: 'north', occupied: false }))
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(f.bot.blockAt(f.pos.offset(0, 0, -1)).getProperties().part, 'head')
})

test('does not create scaffolds when a placement has no support', async () => {
  const f = fixture()
  await assert.rejects(f.executor.perform(f.task, { layer: 5, attempts: 20 }), /support/i)
  assert.equal(f.events.filter(e => Array.isArray(e) && ['place', 'dig'].includes(e[0])).length, 0)
})

test('does not clear access blocks when a target is unreachable', async () => {
  const f = fixture()
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  f.executor.reach = async () => { throw new Error('No reachable face') }
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /reachable/i)
  assert.equal(f.events.filter(e => Array.isArray(e) && e[0] === 'dig').length, 0)
})

test('replaces only the assigned position and requires a state acknowledgement', async () => {
  const f = fixture()
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  f.cells.set(support.toString(), f.block('stone', support))
  f.executor.reach = async () => {}
  f.executor.makeGoal = () => ({ facesPos: [1], getFaceAndRef: () => ({ ref: support, face: new Vec3(0, -1, 0), to: support.offset(0.5, 1, 0.5) }) })
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.deepEqual(f.events.filter(e => Array.isArray(e) && ['dig', 'place'].includes(e[0])).map(e => e.slice(0, 2)), [['dig', f.pos.toString()], ['place', f.pos.toString()]])
  assert.ok(f.events.indexOf('physics') < f.events.findIndex(e => Array.isArray(e) && e[0] === 'place'))
  assert.equal(f.events.find(e => Array.isArray(e) && e[0] === 'place')[2], 'ignore')
})

test('cancellation while equipping prevents the subsequent right click', async () => {
  const f = fixture()
  const controller = new AbortController()
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('stone', support))
  f.executor.reach = async () => {}
  f.executor.makeGoal = () => ({ facesPos: [1], getFaceAndRef: () => ({ ref: support, face: new Vec3(0, -1, 0), to: support.offset(0.5, 1, 0.5) }) })
  f.bot.creative.setInventorySlot = async () => controller.abort()
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'place'), false)
})

test('cancellation interrupts incremental flight without leaving a movement loop', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.executor.pathing.findFlightPath = () => [f.bot.entity.position.offset(10, 0, 0)]
  f.executor.pathing.positionClear = () => true
  const before = f.bot.entity.position.clone()
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(f.executor.move(before.offset(10, 0, 0), controller.signal), { name: 'AbortError' })
  const stopped = f.bot.entity.position.clone()
  assert.ok(stopped.distanceTo(before) <= 0.901)
  assert.ok(f.bot.entity.velocity.equals(new Vec3(0, 0, 0)))
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.ok(f.bot.entity.position.equals(stopped))
})

test('vertical piston and observer goals use opposite viewing directions', () => {
  for (const [name, facing, rayY] of [['piston', 'up', -3], ['piston', 'down', 3], ['observer', 'up', 3], ['observer', 'down', -3]]) {
    const f = fixture(name, { facing })
    const goal = f.executor.makeGoal(f.task)
    assert.equal(goal.checkFacing(new Vec3(0.1, rayY, 0.1)), true, `${name} ${facing}`)
    assert.equal(goal.checkFacing(new Vec3(0.1, -rayY, 0.1)), false, `${name} reversed ${facing}`)
  }
})

test('repeater delay is adjusted using right clicks without replacement', async () => {
  const f = fixture('repeater', { delay: '4', facing: 'north', locked: false, powered: false })
  f.cells.set(f.pos.toString(), f.block('repeater', f.pos, { delay: '1', facing: 'north', locked: false, powered: false }))
  let clicks = 0
  f.executor.interact = async () => {
    clicks++
    f.cells.set(f.pos.toString(), f.block('repeater', f.pos, { delay: String(clicks + 1), facing: 'north', locked: false, powered: false }))
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(clicks, 3)
  assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'dig'), false)
})

test('repeater runtime power and lock differences do not prevent delay calibration', async () => {
  const f = fixture('repeater', { delay: '4', facing: 'north', locked: true, powered: true })
  f.cells.set(f.pos.toString(), f.block('repeater', f.pos, { delay: '1', facing: 'north', locked: false, powered: false }))
  let clicks = 0
  f.executor.interact = async () => {
    clicks++
    f.cells.set(f.pos.toString(), f.block('repeater', f.pos, { delay: String(clicks + 1), facing: 'north', locked: false, powered: false }))
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(clicks, 3)
  assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'dig'), false)
})

test('collision checks include tall fence shapes and the full player body', () => {
  const f = fixture()
  const fence = f.block('oak_fence', new Vec3(0, 0, 0))
  fence.shapes = [[0.375, 0, 0.375, 0.625, 1.5, 0.625]]
  f.cells.set(fence.position.toString(), fence)
  assert.equal(f.executor.pathing.positionClear(new Vec3(0.5, 1.1, 0.5)), false)
  assert.equal(f.executor.pathing.positionClear(new Vec3(0.5, 1.51, 0.5)), true)
})

test('a different acknowledged block cannot complete the assigned target', async () => {
  const f = fixture()
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('stone', support))
  f.executor.reach = async () => {}
  f.executor.makeGoal = () => ({ facesPos: [1], getFaceAndRef: () => ({ ref: support, face: new Vec3(0, -1, 0), to: support.offset(0.5, 1, 0.5) }) })
  f.bot._genericPlace = async () => f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), false)
})

test('cancellation during aiming removes pending tick listeners and sends no right click', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.bot.lookAt = async () => { setImmediate(() => controller.abort()) }
  const listeners = f.bot.listenerCount('physicsTick')
  const endListeners = f.bot.listenerCount('end')
  await assert.rejects(f.executor.orient(f.pos, controller.signal), { name: 'AbortError' })
  assert.equal(f.bot.listenerCount('physicsTick'), listeners)
  assert.equal(f.bot.listenerCount('end'), endListeners)
})

test('cancellation during digging stops and joins the in-flight dig', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  f.executor.reach = async () => {}
  let stopped = false
  f.bot.dig = async () => new Promise((resolve, reject) => {
    f.bot.stopDigging = () => { stopped = true; reject(new Error('Digging aborted')) }
    setImmediate(() => controller.abort())
  })
  await assert.rejects(f.executor.perform({ ...f.task, type: 'dig' }, { layer: 5, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(stopped, true)
  assert.equal(f.executor.busy, false)
})

test('placement cannot merge a support slab belonging to a different layer', () => {
  const f = fixture('stone_slab', { type: 'bottom', waterlogged: false })
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('stone_slab', support, { type: 'bottom', waterlogged: false }))
  assert.equal(f.executor.makeGoal(f.task).facesPos.length, 0)
})

test('placement goals reject positions intersecting another player', () => {
  const f = fixture()
  f.bot.entities.player = { id: 2, type: 'player', position: f.pos.offset(0.5, -1, 0.5) }
  assert.equal(f.executor.placementClear(f.task), false)
})

test('long unobstructed flight uses one direct segment instead of synchronous A star', () => {
  const f = fixture()
  const start = new Vec3(0.5, 5.1, 0.5)
  const target = new Vec3(70.5, 5.1, 0.5)
  f.executor.pathing.positionClear = () => true
  f.executor.pathing.canTraverseFlightStep = () => { throw new Error('A star should not run') }
  assert.deepEqual(f.executor.pathing.findFlightPath(start, target), [target])
})

test('obstructed direct flight tries a clear overhead corridor before A star', () => {
  const f = fixture()
  const start = new Vec3(0.5, 5.1, 0.5)
  const target = new Vec3(20.5, 5.1, 0.5)
  f.executor.pathing.positionClear = pos => pos.x < 5 || pos.x > 15 || pos.y >= 7
  f.executor.pathing.canTraverseFlightStep = () => { throw new Error('A star should not run') }
  const path = f.executor.pathing.findFlightPath(start, target)
  assert.equal(path.length, 3)
  assert.ok(path[0].y >= 7)
  assert.ok(path[2].equals(target))
})

test('flight reports a blocked destination before searching for a route', () => {
  const f = fixture()
  const target = f.bot.entity.position.offset(6, 0, 0)
  const obstacle = target.floored()
  f.cells.set(obstacle.toString(), f.block('stone', obstacle))
  f.executor.pathing.canTraverseFlightStep = () => { throw new Error('A star should not run for a blocked destination') }
  assert.equal(f.executor.pathing.findFlightPath(f.bot.entity.position, target), null)
  assert.equal(f.executor.pathing.lastSearchFailure, 'TARGET_BLOCKED')
})

test('flight distinguishes unloaded destination blocks from solid obstacles', () => {
  const f = fixture()
  const target = f.bot.entity.position.offset(6, 0, 0)
  const blockAt = f.bot.blockAt
  f.bot.blockAt = pos => pos.equals(target.floored()) ? null : blockAt(pos)
  f.executor.pathing.canTraverseFlightStep = () => { throw new Error('A star should not run for an unloaded destination') }
  assert.equal(f.executor.pathing.findFlightPath(f.bot.entity.position, target), null)
  assert.equal(f.executor.pathing.lastSearchFailure, 'TARGET_UNLOADED')
})

test('flight distinguishes the search time budget from an exhausted route search', t => {
  const f = fixture()
  const start = f.bot.entity.position
  const target = start.offset(6, 0, 0)
  let now = 100
  t.mock.method(Date, 'now', () => { const value = now; now += 36; return value })
  assert.equal(f.executor.pathing.findFlightPath(start, target), null)
  assert.equal(f.executor.pathing.lastSearchFailure, 'SEARCH_BUDGET')
  t.mock.restoreAll()
  f.executor.pathing.segmentClear = () => false
  f.executor.pathing.canTraverseFlightStep = () => false
  assert.equal(f.executor.pathing.findFlightPath(start, target), null)
  assert.equal(f.executor.pathing.lastSearchFailure, 'NO_ROUTE')
  f.executor.pathing.segmentClear = () => true
  assert.deepEqual(f.executor.pathing.findFlightPath(start, target), [target])
  assert.equal(f.executor.pathing.lastSearchFailure, null)
})

test('a direct escape may reduce an existing overlap before its destination is fully clear', () => {
  const f = fixture()
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  const start = f.pos.offset(0.5, 0.1, 0.5)
  const target = start.offset(0, 0.3, 0)
  assert.equal(f.executor.pathing.positionClear(target), false)
  assert.deepEqual(f.executor.pathing.findFlightPath(start, target), [target])
  assert.equal(f.executor.pathing.lastSearchFailure, null)
})

test('failed flight includes its cause and worker coordinates without moving the player', async () => {
  for (const code of ['TARGET_BLOCKED', 'TARGET_UNLOADED', 'SEARCH_BUDGET', 'NO_ROUTE']) {
    const f = fixture()
    f.bot.username = 'Builder07'
    const start = f.bot.entity.position.clone()
    const target = start.offset(6, 0, 0)
    f.executor.pathing.findFlightPath = () => null
    f.executor.pathing.lastSearchFailure = code
    await assert.rejects(f.executor.move(target), error => {
      assert.equal(error.code, code)
      assert.match(error.message, /^No collision-free flight route/)
      assert.ok(error.message.includes(f.bot.username))
      assert.ok(error.message.includes(start.toString()))
      assert.ok(error.message.includes(target.toString()))
      return true
    })
    assert.ok(f.bot.entity.position.equals(start))
    assert.ok(f.bot.entity.velocity.equals(new Vec3(0, 0, 0)))
    assert.deepEqual(f.events, [])
  }
})

test('placement approach prefers clear staging above the current layer', async () => {
  const f = fixture()
  const oldEye = f.executor.eye()
  const goal = { getFaceAndRef: eye => eye.equals(oldEye) ? null : {} }
  f.executor.pathing.positionClear = () => true
  let destination
  f.executor.move = async target => { destination = target; f.bot.entity.position = target }
  await f.executor.reach(goal, f.pos)
  assert.ok(destination.y >= f.pos.y + 1)
})

test('overlapping players do not trap collision-free flight', () => {
  const f = fixture()
  f.bot.entities.other = { id: 2, type: 'player', position: f.bot.entity.position.clone() }
  assert.equal(f.executor.pathing.positionClear(f.bot.entity.position), true)
  assert.equal(f.executor.pathing.getFlightObstacleKeys().size, 0)
})

test('upper doors and piston heads are verified without active placement', async () => {
  for (const [name, properties] of [['iron_door', { half: 'upper' }], ['piston_head', { facing: 'up' }]]) {
    const f = fixture(name, properties)
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), false)
    assert.deepEqual(f.events, [])
  }
})

test('placing a lower door permits its upper half to appear naturally', async () => {
  const f = fixture('iron_door', { half: 'lower', facing: 'north', hinge: 'left', powered: false, open: false })
  const operations = []
  f.executor.clickPlace = async task => {
    operations.push(task.pos.y)
    f.cells.set(f.pos.toString(), f.wanted)
    f.cells.set(f.pos.offset(0, 1, 0).toString(), f.block('iron_door', f.pos.offset(0, 1, 0), { half: 'upper', facing: 'north', hinge: 'left', powered: false, open: false }))
    return true
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.deepEqual(operations, [5])
})

test('extended target pistons can be placed retracted for natural circuit activation', async () => {
  const f = fixture('piston', { facing: 'up', extended: true })
  f.executor.clickPlace = async () => {
    f.cells.set(f.pos.toString(), f.block('piston', f.pos, { facing: 'up', extended: false }))
    return true
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
})

test('note blocks can cycle all 25 notes without rebuilding and ignoring runtime power', async () => {
  const f = fixture('note_block', { note: '24', instrument: 'harp', powered: true })
  f.cells.set(f.pos.toString(), f.block('note_block', f.pos, { note: '0', instrument: 'harp', powered: false }))
  let clicks = 0
  f.executor.interact = async () => {
    clicks++
    f.cells.set(f.pos.toString(), f.block('note_block', f.pos, { note: String(clicks), instrument: 'harp', powered: false }))
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(clicks, 24)
})

test('lever power and daylight inversion are set with one ordinary interaction', async () => {
  for (const [name, properties, current] of [
    ['lever', { face: 'floor', facing: 'north', powered: true }, { face: 'floor', facing: 'north', powered: false }],
    ['daylight_detector', { inverted: true, power: '0' }, { inverted: false, power: '0' }]
  ]) {
    const f = fixture(name, properties)
    f.cells.set(f.pos.toString(), f.block(name, f.pos, current))
    let clicks = 0
    f.executor.interact = async () => { clicks++; f.cells.set(f.pos.toString(), f.wanted) }
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(clicks, 1)
  }
})

test('composter levels are raised using compostable material', async () => {
  const f = fixture('composter', { level: '6' })
  f.cells.set(f.pos.toString(), f.block('composter', f.pos, { level: '0' }))
  let clicks = 0
  f.executor.interact = async (task, signal, options) => {
    assert.equal(options.itemName, 'pumpkin_pie')
    clicks++
    f.cells.set(f.pos.toString(), f.block('composter', f.pos, { level: String(clicks) }))
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(clicks, 6)
})

test('fluid and powder snow targets use their buckets at the assigned position', async () => {
  for (const name of ['water', 'lava', 'powder_snow']) {
    const f = fixture(name, name === 'powder_snow' ? {} : { level: '0' })
    f.executor.clickPlace = async (task, signal, options) => {
      assert.equal(options.itemName, `${name}_bucket`)
      assert.equal(options.activateItem, name !== 'powder_snow')
      assert.ok(task.pos.equals(f.pos))
      f.cells.set(f.pos.toString(), f.wanted)
      return true
    }
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  }
})

test('dirt paths and lava cauldrons are made by transforming a base block in place', async () => {
  for (const [name, base, item] of [['dirt_path', 'dirt', 'diamond_shovel'], ['lava_cauldron', 'cauldron', 'lava_bucket']]) {
    const f = fixture(name)
    f.executor.clickPlace = async (task, signal, options) => {
      assert.equal(options.itemName, base)
      f.cells.set(f.pos.toString(), f.block(base, f.pos))
      return true
    }
    f.executor.interact = async (task, signal, options) => {
      assert.equal(options.itemName, item)
      f.cells.set(f.pos.toString(), f.wanted)
    }
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  }
})

function pottedFixture (name = 'potted_bamboo', { existing, acknowledge = true, plantedName = name } = {}) {
  const f = fixture(name)
  f.bot.entity.position = f.pos.offset(2.5, 1.3, 0.5)
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('stone', support))
  if (existing) f.cells.set(f.pos.toString(), f.block(existing, f.pos))
  f.executor.report = event => { if (event.state === 'placing') f.events.push(['audit', event]) }
  f.ack = () => f.bot._client.emit('block_change', { location: f.pos, type: f.block(plantedName, f.pos).stateId })
  f.bot._genericPlace = async (ref, face, options) => {
    const pot = f.bot.heldItem.name === 'flower_pot'
    f.events.push([pot ? 'pot' : 'plant', f.bot.heldItem.name, ref.position.clone(), face.clone()])
    assert.equal(options.forceLook, 'ignore')
    assert.equal(f.bot.controlState.sneak, false)
    const actual = f.block(pot ? 'flower_pot' : plantedName, f.pos)
    f.cells.set(f.pos.toString(), actual)
    if (pot || acknowledge) f.bot._client.emit('block_change', { location: f.pos, type: actual.stateId })
    if (!pot) f.bot.emit('test-plant')
  }
  return f
}

test('all 37 potted plants use an empty pot then an audited normal plant click in their active layer', async () => {
  const names = Object.keys(registry.blocksByName).filter(name => name.startsWith('potted_'))
  assert.equal(names.length, 37)
  for (const name of names) {
    const f = pottedFixture(name)
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true, name)
    const actions = f.events.filter(event => ['pot', 'plant'].includes(event[0]))
    assert.deepEqual(actions.map(event => event[0]), ['pot', 'plant'], name)
    assert.equal(actions[1][1], name.slice(7).replace('flowering_azalea_bush', 'flowering_azalea').replace('azalea_bush', 'azalea'))
    assert.ok(actions[1][2].equals(f.pos))
    const audits = f.events.filter(event => event[0] === 'audit').map(event => event[1])
    assert.equal(audits.length, 2)
    assert.ok(audits.every(event => event.pos.equals(f.pos) && event.useItem === false))
    assert.ok(audits[1].referencePos.equals(f.pos))
    assert.equal(f.executor.satisfied(f.task), true)
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(f.events.filter(event => event[0] === 'plant').length, 1, 'a completed pot must never be clicked again')
  }
})

test('existing empty pots are reused and completed pots do not receive clicks', async () => {
  for (const existing of ['flower_pot', 'potted_bamboo']) {
    const f = pottedFixture('potted_bamboo', { existing })
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(f.events.filter(event => event[0] === 'pot').length, 0)
    assert.equal(f.events.filter(event => event[0] === 'plant').length, existing === 'flower_pot' ? 1 : 0)
    assert.equal(f.events.some(event => event[0] === 'dig'), false)
  }
})

test('planting requires a fresh exact server update rather than optimistic cache or another plant', async () => {
  const f = pottedFixture('potted_bamboo', { existing: 'flower_pot', acknowledge: false })
  f.ack()
  let complete = false
  const sent = new Promise(resolve => f.bot.once('test-plant', resolve))
  const work = f.executor.perform(f.task, { layer: 5 }).then(result => { complete = true; return result })
  await Promise.race([sent, work])
  assert.equal(f.events.filter(event => event[0] === 'plant').length, 1)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(complete, false)
  f.ack()
  assert.equal(await work, true)

  for (const plantedName of ['flower_pot', 'potted_poppy']) {
    const wrong = pottedFixture('potted_bamboo', { existing: 'flower_pot', plantedName })
    const controller = new AbortController()
    wrong.bot.once('test-plant', () => controller.abort())
    await assert.rejects(wrong.executor.perform(wrong.task, { layer: 5, signal: controller.signal }), { code: 'MUTATION_OUTCOME_UNKNOWN' })
    assert.equal(wrong.executor.satisfied(wrong.task), false)
    await assert.rejects(wrong.executor.perform(wrong.task, { layer: 5 }), { code: 'MUTATION_OUTCOME_UNKNOWN' })
    assert.equal(wrong.events.filter(event => event[0] === 'plant').length, 1)
  }
})

test('pot placement and filling each obey the layer audit before sending their packet', async () => {
  for (const rejectFill of [false, true]) {
    const f = pottedFixture()
    f.executor.report = event => {
      if (event.state === 'placing' && event.referencePos.equals(f.pos) === rejectFill) throw new Error('Pot layer audit rejected placement')
    }
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Pot layer audit rejected/)
    assert.equal(f.events.filter(event => event[0] === 'pot').length, rejectFill ? 1 : 0)
    assert.equal(f.events.filter(event => event[0] === 'plant').length, 0)
  }
  const f = pottedFixture()
  await assert.rejects(f.executor.perform(f.task, { layer: 6 }), /outside the active layer/)
  assert.deepEqual(f.events, [])
})

test('planting waits for the matching sequence acknowledgement after a correct raw block update', async () => {
  const f = pottedFixture('potted_bamboo', { existing: 'flower_pot' })
  let sequence = 0
  f.bot._nextSequence = () => ++sequence
  const place = f.bot._genericPlace
  f.bot._genericPlace = async (...args) => {
    f.bot._nextSequence()
    await place(...args)
  }
  let complete = false
  const sent = new Promise(resolve => f.bot.once('test-plant', resolve))
  const work = f.executor.perform(f.task, { layer: 5 }).then(result => { complete = true; return result })
  await sent
  f.bot._client.emit('acknowledge_player_digging', { sequenceId: sequence - 1 })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(complete, false)
  f.bot._client.emit('acknowledge_player_digging', { sequenceId: sequence })
  assert.equal(await work, true)
  assert.equal(f.executor.mutations.confirmed.get('0,5,0').sequence, sequence)
})

test('cancellation between placing the pot and equipping the plant sends no filling click', async () => {
  const f = pottedFixture()
  const controller = new AbortController()
  const equip = f.bot.creative.setInventorySlot
  f.bot.creative.setInventorySlot = async (slot, item) => {
    if (item?.name === 'bamboo') controller.abort()
    else await equip(slot, item)
  }
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.events.filter(event => event[0] === 'pot').length, 1)
  assert.equal(f.events.filter(event => event[0] === 'plant').length, 0)
  assert.equal(f.bot.blockAt(f.pos).name, 'flower_pot')
  assert.equal(f.executor.satisfied(f.task), false)
  f.bot.creative.setInventorySlot = equip
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(f.events.filter(event => event[0] === 'pot').length, 1)
  assert.equal(f.events.filter(event => event[0] === 'plant').length, 1)
})

test('planting rechecks the empty pot and final aiming ray immediately before the click', async () => {
  for (const mutation of ['after-aim', 'after-audit', 'ray']) {
    const f = pottedFixture('potted_bamboo', { existing: 'flower_pot' })
    const orient = f.executor.orient.bind(f.executor)
    f.executor.orient = async (...args) => {
      await orient(...args)
      if (mutation === 'after-aim') f.cells.set(f.pos.toString(), f.block('potted_bamboo', f.pos))
      if (mutation === 'ray') f.executor.selectionRaycast = () => null
    }
    if (mutation === 'after-audit') {
      f.executor.report = event => {
        if (event.state === 'placing') f.cells.set(f.pos.toString(), f.block('potted_bamboo', f.pos))
      }
    }
    if (mutation === 'ray') await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Planting aiming ray/)
    else assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(f.events.filter(event => event[0] === 'plant').length, 0)
  }
})

test('rail placement uses the requested horizontal axis', () => {
  for (const [shape, allowed, rejected] of [
    ['east_west', new Vec3(-3, -1, 0), new Vec3(0, -1, 3)],
    ['north_south', new Vec3(0, -1, 3), new Vec3(-3, -1, 0)]
  ]) {
    const f = fixture('rail', { shape, waterlogged: false })
    const goal = f.executor.makeGoal(f.task)
    assert.equal(goal.checkFacing(allowed), true)
    assert.equal(goal.checkFacing(rejected), false)
  }
})

test('creative inventory uses each item stack limit for filled buckets', async () => {
  const f = fixture('water', { level: '0' })
  await f.executor.equip('water_bucket')
  assert.equal(f.bot.heldItem.count, 1)
})

test('flight clamps the final step before normalizing its mutable vector', async () => {
  const f = fixture()
  const target = f.bot.entity.position.offset(0, 0.2, 0)
  f.executor.pathing.findFlightPath = () => [target]
  f.executor.pathing.positionClear = () => true
  await f.executor.move(target)
  assert.ok(f.bot.entity.position.distanceTo(target) < 0.001)
})

test('flight advances 0.9 blocks per tick and clamps the remaining partial step', async () => {
  const f = fixture()
  const start = f.bot.entity.position.clone()
  const target = start.offset(1.17, 0, 0)
  const positions = []
  const set = f.bot.entity.position.set.bind(f.bot.entity.position)
  f.bot.entity.position.set = (x, y, z) => { positions.push(new Vec3(x, y, z)); return set(x, y, z) }
  f.executor.pathing.findFlightPath = () => [target]
  await f.executor.move(target)
  assert.equal(positions.length, 2)
  assert.ok(Math.abs(positions[0].distanceTo(start) - 0.9) < 0.00001)
  assert.ok(positions[1].distanceTo(target) < 0.00001)
  assert.ok(positions.every(position => position.x <= target.x))
})

test('staging flight tolerates event-loop delays while still moving in physical steps', async t => {
  const f = fixture()
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const start = f.bot.entity.position.clone()
  const target = start.offset(1.8, 0, 0)
  const positions = []
  const set = f.bot.entity.position.set.bind(f.bot.entity.position)
  f.bot.entity.position.set = (x, y, z) => {
    now += 2500
    positions.push(new Vec3(x, y, z))
    return set(x, y, z)
  }
  await f.executor.move(target)
  assert.equal(positions.length, 2)
  assert.ok(positions[0].distanceTo(start) <= 0.901)
  assert.ok(f.bot.entity.position.distanceTo(target) < 0.001)
})

test('delayed flight still respects the placement deadline and a bounded staging timeout', async t => {
  for (const placement of [false, true]) {
    const f = fixture()
    let now = Date.now()
    const clock = t.mock.method(Date, 'now', () => now)
    if (placement) f.executor.deadline = now + 1000
    const target = f.bot.entity.position.offset(1.8, 0, 0)
    const set = f.bot.entity.position.set.bind(f.bot.entity.position)
    f.bot.entity.position.set = (x, y, z) => { now += placement ? 2500 : 31000; return set(x, y, z) }
    await assert.rejects(f.executor.move(target), /Flight deadline exceeded/)
    assert.ok(f.bot.entity.position.distanceTo(target) > 0.5)
    assert.ok(f.bot.entity.velocity.equals(new Vec3(0, 0, 0)))
    clock.mock.restore()
  }
})

test('a thin diagonal obstruction between start midpoint and endpoint prevents a fast step', async () => {
  const f = fixture()
  const start = new Vec3(0.5, 5.1, 0.5)
  f.bot.entity.position = start.clone()
  const target = start.offset(0.9 / Math.SQRT2, 0, 0.9 / Math.SQRT2)
  const thin = f.block('iron_bars', new Vec3(0, 5, 0))
  thin.shapes = [[15 / 16, 0, 5 / 16, 1, 1, 7 / 16]]
  f.cells.set(thin.position.toString(), thin)
  assert.ok([start, start.plus(target.minus(start).scaled(0.5)), target].every(point => f.executor.pathing.positionClear(point)))
  assert.equal(f.executor.pathing.segmentClear(start, target), false)
  f.executor.pathing.findFlightPath = () => [target]
  await assert.rejects(f.executor.move(target), /obstructed/)
  assert.ok(f.bot.entity.position.equals(start))
  assert.ok(f.bot.entity.velocity.equals(new Vec3(0, 0, 0)))
})

test('a player restored inside a block can only reduce the original overlap when flying out', async () => {
  const f = fixture()
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  const start = f.pos.offset(0.5, 0.1, 0.5)
  const target = start.offset(0, 1.1, 0)
  f.bot.entity.position = start.clone()
  assert.equal(f.executor.pathing.positionClear(start), false)
  assert.equal(f.executor.pathing.segmentClear(start, start.offset(0, -0.1, 0)), false, 'deeper penetration is forbidden')
  assert.equal(f.executor.pathing.segmentClear(start, target), true)
  await f.executor.move(target)
  assert.ok(f.bot.entity.position.equals(target))
  assert.equal(f.executor.pathing.positionClear(target), true)
})

test('collision escape never crosses a new obstacle or deepens another overlapping axis', () => {
  const f = fixture()
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  const start = f.pos.offset(0.5, 0.1, 0.5)
  const ceiling = f.pos.offset(0, 2, 0)
  f.cells.set(ceiling.toString(), f.block('glass', ceiling))
  assert.equal(f.executor.pathing.segmentClear(start, start.offset(0, 1.1, 0)), false)
  f.cells.delete(ceiling.toString())
  const edge = f.pos.offset(-0.2, 0.1, 0.5)
  assert.equal(f.executor.pathing.segmentClear(edge, edge.offset(0.5, 1.1, 0)), false)
  assert.equal(f.executor.pathing.segmentClear(edge, edge.offset(-0.5, 0, 0)), true)
})

test('completed workers leave the active layer before becoming idle', async () => {
  const f = fixture()
  f.cells.set(f.pos.toString(), f.wanted)
  const parking = []
  f.executor.move = async destination => { parking.push(destination); f.bot.entity.position = destination }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(parking.length, 1)
  assert.ok(f.bot.entity.position.y >= 6.2)
})

test('failed placement approaches leave the layer so other workers can build their supports', async () => {
  for (const failure of [false, new Error('Placement face changed')]) {
    const f = fixture()
    const parked = []
    f.executor.move = async destination => { parked.push(destination); f.bot.entity.position = destination }
    f.executor.clickPlace = async () => {
      await f.executor.reach({ getFaceAndRef: () => ({}) }, f.pos)
      if (failure) throw failure
      return false
    }
    if (failure) await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Placement face changed/)
    else assert.equal(await f.executor.perform(f.task, { layer: 5 }), false)
    assert.equal(parked.length, 1)
    assert.ok(f.bot.entity.position.y >= 6.2)
    assert.equal(f.executor.busy, false)
    assert.equal(f.events.some(e => Array.isArray(e) && ['dig', 'place'].includes(e[0])), false)
  }
})

test('cancelling a failed placement approach does not start a parking movement', async () => {
  const f = fixture()
  const controller = new AbortController()
  let moved = 0
  f.executor.move = async () => { moved++ }
  f.executor.clickPlace = async () => {
    await f.executor.reach({ getFaceAndRef: () => ({}) }, f.pos, controller.signal)
    controller.abort()
    const error = new Error('cancelled')
    error.name = 'AbortError'
    throw error
  }
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(moved, 0)
  assert.equal(f.executor.busy, false)
})

test('component materials preserve facing while excluding runtime power', async () => {
  const f = fixture('observer', { facing: 'up', powered: true })
  f.executor.useStateComponents = true
  const properties = f.executor.placementProperties(f.wanted)
  assert.deepEqual(properties, { facing: 'up' })
  await f.executor.equip('observer', undefined, properties)
  assert.deepEqual(f.bot.heldItem.components.find(c => c.type === 'block_state').data, { properties: [{ name: 'facing', value: 'up' }] })
  const goal = f.executor.makeGoal(f.task)
  assert.equal(goal.checkFacing(new Vec3(0.1, -3, 0.1)), true)
})

test('same item with different component state is not reused as stale material', async () => {
  const f = fixture('observer', { facing: 'up', powered: false })
  f.executor.useStateComponents = true
  f.bot.creative.setInventorySlot = async (slot, item) => {
    if (f.executor.Item.equal(f.bot.inventory.slots[slot], item)) return
    f.bot.inventory.slots[slot] = item
  }
  await f.executor.equip('observer', undefined, { facing: 'up' })
  await f.executor.equip('observer', undefined, { facing: 'south' })
  assert.deepEqual(f.bot.heldItem.components.find(c => c.type === 'block_state').data.properties, [{ name: 'facing', value: 'south' }])
})

test('a lantern component can be applied through a temporary floor support', () => {
  const f = fixture('lantern', { hanging: true, waterlogged: false })
  f.executor.useStateComponents = true
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('stone', support))
  assert.ok(f.executor.makeGoal(f.task).facesPos.some(([face]) => face.y === -1))
})

test('opposing hopper components can use floor support before their peer exists', () => {
  for (const facing of ['north', 'south']) {
    const f = fixture('hopper', { facing, enabled: true })
    f.executor.useStateComponents = true
    const support = f.pos.offset(0, -1, 0)
    f.cells.set(support.toString(), f.block('white_concrete', support))
    assert.ok(f.executor.makeGoal(f.task).facesPos.some(([face]) => face.y === -1), facing)
    assert.deepEqual(f.executor.placementProperties(f.wanted), { facing })
  }
})

test('trapdoor state components permit floor and opposite-side click references', () => {
  for (const name of ['iron_trapdoor', 'oak_trapdoor']) {
    const f = fixture(name, { facing: 'east', half: 'bottom', open: false, waterlogged: true, powered: false })
    f.executor.useStateComponents = true
    const floor = f.pos.offset(0, -1, 0)
    const oppositeSide = f.pos.offset(1, 0, 0)
    f.cells.set(floor.toString(), f.block('stone', floor))
    f.cells.set(oppositeSide.toString(), f.block('stone', oppositeSide))
    const goal = f.executor.makeGoal(f.task)
    assert.ok(goal.facesPos.some(([face]) => face.y === -1))
    assert.ok(goal.facesPos.some(([face]) => face.x === 1))
    const properties = f.executor.placementProperties(f.wanted)
    assert.equal(properties.facing, 'east')
    assert.equal(properties.half, 'bottom')
    assert.equal(properties.waterlogged, 'true')
  }
})

test('component wall torches still require their attachment support', () => {
  const f = fixture('redstone_wall_torch', { facing: 'north', lit: true })
  f.executor.useStateComponents = true
  const floor = f.pos.offset(0, -1, 0)
  f.cells.set(floor.toString(), f.block('stone', floor))
  assert.equal(f.executor.makeGoal(f.task).facesPos.length, 0)
  const support = f.pos.offset(0, 0, 1)
  f.cells.set(support.toString(), f.block('stone', support))
  assert.ok(f.executor.makeGoal(f.task).facesPos.some(([face]) => face.z === 1))
})

test('standing torches only click the floor even when a nearby wall is reachable', () => {
  for (const name of ['torch', 'redstone_torch', 'soul_torch']) {
    const f = fixture(name)
    f.executor.useStateComponents = true
    const floor = f.pos.offset(0, -1, 0)
    const wall = f.pos.offset(0, 0, -1)
    f.cells.set(floor.toString(), f.block('stone', floor))
    f.cells.set(wall.toString(), f.block('stone', wall))
    assert.ok(f.executor.makeGoal(f.task).facesPos.length > 0)
    assert.ok(f.executor.makeGoal(f.task).facesPos.every(([face]) => face.equals(new Vec3(0, -1, 0))))
    f.cells.delete(floor.toString())
    assert.equal(f.executor.makeGoal(f.task).facesPos.length, 0, 'a wall cannot substitute the required floor')
  }
})

test('standing skulls and heads require floor clicks with or without block state components', () => {
  const names = Object.keys(registry.blocksByName).filter(name => /_(skull|head)$/.test(name) && !name.includes('_wall_') && name !== 'piston_head')
  for (const name of names) {
    for (const components of [false, true]) {
      const f = fixture(name)
      f.executor.useStateComponents = components
      const floor = f.pos.offset(0, -1, 0)
      const wall = f.pos.offset(0, 0, -1)
      f.cells.set(floor.toString(), f.block('stone', floor))
      f.cells.set(wall.toString(), f.block('stone', wall))
      assert.ok(f.executor.makeGoal(f.task).facesPos.length > 0, name)
      assert.ok(f.executor.makeGoal(f.task).facesPos.every(([face]) => face.equals(new Vec3(0, -1, 0))), name)
      f.cells.delete(floor.toString())
      assert.equal(f.executor.makeGoal(f.task).facesPos.length, 0, `${name}: a wall cannot substitute for the floor`)
    }
  }
})

test('wall skulls and heads retain their exact attachment in all four directions for both component modes', () => {
  const names = Object.keys(registry.blocksByName).filter(name => /_wall_(skull|head)$/.test(name))
  const directions = { north: new Vec3(0, 0, 1), south: new Vec3(0, 0, -1), east: new Vec3(-1, 0, 0), west: new Vec3(1, 0, 0) }
  for (const name of names) {
    for (const [facing, expected] of Object.entries(directions)) {
      for (const components of [false, true]) {
        const f = fixture(name, { facing })
        f.executor.useStateComponents = components
        for (const offset of [new Vec3(0, -1, 0), ...Object.values(directions)]) {
          const support = f.pos.plus(offset)
          f.cells.set(support.toString(), f.block('stone', support))
        }
        const goal = f.executor.makeGoal(f.task)
        assert.ok(goal.facesPos.length > 0, `${name}/${facing}`)
        assert.ok(goal.facesPos.every(([face]) => face.equals(expected)), `${name}/${facing}/${components}`)
        f.cells.delete(f.pos.plus(expected).toString())
        assert.equal(f.executor.makeGoal(f.task).facesPos.length, 0, `${name}/${facing}: another support cannot substitute`)
      }
    }
  }
})

test('standing and wall torch outlines are selectable without adding collision shapes', () => {
  for (const name of ['torch', 'redstone_torch', 'soul_torch', 'wall_torch', 'redstone_wall_torch', 'soul_wall_torch']) {
    for (const facing of name.includes('wall') ? ['north', 'south', 'east', 'west'] : [null]) {
      const f = fixture(name, facing ? { facing } : {})
      f.cells.set(f.pos.toString(), f.block(name, f.pos, facing ? { facing } : {}))
      f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
      const offset = { north: [0, 0, -2], south: [0, 0, 2], east: [2, 0, 0], west: [-2, 0, 0] }[facing] || [0, 0, 2]
      f.bot.entity.position = f.pos.offset(offset[0] + 0.5, -1, offset[2] + 0.5)
      assert.deepEqual(f.bot.blockAt(f.pos).shapes, [])
      assert.ok(f.executor.interactionGoal(f.pos).getFaceAndRef(f.executor.eye()), `${name}/${facing}`)
    }
  }
})

test('a misattached wall torch is corrected using only the current target and its floor', async () => {
  const f = fixture('redstone_torch', { lit: true })
  f.executor.useStateComponents = true
  const floor = f.pos.offset(0, -1, 0)
  const wall = f.pos.offset(0, 0, -1)
  f.cells.set(floor.toString(), f.block('white_concrete', floor))
  f.cells.set(wall.toString(), f.block('white_concrete', wall))
  f.cells.set(f.pos.toString(), f.block('redstone_wall_torch', f.pos, { facing: 'south', lit: true }))
  f.bot.entity.position = f.pos.offset(0.5, 0.1, 2.5)
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  f.bot._genericPlace = async (ref, face) => {
    assert.ok(ref.position.equals(floor))
    assert.ok(face.equals(new Vec3(0, 1, 0)))
    f.cells.set(f.pos.toString(), f.block('redstone_torch', f.pos, { lit: true }))
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.deepEqual(f.events.filter(e => Array.isArray(e) && e[0] === 'dig'), [['dig', f.pos.toString()]])
  assert.equal(f.bot.blockAt(wall).name, 'white_concrete')
  assert.equal(f.bot.blockAt(floor).name, 'white_concrete')
})

test('dot redstone material preserves disconnected sides without copying power', async () => {
  const f = fixture('redstone_wire', { north: 'none', south: 'none', east: 'none', west: 'none', power: '15' })
  f.executor.useStateComponents = true
  await f.executor.equip('redstone_wire', undefined, f.executor.placementProperties(f.wanted))
  assert.deepEqual(f.bot.heldItem.components.find(c => c.type === 'block_state')?.data.properties, [
    { name: 'east', value: 'none' }, { name: 'north', value: 'none' },
    { name: 'south', value: 'none' }, { name: 'west', value: 'none' }
  ])
})

test('an existing redstone cross is toggled to a dot without digging or support edits', async () => {
  const f = fixture('redstone_wire', { north: 'none', south: 'none', east: 'none', west: 'none', power: '0' })
  f.cells.set(f.pos.toString(), f.block('redstone_wire', f.pos, { north: 'side', south: 'side', east: 'side', west: 'side', power: '7' }))
  let clicks = 0
  f.bot._genericPlace = async (block, face, options) => {
    assert.ok(block.position.equals(f.pos))
    assert.ok(face.equals(new Vec3(0, 1, 0)))
    assert.equal(options.forceLook, 'ignore')
    clicks++
    f.cells.set(f.pos.toString(), f.block('redstone_wire', f.pos, { north: 'none', south: 'none', east: 'none', west: 'none', power: '7' }))
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(clicks, 1)
  assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'dig'), false)
})

test('redstone interaction cannot reach through an obstructing block', () => {
  const f = fixture('redstone_wire', { north: 'none', south: 'none', east: 'none', west: 'none' })
  f.cells.set(f.pos.toString(), f.wanted)
  f.bot.world.raycast = () => ({ position: f.pos.offset(1, 0, 0), face: 4 })
  assert.equal(f.executor.interactionGoal(f.pos).getFaceAndRef(f.executor.eye()), null)
})

test('interactive support placement synchronizes legacy sneaking before the click', async () => {
  const f = fixture('white_concrete')
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('hopper', support))
  f.bot._client.write = (name, packet) => f.events.push(['packet', name, packet.actionId])
  f.executor.reach = async () => {}
  f.executor.makeGoal = () => ({ facesPos: [1], getFaceAndRef: () => ({ ref: support, face: new Vec3(0, -1, 0), to: support.offset(0.0625, 1, 0.5) }) })
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  const start = f.events.findIndex(e => Array.isArray(e) && e[2] === 'start_sneaking')
  const place = f.events.findIndex(e => Array.isArray(e) && e[0] === 'place')
  const stop = f.events.findIndex(e => Array.isArray(e) && e[2] === 'stop_sneaking')
  assert.ok(start >= 0 && start < place && stop > place)
})

test('1.21.6 input handling does not send removed legacy sneak actions', () => {
  const f = fixture()
  f.executor.mcData = require('minecraft-data')('1.21.6')
  const controls = []
  f.bot.setControlState = (name, state) => controls.push([name, state])
  f.executor.setSneaking(true)
  f.executor.setSneaking(false)
  assert.deepEqual(controls, [['sneak', true], ['sneak', false]])
  assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'packet'), false)
})

test('rail replacement digs the selectable top even though its collision shape is empty', async () => {
  for (const [shape, height] of [['north_south', 0.125], ['ascending_south', 0.625]]) {
    const f = fixture('powered_rail', { shape, powered: true, waterlogged: false })
    f.cells.set(f.pos.toString(), f.block('powered_rail', f.pos, { shape, powered: true, waterlogged: false }))
    assert.deepEqual(f.bot.blockAt(f.pos).shapes, [])
    const aim = []
    f.bot.lookAt = async point => { aim.push(point); setImmediate(() => f.bot.emit('physicsTick')) }
    f.bot.dig = async (block, forceLook) => {
      assert.ok(block.position.equals(f.pos))
      assert.equal(forceLook, 'ignore')
      f.cells.delete(f.pos.toString())
      f.bot._client.emit('block_change', { location: f.pos, type: 0 })
    }
    assert.equal(await f.executor.perform({ ...f.task, type: 'dig' }, { layer: 5 }), true)
    assert.ok(aim.some(point => point.equals(f.pos.offset(0.5, height, 0.5))))
  }
})

test('rail shape calibration takes a safe reverse debug-stick step without rebuilding', async () => {
  const f = fixture('powered_rail', { shape: 'ascending_south', powered: true, waterlogged: false })
  f.cells.set(f.pos.toString(), f.block('powered_rail', f.pos, { shape: 'north_south', powered: true, waterlogged: false }))
  const support = f.pos.offset(0, 0, 1)
  f.cells.set(support.toString(), f.block('stone', support))
  let sneaking = false
  f.bot.setControlState = (name, state) => { if (name === 'sneak') sneaking = state }
  let clicks = 0
  f.bot._genericPlace = async block => {
    assert.ok(block.position.equals(f.pos))
    assert.equal(f.bot.heldItem.name, 'debug_stick')
    assert.equal(sneaking, true)
    assert.deepEqual(f.bot.heldItem.components.find(c => c.type === 'debug_stick_state').data, {
      type: 'compound', value: { 'minecraft:powered_rail': { type: 'string', value: 'shape' } }
    })
    clicks++
    f.cells.set(f.pos.toString(), f.block('powered_rail', f.pos, { shape: 'ascending_south', powered: true, waterlogged: false }))
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(clicks, 1)
  assert.equal(sneaking, false)
  assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'dig'), false)
})

test('rail calibration refuses cycles through unsupported ascending intermediate shapes', async () => {
  const f = fixture('powered_rail', { shape: 'ascending_north', powered: true, waterlogged: false })
  f.cells.set(f.pos.toString(), f.block('powered_rail', f.pos, { shape: 'north_south', powered: true, waterlogged: false }))
  const support = f.pos.offset(0, 0, -1)
  f.cells.set(support.toString(), f.block('stone', support))
  assert.equal(await f.executor.adjust(f.task), false)
  assert.deepEqual(f.events, [])
})

test('ascending rail placement defers until both the floor and rising-side support exist', async () => {
  const f = fixture('activator_rail', { shape: 'ascending_north', powered: false, waterlogged: false })
  f.executor.useStateComponents = true
  const floor = f.pos.offset(0, -1, 0)
  const side = f.pos.offset(0, 0, -1)
  f.cells.set(floor.toString(), f.block('white_concrete', floor))
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), { code: 'LAYER_DEPENDENCY_PENDING' })
  assert.deepEqual(f.events, [])
  f.cells.set(side.toString(), f.block('white_concrete', side))
  f.cells.delete(floor.toString())
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), { code: 'LAYER_DEPENDENCY_PENDING' })
  assert.deepEqual(f.events, [])
  f.cells.set(floor.toString(), f.block('white_concrete', floor))
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(f.events.filter(e => Array.isArray(e) && e[0] === 'place').length, 1)
})

test('missing final rail support cannot dig an existing rail during a placement retry', async () => {
  const f = fixture('activator_rail', { shape: 'ascending_north', powered: false, waterlogged: false })
  f.cells.set(f.pos.toString(), f.block('activator_rail', f.pos, { shape: 'east_west', powered: false, waterlogged: false }))
  f.cells.set(f.pos.offset(0, -1, 0).toString(), f.block('white_concrete', f.pos.offset(0, -1, 0)))
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), { code: 'LAYER_DEPENDENCY_PENDING' })
  assert.deepEqual(f.events, [])
})

test('rigid rail support uses the complete two-pixel top rim union', () => {
  const { isRigidRailSupport } = require('../lib/railSupport')
  for (const facing of ['down', 'north', 'south', 'east', 'west']) {
    assert.equal(isRigidRailSupport(Block.fromProperties('hopper', { facing }, 0)), true)
  }
  const rim = [
    [0, 0.5, 0, 1 / 8, 1, 1], [7 / 8, 0.5, 0, 1, 1, 1],
    [1 / 8, 0.5, 0, 7 / 8, 1, 1 / 8], [1 / 8, 0.5, 7 / 8, 7 / 8, 1, 1]
  ]
  assert.equal(isRigidRailSupport({ name: 'fixture', shapes: rim }), true)
  assert.equal(isRigidRailSupport({ name: 'fixture', shapes: rim.slice(1) }), false)
  assert.equal(isRigidRailSupport({ name: 'fixture', shapes: [[0, 0, 0, 1, 0.9, 1]] }), false)
  assert.equal(isRigidRailSupport({ name: 'fixture', shapes: [[0.25, 0, 0.25, 0.75, 1.5, 0.75]] }), false)
  for (const type of ['top', 'double']) assert.equal(isRigidRailSupport(Block.fromProperties('stone_slab', { type }, 0)), true)
  for (const name of ['chest', 'cobblestone_wall']) assert.equal(isRigidRailSupport(Block.fromProperties(name, {}, 0)), false)
  assert.equal(isRigidRailSupport(Block.fromProperties('stone_slab', { type: 'bottom' }, 0)), false)
})

test('rigid rail support respects proven server support-shape overrides', () => {
  const { isRigidRailSupport } = require('../lib/railSupport')
  for (const name of ['soul_sand', 'mud']) assert.equal(isRigidRailSupport(Block.fromProperties(name, {}, 0)), true)
  assert.equal(isRigidRailSupport(Block.fromProperties('oak_leaves', {}, 0)), false)
  assert.equal(isRigidRailSupport(Block.fromProperties('snow', { layers: '8' }, 0)), true)
  assert.equal(isRigidRailSupport(Block.fromProperties('snow', { layers: '7' }, 0)), false)
})

test('rail debug calibration accepts a hopper rim as permanent ascending support', async () => {
  const f = fixture('activator_rail', { shape: 'ascending_east', powered: false, waterlogged: false })
  f.cells.set(f.pos.toString(), f.block('activator_rail', f.pos, { shape: 'east_west', powered: false, waterlogged: false }))
  const support = f.pos.offset(1, 0, 0)
  f.cells.set(support.toString(), f.block('hopper', support, { facing: 'down' }))
  let clicks = 0
  f.bot._genericPlace = async ref => {
    assert.ok(ref.position.equals(f.pos))
    clicks++
    f.cells.set(f.pos.toString(), f.block('activator_rail', f.pos, f.wanted.getProperties()))
  }
  assert.equal(await f.executor.adjustRail(f.task, f.wanted), true)
  assert.equal(clicks, 1)
})

test('rail calibration uses its explicit temporary target without registering a new plan state', async () => {
  const f = fixture('powered_rail', { shape: 'ascending_east', powered: true, waterlogged: false })
  f.cells.set(f.pos.toString(), f.block('powered_rail', f.pos, f.wanted.getProperties()))
  const flat = Block.fromProperties('powered_rail', { shape: 'east_west', powered: true, waterlogged: false }, 0)
  const flatTask = { ...f.task, state: flat.stateId }
  let clicks = 0
  f.bot._genericPlace = async ref => {
    assert.ok(ref.position.equals(f.pos))
    assert.equal(f.bot.heldItem.name, 'debug_stick')
    clicks++
    f.cells.set(f.pos.toString(), f.block('powered_rail', f.pos, flat.getProperties()))
  }
  assert.equal(await f.executor.adjustRail(flatTask, flat), true)
  assert.equal(clicks, 1)
  assert.equal(f.bot.blockAt(f.pos).getProperties().shape, 'east_west')
})

test('copper bulb memory is calibrated by one debug-stick click while power is preserved', async () => {
  for (const [name, lit] of [['waxed_copper_bulb', true], ['copper_bulb', false], ['waxed_oxidized_copper_bulb', true]]) {
    const f = fixture(name, { lit, powered: false })
    f.cells.set(f.pos.toString(), f.block(name, f.pos, { lit: !lit, powered: true }))
    f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
    let clicks = 0
    f.bot.dig = async () => { throw new Error('Copper bulb must not be rebuilt') }
    f.bot._genericPlace = async block => {
      assert.ok(block.position.equals(f.pos))
      assert.equal(f.bot.heldItem.name, 'debug_stick')
      assert.deepEqual(f.bot.heldItem.components.find(c => c.type === 'debug_stick_state').data, {
        type: 'compound', value: { ['minecraft:' + name]: { type: 'string', value: 'lit' } }
      })
      clicks++
      const acknowledged = f.block(name, f.pos, { lit, powered: true })
      f.cells.set(f.pos.toString(), acknowledged)
      f.bot._client.emit('block_change', { location: f.pos, type: acknowledged.stateId })
    }
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(clicks, 1)
    assert.equal(f.bot.blockAt(f.pos).getProperties().powered, true)
  }
})

test('unacknowledged copper bulb calibration never falls back to replacement', async () => {
  const f = fixture('waxed_copper_bulb', { lit: true, powered: true })
  f.cells.set(f.pos.toString(), f.block('waxed_copper_bulb', f.pos, { lit: false, powered: true }))
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  let clicks = 0
  f.bot._genericPlace = async () => { clicks++ }
  f.bot.dig = async () => { throw new Error('Copper bulb must not be rebuilt') }
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Copper bulb calibration was not acknowledged/)
  assert.equal(clicks, 1)
  assert.equal(f.executor.satisfied(f.task), false)
})

test('fluid use-item stays standing when its reference is interactive', async () => {
  const f = fixture('water', { level: '0' })
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('note_block', support))
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  let uses = 0
  f.bot.activateItem = () => {
    assert.equal(f.bot.controlState.sneak, false)
    uses++
    f.cells.set(f.pos.toString(), f.block('water', f.pos, { level: '0' }))
    f.bot._client.emit('block_change', { location: f.pos, type: f.wanted.stateId })
  }
  assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
  assert.equal(uses, 1)
  assert.equal(f.events.some(e => Array.isArray(e) && e[2] === 'start_sneaking'), false)
})

test('bucket fence rejects stale air at an intervening new solid before any use-item packet', async () => {
  const f = waterloggedSlabFixture({ existing: false })
  let fenced = false
  f.build.verifyFluidRay = async blocks => {
    assert.ok(blocks.some(row => row.stateId === 0))
    assert.ok(blocks.some(row => row.pos.equals(f.pos)))
    fenced = true
    throw new Error('Fluid ray world state differs')
  }
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /world state differs/)
  assert.equal(fenced, true)
  assert.equal(f.events.some(row => row[0] === 'bucket'), false)
})

test('unknown bucket outcome permanently halts the shared mutation coordinator and invokes fatal callback', async () => {
  const { PhysicalMutationCoordinator } = require('../lib/physicalMutations')
  const f = waterloggedSlabFixture({ existing: false, acknowledge: false })
  f.build.mutations = f.executor.mutations = new PhysicalMutationCoordinator()
  let fatal
  f.build.onFatalMutation = error => { fatal = error }
  const controller = new AbortController()
  f.bot.once('test-bucket', () => controller.abort())
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { code: 'FLUID_OUTCOME_UNKNOWN' })
  assert.equal(fatal.code, 'FLUID_OUTCOME_UNKNOWN')
  await assert.rejects(f.executor.mutations.acquire(false), { code: 'FLUID_OUTCOME_UNKNOWN' })
  assert.equal(f.events.filter(row => row[0] === 'bucket').length, 1)
})

test('a waterlogging bucket blocks another worker mutation until raw target ACK, including predicted wet cache', async () => {
  const { PhysicalMutationCoordinator } = require('../lib/physicalMutations')
  const coordinator = new PhysicalMutationCoordinator()
  const f = waterloggedSlabFixture({ existing: false, acknowledge: false })
  f.build.mutations = f.executor.mutations = coordinator
  let dispatched
  const sent = new Promise(resolve => { dispatched = resolve })
  f.bot.once('test-bucket', dispatched)
  const work = f.executor.perform(f.task, { layer: 5 })
  await sent
  let later = false
  const waiting = coordinator.acquire(false).then(release => { later = true; return release })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(later, false)
  f.ack()
  assert.equal(await work, true)
  const release = await waiting
  release()
})

test('waterlogged bucket refuses missing managed ray fence and cancelled fence before dispatch', async () => {
  for (const mode of ['missing', 'cancelled']) {
    const f = waterloggedSlabFixture({ existing: false })
    const controller = new AbortController()
    if (mode === 'missing') delete f.build.verifyFluidRay
    else f.build.verifyFluidRay = async blocks => { controller.abort(); return { verified: true, checked: blocks.length } }
    await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }))
    assert.equal(f.events.some(row => row[0] === 'bucket'), false)
  }
})

test('a source mutation must receive raw and sequence ACK before another worker can fence its bucket', async () => {
  const { PhysicalMutationCoordinator } = require('../lib/physicalMutations')
  const coordinator = new PhysicalMutationCoordinator()
  const solid = fixture()
  const wet = waterloggedSlabFixture({ existing: false })
  for (const f of [solid, wet]) f.build.mutations = f.executor.mutations = coordinator
  solid.cells.set(solid.pos.offset(0, -1, 0).toString(), solid.block('stone', solid.pos.offset(0, -1, 0)))
  solid.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  let next = 0
  solid.bot._nextSequence = () => ++next
  let sent
  const dispatched = new Promise(resolve => { sent = resolve })
  solid.bot._genericPlace = async () => {
    solid.bot._nextSequence()
    solid.cells.set(solid.pos.toString(), solid.block('stone', solid.pos))
    sent()
  }
  let fenced = false
  wet.build.verifyFluidRay = async blocks => { fenced = true; return { verified: true, checked: blocks.length } }
  const building = solid.executor.perform(solid.task, { layer: 5 })
  await dispatched
  const pouring = wet.executor.perform(wet.task, { layer: 5 })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fenced, false)
  solid.bot._client.emit('block_change', { location: solid.pos, type: solid.wanted.stateId })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(fenced, false, 'raw state alone could predate this mutation packet')
  solid.bot._client.emit('acknowledge_player_digging', { sequenceId: 1 })
  assert.equal(await building, true)
  assert.equal(await pouring, true)
  assert.equal(fenced, true)
  assert.equal(solid.bot._nextSequence(), 2)
  assert.equal(solid.bot._client.listenerCount('acknowledge_player_digging'), 0)
})

test('ordinary dig and debug interaction also wait outside a fluid exclusive window', async () => {
  const { PhysicalMutationCoordinator } = require('../lib/physicalMutations')
  for (const operation of ['dig', 'interact']) {
    const f = fixture()
    f.cells.set(f.pos.toString(), f.block('stone', f.pos))
    f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
    f.build.mutations = f.executor.mutations = new PhysicalMutationCoordinator()
    const release = await f.executor.mutations.acquire(true)
    let dispatched = false
    f.bot._genericPlace = async () => { dispatched = true; f.bot._client.emit('block_change', { location: f.pos, type: f.wanted.stateId }) }
    const dig = f.bot.dig
    f.bot.dig = async block => { dispatched = true; await dig(block) }
    const work = f.executor[operation](f.task)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(dispatched, false)
    release()
    await work
    assert.equal(dispatched, true)
  }
})

test('source-water cache prediction without raw acknowledgement halts instead of allowing a blind retry', async () => {
  const f = fixture('water', { level: '0' })
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('stone', support))
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  const controller = new AbortController()
  let packets = 0
  f.bot.activateItem = () => {
    packets++
    f.cells.set(f.pos.toString(), f.block('water', f.pos, { level: '0' }))
    controller.abort()
  }
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { code: 'FLUID_OUTCOME_UNKNOWN' })
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), { code: 'FLUID_OUTCOME_UNKNOWN' })
  assert.equal(packets, 1)
})

test('fluid fences refuse intermediate collision-only geometry even when that local ray misses it', async () => {
  for (const name of ['redstone_wire', 'honey_block', 'scaffolding', 'hopper']) {
    const f = waterloggedSlabFixture({ existing: false })
    const overhead = f.pos.offset(0, 2, 0)
    f.bot.entity.pitch = -Math.PI / 2
    f.cells.set(overhead.toString(), f.block(name, overhead))
    await assert.rejects(f.executor.fenceFluid(f.task, f.pos, 1), /unproven selection shape/)
    assert.equal(f.events.some(row => row[0] === 'bucket'), false)
  }
})

test('soul sand uses its full vanilla outline while retaining the lower collision surface', () => {
  const f = fixture('water', { level: '0' })
  const support = f.pos.offset(0, -1, 0)
  const sand = f.block('soul_sand', support)
  f.cells.set(support.toString(), sand)
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  assert.deepEqual(sand.shapes, [[0, 0, 0, 1, 14 / 16, 1]])
  assert.deepEqual(f.executor.selectionShapes(sand), [[0, 0, 0, 1, 1, 1]])
  const hit = f.executor.selectionRaycast(support.offset(-1, 15 / 16, 0.5), new Vec3(1, 0, 0), 4.5)
  assert.ok(hit?.position.equals(support), 'outline must block rays through the gap above the collision surface')
  assert.deepEqual(sand.shapes, [[0, 0, 0, 1, 14 / 16, 1]], 'flight collisions must remain unchanged')
  assert.ok(f.executor.makeGoal(f.task).facesPos.every(([, point]) => point.y === support.y + 1))
})

test('source water on soul sand uses the proven top outline and still requires the readonly world fence', async () => {
  for (const verified of [true, false]) {
    const f = fixture('water', { level: '0' })
    const support = f.pos.offset(0, -1, 0)
    const sand = f.block('soul_sand', support)
    f.cells.set(support.toString(), sand)
    f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
    let fences = 0
    let buckets = 0
    f.build.verifyFluidRay = async blocks => {
      fences++
      assert.ok(blocks.some(row => row.pos.equals(support) && row.stateId === sand.stateId))
      return { verified, checked: blocks.length }
    }
    f.bot.activateItem = () => {
      buckets++
      f.cells.set(f.pos.toString(), f.block('water', f.pos, { level: '0' }))
      f.bot._client.emit('block_change', { location: f.pos, type: f.wanted.stateId })
    }
    if (verified) assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    else await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Incomplete fluid ray world fence/)
    assert.equal(fences, 1)
    assert.equal(buckets, verified ? 1 : 0)
  }
})

test('cancellation from the durable dispatch journal never sends the bucket packet', async () => {
  const f = waterloggedSlabFixture({ existing: false })
  const controller = new AbortController()
  f.build.recordMutationEvidence = event => { if (event.phase === 'fluid-dispatched') controller.abort() }
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { code: 'FLUID_OUTCOME_UNKNOWN' })
  assert.equal(f.events.some(row => row[0] === 'bucket'), false)
})

test('fluid use-item refuses a final ray hitting a different block or face', async () => {
  for (const wrongFace of [false, true]) {
    const f = fixture('water', { level: '0' })
    const support = f.pos.offset(0, -1, 0)
    f.cells.set(support.toString(), f.block('stone', support))
    f.executor.reach = async () => {}
    f.executor.makeGoal = () => ({ facesPos: [1], getFaceAndRef: () => ({ ref: support, face: new Vec3(0, -1, 0), to: support.offset(0.5, 1, 0.5) }) })
    f.bot.world.raycast = () => ({ position: wrongFace ? support : support.offset(0, -1, 0), face: wrongFace ? 4 : 1 })
    let uses = 0
    f.bot.activateItem = () => { uses++ }
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Fluid aiming ray no longer matches the placement face/)
    assert.equal(uses, 0)
  }
})

test('placement audit receives exact coordinates and can stop block and fluid packets', async () => {
  for (const name of ['stone', 'water']) {
    const f = fixture(name)
    const support = f.pos.offset(0, -1, 0)
    f.cells.set(support.toString(), f.block('stone', support))
    f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
    let uses = 0
    f.bot.activateItem = () => { uses++ }
    let audited = false
    f.executor.report = event => {
      if (event.state !== 'placing') return
      assert.deepEqual(event.pos, f.pos)
      assert.deepEqual(event.referencePos, support)
      assert.equal(event.face, 1)
      assert.equal(event.useItem, name === 'water')
      audited = true
      throw new Error('Placement rejected by layer audit')
    }
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Placement rejected by layer audit/)
    assert.equal(audited, true)
    assert.equal(uses, 0)
    assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'place'), false)
  }
})

test('scaffolding references use secondary placement for both side and top faces', async () => {
  for (const offset of [new Vec3(1, 0, 0), new Vec3(0, -1, 0)]) {
    const f = fixture('scaffolding', { distance: '1', bottom: false, waterlogged: false })
    const support = f.pos.plus(offset)
    f.cells.set(support.toString(), f.block('scaffolding', support))
    f.executor.reach = async () => {}
    f.executor.makeGoal = () => ({ facesPos: [1], getFaceAndRef: () => ({ ref: support, face: offset, to: support.offset(0.5, 0.5, 0.5) }) })
    let clicks = 0
    f.bot._genericPlace = async (ref, face) => {
      assert.equal(f.bot.controlState.sneak, true, 'secondary use must prevent scaffolding item redirection')
      assert.ok(ref.position.plus(face).equals(f.pos))
      assert.ok(f.events.some(e => Array.isArray(e) && e[2] === 'start_sneaking'))
      clicks++
      f.cells.set(f.pos.toString(), f.block('scaffolding', f.pos, { distance: '1', bottom: false, waterlogged: false }))
    }
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(clicks, 1)
    assert.equal(f.bot.controlState.sneak, false)
  }
})

function generatedBubbleFixture ({ drag = false, acknowledge = true, actualDrag = drag } = {}) {
  const f = fixture('water', { level: '0' })
  const source = f.block('bubble_column', f.pos, { drag })
  f.task.name = 'water'
  f.task.generatedTarget = { name: 'bubble_column', state: source.stateId }
  f.cells.set(f.pos.offset(0, -1, 0).toString(), f.block('stone', f.pos.offset(0, -1, 0)))
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  f.bot.activateItem = () => {
    f.events.push(['bucket', f.bot.heldItem.name])
    const actual = f.block('bubble_column', f.pos, { drag: actualDrag })
    f.cells.set(f.pos.toString(), actual)
    if (acknowledge) f.bot._client.emit('block_change', { location: f.pos, type: actual.stateId })
    f.bot.emit('test-bucket')
  }
  return f
}

test('source-water tasks accept only their declared natural bubble target through bucket acknowledgement', async () => {
  for (const drag of [false, true]) {
    const f = generatedBubbleFixture({ drag })
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.deepEqual(f.events.filter(event => event[0] === 'bucket'), [['bucket', 'water_bucket']])
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(f.events.filter(event => event[0] === 'bucket').length, 1)
    assert.equal(f.events.some(event => event[0] === 'dig'), false)
  }
})

test('existing wrong-direction or undeclared bubble columns are refused without digging or pouring', async () => {
  for (const declared of [false, true]) {
    const f = generatedBubbleFixture()
    if (!declared) delete f.task.generatedTarget
    f.cells.set(f.pos.toString(), f.block('bubble_column', f.pos, { drag: true }))
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /bubble column/i)
    assert.equal(f.events.some(event => ['dig', 'bucket'].includes(event[0])), false)
  }
})

test('predicted bubbles or wrong-direction raw updates cannot acknowledge a source-water placement', async () => {
  for (const options of [{ acknowledge: false }, { actualDrag: true }]) {
    const f = generatedBubbleFixture(options)
    const controller = new AbortController()
    f.bot.once('test-bucket', () => controller.abort())
    await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { code: 'FLUID_OUTCOME_UNKNOWN' })
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), { code: 'FLUID_OUTCOME_UNKNOWN' })
    assert.equal(f.events.filter(event => event[0] === 'bucket').length, 1)
  }
})

test('a fluid fence treats a bubble column as transparent while retaining the server ray-state fence', async () => {
  const f = waterloggedSlabFixture({ existing: false })
  const overhead = f.pos.offset(0, 2, 0)
  f.bot.entity.pitch = -Math.PI / 2
  f.cells.set(overhead.toString(), f.block('bubble_column', overhead, { drag: false }))
  let fenced = false
  f.build.verifyFluidRay = async blocks => {
    fenced = true
    assert.ok(blocks.some(row => row.pos.equals(overhead)))
    return { verified: true, checked: blocks.length }
  }
  assert.equal((await f.executor.fenceFluid(f.task, f.pos, 1)).fence.verified, true)
  assert.equal(fenced, true)
})

function fireFixture (name, support, { acknowledge = true } = {}) {
  const f = fixture(name)
  f.task.name = name
  f.cells.set(f.pos.offset(0, -1, 0).toString(), f.block(support, f.pos.offset(0, -1, 0)))
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  f.bot._genericPlace = async (reference, face) => {
    f.events.push(['ignite', f.bot.heldItem.name, reference.position.clone(), face.clone()])
    const actual = f.block(name, f.pos)
    f.cells.set(f.pos.toString(), actual)
    if (acknowledge) f.bot._client.emit('block_change', { location: f.pos, type: actual.stateId })
    f.bot.emit('test-ignite')
  }
  return f
}

test('fire targets use flint and steel on only the proper lower support top with raw acknowledgement', async () => {
  for (const [name, support] of [['fire', 'netherrack'], ['soul_fire', 'soul_sand'], ['soul_fire', 'soul_soil']]) {
    const f = fireFixture(name, support)
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    const actions = f.events.filter(event => event[0] === 'ignite')
    assert.equal(actions.length, 1)
    assert.equal(actions[0][1], 'flint_and_steel')
    assert.ok(actions[0][2].equals(f.pos.offset(0, -1, 0)))
    assert.ok(actions[0][3].equals(new Vec3(0, 1, 0)))
    assert.equal(await f.executor.perform(f.task, { layer: 5 }), true)
    assert.equal(f.events.filter(event => event[0] === 'ignite').length, 1)
  }
})

test('fire rejects wrong bases, wrong reference faces and occupied targets without destructive retries', async () => {
  for (const [name, support] of [['fire', 'stone'], ['fire', 'soul_sand'], ['soul_fire', 'netherrack']]) {
    const f = fireFixture(name, support)
    await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /fire.*support|fire.*requires/i)
    assert.equal(f.events.some(event => ['ignite', 'dig'].includes(event[0])), false)
  }
  const occupied = fireFixture('fire', 'netherrack')
  occupied.cells.set(occupied.pos.toString(), occupied.block('stone', occupied.pos))
  assert.equal(await occupied.executor.perform(occupied.task, { layer: 5 }), false)
  assert.equal(occupied.events.some(event => ['ignite', 'dig'].includes(event[0])), false)
  const side = fireFixture('fire', 'netherrack')
  const reference = side.pos.offset(1, 0, 0)
  side.cells.set(reference.toString(), side.block('netherrack', reference))
  side.executor.reach = async () => {}
  side.executor.makeGoal = () => ({ facesPos: [1], getFaceAndRef: () => ({ ref: reference, face: new Vec3(1, 0, 0), to: reference.offset(0, 0.5, 0.5) }) })
  await assert.rejects(side.executor.perform(side.task, { layer: 5 }), /fire.*top|fire.*support/i)
  assert.equal(side.events.some(event => event[0] === 'ignite'), false)
})

test('fire cache prediction without acknowledgement halts instead of reporting successful ignition', async () => {
  const f = fireFixture('fire', 'netherrack', { acknowledge: false })
  const controller = new AbortController()
  f.bot.once('test-ignite', () => controller.abort())
  await assert.rejects(f.executor.perform(f.task, { layer: 5, signal: controller.signal }), { code: 'MUTATION_OUTCOME_UNKNOWN' })
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), { code: 'MUTATION_OUTCOME_UNKNOWN' })
  assert.equal(f.events.filter(event => event[0] === 'ignite').length, 1)
})

test('fire placement stays in its active layer and cannot dispatch after the placement audit rejects it', async () => {
  const f = fireFixture('fire', 'netherrack')
  await assert.rejects(f.executor.perform(f.task, { layer: 6 }), /outside the active layer/)
  f.executor.report = event => {
    if (event.state !== 'placing') return
    assert.ok(event.pos.equals(f.pos))
    assert.equal(event.face, 1)
    assert.equal(event.useItem, false)
    throw new Error('Layer audit rejected ignition')
  }
  await assert.rejects(f.executor.perform(f.task, { layer: 5 }), /Layer audit rejected ignition/)
  assert.equal(f.events.some(event => event[0] === 'ignite'), false)
})

test('powder snow supplies a selectable placement face without becoming a flight obstacle', () => {
  const f = fixture('observer', { facing: 'south' })
  f.executor.useStateComponents = true
  const support = f.pos.offset(0, -1, 0)
  f.cells.set(support.toString(), f.block('powder_snow', support))
  f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
  assert.deepEqual(f.bot.blockAt(support).shapes, [])
  const goal = f.executor.makeGoal(f.task)
  assert.ok(goal.facesPos.length > 0)
  assert.ok(goal.getFaceAndRef(f.executor.eye()).ref.equals(support))
  assert.equal(f.executor.pathing.positionClear(support.offset(0.5, 0.1, 0.5)), true)
  assert.ok(f.executor.interactionGoal(support).getFaceAndRef(f.executor.eye()))
})

test('lever selection outlines support ordinary power adjustment for every attachment', async () => {
  for (const face of ['floor', 'wall', 'ceiling']) {
    for (const facing of ['north', 'south', 'east', 'west']) {
      const properties = { face, facing, powered: true }
      const f = fixture('lever', properties)
      f.cells.set(f.pos.toString(), f.block('lever', f.pos, { ...properties, powered: false }))
      f.bot.world.raycast = require('prismarine-world/src/worldsync').prototype.raycast
      const direction = { north: [0, 0, -2], south: [0, 0, 2], east: [2, 0, 0], west: [-2, 0, 0] }[facing]
      f.bot.entity.position = f.pos.offset(direction[0] + 0.5, -0.62, direction[2] + 0.5)
      assert.deepEqual(f.bot.blockAt(f.pos).shapes, [], 'selection must not invent a movement collision')
      assert.ok(f.executor.interactionGoal(f.pos).getFaceAndRef(f.executor.eye()), `${face}/${facing} must be selectable`)
      let clicks = 0
      f.bot._genericPlace = async ref => {
        assert.ok(ref.position.equals(f.pos))
        assert.equal(f.bot.heldItem.name, 'lever')
        assert.equal(f.bot.controlState.sneak, false)
        clicks++
        f.cells.set(f.pos.toString(), f.block('lever', f.pos, properties))
      }
      assert.equal(await f.executor.adjust(f.task), true)
      assert.equal(clicks, 1)
    }
  }
})

test('audited persistent dirt scaffolds replace water through an adjacent right click', async () => {
  for (const audit of [{ purpose: 'fluid-staging' }, { purpose: 'fluid-reference', replacesDerived: 'flow:0,5,0' }]) {
    const f = fixture('dirt')
    const support = f.pos.offset(1, 0, 0)
    f.cells.set(f.pos.toString(), f.block('water', f.pos, { level: audit.purpose === 'fluid-staging' ? '0' : '8' }))
    f.cells.set(support.toString(), f.block('stone', support))
    f.executor.reach = async () => {}
    f.executor.makeGoal = () => ({ facesPos: [1], getFaceAndRef: () => ({ ref: support, face: new Vec3(1, 0, 0), to: support.offset(0, 0.5, 0.5) }) })
    f.bot.dig = async () => { throw new Error('Water must not be dug') }
    let clicks = 0
    f.bot._genericPlace = async (ref, face) => {
      assert.ok(ref.position.plus(face).equals(f.pos))
      clicks++
      setTimeout(() => {
        f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
        f.bot._client.emit('block_change', { location: f.pos, type: f.wanted.stateId })
      }, 10)
    }
    const task = { ...f.task, name: 'dirt', scaffold: true, persistent: true, ...audit }
    assert.equal(await f.executor.perform(task, { layer: 5 }), true)
    assert.equal(clicks, 1)
  }
})

test('fluid replacement does not expand to unaudited tasks or non-dirt materials', async () => {
  for (const [name, audit] of [['dirt', {}], ['dirt', { scaffold: true }], ['stone', { scaffold: true, persistent: true, purpose: 'fluid-staging' }]]) {
    const f = fixture(name)
    f.cells.set(f.pos.toString(), f.block('water', f.pos, { level: '0' }))
    f.bot.dig = async () => { throw new Error('Water must not be dug') }
    await assert.rejects(f.executor.perform({ ...f.task, name, ...audit }, { layer: 5 }), /Only audited temporary dirt supports may replace water/)
    assert.equal(f.events.some(e => Array.isArray(e) && ['dig', 'place'].includes(e[0])), false)
  }
})

test('digging switches away from debug stick before starting the ordinary dig', async () => {
  const f = fixture('dirt')
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  await f.executor.equipDebugStick('powered_rail', 'shape')
  f.executor.reach = async () => {}
  f.bot.dig = async block => {
    assert.equal(f.bot.heldItem.name, 'diamond_pickaxe')
    f.cells.delete(block.position.toString())
    f.bot._client.emit('block_change', { location: block.position, type: 0 })
  }
  assert.equal(await f.executor.perform({ ...f.task, type: 'dig' }, { layer: 5 }), true)
})

test('optimistic local air cannot satisfy cleanup without a server block update', async () => {
  const f = fixture('dirt')
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  f.executor.reach = async () => {}
  f.bot.dig = async block => { f.cells.delete(block.position.toString()) }
  const task = { ...f.task, type: 'dig' }
  await assert.rejects(f.executor.perform(task, { layer: 5 }), /confirmed by server/)
  assert.equal(f.executor.satisfied(task), false)
  await assert.rejects(f.executor.perform(task, { layer: 5 }), /confirmed by server/)
  f.bot._client.emit('block_change', { location: f.pos, type: 0 })
  assert.equal(f.executor.satisfied(task), true)
})

test('section block updates confirm a dig and listeners leave with the connection', async () => {
  const f = fixture('dirt')
  f.cells.set(f.pos.toString(), f.block('dirt', f.pos))
  f.executor.reach = async () => {}
  f.bot.dig = async block => {
    f.cells.delete(block.position.toString())
    f.bot._client.emit('multi_block_change', { chunkCoordinates: { x: 0, y: 0, z: 0 }, records: [5] })
  }
  assert.equal(await f.executor.perform({ ...f.task, type: 'dig' }, { layer: 5 }), true)
  assert.equal(f.executor.unconfirmedDigs.size, 0)
  f.bot.emit('end')
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
  assert.equal(f.bot._client.listenerCount('multi_block_change'), 0)
})
