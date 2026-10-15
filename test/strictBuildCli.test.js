const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { EventEmitter } = require('node:events')
const { parseOptions, loadBuildPlan, assertSchematicAlignment, grantManagedCloneOperators, fixturePlan, stageWorkers, runLayeredBuild, selectedPhysicalTasks, stopBots, createMechanismHooks, verifyBuildContents, reachContainer, selectVerificationBackend, createWorkerReporter, calibrateExistingRails, prepareMechanismStaging, updateVerificationMetrics } = require('../examples/strictBuilder')
const { resolveState, preparePhysicalPlan } = require('../lib/strictSchematic')
const { buildIdentity, parseRecovery } = require('../lib/buildRecovery')
const { approachGoal } = require('../lib/physicalApproach')

test('CLI rejects invalid worker counts and ambiguous missing targets', () => {
  assert.throws(() => parseOptions(['--bots', '0', '--fixture']), /bots/)
  assert.throws(() => parseOptions(['--bots', '101', '--fixture']), /bots/)
  assert.throws(() => parseOptions(['--bots', '1.5', '--fixture']), /bots/)
  assert.throws(() => parseOptions([]), /schematic/)
  assert.equal(parseOptions(['--fixture']).bots, 30)
  assert.throws(() => parseOptions(['--fixture', '--origin', '0,1.5,0']), /origin/)
})

test('CLI accepts 100 workers while keeping a 30-worker default', () => {
  assert.equal(parseOptions(['--bots', '100', '--fixture']).bots, 100)
  assert.equal(parseOptions(['--fixture']).bots, 30)
})

test('schematic origin is explicit, integer and mutually exclusive with the bounding-box origin', () => {
  const options = parseOptions(['--schematic', 'cannon.litematic', '--schematic-origin', '128,0,128'])
  assert.deepEqual(options.schematicOrigin, { x: 128, y: 0, z: 128 })
  assert.throws(() => parseOptions(['--schematic', 'cannon', '--origin', '101,-5,102', '--schematic-origin', '128,0,128']), /mutually exclusive/)
  assert.throws(() => parseOptions(['--fixture', '--schematic-origin', '128,0,128']), /fixture/)
  for (const value of ['128,,128', '128,0.5,128', '128,0,128,0']) assert.throws(() => parseOptions(['--schematic', 'cannon', '--schematic-origin', value]), /integer/)
})

test('true schematic origin is resolved through sourceMin and the reader translates the complete plan', async () => {
  const sourceMin = { x: -27, y: -5, z: -26 }
  const calls = []
  const options = parseOptions(['--schematic', 'cannon.litematic', '--schematic-origin', '128,0,128'])
  const reader = async (_file, _version, origin) => {
    calls.push({ ...origin })
    return { sourceMin, origin, tasks: [{ id: `${origin.x},${origin.y},${origin.z}`, pos: { ...origin } }], air: [{ ...origin }], blockEntities: [{ pos: { ...origin } }], entities: [{ original: true }] }
  }
  const plan = await loadBuildPlan(options, { reader })
  assert.deepEqual(calls.at(-1), { x: 101, y: -5, z: 102 })
  assert.deepEqual(plan.origin, { x: 101, y: -5, z: 102 })
  assert.deepEqual(plan.schematicOrigin, { x: 128, y: 0, z: 128 })
  assert.equal(plan.tasks[0].id, '101,-5,102')
  assert.deepEqual(plan.air[0], plan.origin)
  assert.deepEqual(plan.blockEntities[0].pos, plan.origin)
})

test('Mk6.1 alignment blocks fresh writes on all three axes while preserving inspect and legacy resume', () => {
  const aligned = { name: 'The Orbital Strike Cannon Mk.6.1', sourceMin: { x: -27, y: -5, z: -26 }, origin: { x: 101, y: -5, z: 102 } }
  assert.doesNotThrow(() => assertSchematicAlignment(aligned, {}))
  for (const axis of ['x', 'y', 'z']) {
    const wrong = { ...aligned, origin: { ...aligned.origin, [axis]: aligned.origin[axis] + 1 } }
    assert.throws(() => assertSchematicAlignment(wrong, {}), /multiple.*16/i)
    assert.doesNotThrow(() => assertSchematicAlignment(wrong, { inspect: true }))
    assert.doesNotThrow(() => assertSchematicAlignment(wrong, { resume: '/old/audited-run' }))
  }
  assert.doesNotThrow(() => assertSchematicAlignment({ ...aligned, name: 'Unrelated model', origin: { x: 1, y: 2, z: 3 } }, {}))
})

test('live fixture offers each of 30 bots work across three complete layers', () => {
  const plan = fixturePlan('1.21.4', { x: 0, y: -60, z: 0 })
  assert.equal(plan.tasks.length, 180)
  assert.equal(new Set(plan.tasks.map(t => t.id)).size, 180)
  assert.deepEqual(plan.layers, [-60, -59, -58])
  for (const layer of plan.layers) assert.equal(plan.tasks.filter(t => t.pos.y === layer).length, 60)
})

const version = '1.21.4'
const Block = require('prismarine-block')(version)
const block = name => resolveState(name, {}, version)
const key = pos => `${pos.x},${pos.y},${pos.z}`

test('placement reporting audits actual packet attempts and rejects out-of-layer writes synchronously', () => {
  const controller = new AbortController()
  const worker = { id: 'bot', position: new Vec3(0, 68, 0) }
  const report = { currentLayer: 64, placementAttempts: 0, workers: { bot: {} } }
  const events = []
  const record = createWorkerReporter(worker, report, event => events.push(event), controller)
  const state = { state: 'placing', pos: new Vec3(1, 64, 2), referencePos: new Vec3(1, 63, 2), face: 1, useItem: false, reason: 'stone' }
  record(state)
  assert.equal(report.placementAttempts, 1)
  assert.equal(events[0].type, 'placement-attempt')
  assert.deepEqual(events[0].taskPos, { x: 1, y: 64, z: 2 })
  assert.deepEqual(events[0].referencePos, { x: 1, y: 63, z: 2 })
  assert.equal(events[0].face, 1)
  assert.equal(events[0].useItem, false)
  let packets = 0
  assert.throws(() => { record({ ...state, pos: new Vec3(1, 63, 2) }); packets++ }, /placement audit/i)
  assert.equal(packets, 0)
  assert.equal(controller.signal.aborted, true)
  assert.equal(report.placementAttempts, 1)
})

test('dig reports do not change placement audit and lower placement remains rejected if active layer regresses', () => {
  const controller = new AbortController()
  const worker = { id: 'bot', position: new Vec3(0, 68, 0) }
  const report = { currentLayer: 65, placementAttempts: 0, workers: { bot: {} } }
  const events = []
  const record = createWorkerReporter(worker, report, event => events.push(event), controller)
  record({ state: 'placing', pos: new Vec3(0, 65, 0), referencePos: new Vec3(0, 64, 0), face: 1, useItem: true, reason: 'water' })
  record({ state: 'digging', pos: new Vec3(0, 64, 0), reason: 'dirt' })
  report.currentLayer = 64
  assert.throws(() => record({ state: 'placing', pos: new Vec3(0, 64, 0), referencePos: new Vec3(0, 63, 0), face: 1, useItem: false, reason: 'dirt' }), /placement audit/i)
  assert.equal(events.filter(event => event.type === 'placement-attempt').length, 1)
})
function blueprint (cells) {
  const tasks = cells.map(([x, y, z, name, properties = {}, blockEntity]) => {
    const pos = new Vec3(x, y, z)
    return { id: key(pos), type: 'place', pos, state: resolveState(name, properties, version).stateId, name, blockEntity }
  })
  return { name: 'test', version, origin: { x: 0, y: 64, z: 0 }, min: new Vec3(0, 64, 0), max: new Vec3(8, 67, 6), tasks, layers: [...new Set(tasks.map(t => t.pos.y))], air: [], entities: [], blockEntities: [] }
}

test('existing rail calibration only adjusts shape and preserves the active placement layer', async () => {
  const plan = blueprint([[0, 64, 0, 'powered_rail', { shape: 'ascending_east', powered: true }]])
  let actual = resolveState('powered_rail', { shape: 'ascending_west', powered: false }, version)
  const report = { currentLayer: 65, highestPlacedLayer: 65 }
  const events = []
  let adjusts = 0
  const worker = {
    id: 'bot',
    position: new Vec3(0, 67, 0),
    executor: {
      perform: async () => { throw new Error('Placement is forbidden') },
      dig: async () => { throw new Error('Digging is forbidden') },
      adjustRail: async (_task, wanted) => { adjusts++; actual = wanted; return true }
    }
  }
  await calibrateExistingRails({ tasks: plan.tasks, version, workers: [worker], readBlock: () => actual, report, emit: event => events.push(event) })
  assert.equal(adjusts, 1)
  assert.equal(report.currentLayer, 65)
  assert.equal(report.highestPlacedLayer, 65)
  assert.equal(events[0].type, 'rail-calibration')
  assert.equal(events[0].before.shape, 'ascending_west')
  assert.equal(events.at(-1).after.shape, 'ascending_east')
})

