const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { RaycastIterator } = require('prismarine-world/src/iterators')
const { PhysicalDecorations } = require('../lib/physicalDecorations')

function fixture (name = 'armor_stand') {
  const registry = require('minecraft-data')('1.21.11')
  const Block = require('prismarine-block')('1.21.11')
  const blocks = new Map()
  const put = (name, x, y, z) => {
    const block = Block.fromStateId(registry.blocksByName[name].minStateId, 0)
    block.position = new Vec3(x, y, z)
    blocks.set(`${x},${y},${z}`, block)
    return block
  }
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) put('stone', x, 0, z)
  const events = []
  const actions = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    version: '1.21.11',
    registry,
    _client: { ended: false },
    entity: { id: 1, position: new Vec3(0.5, 1.1, 3.5), eyeHeight: 1.62, yaw: 0, pitch: 0 },
    entities: {},
    inventory: { slots: Array(46).fill(null) },
    quickBarSlot: 2,
    blockAt (position) {
      const pos = position.floored()
      return blocks.get(`${pos.x},${pos.y},${pos.z}`) || Object.assign(Block.fromStateId(0, 0), { position: pos })
    },
    setQuickBarSlot (slot) { bot.quickBarSlot = slot; bot.heldItem = bot.inventory.slots[36 + slot] },
    creative: { async setInventorySlot (slot, item) { actions.push(['slot', slot, item]); bot.inventory.slots[slot] = item } },
    getControlState: () => false,
    setControlState: (name, value) => actions.push(['control', name, value]),
    waitForTicks: async () => {},
    world: {
      raycast (eye, direction, distance) {
        let nearest
        for (const block of blocks.values()) {
          const hit = new RaycastIterator(eye, direction, distance).intersect(block.shapes, block.position)
          if (hit && (!nearest || hit.pos.distanceTo(eye) < nearest.intersect.distanceTo(eye))) nearest = { ...block, face: hit.face, intersect: hit.pos }
        }
        return nearest
      }
    }
  })
  const entity = {
    id: `decoration:${name}`,
    name,
    pos: new Vec3(0.5, 1, 0.5),
    anchor: name === 'armor_stand' ? null : new Vec3(0, 1, 0),
    facing: name === 'armor_stand' ? null : 1,
    rotation: [0, 0],
    equipment: {},
    item: null,
    variant: name === 'painting' ? 'minecraft:kebab' : null,
    flags: { NoGravity: false, Invisible: false, ...(name.includes('item_frame') ? { Fixed: false } : {}) },
    pose: {},
    itemRotation: 0,
    itemDropChance: 1,
    source: { id: `minecraft:${name}`, Pos: [0.5, 1, 0.5], Rotation: [0, 0], NoGravity: 0, Pose: {} }
  }
  let observed = null
  const snapshot = {
    async readDecoration () { actions.push(['read']); return observed }
  }
  bot._genericPlace = async (reference, face, options) => {
    actions.push(['place', reference.position.clone(), face.clone(), options, bot.heldItem])
    observed = { uuid: '00000000-0000-0000-0000-000000000001', pos: entity.pos.clone(), entity: { ...entity.source, Pos: [entity.pos.x, entity.pos.y, entity.pos.z] }, differences: [], evidence: ['readback'] }
  }
  const executor = {
    async reach (goal) { assert.ok(goal.getFaceAndRef(bot.entity.position.offset(0, 1.62, 0))) },
    async orient (point) {
      actions.push(['orient', point.clone()])
      const delta = point.minus(bot.entity.position.offset(0, 1.62, 0))
      bot.entity.yaw = Math.atan2(-delta.x, -delta.z)
      bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z))
    },
    async mutate (exclusive, signal, action) { actions.push(['mutation', exclusive]); return action() },
    setSneaking (value) { actions.push(['sneak', value]) }
  }
  const decorations = new PhysicalDecorations({ bot, executor, snapshot, onEvent: event => events.push(event) })
  return { bot, entity, executor, snapshot, decorations, actions, events, put, blocks, setObserved: value => { observed = value } }
}

test('decoration placement reuses an exact snapshot and never duplicates it', async () => {
  const f = fixture()
  f.setObserved({ uuid: 'existing', pos: f.entity.pos, entity: f.entity.source, differences: [], evidence: [] })
  const result = await f.decorations.placeDecoration(f.entity)
  assert.equal(result.reused, true)
  assert.equal(result.uuid, 'existing')
  assert.equal(f.actions.some(action => action[0] === 'place' || action[0] === 'slot'), false)
})

test('a mismatching existing snapshot stops before placing another entity', async () => {
  const f = fixture()
  f.setObserved({ uuid: 'existing', pos: f.entity.pos, entity: f.entity.source, differences: ['equipment.head'], evidence: ['mismatch'] })
  await assert.rejects(f.decorations.placeDecoration(f.entity), /equipment.head/)
  assert.equal(f.actions.some(action => action[0] === 'place'), false)
})

test('armor stands use a normal right click with target entity_data and retain source gravity', async () => {
  const f = fixture()
  // The saved destination can overlap blocks; the initial player click must be clear.
  f.put('stone', 0, 1, 0)
  const result = await f.decorations.placeDecoration(f.entity)
  const placements = f.actions.filter(action => action[0] === 'place')
  assert.equal(placements.length, 1)
  const [, reference, face, options, item] = placements[0]
  assert.notDeepEqual(reference, new Vec3(0, 0, 0))
  assert.deepEqual(face, new Vec3(0, 1, 0))
  assert.equal(options.forceLook, 'ignore')
  const component = item.components.find(component => component.type === 'entity_data')
  assert.equal(component.data.type, f.bot.registry.entitiesByName.armor_stand.id)
  assert.deepEqual(component.data.data.value.Pos.value.value, [0.5, 1, 0.5])
  assert.equal(component.data.data.value.NoGravity.value, 0)
  assert.equal(result.verified, true)
  assert.equal(result.reused, false)
  assert.equal(result.uuid, '00000000-0000-0000-0000-000000000001')
  assert.equal(f.bot.quickBarSlot, 2)
  assert.equal(f.bot.inventory.slots[44], null)
})

