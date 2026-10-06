const test = require('node:test')
const assert = require('node:assert/strict')

let planLayerSupports
let createSupportCleanupTasks
try {
  ({ planLayerSupports, createSupportCleanupTasks } = require('../lib/layerSupports'))
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}

const key = pos => `${pos.x},${pos.y},${pos.z}`
const pos = (x, y = 64, z = 0) => ({ x, y, z })
const target = (x, z = 0, name = 'white_concrete') => ({ id: `${x},64,${z}`, type: 'place', pos: pos(x, 64, z), state: 1, name })
const air = { name: 'air', boundingBox: 'empty', shapes: [] }
const solid = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }

function plan (tasks, occupied, options = {}) {
  assert.equal(typeof planLayerSupports, 'function', 'Support planner must be implemented')
  const targets = new Set(tasks.map(task => key(task.pos)))
  const blocks = new Map(occupied.map(([position, block]) => [key(position), block]))
  return planLayerSupports(tasks, {
    getBlock: position => blocks.get(key(position)) || air,
    isTargetAt: position => targets.has(key(position)),
    layer: 64,
    materialState: 10,
    ...options
  })
}

test('connects two floating islands with bridges entirely on the current layer', () => {
  const tasks = [target(4), target(8)]
  const supports = plan(tasks, [[pos(0), solid]])
  assert.deepEqual(supports.map(task => task.pos.x).sort((a, b) => a - b), [1, 2, 3, 5, 6, 7])
  assert.equal(new Set(supports.map(task => key(task.pos))).size, 6)
  assert.ok(supports.every(task => task.pos.y === 64 && task.pos.z === 0 && task.type === 'place' && task.name === 'dirt' && task.scaffold && task.state === 10))
  assert.ok(supports.every(task => !tasks.some(original => key(original.pos) === key(task.pos))))
})

test('does not add a bridge when permanent blocks already support the layer from below', () => {
  assert.deepEqual(plan([target(4), target(5)], [[pos(4, 63), solid]]), [])
})

test('uses original target blocks to connect a component without overwriting them', () => {
  const tasks = [target(2), target(3), target(4), target(7)]
  const supports = plan(tasks, [[pos(0), solid]])
  assert.deepEqual(supports.map(task => task.pos.x).sort((a, b) => a - b), [1, 5, 6])
})

test('routes around reserved target coordinates instead of replacing them with dirt', () => {
  const tasks = [target(4)]
  const reserved = new Set([key(pos(2)), key(pos(4))])
  const supports = plan(tasks, [[pos(0), solid]], { isTargetAt: position => reserved.has(key(position)) })
  assert.ok(supports.length > 3)
  assert.ok(supports.every(task => !reserved.has(key(task.pos))))
  assert.ok(supports.some(task => task.pos.z !== 0))
})

test('does not accept redstone wire or torches as structural support', () => {
  for (const name of ['redstone_wire', 'torch']) {
    const partial = { name, boundingBox: 'empty', shapes: [[0.4, 0, 0.4, 0.6, 0.7, 0.6]] }
    assert.throws(() => plan([target(4)], [[pos(0), partial]]), error => error.code === 'LAYER_SUPPORT_UNREACHABLE')
  }
})

test('does not connect a component through planned redstone attachments', () => {
  const tasks = [target(1, 0, 'redstone_wire'), target(2)]
  const supports = plan(tasks, [[pos(0), solid], [pos(1, 63), solid]])
  assert.ok(supports.length > 0)
  assert.ok(supports.every(task => key(task.pos) !== key(pos(1))))
})

test('cannot scaffold unsupported attachments that would fall after cleanup', () => {
  assert.throws(() => plan([target(4, 0, 'torch')], [[pos(0), solid]]), error => error.code === 'LAYER_SUPPORT_ATTACHMENT')
})

test('never plans outside loaded chunks or relies on an upper-layer anchor', () => {
  assert.throws(() => plan([target(4)], [[pos(0, 65), solid]]), error => error.code === 'LAYER_SUPPORT_UNREACHABLE')
  const known = new Map([[key(pos(4)), air], [key(pos(0)), solid]])
  assert.throws(() => plan([target(4)], [], { getBlock: position => known.get(key(position)) || null }), error => error.code === 'LAYER_SUPPORT_UNREACHABLE')
})

test('limits bridges to a Manhattan route of 32 blocks', () => {
  assert.equal(plan([target(32)], [[pos(0), solid]]).length, 31)
  assert.throws(() => plan([target(33)], [[pos(0), solid]]), error => error.code === 'LAYER_SUPPORT_UNREACHABLE' && error.maxDistance === 32)
})