test('rail calibration refuses missing blocks, other static changes and unacknowledged adjustment', async () => {
  const plan = blueprint([[0, 64, 0, 'powered_rail', { shape: 'ascending_east', waterlogged: true }]])
  let adjusts = 0
  const worker = { id: 'bot', position: new Vec3(0, 66, 0), executor: { adjustRail: async () => { adjusts++; return true } } }
  const run = actual => calibrateExistingRails({ tasks: plan.tasks, version, workers: [worker], readBlock: () => actual, report: { currentLayer: 65 }, emit: () => {} })
  await assert.rejects(run(block('air')), /rail calibration.*refused/i)
  await assert.rejects(run(resolveState('powered_rail', { shape: 'ascending_west', waterlogged: false }, version)), /static.*difference/i)
  assert.equal(adjusts, 0)
  await assert.rejects(run(resolveState('powered_rail', { shape: 'ascending_west', waterlogged: true }, version)), /not verified/i)
  assert.equal(adjusts, 1)
})

test('rail calibration waits for delayed shared cache after the executing worker acknowledges', async () => {
  const plan = blueprint([[0, 64, 0, 'powered_rail', { shape: 'ascending_east' }]])
  const changed = resolveState('powered_rail', { shape: 'ascending_west' }, version)
  let shared = changed
  let acknowledged = changed
  let timer
  const worker = {
    id: 'writer',
    position: new Vec3(0, 66, 0),
    bot: { blockAt: () => acknowledged },
    executor: { adjustRail: async (_task, wanted) => { acknowledged = wanted; timer = setTimeout(() => { shared = wanted }, 80); return true } }
  }
  const events = []
  try {
    await calibrateExistingRails({ tasks: plan.tasks, version, workers: [worker], readBlock: () => shared, report: { currentLayer: 65 }, emit: event => events.push(event) })
    assert.equal(shared.getProperties().shape, 'ascending_east')
    assert.equal(events.at(-1).phase, 'complete')
  } finally { clearTimeout(timer) }
})

test('rail calibration aborts propagation waiting and fails when shared cache never catches up', async () => {
  const plan = blueprint([[0, 64, 0, 'powered_rail', { shape: 'ascending_east' }]])
  const changed = resolveState('powered_rail', { shape: 'ascending_west' }, version)
  let acknowledged = changed
  const worker = { id: 'writer', position: new Vec3(0, 66, 0), bot: { blockAt: () => acknowledged }, executor: { adjustRail: async (_task, wanted) => { acknowledged = wanted; return true } } }
  const run = signal => calibrateExistingRails({ tasks: plan.tasks, version, workers: [worker], readBlock: () => changed, signal, report: { currentLayer: 65 } })
  await assert.rejects(run(), /propagation/i)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('cancel calibration')), 15)
  try { await assert.rejects(run(controller.signal), /cancel calibration/) } finally { clearTimeout(timer) }
})

test('stage distributes 30 workers in a 6 by 5 grid with loaded steps no longer than 8 blocks', async () => {
  assert.equal(typeof stageWorkers, 'function')
  const moves = []
  let loads = 0
  const workers = Array.from({ length: 30 }, (_, i) => {
    const worker = { id: `bot${i}`, position: new Vec3(-10, 64, -10), bot: { waitForChunksToLoad: async () => { loads++ } } }
    worker.executor = {
      move: async destination => {
        assert.ok(worker.position.distanceTo(destination) <= 8.001)
        moves.push(destination)
        worker.position = destination.clone()
      }
    }
    return worker
  })
  const plan = blueprint([[0, 64, 0, 'stone']])
  await stageWorkers(workers, plan, { signal: new AbortController().signal })
  assert.equal(new Set(workers.map(worker => key(worker.position))).size, 30)
  const expectedX = [2 / 3, 2, 10 / 3, 14 / 3, 6, 22 / 3]
  const expectedZ = [0.6, 1.8, 3, 4.2, 5.4]
  assert.ok(workers.every(worker => expectedX.some(x => Math.abs(x - worker.position.x) <= 0.15)))
  assert.ok(workers.every(worker => expectedZ.some(z => Math.abs(z - worker.position.z) <= 0.15)))
  assert.ok(workers.every(worker => worker.position.y === 68))
  assert.ok(loads >= moves.length)
})

test('stage keeps 100 workers inside a unique 10 by 10 grid with bounded movement', async () => {
  const targets = new Map()
  const workers = Array.from({ length: 100 }, (_, i) => {
    const worker = { id: `bot${i}`, position: new Vec3(-10, 64, -10), bot: { waitForChunksToLoad: async () => {} } }
    worker.executor = {
      move: async destination => {
        assert.ok(worker.position.distanceTo(destination) <= 8.001)
        worker.position = destination.clone()
      }
    }
    return worker
  })
  const plan = blueprint([[0, 64, 0, 'stone']])
  await stageWorkers(workers, plan, { onEvent: event => { if (event.type === 'stage-start') targets.set(event.workerId, event.target) } })
  assert.equal(new Set(workers.map(worker => key(worker.position))).size, 100)
  assert.equal(new Set([...targets.values()].map(pos => pos.x)).size, 10)
  assert.equal(new Set([...targets.values()].map(pos => pos.z)).size, 10)
  assert.ok(workers.every(worker => worker.position.distanceTo(targets.get(worker.id)) <= 0.15))
  assert.ok(workers.every(worker => worker.position.x > plan.min.x && worker.position.x < plan.min.x + 10))
  assert.ok(workers.every(worker => worker.position.z > plan.min.z && worker.position.z < plan.min.z + 10))
  assert.ok(workers.every(worker => worker.position.y === 68))
})

test('staging cancellation stops further movement and drains the active moves', async () => {
  assert.equal(typeof stageWorkers, 'function')
  const controller = new AbortController()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started = 0
  let settled = false
  const workers = [0, 1].map(i => ({ id: String(i), position: new Vec3(-40, 64, 0), bot: { waitForChunksToLoad: async () => {} }, executor: { move: async () => { started++; await gate } } }))
  const running = stageWorkers(workers, blueprint([[0, 64, 0, 'stone']]), { signal: controller.signal })
  const rejected = assert.rejects(running, /abort|cancel/i).then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  release()
  await rejected
  assert.equal(started, 2)
})

test('staging preserves the first real worker fault instead of an earlier-index cancellation', async () => {
  const events = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  let firstSettled = false
  const workers = [0, 1].map(index => ({
    id: `builder${index}`,
    position: new Vec3(-40, 64, 0),
    bot: { waitForChunksToLoad: async () => {} },
    executor: {
      move: async (_destination, signal) => {
        if (index === 1) throw new Error('Starting position intersects scaffold')
        await gate
        firstSettled = true
        if (signal.aborted) throw Object.assign(new Error('Physical build cancelled'), { name: 'AbortError' })
      }
    }
  }))
  let finished = false
  const running = stageWorkers(workers, blueprint([[0, 64, 0, 'stone']]), { onEvent: event => events.push(event) })
  const rejected = assert.rejects(running, /Starting position intersects scaffold/).then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  const failure = events.find(event => event.type === 'stage-error')
  assert.equal(failure?.workerId, 'builder1')
  assert.match(failure.error, /intersects scaffold/)
  release()
  await rejected
  assert.equal(firstSettled, true)
})

function environment (plan, hooks = {}) {
  const world = new Map([['0,63,0', block('stone')]])
  const air = block('air')
  const history = []
  const workers = [0, 1].map(index => {
    const worker = { id: `bot${index}`, position: new Vec3(index, 68, 0), bot: {} }
    worker.executor = {
      perform: async (task, { layer }) => {
        history.push({ type: task.type, pos: key(task.pos), layer, scaffold: !!task.scaffold })
        if (hooks.perform) await hooks.perform(task)
        if (task.type === 'dig') { world.delete(key(task.pos)); return true }
        const neighbors = [task.pos.offset(0, -1, 0), task.pos.offset(-1, 0, 0), task.pos.offset(1, 0, 0), task.pos.offset(0, 0, -1), task.pos.offset(0, 0, 1)]
        if (!neighbors.some(pos => world.has(key(pos)))) return false
        world.set(key(task.pos), Block.fromStateId(task.state, 0))
        return true
      }
    }
    return worker
  })
  const readBlock = pos => world.get(key(pos)) || air
  return { plan, workers, readBlock, world, history }
}

function persistentSupport (x, y, z, extra = {}) {
  return { id: `persistent:${x},${y},${z}`, type: 'place', pos: new Vec3(x, y, z), state: block('dirt').stateId, name: 'dirt', scaffold: true, persistent: true, purpose: 'tower', ...extra }
}

test('workspace approaches tasks before execution and parks again before each read barrier', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const env = environment(plan)
  const events = []
  let approached
  let writes = 0
  const workspace = {
    ownerForTask: () => 'bot1',
    approachTask: async (worker, task) => { assert.equal(worker.id, 'bot1'); approached = task.id; events.push('approach:' + task.pos.y) },
    parkForRead: async ({ reason }) => { events.push('park:' + reason); approached = undefined }
  }
  for (const worker of env.workers) {
    const perform = worker.executor.perform
    worker.executor.perform = async (task, context) => {
      assert.equal(approached, task.id)
      assert.equal(worker.id, 'bot1')
      if (task.pos.y === 65) assert.ok(events.includes('park:layer-complete'))
      events.push('write:' + task.pos.y)
      writes++
      return perform(task, context)
    }
  }
  await runLayeredBuild({ ...env, workspace, settleMs: 0 })
  assert.equal(writes, 2)
  assert.ok(events.includes('park:layer-planning'))
  assert.ok(events.includes('park:phase-verification'))
  assert.equal(events.at(-1), 'park:final-verification')
})