test('armor stand click selection preserves the requested Minecraft yaw', async () => {
  const f = fixture()
  f.entity.rotation = [90, 0]
  f.bot.entity.position = new Vec3(-2.5, 1.1, 0.5)
  await f.decorations.placeDecoration(f.entity)
  const aim = f.actions.find(action => action[0] === 'orient')[1]
  const delta = aim.minus(f.bot.entity.position.offset(0, 1.62, 0))
  assert.ok(delta.x > 0)
  assert.ok(Math.abs(delta.z) < 1e-8)
})

test('unreachable or obstructed clicks fail before inventory mutation', async () => {
  const f = fixture()
  f.bot.world.raycast = () => ({ position: new Vec3(99, 99, 99), face: 1 })
  await assert.rejects(f.decorations.placeDecoration(f.entity), /reachable|unobstructed|face/i)
  assert.equal(f.actions.some(action => action[0] === 'place' || action[0] === 'slot'), false)
})

test('changed source collision invalidates a selected click before use', async () => {
  const f = fixture()
  const orient = f.executor.orient
  f.executor.orient = async point => {
    await orient(point)
    for (const block of f.blocks.values()) if (block.position.y === 0) f.put('stone', block.position.x, 1, block.position.z)
  }
  await assert.rejects(f.decorations.placeDecoration(f.entity), /changed|clear|face|obstructed/i)
  assert.equal(f.actions.some(action => action[0] === 'place'), false)
})

test('readback differences after a sent click fail without a second click', async () => {
  const f = fixture()
  const place = f.bot._genericPlace
  f.bot._genericPlace = async (...args) => {
    await place(...args)
    f.setObserved({ uuid: 'wrong', pos: f.entity.pos, entity: f.entity.source, differences: ['Pose.Head'], evidence: ['readback'] })
  }
  await assert.rejects(f.decorations.placeDecoration(f.entity), /Pose.Head/)
  assert.equal(f.actions.filter(action => action[0] === 'place').length, 1)
  assert.equal(f.bot.quickBarSlot, 2)
})

test('verification enforces the UUID claimed by this placer', async () => {
  const f = fixture()
  await f.decorations.placeDecoration(f.entity)
  const verified = await f.decorations.verifyDecorations([f.entity])
  assert.equal(verified.verified, true)
  assert.equal(verified.checked, 1)
  f.setObserved({ uuid: 'replacement', pos: f.entity.pos, entity: f.entity.source, differences: [], evidence: [] })
  await assert.rejects(f.decorations.verifyDecorations([f.entity]), /UUID|identity/i)
})

test('cancelled decoration work does not read or change the world', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.decorations.placeDecoration(f.entity, { signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(f.actions, [])
})

test('floor frames can share a pressure plate cell and retain the target anchor and displayed item', async () => {
  const f = fixture('item_frame')
  f.entity.pos = new Vec3(0.5, 1.03125, 0.5)
  f.entity.item = { id: 'minecraft:diamond', count: 1 }
  f.put('stone_pressure_plate', 0, 1, 0)
  await f.decorations.placeDecoration(f.entity)
  const placed = f.actions.find(action => action[0] === 'place')[4]
  const nbt = placed.components[0].data.data.value
  assert.deepEqual(nbt.block_pos.value, [0, 1, 0])
  assert.equal(nbt.Facing.value, 1)
  assert.equal(nbt.Item.value.id.value, 'minecraft:diamond')
})

test('paintings click an existing wall with a clear one-block hanging volume', async () => {
  const f = fixture('painting')
  f.entity.pos = new Vec3(0.5, 1.5, 1.03125)
  f.entity.anchor = new Vec3(0, 1, 1)
  f.entity.facing = 0
  f.put('stone', 0, 1, 0)
  await f.decorations.placeDecoration(f.entity)
  const placement = f.actions.find(action => action[0] === 'place')
  assert.deepEqual(placement[1], new Vec3(0, 1, 0))
  assert.deepEqual(placement[2], new Vec3(0, 0, 1))
  const nbt = placement[4].components[0].data.data.value
  assert.deepEqual(nbt.block_pos.value, [0, 1, 1])
  assert.equal(nbt.facing.value, 0)
  assert.equal(nbt.variant.value, 'minecraft:kebab')
})

test('cancellation in the final duplicate check leaves the saved inventory untouched', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.bot.inventory.slots[44] = { type: 1, count: 1 }
  let reads = 0
  f.snapshot.readDecoration = async () => {
    if (++reads === 2) controller.abort()
    return null
  }
  await assert.rejects(f.decorations.placeDecoration(f.entity, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.actions.some(action => action[0] === 'slot' || action[0] === 'place'), false)
})

test('cancellation interrupts the settled-position wait after one player click', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.bot.waitForTicks = () => {
    controller.abort()
    return new Promise(() => {})
  }
  await assert.rejects(f.decorations.placeDecoration(f.entity, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.actions.filter(action => action[0] === 'place').length, 1)
  assert.equal(f.bot.quickBarSlot, 2)
})
