const test = require('node:test')
const assert = require('node:assert/strict')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { normalizeDecorationEntities, decorationEntityData, decorationDifferences } = require('../lib/physicalDecorationsData')

function plan (...entities) {
  return {
    version: '1.21.11',
    origin: { x: 100, y: -20, z: 200 },
    sourceMin: { x: -5, y: 2, z: -8 },
    entities: entities.map(data => ({ regionPosition: { x: -2, y: 4, z: 10 }, regionMin: { x: -2, y: 4, z: -10 }, data }))
  }
}

function entity (data) {
  return normalizeDecorationEntities(plan({ id: 'minecraft:armor_stand', Pos: [0.5, 1, -2.25], Rotation: [180, 0], ...data }))[0]
}

test('projects negative region positions and preserves original indices while skipping minecarts', () => {
  const source = { id: 'minecraft:armor_stand', Pos: [0.5, 1, -2.25], Rotation: [180, 0] }
  const values = normalizeDecorationEntities(plan({ id: 'minecraft:minecart' }, source, { id: 'minecraft:chest_minecart' }, { id: 'minecraft:hopper_minecart' }))
  assert.equal(values.length, 1)
  assert.equal(values[0].id, 'entity:1:armor_stand')
  assert.equal(values[0].name, 'armor_stand')
  assert.equal(values[0].type, 'armor_stand')
  assert.deepEqual(values[0].pos, new Vec3(103.5, -17, 215.75))
  assert.equal(values[0].source, source)
  assert.equal(values[0].flags.NoGravity, false)
})

test('transforms legacy hanging coordinates independently from fractional entity positions', () => {
  const frame = entity({ id: 'minecraft:glow_item_frame', Pos: [2.96875, 3.5, -4.5], Facing: 4, TileX: 2, TileY: 3, TileZ: -5 })
  assert.deepEqual(frame.pos, new Vec3(105.96875, -14.5, 213.5))
  assert.deepEqual(frame.anchor, new Vec3(105, -15, 213))
  assert.equal(frame.facing, 4)
})

test('reads raw Sponge entities and modern block_pos using the schematic origin', () => {
  const p = { version: '1.21.11', format: 'sponge', origin: { x: 7, y: 8, z: 9 }, sourceMin: { x: 0, y: 0, z: 0 }, entities: [{ id: 'minecraft:item_frame', Pos: [2.5, 3.5, 4.03125], block_pos: [2, 3, 4], Facing: 3 }] }
  const frame = normalizeDecorationEntities(p)[0]
  assert.deepEqual(frame.pos, new Vec3(9.5, 11.5, 13.03125))
  assert.deepEqual(frame.anchor, new Vec3(9, 11, 13))
  p.entities[0].data = {}
  assert.deepEqual(normalizeDecorationEntities(p)[0].anchor, new Vec3(9, 11, 13))
})

test('rejects unknown entities and malformed positions without silently filtering them', () => {
  assert.throws(() => normalizeDecorationEntities(plan({ id: 'minecraft:pig', Pos: [0, 0, 0] })), /Unsupported.*entity/)
  assert.throws(() => entity({ Pos: [0, NaN, 0] }), /Pos/)
  assert.throws(() => entity({ id: 'minecraft:item_frame', Facing: 12 }), /facing/i)
  const p = plan({ id: 'minecraft:armor_stand', Pos: [0, 0, 0] })
  delete p.entities[0].regionPosition
  assert.throws(() => normalizeDecorationEntities(p), /regionPosition/)
})

test('migrates old armor and frame stacks to modern equipment and components', () => {
  const stand = entity({ ArmorItems: [{}, {}, {}, { id: 'minecraft:netherite_helmet', Count: 1, tag: { Damage: 17 } }], HandItems: [{ id: 'minecraft:stick', Count: 1 }, {}] })
  assert.deepEqual(stand.equipment.head, { id: 'minecraft:netherite_helmet', count: 1, components: { 'minecraft:damage': 17 } })
  assert.deepEqual(stand.equipment.mainhand, { id: 'minecraft:stick', count: 1 })
  assert.equal(stand.equipment.chest, null)
  const frame = entity({ id: 'minecraft:item_frame', Facing: 1, Item: { id: 'minecraft:cooked_beef', Count: 1 }, ItemRotation: 3 })
  assert.deepEqual(frame.item, { id: 'minecraft:cooked_beef', count: 1 })
  assert.equal(frame.itemRotation, 3)
})