test('missing workspace coverage at the layer barrier prevents any higher layer dispatch', async () => {
  const env = environment(blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']]))
  const workspace = {
    ownerForTask: () => 'bot0',
    approachTask: async () => {},
    parkForRead: async ({ reason }) => { if (reason === 'phase-verification') throw new Error('Music workspace chunk not loaded') }
  }
  await assert.rejects(runLayeredBuild({ ...env, workspace, settleMs: 0 }), /chunk not loaded/)
  assert.deepEqual(env.history.map(row => row.layer), [64])
})

test('persistent tower fills empty construction layers then is removed top down after all placements', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [3, 67, 0, 'glass']])
  const supports = [64, 65, 66, 67].map(y => persistentSupport(2, y, 0))
  const env = environment(plan)
  const events = []
  const report = await runLayeredBuild({ ...env, constructionPlan: { version: 1, startLayer: 64, tasks: supports }, settleMs: 0, onEvent: event => events.push(event) })
  assert.deepEqual(report.layers.map(layer => layer.y), [64, 65, 66, 67])
  const placements = env.history.filter(event => event.type === 'place')
  assert.deepEqual(placements.map(event => event.layer), placements.map(event => event.layer).sort((a, b) => a - b))
  const finalPlacement = env.history.findLastIndex(event => event.type === 'place')
  const cleanup = env.history.slice(finalPlacement + 1).filter(event => supports.some(task => key(task.pos) === event.pos))
  assert.deepEqual(cleanup.map(event => event.layer), [67, 66, 65, 64])
  assert.deepEqual(report.persistentOwned, [])
  assert.equal(events.filter(event => event.type === 'persistent-support-claimed').length, 4)
  assert.ok(supports.every(task => env.readBlock(task.pos).name === 'air'))
})

test('fluid trays release below the current layer after source verification and before advancing', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'stone'], [2, 65, 0, 'water'], [0, 66, 0, 'glass']])
  const tray = persistentSupport(2, 64, 0, { purpose: 'fluid-reference', releaseLayer: 65 })
  plan.air = [tray.pos]
  const env = environment(plan)
  const report = await runLayeredBuild({ ...env, constructionPlan: { version: 1, startLayer: 64, tasks: [tray] }, settleMs: 0 })
  const source = env.history.findIndex(event => event.pos === '2,65,0')
  const cleanup = env.history.findIndex(event => event.type === 'dig' && event.pos === '2,64,0')
  const higher = env.history.findIndex(event => event.layer === 66)
  assert.ok(source >= 0 && cleanup > source && cleanup < higher)
  assert.equal(report.status, 'verified')
})

test('unowned dirt at a planned persistent position is never claimed or deleted', async () => {
  const plan = blueprint([[0, 64, 0, 'stone']])
  const env = environment(plan)
  env.world.set('2,64,0', block('dirt'))
  const events = []
  await assert.rejects(runLayeredBuild({ ...env, constructionPlan: { version: 1, startLayer: 64, tasks: [persistentSupport(2, 64, 0)] }, settleMs: 0, onEvent: event => events.push(event) }), /unowned|occupied/i)
  assert.equal(env.history.length, 0)
  assert.equal(events.some(event => event.type === 'persistent-support-claimed'), false)
})

test('recovery restores only audited persistent ownership and allows tower-only layers', () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [3, 67, 0, 'glass']])
  const options = { host: '127.0.0.1', port: 25566 }
  const tasks = [64, 65, 66, 67].map(y => persistentSupport(2, y, 0))
  const report = { identity: buildIdentity(plan, options), constructionPlan: { version: 1, startLayer: 64, tasks }, layers: [{ y: 64 }, { y: 65 }], currentLayer: 66 }
  const events = [
    { type: 'persistent-support-claimed', record: tasks[0] },
    { type: 'persistent-support-claimed', record: tasks[1] },
    { type: 'persistent-support-removed', record: tasks[0] }
  ]
  const recovery = parseRecovery(report, events, { plan, options, runDir: '/test' })
  assert.deepEqual(recovery.persistentOwned.map(task => key(task.pos)), ['2,65,0'])
  assert.equal(recovery.highestLayer, 66)
  assert.equal(recovery.constructionPlan.tasks.length, 4)
  assert.throws(() => parseRecovery(report, [...events, { type: 'persistent-support-claimed', record: persistentSupport(20, 65, 0) }], { plan, options, runDir: '/test' }), /persistent.*audit|unplanned/i)
})

test('resume never replaces a lower persistent tower section and still cleans audited dirt', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [3, 67, 0, 'glass']])
  const tasks = [64, 65, 66, 67].map(y => persistentSupport(2, y, 0))
  const env = environment(plan)
  for (const task of [plan.tasks[0], ...tasks.slice(0, 2)]) env.world.set(key(task.pos), Block.fromStateId(task.state, 0))
  const recovery = { highestLayer: 66, completedLayers: [64, 65], supports: [], persistentOwned: tasks.slice(0, 2), constructionPlan: { version: 1, startLayer: 64, tasks } }
  const report = await runLayeredBuild({ ...env, recovery, settleMs: 0 })
  assert.equal(report.status, 'verified')
  assert.equal(env.history.some(event => event.type === 'place' && event.layer < 66), false)
  assert.deepEqual(report.persistentOwned, [])
})

test('fluid staging places dependent sources before replacing the same-layer temporary root', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [1, 65, 0, 'water'], [2, 65, 0, 'water']])
  const tray = persistentSupport(1, 64, 0, { purpose: 'fluid-reference', releaseLayer: 65 })
  const stage = persistentSupport(1, 65, 0, { purpose: 'fluid-staging', targetId: '1,65,0', dependentIds: ['2,65,0'], releaseLayer: 65 })
  const env = environment(plan, {
    perform: task => {
      if (task.id === '2,65,0' && env.readBlock(new Vec3(1, 65, 0)).name !== 'dirt') throw new Error('Waiting for support in the completed structure or current layer')
    }
  })
  const events = []
  const report = await runLayeredBuild({ ...env, constructionPlan: { version: 1, startLayer: 64, tasks: [tray], fluidStaging: [stage] }, settleMs: 0, onEvent: event => events.push(event) })
  assert.equal(report.status, 'verified')
  const dependent = env.history.findIndex(event => event.pos === '2,65,0')
  const rootDig = env.history.findIndex(event => event.pos === '1,65,0' && event.type === 'dig')
  assert.ok(dependent >= 0 && rootDig > dependent)
  assert.equal(env.readBlock(new Vec3(1, 65, 0)).name, 'water')
  assert.ok(events.some(event => event.type === 'persistent-support-claimed' && event.record.purpose === 'fluid-staging'))
})

test('recovery recognizes explicit staging ownership but rejects active-target claims without that manifest', () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [1, 65, 0, 'water'], [2, 65, 0, 'water']])
  const stage = persistentSupport(1, 65, 0, { purpose: 'fluid-staging', targetId: '1,65,0', dependentIds: ['2,65,0'], releaseLayer: 65 })
  const options = { host: '127.0.0.1', port: 25566 }
  const report = { identity: buildIdentity(plan, options), layers: [{ y: 64 }], currentLayer: 65, constructionPlan: { version: 1, startLayer: 64, tasks: [], fluidStaging: [stage] } }
  const events = [{ type: 'persistent-support-claimed', record: stage }]
  assert.equal(parseRecovery(report, events, { plan, options }).persistentOwned[0].targetId, stage.targetId)
  assert.throws(() => parseRecovery({ ...report, constructionPlan: { version: 1, startLayer: 64, tasks: [stage] } }, events, { plan, options }), /overlaps an active target/)
})

test('cleanup failure preserves historical highest placement and audited ownership for resume', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [2, 66, 0, 'glass']])
  const tasks = [64, 65, 66].map(y => persistentSupport(1, y, 0))
  const env = environment(plan, { perform: task => { if (task.type === 'dig' && task.pos.y === 65) throw new Error('No server dig acknowledgement') } })
  const report = {}
  const events = []
  const options = { host: '127.0.0.1', port: 25566, maxAttempts: 1 }
  report.identity = buildIdentity(plan, options)
  await assert.rejects(runLayeredBuild({ ...env, options, report, constructionPlan: { version: 1, startLayer: 64, tasks }, settleMs: 0, onEvent: event => events.push(event) }), /attempt limit/)
  assert.equal(report.currentLayer, 65)
  assert.equal(report.highestPlacedLayer, 66)
  const recovery = parseRecovery(report, events, { plan, options })
  assert.equal(recovery.highestLayer, 66)
  assert.deepEqual(recovery.persistentOwned.map(task => task.pos.y).sort(), [64, 65])
})

test('supports are removed and targets reverified before any next-layer task starts', async () => {
  assert.equal(typeof runLayeredBuild, 'function')
  const plan = blueprint([[0, 64, 0, 'stone'], [4, 64, 0, 'stone'], [4, 65, 0, 'glass']])
  plan.air = [new Vec3(1, 64, 0), new Vec3(2, 64, 0), new Vec3(3, 64, 0)]
  const env = environment(plan)
  const events = []
  const report = await runLayeredBuild({ ...env, physicalPlan: preparePhysicalPlan(plan), options: { maxAttempts: 8, bottomLayers: Infinity }, signal: new AbortController().signal, settleMs: 0, onEvent: event => events.push(event) })
  const lastCleanup = env.history.findLastIndex(event => event.type === 'dig')
  const nextLayer = env.history.findIndex(event => event.layer === 65)
  assert.ok(lastCleanup >= 0 && lastCleanup < nextLayer)
  assert.equal(report.status, 'verified')
  assert.deepEqual(report.layers.map(layer => layer.y), [64, 65])
  assert.ok(plan.air.every(pos => env.readBlock(pos).name === 'air'))
  assert.ok(events.filter(event => event.type === 'task-start').every(event => event.layer === event.activeLayer))
})

