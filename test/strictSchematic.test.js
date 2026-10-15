const test = require('node:test')
const assert = require('node:assert/strict')
const { decodeLitematic, decodeSponge, resolveState, matchesTarget, matchesPhysicalTarget, preparePhysicalPlan, inspectPlan, createBuildContext, itemNameForBlock, pottedPlantForBlock } = require('../lib/strictSchematic')
const Block = require('prismarine-block')('1.21.4')

test('wall heads and every registered potted plant retain active physical tasks and valid materials', () => {
  for (const version of ['1.21.4', '1.21.11']) {
    const data = require('minecraft-data')(version)
    const names = Object.keys(data.blocksByName).filter(name => name.startsWith('potted_') || /_wall_(skull|head)$/.test(name))
    const plan = decodeSponge({
      Width: names.length,
      Height: 1,
      Length: 1,
      Palette: Object.fromEntries(names.map((name, index) => [`minecraft:${name}`, index])),
      BlockData: names.map((_, index) => index)
    }, version, { x: 0, y: 64, z: 0 })
    assert.deepEqual(inspectPlan(plan).issues, [])
    assert.equal(preparePhysicalPlan(plan).tasks.length, names.length)
    assert.equal(preparePhysicalPlan(plan).derived.length, 0)
    const context = createBuildContext(plan, {})
    for (const task of plan.tasks) {
      assert.ok(context.items[task.state], task.name)
      if (task.name.startsWith('potted_')) {
        assert.equal(itemNameForBlock(task.name), 'flower_pot')
        assert.ok(data.itemsByName[pottedPlantForBlock(task.name)], task.name)
      } else {
        assert.equal(itemNameForBlock(task.name), task.name.replace('_wall_', '_'))
        assert.equal(context.getFacing(task.state, 'north').faceDirection, true, task.name)
      }
    }
  }
  assert.equal(pottedPlantForBlock('potted_azalea_bush'), 'azalea')
  assert.equal(pottedPlantForBlock('potted_flowering_azalea_bush'), 'flowering_azalea')
  assert.equal(pottedPlantForBlock('potted_bamboo'), 'bamboo')
  assert.equal(pottedPlantForBlock('bamboo'), null)
})

test('integer state migration preserves the requested tree and distance', () => {
  const block = resolveState('oak_leaves', { distance: '7', persistent: 'true', waterlogged: 'false' }, '1.21.4')
  assert.equal(block.name, 'oak_leaves')
  assert.equal(String(block.getProperties().distance), '7')
  assert.throws(() => resolveState('oak_leaves', { distance: '9' }, '1.21.4'), /Invalid/)
  assert.throws(() => resolveState('stone', { missing: 'true' }, '1.21.4'), /Unknown property/)
})

test('head power is live while skull direction and standing rotation remain exact', () => {
  const version = '1.21.11'
  const wanted = resolveState('wither_skeleton_wall_skull', { facing: 'east', powered: false }, version)
  assert.equal(matchesTarget(wanted, resolveState(wanted.name, { facing: 'east', powered: true }, version)), true)
  assert.equal(matchesTarget(wanted, resolveState(wanted.name, { facing: 'west', powered: true }, version)), false)
  assert.equal(matchesTarget(wanted, resolveState(wanted.name, { facing: 'east', powered: true }, version), { exact: true }), false)
  const standing = resolveState('wither_skeleton_skull', { rotation: '3', powered: false }, version)
  assert.equal(matchesTarget(standing, resolveState(standing.name, { rotation: '3', powered: true }, version)), true)
  assert.equal(matchesTarget(standing, resolveState(standing.name, { rotation: '4', powered: false }, version)), false)
})

test('legacy chains map only when the target registry renamed them and preserve every state', () => {
  for (const axis of ['x', 'y', 'z']) {
    for (const waterlogged of ['false', 'true']) {
      const migrated = resolveState('minecraft:chain', { axis, waterlogged }, '1.21.11')
      assert.equal(migrated.name, 'iron_chain')
      assert.equal(migrated.getProperties().axis, axis)
      assert.equal(String(migrated.getProperties().waterlogged), waterlogged)
      assert.equal(migrated.stateId, resolveState('iron_chain', { axis, waterlogged }, '1.21.11').stateId)
    }
  }
  assert.equal(resolveState('chain', { axis: 'z' }, '1.21.4').name, 'chain')
  for (const name of ['iron_chain', 'copper_chain', 'chain_command_block']) assert.equal(resolveState(name, {}, '1.21.11').name, name)
  assert.throws(() => resolveState('minecraft:chain', { axis: 'invalid' }, '1.21.11'), /Invalid block state/)
  assert.throws(() => resolveState('minecraft:chain', { missing: 'true' }, '1.21.11'), /Unknown property/)
  assert.throws(() => resolveState('minecraft:not_a_chain', {}, '1.21.11'), /Unsupported block/)
  assert.throws(() => resolveState('iron_chain', {}, '1.21.4'), /Unsupported block/)
})

