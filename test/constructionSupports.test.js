const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { planConstructionSupports } = require('../lib/constructionSupports')
const { resolveState } = require('../lib/strictSchematic')

const task = (x, y, z, name = 'stone') => ({ id: `${x},${y},${z}`, pos: new Vec3(x, y, z), name, type: 'place', state: 1 })
const bounds = { min: new Vec3(0, 0, 0), max: new Vec3(10, 7, 10) }

test('an upper island receives a continuous outside tower starting at the still-open layer', () => {
  const tasks = [task(1, 0, 1), task(1, 1, 1), task(2, 5, 2), task(2, 6, 2)]
  const plan = { ...bounds, tasks }
  const result = planConstructionSupports(plan, { tasks, derived: [] }, { startLayer: 1, materialState: 10 })
  assert.deepEqual(result.tasks.map(item => item.pos.y), [1, 2, 3, 4, 5, 6])
  assert.ok(result.tasks.every(item => item.pos.x >= plan.max.x && item.persistent && item.scaffold && item.name === 'dirt' && item.state === 10))
  assert.ok(result.tasks.every(item => item.releaseLayer === undefined))
  assert.deepEqual(result.towers[0].gaps, [{ lower: 1, upper: 5 }])
})

test('water trays reserve only future flowing-water cells and release after the source layer', () => {
  const active = [task(1, 0, 1), task(1, 1, 1, 'water'), task(1, 2, 1, 'water'), task(2, 2, 2, 'water')]
  const flowing = { ...task(2, 1, 2, 'water'), reason: 'generated-by-source-water' }
  const oldFlowing = { ...task(1, 0, 1, 'water'), reason: 'generated-by-source-water' }
  const plan = { ...bounds, tasks: [...active, flowing] }
  const result = planConstructionSupports(plan, { tasks: active, derived: [flowing, oldFlowing] }, { startLayer: 1, materialState: 10 })
  assert.equal(result.tasks.length, 1)
  assert.deepEqual(result.tasks[0].pos, new Vec3(2, 1, 2))
  assert.equal(result.tasks[0].releaseLayer, 2)
  assert.equal(result.tasks[0].replacesDerived, flowing.id)
  assert.equal(result.fluidReferences[0].targetId, '2,2,2')
  assert.ok(!result.tasks.some(item => item.pos.equals(active[1].pos)))
})

test('ordinary consecutive layers do not receive an unnecessary tower', () => {
  const tasks = [task(1, 0, 1), task(1, 1, 1), task(1, 2, 1)]
  const plan = { ...bounds, tasks }
  assert.deepEqual(planConstructionSupports(plan, { tasks, derived: [] }, { startLayer: 0, materialState: 10 }).tasks, [])
  assert.throws(() => planConstructionSupports(plan, { tasks, derived: [] }, { startLayer: -1, materialState: 10 }), /outside/)
  assert.throws(() => planConstructionSupports(plan, { tasks, derived: [] }, { startLayer: 1.5, materialState: 10 }), /Integer/)
})

test('an enclosed source uses a neighboring source cell temporarily, with a separately supported replacement', () => {
  const active = [task(1, 0, 1, 'water'), task(1, 1, 1, 'water'), ...[[0, 1], [2, 1], [1, 0], [1, 2]].map(([x, z]) => task(x, 1, z, 'water'))]
  const flowing = { ...task(0, 0, 1, 'water'), reason: 'generated-by-source-water' }
  const plan = { ...bounds, tasks: [...active, flowing] }
  const result = planConstructionSupports(plan, { tasks: active, derived: [flowing] }, { startLayer: 0, materialState: 10 })
  assert.equal(result.fluidStaging.length, 1)
  const staged = result.fluidStaging[0]
  assert.equal(staged.targetId, '0,1,1')
  assert.deepEqual(staged.dependentIds, ['1,1,1'])
  assert.equal(staged.releaseLayer, 1)
  assert.equal(staged.state, 10)
  assert.ok(!result.tasks.some(item => item.pos.equals(staged.pos)))
  assert.equal(result.tasks[0].releaseLayer, 1)
  assert.throws(() => planConstructionSupports({ ...plan, tasks: active }, { tasks: active, derived: [] }, { startLayer: 0, materialState: 10 }), /no supported same-layer staging root/)
})

test('adjacent tray-backed roots do not create cyclic staging dependencies', () => {
  const active = []
  const derived = []
  for (let x = 0; x < 4; x++) {
    for (let z = 0; z < 4; z++) {
      active.push(task(x, 1, z, 'water'))
      if (x === 1 && [1, 2].includes(z)) derived.push({ ...task(x, 0, z, 'water'), reason: 'generated-by-source-water' })
      else active.push(task(x, 0, z, 'water'))
    }
  }
  const result = planConstructionSupports({ ...bounds, tasks: [...active, ...derived] }, { tasks: active, derived }, { startLayer: 0, materialState: 10 })
  assert.deepEqual(result.fluidStaging.map(item => [item.targetId, item.dependentIds]), [['1,1,1', ['2,1,1']], ['1,1,2', ['2,1,2']]])
})