test('cleanup damage fails the current layer without dispatching higher work', async () => {
  assert.equal(typeof runLayeredBuild, 'function')
  const plan = blueprint([[0, 64, 0, 'stone'], [4, 64, 0, 'stone'], [4, 65, 0, 'glass']])
  const env = environment(plan, { perform: async task => { if (task.type === 'dig') env.world.delete('4,64,0') } })
  await assert.rejects(runLayeredBuild({ ...env, physicalPlan: preparePhysicalPlan(plan), options: { maxAttempts: 8, bottomLayers: Infinity }, signal: new AbortController().signal, settleMs: 0 }), /cleanup|verification/i)
  assert.equal(env.history.some(event => event.layer === 65), false)
})

test('natural derived targets remain in final verification and cannot be declared complete when absent', async () => {
  assert.equal(typeof runLayeredBuild, 'function')
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'piston_head', { facing: 'up' }]])
  const env = environment(plan)
  const report = {}
  await assert.rejects(runLayeredBuild({ ...env, physicalPlan: preparePhysicalPlan(plan), options: { maxAttempts: 2, bottomLayers: Infinity }, signal: new AbortController().signal, settleMs: 0, report }), /derived|final verification/i)
  assert.notEqual(report.status, 'verified')
  assert.deepEqual(report.derivedPending, ['0,65,0'])
  assert.equal(env.history.some(event => event.pos === '0,65,0'), false)
})

test('final music checks reject the wrong instrument even when placement state matching ignores it', async () => {
  const plan = blueprint([[0, 64, 0, 'clay'], [0, 65, 0, 'note_block', { note: 12, instrument: 'flute' }]])
  plan.music = true
  const env = environment(plan)
  await assert.rejects(runLayeredBuild({ ...env, settleMs: 0, afterBuild: async () => { env.world.set('0,65,0', resolveState('note_block', { note: 12, instrument: 'harp' })) } }), /Music instrument mismatch/)
})

test('music validates clear space above notes even outside selected construction layers', async () => {
  const plan = blueprint([[0, 64, 0, 'clay'], [0, 65, 0, 'note_block', { note: 12, instrument: 'flute' }]])
  plan.music = true
  const env = environment(plan)
  env.world.set('0,66,0', resolveState('glass'))
  await assert.rejects(runLayeredBuild({ ...env, settleMs: 0 }), /clear air above note block/)
})

test('structural note blocks in ordinary schematics retain their existing covered-block behavior', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'note_block'], [0, 66, 0, 'glass']])
  const report = await runLayeredBuild({ ...environment(plan), settleMs: 0 })
  assert.equal(report.status, 'verified')
  assert.equal(report.musicVerification, undefined)
})

test('bubble water is placed layer by layer then awaited as natural columns before final verification', async () => {
  const plan = blueprint([[0, 64, 0, 'soul_sand'], [1, 64, 0, 'glass'], [0, 65, 0, 'bubble_column', { drag: false }], [1, 65, 0, 'glass'], [0, 66, 0, 'bubble_column', { drag: false }], [1, 66, 0, 'glass']])
  const env = environment(plan)
  const placed = []
  const events = []
  const finalization = []
  const originalPerform = env.workers[0].executor.perform
  for (const worker of env.workers) worker.executor.perform = async (task, settings) => { placed.push({ name: task.name, y: task.pos.y }); return originalPerform(task, settings) }
  const report = await runLayeredBuild({
    ...env,
    settleMs: 0,
    naturalTimeoutMs: 1000,
    afterBuild: async () => { finalization.push('finish-mutations') },
    afterNaturalGeneration: async () => { finalization.push('verify-natural-result') },
    onEvent: event => {
      events.push(event)
      if (event.type === 'natural-generation-wait') {
        assert.deepEqual(finalization, ['finish-mutations'])
        finalization.push('wait')
        assert.equal(env.readBlock(new Vec3(0, 65, 0)).name, 'water')
        assert.equal(env.readBlock(new Vec3(0, 66, 0)).name, 'water')
        for (const task of plan.tasks.filter(task => task.name === 'bubble_column')) env.world.set(task.id, Block.fromStateId(task.state, 0))
      }
    }
  })
  assert.equal(report.status, 'verified')
  assert.equal(report.blueprintBlocksVerified, 6)
  assert.equal(placed.some(task => task.name === 'bubble_column'), false)
  assert.deepEqual(placed.filter(task => task.name === 'water').map(task => task.y), [65, 66])
  assert.equal(events.filter(event => event.type === 'natural-generation-wait').length, 1)
  assert.deepEqual(finalization, ['finish-mutations', 'wait', 'verify-natural-result'])
})

test('plain water and wrong-direction bubbles cannot pass the original blueprint final check', async () => {
  const plan = blueprint([[0, 64, 0, 'soul_sand'], [0, 65, 0, 'bubble_column', { drag: false }]])
  for (const replace of [null, resolveState('bubble_column', { drag: true })]) {
    const env = environment(plan)
    const report = {}
    await assert.rejects(runLayeredBuild({
      ...env,
      report,
      settleMs: 0,
      naturalTimeoutMs: 0,
      onEvent: event => { if (event.type === 'natural-generation-wait' && replace) env.world.set('0,65,0', replace) }
    }), /bubble|natural|气泡|自然/i)
    assert.equal(report.status, 'failed')
    assert.equal(report.blueprintBlocksVerified, undefined)
    assert.deepEqual(report.derivedPending, ['0,65,0'])
  }
})

test('natural generation waiting is cancellable and never adds placement attempts', async () => {
  const plan = blueprint([[0, 64, 0, 'soul_sand'], [0, 65, 0, 'bubble_column', { drag: false }]])
  const env = environment(plan)
  const controller = new AbortController()
  let beforeCancel
  await assert.rejects(runLayeredBuild({
    ...env,
    signal: controller.signal,
    settleMs: 0,
    afterNaturalGeneration: async () => assert.fail('Cancelled generation must not run final verification'),
    onEvent: event => {
      if (event.type === 'natural-generation-wait') { beforeCancel = env.history.length; controller.abort(new Error('cancel natural wait')) }
    }
  }), /cancel natural wait/)
  assert.equal(env.history.length, beforeCancel)
})

test('container content is restored after placement, including explicitly empty inventories', async () => {
  assert.equal(typeof runLayeredBuild, 'function')
  const plan = blueprint([[0, 64, 0, 'dropper', {}, { Items: [{ Slot: 0, id: 'minecraft:shears', count: 1 }] }], [1, 64, 0, 'dropper', {}, { Items: [] }]])
  const env = environment(plan)
  const filled = []
  const fillContainer = async (bot, task) => {
    assert.equal(env.readBlock(task.pos).name, 'dropper')
    filled.push(task.id)
    return { verified: true }
  }
  await runLayeredBuild({ ...env, physicalPlan: preparePhysicalPlan(plan), options: { maxAttempts: 4, bottomLayers: Infinity }, signal: new AbortController().signal, settleMs: 0, fillContainer })
  assert.deepEqual(filled.sort(), ['0,64,0', '1,64,0'])
})

test('selection treats container contents as informational but rejects unplaceable active blocks', () => {
  assert.equal(typeof selectedPhysicalTasks, 'function')
  const plan = blueprint([[0, 64, 0, 'dropper']])
  const physical = preparePhysicalPlan(plan)
  const result = selectedPhysicalTasks(plan, physical, Infinity, [{ id: '0,64,0', reason: 'requires-block-entity-contents' }])
  assert.equal(result.tasks.length, 1)
  assert.throws(() => selectedPhysicalTasks(plan, physical, Infinity, [{ id: '0,64,0', reason: 'no-direct-placement-item' }]), /unsupported|placement/i)
})

test('layer mechanism failures keep the next layer undispatched', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const env = environment(plan)
  await assert.rejects(runLayeredBuild({ ...env, options: { maxAttempts: 2 }, signal: new AbortController().signal, settleMs: 0, afterLayer: async () => { throw new Error('Minecart placement failed') } }), /Minecart placement failed/)
  assert.equal(env.history.some(event => event.layer === 65), false)
})

test('post-build natural generation is awaited before verifying original derived blocks', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'piston_head', { facing: 'up' }]])
  const env = environment(plan)
  const report = await runLayeredBuild({
    ...env,
    options: { maxAttempts: 2 },
    signal: new AbortController().signal,
    settleMs: 0,
    afterBuild: async () => {
      await new Promise(resolve => setImmediate(resolve))
      env.world.set('0,65,0', Block.fromStateId(plan.tasks[1].state, 0))
    }
  })
  assert.equal(report.status, 'verified')
  assert.deepEqual(report.derivedPending, [])
})

test('a plan with unhandled entities cannot receive verified status', async () => {
  const plan = blueprint([[0, 64, 0, 'stone']])
  plan.entities = [{ data: { id: 'minecraft:hopper_minecart' } }]
  await assert.rejects(runLayeredBuild({ ...environment(plan), options: { maxAttempts: 2 }, signal: new AbortController().signal, settleMs: 0 }), /entities have not been handled/)
})

test('shutdown does not reopen close timers on a client which has already ended', async () => {
  const bot = new EventEmitter()
  let quit = 0
  bot._client = { ended: true }
  bot.quit = () => { quit++ }
  await stopBots([bot])
  assert.equal(quit, 0)
})