test('keeps modern equipment and rejects conflicting legacy copies', () => {
  const stand = entity({ equipment: { head: { id: 'minecraft:netherite_helmet', count: 1, components: { 'minecraft:damage': 4 } } } })
  assert.equal(stand.equipment.head.components['minecraft:damage'], 4)
  assert.throws(() => entity({ equipment: { head: { id: 'minecraft:netherite_helmet', count: 1 } }, ArmorItems: [{}, {}, {}, { id: 'minecraft:diamond_helmet', Count: 1 }] }), /Conflicting.*equipment/)
})

test('rejects unsupported item data instead of losing tags or components', () => {
  const frame = Item => entity({ id: 'minecraft:item_frame', Facing: 1, Item })
  assert.throws(() => frame({ id: 'minecraft:stick', Count: 1, tag: { display: { Name: 'special' } } }), /Unsupported.*tag/)
  assert.throws(() => frame({ id: 'minecraft:stick', count: 1, components: { 'minecraft:custom_data': { secret: 1 } } }), /Unsupported.*component/)
  assert.throws(() => frame({ id: 'minecraft:stick', Count: 1, count: 2 }), /Conflicting.*count/)
  assert.throws(() => frame({ id: 'minecraft:stick', Count: 1, unknown: 1 }), /Unsupported.*field/)
  assert.throws(() => frame({ id: 'minecraft:does_not_exist', count: 1 }), /Unsupported.*item/)
  assert.throws(() => frame({ id: 'minecraft:netherite_helmet', count: 2 }), /stack/i)
})

test('serializes exact fractional positions, explicit gravity and modern equipment as typed NBT', () => {
  const stand = entity({ ArmorItems: [{}, {}, {}, { id: 'minecraft:netherite_helmet', Count: 1, tag: { Damage: 0 } }], Pose: {} })
  const tag = decorationEntityData(stand)
  assert.equal(tag.type, 'compound')
  assert.equal(tag.value.Pos.value.type, 'double')
  assert.equal(tag.value.Rotation.value.type, 'float')
  assert.deepEqual(nbt.simplify(tag).Pos, [103.5, -17, 215.75])
  assert.equal(tag.value.NoGravity.type, 'byte')
  assert.equal(nbt.simplify(tag).NoGravity, 0)
  assert.deepEqual(nbt.simplify(tag).equipment.head, { id: 'minecraft:netherite_helmet', count: 1, components: { 'minecraft:damage': 0 } })
  assert.equal(tag.value.equipment.value.head.value.count.type, 'int')
  assert.equal(tag.value.ArmorItems, undefined)
  assert.deepEqual(nbt.simplify(nbt.parseUncompressed(nbt.writeUncompressed(tag))).Pos, [103.5, -17, 215.75])
})

test('writes distinct frame and painting attachment schemas', () => {
  const frame = entity({ id: 'minecraft:item_frame', Pos: [2.96875, 3.5, -4.5], Facing: 4, TileX: 2, TileY: 3, TileZ: -5, Item: { id: 'minecraft:cooked_beef', Count: 1 }, ItemRotation: 2 })
  const frameTag = decorationEntityData(frame)
  assert.deepEqual(frameTag.value.block_pos, { type: 'intArray', value: [105, -15, 213] })
  assert.deepEqual(frameTag.value.Facing, { type: 'byte', value: 4 })
  assert.equal(nbt.simplify(frameTag).Item.count, 1)
  assert.equal(nbt.simplify(frameTag).ItemRotation, 2)
  const painting = entity({ id: 'minecraft:painting', Pos: [2.5, 3.5, -4.96875], TileX: 2, TileY: 3, TileZ: -5, facing: 0, variant: 'minecraft:wasteland' })
  const paintingTag = decorationEntityData(painting)
  assert.deepEqual(paintingTag.value.facing, { type: 'byte', value: 0 })
  assert.equal(paintingTag.value.Facing, undefined)
  assert.equal(nbt.simplify(paintingTag).variant, 'minecraft:wasteland')
})