test('both schematic formats migrate legacy chain palettes through physical item selection', () => {
  const axes = ['x', 'y', 'z']
  const litematic = decodeLitematic({
    MinecraftDataVersion: 4189,
    Regions: {
      main: {
        Position: { x: 0, y: 0, z: 0 },
        Size: { x: 3, y: 1, z: 1 },
        BlockStatePalette: axes.map(axis => ({ Name: 'minecraft:chain', Properties: { axis, waterlogged: 'false' } })),
        BlockStates: [[0, 36]]
      }
    }
  }, '1.21.11', { x: 16, y: 64, z: 16 })
  const sponge = decodeSponge({
    DataVersion: 4189,
    Width: 3,
    Height: 1,
    Length: 1,
    Palette: Object.fromEntries(axes.map((axis, index) => [`minecraft:chain[axis=${axis},waterlogged=false]`, index])),
    BlockData: [0, 1, 2]
  }, '1.21.11', { x: 16, y: 64, z: 16 })
  for (const plan of [litematic, sponge]) {
    assert.deepEqual(plan.tasks.map(task => task.name), ['iron_chain', 'iron_chain', 'iron_chain'])
    assert.deepEqual(inspectPlan(plan).issues, [])
    assert.equal(preparePhysicalPlan(plan).tasks.length, 3)
    const context = createBuildContext(plan, {})
    for (const [index, task] of plan.tasks.entries()) {
      assert.equal(context.blocks[task.state].getProperties().axis, axes[index])
      assert.equal(context.items[task.state].name, 'iron_chain')
    }
  }
})

test('negative region sizes use the minimum corner without reversing storage', () => {
  const plan = decodeLitematic({
    Metadata: { Name: 'negative' },
    Regions: {
      part: {
        Position: { x: 10, y: 4, z: 8 },
        Size: { x: -2, y: 1, z: 1 },
        BlockStatePalette: [{ Name: 'minecraft:air' }, { Name: 'minecraft:stone' }, { Name: 'minecraft:dirt' }],
        BlockStates: [[0, 9]],
        TileEntities: [],
        Entities: []
      }
    }
  }, '1.21.4', { x: 100, y: 64, z: 100 })
  assert.deepEqual(plan.tasks.map(t => [t.pos.x, t.pos.y, t.pos.z, t.name]), [[100, 64, 100, 'stone'], [101, 64, 100, 'dirt']])
  assert.deepEqual(plan.sourceMin, { x: 9, y: 4, z: 8 })
})

test('packed palette indices straddle a signed 64 bit boundary', () => {
  const plan = decodeLitematic({
    Regions: {
      p: {
        Position: { x: 0, y: 0, z: 0 },
        Size: { x: 22, y: 1, z: 1 },
        BlockStatePalette: ['air', 'stone', 'dirt', 'glass', 'obsidian', 'gold_block'].map(n => ({ Name: 'minecraft:' + n })),
        BlockStates: [[-2147483648, 0], [0, 2]],
        TileEntities: [],
        Entities: []
      }
    }
  }, '1.21.4', { x: 0, y: 0, z: 0 })
  assert.equal(plan.tasks.length, 1)
  assert.equal(plan.tasks[0].pos.x, 21)
  assert.equal(plan.tasks[0].name, 'gold_block')
  assert.equal(plan.air.length, 21)
})

test('layer matching keeps repeater direction and delay while allowing live power', () => {
  const wanted = resolveState('repeater', { facing: 'east', delay: '4', powered: 'true' }, '1.21.4')
  const actual = resolveState('repeater', { facing: 'east', delay: '4', powered: 'false' }, '1.21.4')
  assert.equal(matchesTarget(wanted, actual), true)
  assert.equal(matchesTarget(wanted, actual, { exact: true }), false)
  assert.equal(matchesTarget(wanted, resolveState('repeater', { facing: 'east', delay: '1' }, '1.21.4')), false)
  assert.equal(matchesTarget(wanted, Block.fromStateId(0, 0)), false)
})

test('overlapping region block entities compare content independent of local coordinates', () => {
  const region = (x, size, tileX, customName) => ({
    Position: { x, y: 0, z: 0 },
    Size: { x: size, y: 1, z: 1 },
    BlockStatePalette: [{ Name: 'minecraft:chest' }],
    BlockStates: [[0, 0]],
    TileEntities: [{ x: tileX, y: 0, z: 0, id: 'minecraft:chest', CustomName: customName }]
  })
  const input = { Regions: { a: region(0, 2, 1, 'same'), b: region(1, 1, 0, 'same') } }
  assert.equal(decodeLitematic(input, '1.21.4', { x: 0, y: 0, z: 0 }).blockEntities.length, 1)
  input.Regions.b.TileEntities[0].CustomName = 'conflict'
  assert.throws(() => decodeLitematic(input, '1.21.4', { x: 0, y: 0, z: 0 }), /Conflicting block entities/)
})