test('mechanism hooks place carts on their rail layer and ignite portals only after building', async () => {
  assert.equal(typeof createMechanismHooks, 'function')
  const plan = blueprint([[0, 64, 0, 'stone']])
  const workers = [{ id: 'bot', position: new Vec3(0, 68, 0), bot: {}, executor: {} }]
  const cart = { id: 'cart', name: 'hopper_minecart', layer: 64, pos: new Vec3(0, 65, 0) }
  const calls = []
  const hooks = createMechanismHooks(plan, {
    selectedLayers: new Set([64]),
    mechanisms: {
      normalizeMinecartEntities: () => [cart],
      placeMinecart: async (bot, entity) => { calls.push(['cart', entity.id]); return { verified: true, entityId: 5 } },
      ignitePortals: async () => { calls.push(['portal']); return { verified: true, portals: 0, blocks: 0 } },
      verifyMinecarts: async () => { calls.push(['verify']); return { verified: true, entities: 1, matches: [{ id: 'cart', entityId: 5 }] } }
    }
  })
  const report = {}
  const context = { plan, workers, signal: new AbortController().signal, report, emit: () => {} }
  await hooks.afterLayer({ ...context, layer: 63 })
  assert.deepEqual(calls, [])
  await hooks.afterLayer({ ...context, layer: 64 })
  await hooks.afterLayer({ ...context, layer: 64 })
  assert.deepEqual(calls, [['cart', 'cart']])
  await hooks.afterBuild(context)
  assert.deepEqual(calls, [['cart', 'cart'], ['portal'], ['verify']])
  await assert.rejects(hooks.afterBuild({ ...context, readOnly: true }), /read-only snapshot/)
  assert.deepEqual(calls, [['cart', 'cart'], ['portal'], ['verify']])
  assert.equal(report.entitiesVerified, 1)
  assert.equal(report.entityVerification.verified, true)
})

test('verified-layer checkpoint runs after the completion journal and blocks the next layer until settled', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const env = environment(plan)
  const events = []
  const checkpoints = []
  await runLayeredBuild({
    ...env,
    settleMs: 0,
    onEvent: event => events.push(event),
    afterLayerVerified: async ({ layer, report }) => {
      assert.equal(report.activeWorkers, 0)
      assert.equal(report.layers.at(-1).y, layer)
      assert.equal(events.at(-1).type, 'layer-complete')
      assert.equal(events.some(event => event.type === 'layer-start' && event.layer > layer), false)
      await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(events.some(event => event.type === 'layer-start' && event.layer > layer), false)
      checkpoints.push(layer)
    }
  })
  assert.deepEqual(checkpoints, [64, 65])
})

test('checkpoint failure preserves the completed layer and dispatches no higher writes', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const env = environment(plan)
  const report = {}
  await assert.rejects(runLayeredBuild({ ...env, report, settleMs: 0, afterLayerVerified: async () => { throw new Error('Backup unavailable') } }), /Backup unavailable/)
  assert.deepEqual(report.layers.map(row => row.y), [64])
  assert.equal(report.completed, 1)
  assert.equal(env.history.some(event => event.layer === 65), false)
})

test('already completed recovery layers do not create duplicate checkpoints', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const env = environment(plan)
  env.world.set('0,64,0', block('stone'))
  const checkpoints = []
  const report = await runLayeredBuild({ ...env, settleMs: 0, recovery: { highestLayer: 64, completedLayers: [64], supports: [] }, afterLayerVerified: async ({ layer }) => checkpoints.push(layer) })
  assert.deepEqual(checkpoints, [65])
  assert.equal(report.blueprintBlocksVerified, 2)
  assert.equal(report.freshVerifiedBlocks, 1)
  assert.equal(report.freshVerifiedBlocksPerSecond, 1 / report.buildSeconds)
})

test('fresh verification rate excludes resumed layers and does not count derived final targets as new construction', () => {
  const report = { completed: 5606, resumedReadOnlyBlocks: 5506, placementAttempts: 120 }
  updateVerificationMetrics(report, 10)
  assert.equal(report.freshVerifiedBlocks, 100)
  assert.equal(report.freshVerifiedBlocksPerSecond, 10)
  assert.equal(report.verifiedBlocksPerSecond, 560.6)
  assert.equal(report.placementAttemptsPerSecond, 12)
  report.blueprintBlocksVerified = 5700
  updateVerificationMetrics(report, 20)
  assert.equal(report.freshVerifiedBlocks, 100)
  assert.equal(report.freshVerifiedBlocksPerSecond, 5)
  assert.equal(report.verifiedBlocksPerSecond, 285)
  assert.match(report.freshVerifiedBlocksDefinition, /already-correct/)
})

test('enclosed minecart staging requires a managed frozen attestation only for selected layers', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const mechanisms = { normalizeMinecartEntities: (_plan, { frozen }) => [{ id: 'cart', layer: frozen ? 64 : 65, stagedStrategy: frozen ? { type: 'frozen-flat-rail' } : undefined }] }
  await assert.rejects(prepareMechanismStaging(plan, { mechanisms }), /managed.*attestation/)
  const untouched = await prepareMechanismStaging(plan, { mechanisms, selectedLayers: new Set([63]) })
  assert.equal(untouched.frozen, false)
  const evidence = [{ command: 'tick query' }]
  const verificationBackend = { backend: 'managed-readonly-rcon', snapshot: { readTickState: async () => ({ frozen: true, quiescent: true, evidence }) } }
  const result = await prepareMechanismStaging(plan, { mechanisms, verificationBackend })
  assert.equal(result.frozen, true)
  assert.deepEqual(result.entityIds, ['cart'])
  assert.deepEqual(result.attestation.evidence, evidence)
  verificationBackend.snapshot.readTickState = async () => ({ frozen: false, quiescent: true })
  await assert.rejects(prepareMechanismStaging(plan, { mechanisms, verificationBackend }), /frozen and quiescent/)
})

test('staged minecart hooks reattest the live server and journal staging actions', async () => {
  const plan = blueprint([[0, 64, 0, 'stone']])
  const workers = [{ id: 'bot', position: new Vec3(0, 68, 0), bot: {}, executor: {} }]
  const events = []
  const report = {}
  const hooks = createMechanismHooks(plan, {
    frozen: true,
    verificationBackend: { backend: 'managed-readonly-rcon', snapshot: { readTickState: async () => ({ frozen: true, quiescent: true, evidence: [{ command: 'tick query' }] }) } },
    mechanisms: {
      normalizeMinecartEntities: (_plan, { frozen }) => [{ id: 'cart', name: 'hopper_minecart', layer: frozen ? 64 : 65, railLayer: 64, pos: new Vec3(0, 64, 0), stagedStrategy: { type: 'frozen-flat-rail' } }],
      placeMinecart: async (_bot, _entity, options) => {
        assert.equal((await options.assertFrozen()).frozen, true)
        options.onEvent({ type: 'minecart-staging', phase: 'flatten' })
        return { verified: true, entityId: 30 }
      }
    }
  })
  await hooks.afterLayer({ layer: 64, workers, report, emit: event => events.push(event) })
  assert.equal(report.entitiesVerified, 1)
  assert.equal(report.freezeEvidence.length, 1)
  assert.equal(events.some(event => event.type === 'freeze-attestation' && event.entityId === 'cart'), true)
  assert.equal(events.some(event => event.type === 'minecart-staging' && event.workerId === 'bot'), true)
})

test('partial builds do not require higher entities or ignite incomplete higher frames', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const hooks = createMechanismHooks(plan, {
    selectedLayers: new Set([64]),
    mechanisms: {
      normalizeMinecartEntities: () => [{ id: 'higher-cart', layer: 65 }],
      findPortalFrames: () => [{ positions: [new Vec3(0, 65, 0)], frame: [new Vec3(0, 66, 0)] }],
      placeMinecart: async () => assert.fail('Higher entity dispatched'),
      ignitePortals: async () => assert.fail('Incomplete higher frame ignited')
    }
  })
  const report = await runLayeredBuild({ ...environment(plan), options: { maxAttempts: 2, bottomLayers: 1 }, signal: new AbortController().signal, settleMs: 0, ...hooks })
  assert.equal(report.status, 'verified-selected-layers')
  assert.equal(report.entitiesExpected, 0)
  assert.deepEqual(report.entitiesPending, [])
  assert.equal(report.portalsDeferred, 1)
})

test('unverified entity results fail before next layer and remain pending', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const env = environment(plan)
  const hooks = createMechanismHooks(plan, {
    mechanisms: {
      normalizeMinecartEntities: () => [{ id: 'cart', layer: 64, pos: new Vec3(0, 64, 0) }],
      placeMinecart: async () => ({ verified: false }),
      ignitePortals: async () => assert.fail('Ignition should not be dispatched')
    }
  })
  const report = {}
  await assert.rejects(runLayeredBuild({ ...env, options: { maxAttempts: 2 }, signal: new AbortController().signal, settleMs: 0, report, ...hooks }), /Entity placement was not verified/)
  assert.equal(env.history.some(event => event.layer === 65), false)
  assert.deepEqual(report.entitiesPending, ['cart'])
  assert.equal(report.entitiesVerified, 0)
})