test('verification ignores transient data and compares default poses and equivalent rotations', () => {
  const stand = entity({ ArmorItems: [{}, {}, {}, { id: 'minecraft:netherite_helmet', Count: 1, tag: { Damage: 0 } }], Pose: {} })
  const actual = { id: 'minecraft:armor_stand', Pos: [103.52, -17, 215.75], Rotation: [-180, 360], equipment: { head: { id: 'minecraft:netherite_helmet', count: 1 } }, UUID: [1, 2, 3, 4], Motion: [1, -8, 9], OnGround: 0, Health: 19 }
  assert.deepEqual(decorationDifferences(stand, actual), [])
  assert.ok(decorationDifferences(stand, { ...actual, Pos: [103.55, -17, 215.75] }).some(s => /Pos|position/.test(s)))
  assert.ok(decorationDifferences(stand, { ...actual, Rotation: [90, 0] }).some(s => /Rotation|rotation/.test(s)))
  assert.ok(decorationDifferences(stand, { ...actual, NoGravity: 1 }).some(s => /NoGravity/.test(s)))
  assert.ok(decorationDifferences(stand, { ...actual, equipment: {} }).some(s => /head|equipment/.test(s)))
  assert.ok(decorationDifferences(stand, { ...actual, Pose: { Head: [15, 0, 0] } }).some(s => /Pose|pose/.test(s)))
})

test('verification accepts modern runtime fields while retaining visual fire semantics', () => {
  const stand = entity({ HasVisualFire: 0 })
  const actual = { id: 'minecraft:armor_stand', Pos: [103.5, -17, 215.75], Rotation: [-180, 0], fall_distance: 0, HasVisualFire: 0, data: {} }
  assert.deepEqual(decorationDifferences(stand, actual), [])
  assert.ok(decorationDifferences(stand, { ...actual, HasVisualFire: 1 }).some(s => /HasVisualFire/.test(s)))
  assert.throws(() => entity({ data: { custom: 1 } }), /custom.*data|data/i)
})

test('verification checks attached item, anchor, facing, rotation, variant and flags', () => {
  const frame = entity({ id: 'minecraft:item_frame', Pos: [2.5, 3.03125, -4.5], Facing: 1, TileX: 2, TileY: 3, TileZ: -5, Item: { id: 'minecraft:cooked_beef', Count: 1 } })
  const actual = { id: 'minecraft:item_frame', Pos: [105.5, -14.96875, 213.5], Rotation: [180, 0], block_pos: [105, -15, 213], Facing: 1, Item: { id: 'minecraft:cooked_beef', count: 1 }, ItemRotation: 0 }
  assert.deepEqual(decorationDifferences(frame, actual), [])
  for (const change of [{ Item: { id: 'minecraft:cooked_chicken', count: 1 } }, { ItemRotation: 1 }, { Facing: 0 }, { block_pos: [104, -15, 213] }, { Invisible: 1 }, { Fixed: 1 }]) assert.ok(decorationDifferences(frame, { ...actual, ...change }).length > 0)
  const painting = entity({ id: 'minecraft:painting', Pos: [2.5, 3.5, -4.96875], TileX: 2, TileY: 3, TileZ: -5, facing: 0, variant: 'minecraft:wasteland' })
  const observed = { id: 'minecraft:painting', Pos: [105.5, -14.5, 213.03125], Rotation: [180, 0], block_pos: [105, -15, 213], facing: 0, variant: 'minecraft:wasteland' }
  assert.deepEqual(decorationDifferences(painting, observed), [])
  assert.ok(decorationDifferences(painting, { ...observed, variant: 'minecraft:kebab' }).some(s => /variant/.test(s)))
})

test('rejects malformed decorative customization instead of changing its meaning', () => {
  assert.throws(() => entity({ Pose: { UnknownLimb: [0, 0, 0] } }), /Pose|pose/)
  assert.throws(() => entity({ Pose: { Head: [0, 1] } }), /Pose|pose/)
  assert.throws(() => entity({ equipment: { saddle: { id: 'minecraft:saddle', count: 1 } } }), /equipment/)
  assert.throws(() => entity({ NoGravity: 2 }), /NoGravity/)
  assert.throws(() => entity({ Passengers: [{ id: 'minecraft:pig' }] }), /Passengers|customization/)
  assert.throws(() => entity({ id: 'minecraft:painting', facing: 0 }), /variant/)
})
