const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { resolveState } = require('../lib/strictSchematic')
const Block = require('prismarine-block')('1.21.4')

let planFoundationSupports
let createFoundationCleanupTasks
try {
  ({ planFoundationSupports, createFoundationCleanupTasks } = require('../lib/foundationSupports'))
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}
const dirt = resolveState('dirt').stateId
const stone = resolveState('white_concrete').stateId
const ground = resolveState('grass_block')
const air = resolveState('air')
const key = pos => `${pos.x},${pos.y},${pos.z}`
const target = (x, y = 3, z = 0) => ({ id: `${x},${y},${z}`, type: 'place', pos: new Vec3(x, y, z), state: stone, name: 'white_concrete' })
const flat = pos => pos.y <= 0 ? ground : air
function fixture ({ targets = [target(0)], towers = [{ x: 31, z: 0, bottom: 3, top: 6 }], getBlock = flat, ...options } = {}) {
  assert.equal(typeof planFoundationSupports, 'function', 'Foundation planner must be implemented')
  const plan = { version: '1.21.4', min: new Vec3(0, 3, 0), tasks: targets, air: [] }
  const physicalPlan = { tasks: targets, derived: [] }
  const constructionPlan = { towers, tasks: towers.map(tower => ({ id: `aux:tower:${tower.x},3,${tower.z}`, pos: new Vec3(tower.x, 3, tower.z), state: dirt, name: 'dirt', type: 'place', scaffold: true, persistent: true })) }
  return planFoundationSupports(plan, physicalPlan, constructionPlan, { groundY: 0, materialState: dirt, getBlock, ...options })
}

test('one rooted tower connects the first floating layer within the existing 32-block limit', () => {
  const result = fixture()
  assert.deepEqual(result.pillars, [{ x: 31, z: 0, bottom: 1, top: 2 }])
  assert.deepEqual(result.tasks.map(task => key(task.pos)), ['31,1,0', '31,2,0'])
  assert.deepEqual(result.layers, [1, 2])
  assert.equal(result.firstLayer, 3)
  assert.equal(result.firstLayerSupports.length, 30)
  assert.ok(result.firstLayerSupports.every(task => task.pos.y === 3))
  assert.deepEqual(result.minimality, { proven: true, lowerBound: 1, actualPillars: 1 })
  assert.ok(result.tasks.every(task => task.name === 'dirt' && task.scaffold && task.persistent && task.foundation && task.purpose === 'foundation'))
})

test('multiple columns are globally ordered by Y and cleanup runs from the top down', () => {
  const result = fixture({ targets: [target(0), target(100)], towers: [{ x: 31, z: 0, bottom: 3, top: 5 }, { x: 131, z: 0, bottom: 3, top: 5 }] })
  assert.deepEqual(result.tasks.map(task => task.pos.y), [1, 1, 2, 2])
  assert.deepEqual(result.cleanupTasks.map(task => task.pos.y), [2, 2, 1, 1])
  assert.ok(result.cleanupTasks.every(task => task.type === 'dig' && task.foundation && task.name === 'dirt'))
  assert.equal(result.minimality.proven, false)
})

test('preflight lists the exact ground, column air and first-layer bridge cells', () => {
  const result = fixture()
  assert.deepEqual(result.preflight.ground.map(entry => key(entry.pos)), ['31,0,0'])
  assert.deepEqual(result.preflight.columns.map(entry => key(entry.pos)), ['31,1,0', '31,2,0'])
  assert.ok(result.preflight.columns.every(entry => entry.expected === 'air'))
  assert.deepEqual(result.preflight.firstLayerSupports.map(entry => key(entry.pos)), result.firstLayerSupports.map(task => key(task.pos)))
  assert.equal(result.preflight.firstLayerTargets.length, 2)
})

test('does not treat unknown column or planner space as air', () => {
  assert.throws(() => fixture({ getBlock: pos => pos.y === 1 ? null : flat(pos) }), error => error.code === 'FOUNDATION_UNKNOWN_BLOCK')
  assert.throws(() => fixture({ getBlock: pos => pos.x === -32 && pos.y === 3 ? null : flat(pos) }), error => error.code === 'FOUNDATION_UNKNOWN_BLOCK')
})

test('never replaces an occupied column or roots a tower on water', () => {
  assert.throws(() => fixture({ getBlock: pos => pos.x === 31 && pos.y === 1 ? resolveState('dirt') : flat(pos) }), error => error.code === 'FOUNDATION_OCCUPIED')
  assert.throws(() => fixture({ getBlock: pos => pos.y === 0 ? resolveState('water') : flat(pos) }), error => error.code === 'FOUNDATION_GROUND_SUPPORT')
})

test('rejects a foundation that cannot connect all first-layer components', () => {
  assert.throws(() => fixture({ towers: [{ x: 65, z: 0, bottom: 3, top: 6 }] }), error => error.code === 'LAYER_SUPPORT_UNREACHABLE')
})

test('all foundation placement stops below the blueprint and does not mutate its tasks', () => {
  const targets = [target(0)]
  const before = JSON.stringify(targets)
  const result = fixture({ targets })
  assert.ok(result.tasks.every(task => task.pos.y < 3))
  assert.equal(JSON.stringify(targets), before)
  assert.throws(() => fixture({ groundY: 3 }), /ground.*below/i)
  assert.throws(() => fixture({ materialState: stone }), /dirt/i)
})

test('cleanup refuses unowned dirt and corrupted foundation tasks', () => {
  const result = fixture()
  assert.equal(typeof createFoundationCleanupTasks, 'function')
  assert.throws(() => createFoundationCleanupTasks([{ ...result.tasks[0], foundation: false }]), /foundation/i)
  assert.throws(() => createFoundationCleanupTasks([{ ...result.tasks[0], name: 'white_concrete' }]), /foundation/i)
  assert.throws(() => createFoundationCleanupTasks([{ ...result.tasks[0], pos: new Vec3(31, 1.5, 0) }]), /foundation/i)
})

test('returns no column when the existing surface already reaches the blueprint underside', () => {
  const result = fixture({ groundY: 2, getBlock: pos => Block.fromStateId(pos.y <= 2 ? stone : 0, 0) })
  assert.deepEqual(result.tasks, [])
  assert.deepEqual(result.layers, [])
  assert.equal(result.firstLayerSupports.length, 0)
})