test('recovery binds audited supports to the same server, origin, version and blueprint', () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const options = { host: '127.0.0.1', port: 25566 }
  const report = { identity: buildIdentity(plan, options), layers: [{ y: 64 }], currentLayer: 65 }
  const events = [{ type: 'layer-start', phase: 'layer', layer: 65 }, { type: 'supports-planned', layer: 65, positions: [{ x: 1, y: 65, z: 0 }] }]
  const recovery = parseRecovery(report, events, { plan, options, runDir: '/previous' })
  assert.equal(recovery.highestLayer, 65)
  assert.deepEqual(recovery.completedLayers, [64])
  assert.deepEqual(recovery.supports.map(task => key(task.pos)), ['1,65,0'])
  assert.throws(() => parseRecovery(report, events, { plan, options: { ...options, port: 25567 } }), /identity|server/i)
  const changed = { ...plan, tasks: [{ ...plan.tasks[0], state: block('dirt').stateId }, plan.tasks[1]] }
  assert.throws(() => parseRecovery(report, events, { plan: changed, options }), /identity|blueprint/i)
  assert.throws(() => parseRecovery(report, [{ ...events[1], positions: [{ x: 0, y: 65, z: 0 }] }], { plan, options }), /target|scaffold/i)
})

test('legacy recovery is restricted to the recorded file and explicit default local endpoint', () => {
  const plan = { ...blueprint([[0, 64, 0, 'stone']]), filename: '/cannon.litematic' }
  const report = { target: plan.filename, origin: plan.origin, version, currentLayer: 64, layers: [] }
  assert.equal(parseRecovery(report, [], { plan, options: { host: '127.0.0.1', port: 25566 } }).legacyIdentity, true)
  assert.throws(() => parseRecovery(report, [], { plan, options: { host: 'localhost', port: 25566 } }), /legacy|endpoint/i)
  assert.throws(() => parseRecovery({ ...report, target: '/different' }, [], { plan, options: { host: '127.0.0.1', port: 25566 } }), /identity|target|file/i)
})

test('recovery rechecks completed lower layers without placing and cleans audited current scaffolds', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  plan.air = [new Vec3(1, 65, 0)]
  const env = environment(plan)
  env.world.set('0,64,0', block('stone'))
  env.world.set('1,65,0', block('dirt'))
  const support = { id: 'scaffold:1,65,0', type: 'place', pos: plan.air[0], state: block('dirt').stateId, name: 'dirt', scaffold: true }
  const recovery = { highestLayer: 65, completedLayers: [64], supports: [support] }
  const report = await runLayeredBuild({ ...env, recovery, options: { maxAttempts: 2 }, signal: new AbortController().signal, settleMs: 0 })
  assert.equal(report.status, 'verified')
  assert.equal(env.history.some(event => event.layer === 64), false)
  assert.ok(env.history.some(event => event.type === 'dig' && event.pos === '1,65,0'))
  assert.equal(env.readBlock(plan.air[0]).name, 'air')
})

test('recovery, layer completion and final verification calibrate lower rails without replacing them', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [1, 64, 0, 'powered_rail', { shape: 'ascending_east' }], [0, 65, 0, 'glass']])
  const env = environment(plan)
  const rail = plan.tasks[1]
  const changed = resolveState('powered_rail', { shape: 'ascending_west' }, version)
  env.world.set('0,64,0', block('stone'))
  env.world.set('1,64,0', changed)
  let adjustments = 0
  for (const worker of env.workers) worker.executor.adjustRail = async (task, wanted) => { adjustments++; env.world.set(key(task.pos), wanted); return true }
  const report = await runLayeredBuild({
    ...env,
    recovery: { highestLayer: 65, completedLayers: [64], supports: [] },
    settleMs: 0,
    afterLayer: async () => env.world.set(key(rail.pos), changed),
    afterBuild: async () => env.world.set(key(rail.pos), changed)
  })
  assert.equal(report.status, 'verified')
  assert.equal(adjustments, 3)
  assert.equal(report.railCalibrations.length, 3)
  assert.equal(env.history.some(event => event.type === 'place' && event.layer < 65), false)
})

test('recovery fails on damaged lower layers or changed support material without any writes', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass']])
  const env = environment(plan)
  const support = { id: 'scaffold:1,65,0', type: 'place', pos: new Vec3(1, 65, 0), state: block('dirt').stateId, name: 'dirt', scaffold: true }
  const recovery = { highestLayer: 65, completedLayers: [64], supports: [support] }
  await assert.rejects(runLayeredBuild({ ...env, recovery, options: { maxAttempts: 2 }, signal: new AbortController().signal, settleMs: 0 }), /recovery|lower|completed/i)
  assert.equal(env.history.length, 0)
  env.world.set('0,64,0', block('stone'))
  env.world.set('1,65,0', block('diamond_block'))
  await assert.rejects(runLayeredBuild({ ...env, recovery, options: { maxAttempts: 2 }, signal: new AbortController().signal, settleMs: 0 }), /scaffold|material/i)
  assert.equal(env.history.length, 0)
})

test('rail calibration retains owned supports until the pre-cleanup barrier and rechecks after digging', async () => {
  const plan = blueprint([[0, 64, 0, 'powered_rail', { shape: 'north_south' }], [1, 65, 0, 'stone']])
  const support = persistentSupport(-1, 64, 0, { purpose: 'rail-calibration', releaseLayer: 65 })
  const changed = resolveState('powered_rail', { shape: 'ascending_east' }, version)
  const rail = plan.tasks[0]
  let adjustments = 0
  const env = environment(plan, {
    perform: async task => {
      if (task.type === 'dig' && key(task.pos) === key(support.pos)) {
        assert.equal(adjustments, 1, 'calibration must finish before releasing its safe intermediate support')
        env.world.set(key(rail.pos), changed)
      }
    }
  })
  env.world.set(key(rail.pos), Block.fromStateId(rail.state, 0))
  env.world.set(key(support.pos), block('dirt'))
  for (const worker of env.workers) {
    worker.executor.adjustRail = async (task, wanted) => {
      if (adjustments === 0) assert.equal(env.readBlock(support.pos).name, 'dirt')
      adjustments++
      env.world.set(key(task.pos), wanted)
      return true
    }
  }
  const report = await runLayeredBuild({ ...env, settleMs: 0, recovery: { highestLayer: 65, completedLayers: [64], supports: [], persistentOwned: [support] }, afterLayer: async () => env.world.set(key(rail.pos), changed) })
  assert.equal(report.status, 'verified')
  assert.equal(adjustments, 2)
  assert.equal(env.readBlock(support.pos).name, 'air')
  assert.equal(report.highestPlacedLayer, 65)
  assert.equal(env.history.some(event => event.type === 'place' && event.layer < 65), false)
})

test('a failed pre-cleanup rail calibration preserves owned supports and prevents advancing', async () => {
  const plan = blueprint([[0, 64, 0, 'powered_rail', { shape: 'north_south' }], [0, 65, 0, 'stone'], [0, 66, 0, 'stone']])
  const support = persistentSupport(-1, 64, 0, { purpose: 'rail-calibration', releaseLayer: 65 })
  const env = environment(plan)
  env.world.set(key(plan.tasks[0].pos), Block.fromStateId(plan.tasks[0].state, 0))
  env.world.set(key(support.pos), block('dirt'))
  for (const worker of env.workers) worker.executor.adjustRail = async () => false
  const report = {}
  await assert.rejects(runLayeredBuild({ ...env, report, settleMs: 0, recovery: { highestLayer: 65, completedLayers: [64], supports: [], persistentOwned: [support] }, afterLayer: async () => env.world.set(key(plan.tasks[0].pos), resolveState('powered_rail', { shape: 'ascending_east' }, version)) }), /calibration.*not verified/i)
  assert.equal(env.readBlock(support.pos).name, 'dirt')
  assert.equal(env.history.some(event => event.layer === 66 || (event.type === 'dig' && event.pos === key(support.pos))), false)
  assert.equal(report.persistentOwned.length, 1)
})

test('a successful partial build resumes into higher layers without replaying completed placement', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass'], [0, 66, 0, 'stone']])
  const options = { host: '127.0.0.1', port: 25566, maxAttempts: 2, bottomLayers: 2 }
  const env = environment(plan)
  const events = []
  const partial = await runLayeredBuild({ ...env, options, signal: new AbortController().signal, settleMs: 0, report: { identity: buildIdentity(plan, options) }, onEvent: event => events.push(event) })
  assert.equal(partial.status, 'verified-selected-layers')
  const recovery = parseRecovery(partial, events, { plan, options })
  assert.equal(recovery.highestLayer, 65)
  assert.deepEqual(recovery.completedLayers, [64, 65])
  env.history.length = 0
  const complete = await runLayeredBuild({ ...env, recovery, options: { ...options, bottomLayers: Infinity }, signal: new AbortController().signal, settleMs: 0 })
  assert.equal(complete.status, 'verified')
  assert.equal(complete.blocksPerSecond, undefined)
  assert.ok(complete.verifiedBlocksPerSecond > 0)
  assert.equal(complete.resumedReadOnlyBlocks, 2)
  assert.ok(env.history.length > 0)
  assert.ok(env.history.every(event => event.layer === 66))
  assert.deepEqual(complete.layers.map(layer => layer.y), [64, 65, 66])
})

test('resume staging remains above the historical highest layer', async () => {
  const worker = { id: 'bot', position: new Vec3(0, 64, 0), bot: { waitForChunksToLoad: async () => {} } }
  worker.executor = { move: async destination => { worker.position = destination.clone() } }
  await stageWorkers([worker], blueprint([[0, 64, 0, 'stone']]), { minimumLayer: 90, signal: new AbortController().signal })
  assert.equal(worker.position.y, 94)
})