function railTask (x, y, z, name = 'activator_rail', properties = { shape: 'north_south' }) {
  return { ...task(x, y, z, name), state: resolveState(name, properties, '1.21.4').stateId }
}

function railFixture (extra = [], air = [new Vec3(5, 2, 6)]) {
  const rail = railTask(5, 2, 5)
  const tasks = [rail, railTask(5, 2, 4, 'observer', {}), railTask(5, 3, 4), ...extra]
  return { plan: { ...bounds, version: '1.21.4', tasks, air }, physical: { tasks, derived: [] }, rail }
}

test('native north ascent reserves the single south support through the following layer', () => {
  const f = railFixture()
  const result = planConstructionSupports(f.plan, f.physical, { startLayer: 2, materialState: 10 })
  assert.equal(result.tasks.length, 1)
  const support = result.tasks[0]
  assert.deepEqual(support.pos, new Vec3(5, 2, 6))
  assert.equal(support.purpose, 'rail-calibration')
  assert.equal(support.releaseLayer, 3)
  assert.equal(support.persistent, true)
  assert.equal(support.scaffold, true)
  const reference = result.railReferences.find(item => item.targetId === f.rail.id)
  assert.deepEqual(reference.nativeShapes, ['ascending_north'])
  assert.deepEqual(reference.supportIds, [support.id])
  assert.deepEqual(reference.paths.find(item => item.from === 'ascending_north').shapes, ['ascending_south', 'north_south'])
})

test('full-top neighboring shapes provide safe intermediate slopes without extra dirt', () => {
  const f = railFixture([
    railTask(6, 2, 5, 'stone_slab', { type: 'top' }),
    railTask(4, 2, 5, 'stone', {})
  ])
  const result = planConstructionSupports(f.plan, f.physical, { startLayer: 2, materialState: 10 })
  assert.equal(result.tasks.length, 0)
  const reference = result.railReferences.find(item => item.targetId === f.rail.id)
  assert.deepEqual(reference.paths.find(item => item.from === 'ascending_north').shapes, ['ascending_west', 'ascending_east', 'east_west', 'north_south'])
  const bottom = railFixture([
    railTask(6, 2, 5, 'stone_slab', { type: 'bottom' }),
    railTask(4, 2, 5, 'stone', {})
  ])
  assert.equal(planConstructionSupports(bottom.plan, bottom.physical, { startLayer: 2, materialState: 10 }).tasks.length, 1)
})

test('a full-top neighbor without an upper rail cannot induce a native ascending shape', () => {
  const f = railFixture()
  f.physical.tasks = f.physical.tasks.filter(item => item.pos.y === 2)
  f.plan.tasks = f.physical.tasks
  const result = planConstructionSupports(f.plan, f.physical, { startLayer: 2, materialState: 10 })
  assert.equal(result.tasks.length, 0)
  assert.deepEqual(result.railReferences.find(item => item.targetId === f.rail.id).nativeShapes, [])
})

test('unrepresented adjacent cells require an actual empty-world check and are identified in the audit', () => {
  const f = railFixture([], [])
  const result = planConstructionSupports(f.plan, f.physical, { startLayer: 2, materialState: 10 })
  const support = result.tasks[0]
  assert.deepEqual(support.pos, new Vec3(5, 2, 6))
  assert.equal(support.requiresEmpty, true)
  assert.equal(support.source, 'outside-litematic-regions')
  const reference = result.railReferences.find(item => item.targetId === f.rail.id)
  assert.equal(reference.supports[0].source, 'outside-litematic-regions')
})

test('known active or derived cells are never reused as rail calibration dirt even if listed as air', () => {
  const f = railFixture([
    railTask(6, 2, 5),
    railTask(4, 2, 5, 'repeater', {}),
    railTask(5, 2, 6, 'water', { level: 8 })
  ])
  const flowing = { ...f.physical.tasks.pop(), reason: 'generated-by-source-water' }
  f.physical.derived = [flowing]
  assert.throws(() => planConstructionSupports(f.plan, f.physical, { startLayer: 2, materialState: 10 }), /rail calibration.*5,2,5/i)
})

test('rail calibration never adds supports below the open start layer', () => {
  const f = railFixture()
  const result = planConstructionSupports(f.plan, f.physical, { startLayer: 3, materialState: 10 })
  assert.deepEqual(result.tasks, [])
  assert.ok(result.railReferences.every(reference => reference.targetId !== f.rail.id))
})