test('wire matching preserves manual dot mode while allowing natural connection and power changes', () => {
  const dot = resolveState('redstone_wire', { north: 'none', south: 'none', east: 'none', west: 'none' })
  const cross = resolveState('redstone_wire', { north: 'side', south: 'side', east: 'side', west: 'side' })
  const connected = resolveState('redstone_wire', { north: 'side', south: 'up', east: 'none', west: 'none', power: '15' })
  assert.equal(matchesTarget(dot, cross), false)
  assert.equal(matchesTarget(cross, dot), false)
  assert.equal(matchesTarget(cross, connected), true)
  assert.equal(matchesTarget(dot, resolveState('redstone_wire', { ...dot.getProperties(), power: '15' })), true)
})

test('natural components become explicit verification obligations, never block placement jobs', () => {
  const blocks = [resolveState('piston_head', { facing: 'down' }), resolveState('water', { level: '8' }), resolveState('water', { level: '0' }), resolveState('iron_door', { half: 'upper' }), resolveState('iron_door', { half: 'lower' })]
  const plan = { version: '1.21.4', tasks: blocks.map((b, i) => ({ id: String(i), name: b.name, state: b.stateId, pos: { x: i, y: 0, z: 0 } })) }
  const result = preparePhysicalPlan(plan)
  assert.deepEqual(result.tasks.map(t => t.id), ['2', '4'])
  assert.deepEqual(result.derived.map(t => t.id), ['0', '1', '3'])
})

test('bubble columns receive source-water preparation while keeping original direction for final verification', () => {
  const bubble = resolveState('bubble_column', { drag: false }, '1.21.11')
  const task = { id: '0,1,0', type: 'place', name: 'bubble_column', state: bubble.stateId, pos: { x: 0, y: 1, z: 0 } }
  const plan = { version: '1.21.11', tasks: [task], air: [], layers: [1], blockEntities: [], entities: [] }
  const physical = preparePhysicalPlan(plan)
  assert.equal(physical.tasks[0].name, 'water')
  assert.equal(physical.tasks[0].state, resolveState('water', { level: 0 }, '1.21.11').stateId)
  assert.deepEqual(physical.tasks[0].generatedTarget, { name: 'bubble_column', state: bubble.stateId })
  assert.equal(physical.derived[0].state, bubble.stateId)
  assert.equal(plan.tasks[0], task)
  assert.equal(task.name, 'bubble_column')
  assert.deepEqual(inspectPlan(plan).issues, [])
  const context = createBuildContext(plan, {})
  assert.equal(context.getTargetBlock(physical.tasks[0].state).name, 'water')
  assert.equal(context.items[physical.tasks[0].state].name, 'water_bucket')
})

test('water preparation accepts only its declared bubble direction, never weakens original final matching', () => {
  const water = resolveState('water', { level: 0 })
  const bubble = resolveState('bubble_column', { drag: false })
  const task = { name: 'water', generatedTarget: { name: 'bubble_column', state: bubble.stateId } }
  assert.equal(matchesPhysicalTarget(water, water, task), true)
  assert.equal(matchesPhysicalTarget(water, bubble, task), true)
  assert.equal(matchesPhysicalTarget(water, resolveState('bubble_column', { drag: true }), task), false)
  assert.equal(matchesPhysicalTarget(water, resolveState('water', { level: 1 }), task), false)
  assert.equal(matchesPhysicalTarget(water, bubble, { name: 'water' }), false)
  assert.equal(matchesTarget(bubble, water), false)
})

test('fire is physically ignitable and natural age changes do not hide shape or type differences', () => {
  const fire = resolveState('fire', { age: 15 })
  const fresh = resolveState('fire', { age: 0 })
  assert.equal(matchesTarget(fire, fresh), true)
  assert.equal(matchesTarget(fire, fresh, { exact: true }), false)
  assert.equal(matchesTarget(fire, resolveState('soul_fire')), false)
  assert.equal(matchesTarget(fire, resolveState('fire', { age: 0, north: true })), false)
  const plan = { version: '1.21.4', tasks: [{ id: 'fire', name: 'fire', state: fire.stateId }], air: [], layers: [], blockEntities: [], entities: [] }
  assert.deepEqual(inspectPlan(plan).issues, [])
})

test('empty container and default comparator metadata do not request inventory filling', () => {
  const tasks = ['comparator', 'hopper'].map((name, i) => ({ id: String(i), name, blockEntity: { id: name, Items: [], components: {}, OutputSignal: 0 } }))
  const plan = { version: '1.21.4', tasks, air: [], layers: [], blockEntities: [], entities: [] }
  assert.equal(inspectPlan(plan).issues.filter(i => i.reason === 'requires-block-entity-contents').length, 0)
  tasks[1].blockEntity.Items.push({ id: 'minecraft:shears', Slot: 1, count: 1 })
  assert.equal(inspectPlan(plan).issues.filter(i => i.reason === 'requires-block-entity-contents').length, 1)
})