test('can start a same-layer bridge on a lower permanent support', () => {
  const supports = plan([target(3)], [[pos(0, 63), solid]])
  assert.deepEqual(supports.map(task => key(task.pos)), ['0,64,0', '1,64,0', '2,64,0'])
})

test('cleanup reverses only temporary positions and stays in the same layer', () => {
  const supports = plan([target(4)], [[pos(0), solid]])
  const cleanup = createSupportCleanupTasks(supports)
  assert.deepEqual(cleanup.map(task => key(task.pos)), supports.map(task => key(task.pos)).reverse())
  assert.ok(cleanup.every(task => task.type === 'dig' && task.scaffold && task.pos.y === 64))
  assert.equal(supports.every(task => task.type === 'place'), true)
  assert.throws(() => createSupportCleanupTasks([target(1)]), /scaffold/i)
})

test('validates task layer and duplicate coordinates before planning', () => {
  assert.throws(() => plan([{ ...target(1), pos: pos(1, 65) }], []), /layer/i)
  assert.throws(() => plan([target(1), target(1)], []), /duplicate/i)
  assert.deepEqual(plan([], []), [])
})

test('extended target pistons use their retracted full cube during construction', () => {
  const piston = { name: 'sticky_piston', shapes: [[0, 0, 0, 1, 0.75, 1]], getProperties: () => ({ extended: true, facing: 'up' }) }
  const supports = plan([target(3, 0, 'sticky_piston')], [[pos(0), solid]], { getTargetBlock: () => piston })
  assert.deepEqual(supports.map(task => task.pos.x), [1, 2])
})

test('stable partial blocks can float and use partial lower blocks as click references', () => {
  const hopper = { name: 'hopper', shapes: [[0, 0.625, 0, 1, 1, 1]], getProperties: () => ({ facing: 'down' }) }
  for (const name of ['chest', 'hopper', 'cobblestone_wall']) {
    const partial = { name, shapes: [[0.25, 0, 0.25, 0.75, 0.875, 0.75]], getProperties: () => ({}) }
    assert.deepEqual(plan([target(3, 0, name)], [[pos(3, 63), hopper]], { getTargetBlock: () => partial }), [])
    assert.ok(plan([target(3, 0, name)], [[pos(0), solid]], { getTargetBlock: () => partial }).length > 0)
  }
})

test('floor attachments accept permanent selectable non-full support but not a side-only block', () => {
  const scaffolding = { name: 'scaffolding', shapes: [[0, 0.875, 0, 1, 1, 1]], getProperties: () => ({}) }
  assert.deepEqual(plan([target(3, 0, 'redstone_wire')], [[pos(3, 63), scaffolding]]), [])
  assert.throws(() => plan([target(3, 0, 'redstone_wire')], [[pos(2), solid]]), error => error.code === 'LAYER_SUPPORT_ATTACHMENT')
})

test('source fluids get temporary same-layer click references without requiring survival support', () => {
  const supports = plan([target(3, 0, 'water')], [[pos(0), solid]], { getTargetBlock: () => ({ name: 'water', shapes: [], getProperties: () => ({ level: '0' }) }) })
  assert.ok(supports.some(task => key(task.pos) === key(pos(2))))
  assert.ok(supports.every(task => task.pos.y === 64 && key(task.pos) !== key(pos(3))))
})

test('a supported comparator is a selectable click reference for its enclosed neighbor', () => {
  const comparator = { ...target(1, 0, 'comparator'), block: { name: 'comparator', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.125, 1]] } }
  const task = target(0)
  const reserved = new Set([key(task.pos), key(comparator.pos), key(pos(-1)), key(pos(0, 64, -1)), key(pos(0, 64, 1))])
  const result = plan([task, comparator], [[pos(1, 63), solid]], { isTargetAt: position => reserved.has(key(position)) })
  assert.deepEqual(result, [])
})

test('powder snow supplies a selectable outline without claiming to support floor attachments', () => {
  const powder = { name: 'powder_snow', boundingBox: 'empty', shapes: [] }
  assert.deepEqual(plan([target(0)], [[pos(0, 63), powder]]), [])
  const snowTask = { ...target(0, 0, 'powder_snow'), block: powder }
  assert.deepEqual(plan([snowTask, target(1)], [[pos(0, 63), solid]]), [])
  assert.throws(() => plan([target(0, 0, 'redstone_wire')], [[pos(0, 63), powder]]), /permanent support/i)
})