test('final entity verification cannot trust a historical successful placement', async () => {
  const plan = blueprint([[0, 64, 0, 'stone']])
  const hooks = createMechanismHooks(plan, {
    recoveredEntities: [{ id: 'cart', verified: true, entityId: 5 }],
    mechanisms: {
      normalizeMinecartEntities: () => [{ id: 'cart', layer: 64 }],
      ignitePortals: async () => ({ verified: true, portals: 0, blocks: 0 }),
      verifyMinecarts: async () => { throw new Error('Missing live minecart') }
    }
  })
  await assert.rejects(hooks.afterBuild({ workers: [], signal: new AbortController().signal, report: {}, emit: () => {} }), /Missing live minecart/)
})

test('final container checks are read-only and include explicitly empty containers', async () => {
  assert.equal(typeof verifyBuildContents, 'function')
  const plan = blueprint([[0, 64, 0, 'chest', {}, { Items: [] }], [1, 64, 0, 'dropper', {}, { Items: [{ Slot: 0, id: 'minecraft:shears', count: 1 }] }]])
  const env = environment(plan)
  const checked = []
  const report = {}
  await verifyBuildContents({ tasks: plan.tasks, workers: env.workers, signal: new AbortController().signal, report, emit: () => {}, verifyContainer: async (bot, task) => { checked.push(task.id); return { verified: true, slots: task.blockEntity.Items.length, items: task.blockEntity.Items.length } } })
  assert.equal(report.containersVerified, 2)
  assert.equal(report.containerVerification.verified, true)
  assert.deepEqual(checked.sort(), plan.tasks.map(task => task.id).sort())
  assert.equal(env.history.length, 0)
})

test('container verification failure stops new reads and drains in-flight readers', async () => {
  const plan = blueprint([[0, 64, 0, 'chest'], [1, 64, 0, 'dropper'], [2, 64, 0, 'dropper']])
  const env = environment(plan)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started = 0
  let settled = false
  const running = verifyBuildContents({ tasks: plan.tasks, workers: env.workers, signal: new AbortController().signal, report: {}, emit: () => {}, verifyContainer: async () => { const index = started++; if (!index) { await new Promise(resolve => setImmediate(resolve)); throw new Error('Changed container contents') } await gate; return { verified: true } } })
  const rejected = assert.rejects(running, /Changed container contents/).then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  release()
  await rejected
  assert.equal(started, 2)
})

test('final container approach splits a fifty-block descent into loaded short flights', async () => {
  assert.equal(typeof reachContainer, 'function')
  let loads = 0
  const worker = { id: 'bot', position: new Vec3(0, 114, 0), bot: { entity: { eyeHeight: 1.62 }, waitForChunksToLoad: async () => { loads++ } } }
  let reached = false
  worker.executor = {
    interactionGoal: pos => ({ getFaceAndRef: eye => eye.distanceTo(pos) <= 4.5 ? {} : null }),
    pathing: { positionClear: () => true, findFlightPath: (from, to) => [to] },
    move: async destination => { assert.ok(worker.position.distanceTo(destination) <= 8.001); worker.position = destination.clone() },
    reach: async (goal, pos) => { assert.ok(worker.position.distanceTo(pos) < 8); reached = true }
  }
  await reachContainer(worker, { pos: new Vec3(0, 64, 0) }, new AbortController().signal)
  assert.equal(reached, true)
  assert.ok(loads >= 6)
})

test('entity tracking approach can stop at the outer observation radius', async () => {
  const pos = new Vec3(0, 64, 0)
  const worker = { position: new Vec3(0, 114, 0), bot: { entity: { eyeHeight: 1.62 } } }
  const goal = { getFaceAndRef: eye => eye.distanceTo(pos) <= 16 ? {} : null }
  worker.executor = { pathing: { positionClear: () => true, findFlightPath: (from, to) => [to] }, move: async destination => { worker.position = destination.clone() } }
  await approachGoal(worker, goal, pos, { signal: new AbortController().signal })
  assert.ok(worker.position.distanceTo(pos) > 8)
  assert.ok(goal.getFaceAndRef(worker.position.offset(0, 1.62, 0)))
})

test('expected support waits are reported as dependency deferrals without worker errors', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [2, 64, 0, 'stone']])
  const env = environment(plan, {
    perform: async task => {
      if (task.id === '2,64,0' && !env.world.has('1,64,0')) throw new Error('Waiting for support in the completed structure or current layer')
    }
  })
  env.workers[1].position = new Vec3(2, 68, 0)
  const report = await runLayeredBuild({ ...env, options: { maxAttempts: 1 }, signal: new AbortController().signal, settleMs: 0 })
  assert.equal(report.status, 'verified')
  assert.ok(report.dependencyDeferrals > 0)
  assert.ok(Object.values(report.workers).every(worker => worker.errors === 0))
})

test('managed read-only verification is selected only for an attested numeric loopback endpoint', async () => {
  assert.equal(typeof selectVerificationBackend, 'function')
  const options = { host: '127.0.0.1', port: 25566, version }
  let calls = 0
  const snapshot = { backend: 'managed-rcon' }
  const snapshotFactory = async () => { calls++; return snapshot }
  assert.equal((await selectVerificationBackend({ ...options, host: '192.0.2.1' }, { snapshotFactory })).backend, 'physical-gui')
  assert.equal((await selectVerificationBackend({ ...options, host: 'localhost' }, { snapshotFactory })).backend, 'physical-gui')
  assert.equal(calls, 0)
  const selected = await selectVerificationBackend(options, { snapshotFactory })
  assert.equal(selected.backend, 'managed-readonly-rcon')
  assert.equal(selected.snapshot, snapshot)
  assert.equal((await selectVerificationBackend(options, { snapshotFactory: async () => { throw Object.assign(new Error('Other server'), { code: 'SNAPSHOT_UNAVAILABLE' }) } })).backend, 'physical-gui')
  await assert.rejects(selectVerificationBackend(options, { snapshotFactory: async () => { throw new Error('Malformed managed identity') } }), /Malformed managed identity/)
})

test('fixed managed clone uses the clone snapshot with sanitized endpoint arguments and cannot downgrade on identity failure', async () => {
  const options = { host: '127.0.0.1', port: 25567, version, bots: 30, origin: { x: 101, y: -5, z: 102 } }
  const snapshot = { backend: 'clone-rcon' }
  const selected = await selectVerificationBackend(options, {
    snapshotFactory: async () => assert.fail('The main snapshot must not inspect the clone'),
    cloneSnapshotFactory: async endpoint => { assert.deepEqual(endpoint, { host: '127.0.0.1', port: 25567, version }); return snapshot }
  })
  assert.equal(selected.backend, 'managed-readonly-rcon')
  assert.equal(selected.snapshot, snapshot)
  await assert.rejects(selectVerificationBackend(options, { cloneSnapshotFactory: async () => { throw Object.assign(new Error('Invalid clone identity'), { code: 'SNAPSHOT_UNAVAILABLE' }) } }), /clone identity/)
})

test('managed final verification records read-only commands without flying to or opening containers', async () => {
  const plan = blueprint([[0, 64, 0, 'chest', {}, { Items: [] }]])
  const containerEvidence = { command: 'data get block 0 64 0', response: 'container snapshot' }
  const entityEvidence = { command: 'data get entity @e[type=minecraft:minecart,limit=1]', response: 'entity snapshot' }
  let ignitions = 0
  const hooks = createMechanismHooks(plan, {
    recoveredEntities: [{ id: 'cart', verified: true, entityId: 5 }],
    verificationBackend: {
      backend: 'managed-readonly-rcon',
      snapshot: {
        verifyMinecarts: async () => ({ verified: true, entities: 1, matches: [{ id: 'cart', uuid: 'uuid' }], evidence: [entityEvidence] }),
        verifyContainer: async task => { assert.equal(task.id, '0,64,0'); return { verified: true, slots: 0, items: 0, evidence: [containerEvidence] } }
      }
    },
    mechanisms: {
      normalizeMinecartEntities: () => [{ id: 'cart', layer: 64 }],
      ignitePortals: async () => { ignitions++; return { verified: true, portals: 0, blocks: 0 } },
      verifyMinecarts: async () => assert.fail('Physical entity observation should not run')
    },
    inventory: { isContainerTask: () => true, verifyContainer: async () => assert.fail('Container GUI should not open') }
  })
  const report = {}
  const workers = [{ id: 'bot', position: new Vec3(0, 114, 0), bot: {}, executor: { interactionGoal: () => assert.fail('No physical approach for snapshot reads') } }]
  await hooks.afterBuild({ workers, signal: new AbortController().signal, report, emit: () => {} })
  await hooks.afterBuild({ workers, signal: new AbortController().signal, report, emit: () => {}, readOnly: true })
  assert.equal(ignitions, 1)
  assert.equal(report.verificationBackend, 'managed-readonly-rcon')
  assert.equal(report.entitiesVerified, 1)
  assert.equal(report.containersVerified, 1)
  assert.equal(report.verificationEvidence.length, 2)
  assert.ok(report.verificationEvidence.every(item => item.command.startsWith('data get ')))
})