test('ordinary rails use their ten-state cycle when choosing a safe calibration route', () => {
  const f = railFixture()
  f.rail.name = 'rail'
  f.rail.state = resolveState('rail', { shape: 'north_east' }, '1.21.4').stateId
  const result = planConstructionSupports(f.plan, f.physical, { startLayer: 2, materialState: 10 })
  assert.equal(result.tasks.length, 1)
  assert.deepEqual(result.railReferences.find(item => item.targetId === f.rail.id).paths[0].shapes, ['ascending_south', 'south_east', 'south_west', 'north_west', 'north_east'])
})

test('two neighboring rails share one support and retain it until both upper layers are complete', () => {
  const f = railFixture([
    railTask(6, 2, 6, 'activator_rail', { shape: 'north_south' }),
    railTask(6, 2, 5, 'stone', {}),
    railTask(6, 3, 5),
    railTask(7, 2, 6, 'stone', {}),
    railTask(7, 3, 6)
  ])
  const result = planConstructionSupports(f.plan, f.physical, { startLayer: 2, materialState: 10 })
  const shared = result.tasks.filter(item => item.pos.equals(new Vec3(5, 2, 6)))
  assert.equal(shared.length, 1)
  assert.equal(shared[0].releaseLayer, 3)
  assert.ok(result.railReferences.find(item => item.targetId === '6,2,6').supportIds.includes(shared[0].id))
})

test('all sixteen native support configurations use the minimum new dirt count', () => {
  const offsets = [[1, 0, 0], [-1, 0, 0], [0, 0, -1], [0, 0, 1]]
  const minimum = [0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0]
  for (let mask = 0; mask < 16; mask++) {
    const rail = railTask(5, 2, 5)
    const tasks = [rail]
    const air = []
    for (let direction = 0; direction < offsets.length; direction++) {
      const pos = rail.pos.offset(...offsets[direction])
      if (mask & (1 << direction)) tasks.push(railTask(pos.x, pos.y, pos.z, 'stone', {}), railTask(pos.x, pos.y + 1, pos.z))
      else air.push(pos)
    }
    const result = planConstructionSupports({ ...bounds, version: '1.21.4', tasks, air }, { tasks, derived: [] }, { startLayer: 2, materialState: 10 })
    assert.equal(result.tasks.length, minimum[mask], `native mask ${mask}`)
  }
})

test('when the one-block route is occupied, the two-block safe route is selected', () => {
  const rail = railTask(5, 2, 5)
  const tasks = [rail, railTask(4, 2, 5, 'observer', {}), railTask(4, 3, 5), railTask(6, 2, 5)]
  const air = [new Vec3(5, 2, 4), new Vec3(5, 2, 6)]
  const result = planConstructionSupports({ ...bounds, version: '1.21.4', tasks, air }, { tasks, derived: [] }, { startLayer: 2, materialState: 10 })
  assert.deepEqual(result.tasks.map(item => item.pos), air)
  assert.deepEqual(result.railReferences.find(item => item.targetId === rail.id).paths[0].shapes, ['ascending_north', 'ascending_south', 'north_south'])
})

test('a hopper rim permanently supports a source ascending rail without replacing the hopper', () => {
  const rail = railTask(5, 2, 5, 'activator_rail', { shape: 'ascending_east' })
  const hopper = railTask(6, 2, 5, 'hopper', { facing: 'down' })
  const tasks = [rail, hopper, railTask(6, 3, 5)]
  const plan = { ...bounds, version: '1.21.4', tasks, air: [] }
  const result = planConstructionSupports(plan, { tasks, derived: [] }, { startLayer: 2, materialState: 10 })
  assert.deepEqual(result.tasks, [])
  const reference = result.railReferences.find(item => item.targetId === rail.id)
  assert.deepEqual(reference.nativeShapes, ['ascending_east'])
  assert.ok(reference.nativeSupports.some(item => item.targetId === hopper.id))
  assert.deepEqual(reference.paths, [{ from: 'ascending_east', reverse: false, shapes: [] }])

  const chest = railTask(6, 2, 5, 'chest', {})
  const unsupported = [rail, chest, tasks[2]]
  assert.throws(() => planConstructionSupports({ ...plan, tasks: unsupported }, { tasks: unsupported, derived: [] }, { startLayer: 2, materialState: 10 }), /permanent.*support/i)
})

test('a hopper rim is also a safe intermediate slope in the calibration cycle', () => {
  const f = railFixture([railTask(6, 2, 5, 'hopper', { facing: 'down' }), railTask(4, 2, 5, 'stone', {})])
  const result = planConstructionSupports(f.plan, f.physical, { startLayer: 2, materialState: 10 })
  assert.deepEqual(result.tasks, [])
  assert.deepEqual(result.railReferences.find(item => item.targetId === f.rail.id).paths[0].shapes, ['ascending_west', 'ascending_east', 'east_west', 'north_south'])
})