test('a failed managed snapshot retains evidence and cannot fall back to weaker verification', async () => {
  const plan = blueprint([[0, 64, 0, 'stone']])
  const hooks = createMechanismHooks(plan, {
    recoveredEntities: [{ id: 'cart', verified: true, entityId: 5 }],
    verificationBackend: { backend: 'managed-readonly-rcon', snapshot: { verifyMinecarts: async () => { throw Object.assign(new Error('Minecart Enabled differs'), { evidence: [{ command: 'data get entity @e[type=minecraft:hopper_minecart,limit=1]' }] }) } } },
    mechanisms: { normalizeMinecartEntities: () => [{ id: 'cart', layer: 64 }], ignitePortals: async () => ({ verified: true }), verifyMinecarts: async () => assert.fail('No fallback after snapshot mismatch') }
  })
  const report = {}
  await assert.rejects(hooks.afterBuild({ workers: [], signal: new AbortController().signal, report, emit: () => {} }), /Enabled differs/)
  assert.equal(report.verificationEvidence.length, 1)
  assert.equal(report.entityVerification.verified, false)
})

test('recovery rechecks a cart at its updated assembly layer and audits the actual replacement ID', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [0, 65, 0, 'glass'], [0, 66, 0, 'stone']])
  const expected = [
    { id: 'cart', name: 'chest_minecart', layer: 65, railLayer: 64, pos: new Vec3(0, 64, 0) },
    { id: 'other-cart', name: 'hopper_minecart', layer: 66, railLayer: 66, pos: new Vec3(3, 66, 0) }
  ]
  const calls = []
  const events = []
  const hooks = createMechanismHooks(plan, {
    recoveredEntities: [{ id: 'cart', verified: true, entityId: 5, layer: 64 }, { id: 'other-cart', verified: true, entityId: 7, layer: 66 }],
    mechanisms: {
      normalizeMinecartEntities: () => expected,
      placeMinecart: async (bot, entity, { claimedIds }) => {
        calls.push(entity.id)
        assert.equal(claimedIds.has(5), false)
        assert.equal(claimedIds.has(7), true)
        return { verified: true, reused: false, entityId: 9 }
      }
    }
  })
  const report = {}
  const context = { workers: [{ id: 'bot', position: new Vec3(0, 69, 0), bot: {}, executor: {} }], signal: new AbortController().signal, report, emit: event => events.push(event) }
  await hooks.afterLayer({ ...context, layer: 64 })
  assert.deepEqual(calls, [])
  await hooks.afterLayer({ ...context, layer: 65 })
  await hooks.afterLayer({ ...context, layer: 65 })
  assert.deepEqual(calls, ['cart'])
  const record = report.entities.find(entity => entity.id === 'cart')
  assert.equal(record.entityId, 9)
  assert.equal(record.layer, 65)
  assert.equal(record.railLayer, 64)
  assert.deepEqual(record.recoveryCheck, { previousEntityId: 5, previousLayer: 64, replaced: true })
  const audit = events.find(event => event.type === 'entity-complete')
  assert.equal(audit.record.entityId, 9)
  assert.equal(audit.record.recoveryCheck.previousEntityId, 5)
})

test('failed recovery entity rechecks become pending instead of keeping a stale verified record', async () => {
  const plan = blueprint([[0, 64, 0, 'stone']])
  const hooks = createMechanismHooks(plan, {
    recoveredEntities: [{ id: 'cart', verified: true, entityId: 5, layer: 64 }],
    mechanisms: {
      normalizeMinecartEntities: () => [{ id: 'cart', layer: 64, railLayer: 64, pos: new Vec3(0, 64, 0) }],
      placeMinecart: async () => { throw new Error('Missing rail face') }
    }
  })
  const report = {}
  const events = []
  await assert.rejects(hooks.afterLayer({ layer: 64, workers: [{ id: 'bot', position: new Vec3(0, 69, 0), bot: {}, executor: {} }], signal: new AbortController().signal, report, emit: event => events.push(event) }), /Missing rail face/)
  assert.deepEqual(report.entitiesPending, ['cart'])
  assert.equal(report.entitiesVerified, 0)
  assert.equal(report.entities.length, 0)
  assert.equal(events.find(event => event.type === 'entity-error').previousEntityId, 5)
})

test('a recovered live entity may retain its own claimed ID after a physical presence recheck', async () => {
  const plan = blueprint([[0, 64, 0, 'stone']])
  let checked = 0
  const hooks = createMechanismHooks(plan, {
    recoveredEntities: [{ id: 'cart', verified: true, entityId: 5, layer: 64 }],
    mechanisms: {
      normalizeMinecartEntities: () => [{ id: 'cart', layer: 64, railLayer: 64, pos: new Vec3(0, 64, 0) }],
      placeMinecart: async (bot, entity, { claimedIds }) => {
        checked++
        assert.equal(claimedIds.has(5), false)
        return { verified: true, reused: true, entityId: 5 }
      }
    }
  })
  const report = {}
  await hooks.afterLayer({ layer: 64, workers: [{ id: 'bot', position: new Vec3(0, 69, 0), bot: {}, executor: {} }], signal: new AbortController().signal, report, emit: () => {} })
  assert.equal(checked, 1)
  assert.equal(report.entities[0].entityId, 5)
  assert.equal(report.entities[0].recoveryCheck.replaced, false)
})

test('a different workers unconfirmed dig prevents optimistic air from completing cleanup', async () => {
  const plan = blueprint([[0, 64, 0, 'stone'], [4, 64, 0, 'stone'], [4, 65, 0, 'glass']])
  const env = environment(plan, { perform: async task => { if (task.type === 'dig') env.workers[1].executor.unconfirmedDigs.add(key(task.pos)) } })
  env.workers[1].executor.unconfirmedDigs = new Set()
  await assert.rejects(runLayeredBuild({ ...env, options: { maxAttempts: 2 }, signal: new AbortController().signal, settleMs: 0 }), /attempt limit|confirmed/)
  assert.equal(env.history.some(event => event.layer === 65), false)
})

test('a different workers unconfirmed waterlogging prevents predicted wet state from completing a layer', async () => {
  const plan = blueprint([[0, 64, 0, 'oak_slab', { waterlogged: true }], [0, 65, 0, 'glass']])
  const env = environment(plan, { perform: async task => { if (task.pos.y === 64) env.workers[1].executor.unconfirmedWaterlogs.set(key(task.pos), task.state) } })
  env.workers[1].executor.unconfirmedWaterlogs = new Map()
  await assert.rejects(runLayeredBuild({ ...env, options: { maxAttempts: 2 }, signal: new AbortController().signal, settleMs: 0 }), /attempt limit|confirmed/)
  assert.equal(env.history.some(event => event.layer === 65), false)
})

test('clone operator grants require frozen identity, exact online names and durable matching operator UUIDs', async () => {
  const options = { host: '127.0.0.1', port: 25567, version: '1.21.4' }
  const workers = [0, 1].map(index => ({ id: `aligned0${index}`, bot: { username: `aligned0${index}`, player: { uuid: `uuid-${index}` }, entity: {}, _client: { state: 'play' } } }))
  const commands = []
  const events = []
  const operators = []
  let frozen = true
  let checks = 0
  let unlocks = 0
  const snapshot = { readTickState: async () => { checks++; return { frozen, quiescent: true, evidence: [{ command: 'tick query', response: 'frozen' }] } } }
  const clone = {
    STATE: '/stub/run.json',
    readJson: async () => ({ pid: 12, startedAt: 'now', directory: '/stub/clone' }),
    validateState: state => state,
    commandForState: async (state, command) => {
      assert.equal(state.pid, 12)
      commands.push(command)
      const worker = workers[commands.length - 1]
      operators.push({ name: worker.bot.username, uuid: worker.bot.player.uuid, level: 4 })
      return `Made ${worker.bot.username} a server operator`
    }
  }
  const settings = { clone, readOperators: async () => operators, acquireLock: async () => async () => { unlocks++ }, onEvent: event => events.push(event) }
  const result = await grantManagedCloneOperators(workers, options, { backend: 'managed-readonly-rcon', snapshot }, settings)
  assert.equal(result.length, 2)
  assert.equal(checks, 2)
  assert.deepEqual(commands, workers.map(worker => `execute if entity @a[name=${worker.bot.username},limit=1] run op ${worker.bot.username}`))
  assert.equal(events.filter(event => event.type === 'operator-grant-complete').length, 2)
  assert.equal(unlocks, 1)
  frozen = false
  await assert.rejects(grantManagedCloneOperators(workers, options, { backend: 'managed-readonly-rcon', snapshot }, settings), /frozen/)
  assert.equal(commands.length, 2)
  frozen = true
  workers[0].bot._client.state = 'disconnected'
  await assert.rejects(grantManagedCloneOperators(workers, options, { backend: 'managed-readonly-rcon', snapshot }, settings), /online/)
  assert.equal(commands.length, 2)
})

test('clone operator intent cancellation prevents the command and an unconfirmed grant fails closed', async () => {
  const options = { host: '127.0.0.1', port: 25567, version: '1.21.4' }
  const worker = { id: 'aligned00', bot: { username: 'aligned00', player: { uuid: 'uuid' }, entity: {}, _client: { state: 'play' } } }
  const controller = new AbortController()
  let commands = 0
  const clone = { readJson: async () => ({}), validateState: state => state, commandForState: async () => { commands++; return 'Not found' } }
  const settings = { clone, readOperators: async () => [], acquireLock: async () => async () => {}, signal: controller.signal, onEvent: () => controller.abort(new Error('cancel before op')) }
  const verification = { backend: 'managed-readonly-rcon', snapshot: { readTickState: async () => ({ frozen: true, quiescent: true }) } }
  await assert.rejects(grantManagedCloneOperators([worker], options, verification, settings), /cancel before op/)
  assert.equal(commands, 0)
  await assert.rejects(grantManagedCloneOperators([worker], options, verification, { ...settings, signal: undefined, onEvent: () => {} }), /operator.*confirmed/i)
  assert.equal(commands, 1)
})
