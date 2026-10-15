const fs = require('node:fs/promises')
const { appendFileSync } = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { Vec3 } = require('vec3')
const { DEFAULT_BOTS, MAX_BOTS } = require('../lib/buildLimits')
const { LayerScheduler } = require('../lib/layerScheduler')
const { planLayerSupports, createSupportCleanupTasks } = require('../lib/layerSupports')
const { buildIdentity, loadRecovery } = require('../lib/buildRecovery')
const { approachGoal } = require('../lib/physicalApproach')
const { verifyNoteBlockMusic } = require('../lib/noteBlockMusic')
const { createMusicWorkspace } = require('../lib/musicWorkspace')
const { readPlan, resolveState, matchesTarget, matchesPhysicalTarget, dynamicProperties, createBuildContext, inspectPlan, preparePhysicalPlan } = require('../lib/strictSchematic')
const AIR = new Set(['air', 'cave_air', 'void_air'])
const RAILS = new Set(['rail', 'powered_rail', 'activator_rail', 'detector_rail'])
const key = pos => `${pos.x},${pos.y},${pos.z}`

function parseOptions (args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      schematic: { type: 'string' },
      fixture: { type: 'boolean', default: false },
      inspect: { type: 'boolean', default: false },
      resume: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '25566' },
      bots: { type: 'string', default: String(DEFAULT_BOTS) },
      version: { type: 'string', default: '1.21.11' },
      'server-profile': { type: 'string' },
      'prepare-workers': { type: 'boolean', default: false },
      origin: { type: 'string' },
      'schematic-origin': { type: 'string' },
      prefix: { type: 'string', default: 'builder' },
      'bottom-layers': { type: 'string' },
      'max-attempts': { type: 'string', default: '12' },
      'spawn-delay': { type: 'string', default: '100' }
    }
  })
  const bots = Number(values.bots)
  const port = Number(values.port)
  const maxAttempts = Number(values['max-attempts'])
  const spawnDelay = Number(values['spawn-delay'])
  const bottomLayers = values['bottom-layers'] === undefined ? Infinity : Number(values['bottom-layers'])
  if (!Number.isInteger(bots) || bots < 1 || bots > MAX_BOTS) throw new Error(`--bots must be between 1 and ${MAX_BOTS}`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port')
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid --max-attempts')
  if (!Number.isFinite(spawnDelay) || spawnDelay < 0) throw new Error('Invalid --spawn-delay')
  if (bottomLayers !== Infinity && (!Number.isInteger(bottomLayers) || bottomLayers < 1)) throw new Error('Invalid --bottom-layers')
  if (!values.fixture && !values.schematic) throw new Error('Provide --schematic <path> or --fixture')
  if (values.fixture && values.schematic) throw new Error('Choose --fixture or --schematic')
  if (!/^[A-Za-z0-9_]{1,14}$/.test(values.prefix)) throw new Error('Invalid --prefix')
  if (values['prepare-workers'] && !values['server-profile']) throw new Error('--prepare-workers requires --server-profile')
  if (values['server-profile'] !== undefined && (!values['server-profile'].trim() || values.host !== '127.0.0.1')) throw new Error('--server-profile requires a local profile and host 127.0.0.1')
  if (values.origin !== undefined && values['schematic-origin'] !== undefined) throw new Error('--origin and --schematic-origin are mutually exclusive')
  if (values.fixture && values['schematic-origin'] !== undefined) throw new Error('--schematic-origin is unavailable for a fixture')
  const parseOrigin = (value, flag) => {
    const parts = value.split(',')
    const xyz = parts.map(Number)
    if (parts.length !== 3 || parts.some(part => !/^-?\d+$/.test(part)) || !xyz.every(Number.isSafeInteger)) throw new Error(`${flag} must be integer x,y,z`)
    return { x: xyz[0], y: xyz[1], z: xyz[2] }
  }
  const origin = parseOrigin(values.origin ?? '0,-60,0', '--origin')
  const schematicOrigin = values['schematic-origin'] === undefined ? undefined : parseOrigin(values['schematic-origin'], '--schematic-origin')
  return { ...values, bots, port, maxAttempts, spawnDelay, bottomLayers, origin, schematicOrigin, serverProfile: values['server-profile'] === undefined ? undefined : path.resolve(values['server-profile']), prepareWorkers: values['prepare-workers'] }
}

async function loadBuildPlan (options, { reader = readPlan } = {}) {
  if (options.fixture) return fixturePlan(options.version, options.origin)
  let plan = await reader(options.schematic, options.version, options.origin)
  if (options.schematicOrigin) {
    const origin = {}
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isSafeInteger(plan.sourceMin?.[axis])) throw new Error('--schematic-origin requires a source schematic coordinate origin')
      origin[axis] = options.schematicOrigin[axis] + plan.sourceMin[axis]
      if (!Number.isSafeInteger(origin[axis])) throw new Error('Translated schematic origin exceeds integer coordinate limits')
    }
    plan = await reader(options.schematic, options.version, origin)
  }
  if (plan.sourceMin) plan.schematicOrigin = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, plan.origin[axis] - plan.sourceMin[axis]]))
  return plan
}

function assertSchematicAlignment (plan, options) {
  if (options.fixture || options.inspect || options.resume || !/Mk\.?6\.1\b/i.test(plan.name || '')) return
  const origin = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, plan.origin?.[axis] - plan.sourceMin?.[axis]]))
  if (!Object.values(origin).every(value => Number.isSafeInteger(value) && value % 16 === 0)) throw new Error(`Mk6.1 schematic origin must be a multiple of 16 on every axis; received ${origin.x},${origin.y},${origin.z}. Use --schematic-origin x,y,z.`)
}

function fixturePlan (version, origin) {
  const tasks = []
  for (let y = 0; y < 3; y++) {
    for (let z = 0; z < 6; z++) {
      for (let x = 0; x < 10; x++) {
        const name = ['stone', 'glass', (x + z) % 2 ? 'observer' : 'piston'][y]
        const block = resolveState(name, y === 2 ? { facing: 'up' } : {}, version)
        const pos = new Vec3(origin.x + x * 3, origin.y + y, origin.z + z * 3)
        tasks.push({ id: `${pos.x},${pos.y},${pos.z}`, type: 'place', pos, state: block.stateId, name })
      }
    }
  }
  return { name: '30-worker physical flight fixture', version, origin, tasks, air: [], blockEntities: [], entities: [], min: new Vec3(origin.x, origin.y, origin.z), max: new Vec3(origin.x + 28, origin.y + 3, origin.z + 16), layers: [origin.y, origin.y + 1, origin.y + 2] }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function checkSignal (signal) {
  if (!signal?.aborted) return
  const error = new Error(signal.reason?.message || 'Build cancelled')
  error.name = 'AbortError'
  throw error
}

function selectedPhysicalTasks (plan, physicalPlan, bottomLayers = Infinity, issues = []) {
  const layers = [...plan.layers].sort((a, b) => a - b).slice(0, bottomLayers)
  const selected = new Set(layers)
  const tasks = physicalPlan.tasks.filter(task => selected.has(task.pos.y))
  const activeIds = new Set(tasks.map(task => task.id))
  const blocking = issues.filter(issue => activeIds.has(issue.id) && issue.reason === 'no-direct-placement-item')
  if (blocking.length) throw new Error(`Unsupported physical placement for ${blocking.length} active targets: ${blocking.slice(0, 5).map(issue => issue.block || issue.id).join(', ')}`)
  return { tasks, layers, selected, derived: physicalPlan.derived.filter(task => selected.has(task.pos.y)), completeBlueprint: layers.length === plan.layers.length }
}

async function stageWorkers (workers, plan, { signal, onEvent = () => {}, minimumLayer = plan.min.y, workspace } = {}) {
  if (workspace) return workspace.parkForRead({ signal, reason: 'staging' })
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const stageY = Math.max(plan.min.y, minimumLayer) + 4
  const columns = Math.max(1, Math.ceil(Math.sqrt(workers.length)))
  const rows = Math.max(1, Math.ceil(workers.length / columns))
  const width = Math.max(6, columns, plan.max.x - plan.min.x)
  const depth = Math.max(5, rows, plan.max.z - plan.min.z)
  let firstError
  try {
    const results = await Promise.allSettled(workers.map(async (worker, index) => {
      try {
        checkSignal(controller.signal)
        await worker.bot.waitForChunksToLoad()
        const target = new Vec3(plan.min.x + (index % columns + 0.5) * width / columns, stageY, plan.min.z + (Math.floor(index / columns) + 0.5) * depth / rows)
        const travelY = Math.max(worker.position.y, stageY)
        const waypoints = [new Vec3(worker.position.x, travelY, worker.position.z), new Vec3(target.x, travelY, target.z), target]
        onEvent({ type: 'stage-start', workerId: worker.id, position: worker.position, target })
        for (const waypoint of waypoints) {
          while (worker.position.distanceTo(waypoint) > 0.15) {
            checkSignal(controller.signal)
            const delta = waypoint.minus(worker.position)
            const length = delta.norm()
            const destination = length <= 8 ? waypoint.clone() : worker.position.plus(delta.scaled(8 / length))
            const previous = worker.position.clone()
            await worker.executor.move(destination, controller.signal)
            checkSignal(controller.signal)
            await worker.bot.waitForChunksToLoad()
            checkSignal(controller.signal)
            if (worker.position.distanceTo(previous) < 0.01) throw new Error(`Staging movement made no progress: ${worker.id}`)
            onEvent({ type: 'stage-move', workerId: worker.id, position: worker.position })
          }
        }
        onEvent({ type: 'stage-complete', workerId: worker.id, position: worker.position })
      } catch (error) {
        if (!controller.signal.aborted && !firstError) {
          firstError = error
          try {
            onEvent({ type: 'stage-error', workerId: worker.id, position: worker.position, error: error.message, stack: error.stack })
          } finally { controller.abort(error) }
        }
        throw error
      }
    }))
    const rejected = results.find(result => result.status === 'rejected')
    if (rejected) throw firstError || controller.signal.reason || rejected.reason
    checkSignal(controller.signal)
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

function updateVerificationMetrics (report, elapsedSeconds) {
  const seconds = Math.max(0.001, elapsedSeconds)
  report.freshVerifiedBlocks = Math.max(0, (report.completed || 0) - (report.resumedReadOnlyBlocks || 0))
  report.freshVerifiedBlocksPerSecond = report.freshVerifiedBlocks / seconds
  report.freshVerifiedBlocksDefinition = 'Active targets verified outside read-only resumed layers, including already-correct targets; excludes scaffolds and natural derived blocks. Not a confirmed placement count.'
  report.verifiedBlocksPerSecond = (report.blueprintBlocksVerified ?? report.completed ?? 0) / seconds
  if (Number.isFinite(report.placementAttempts)) report.placementAttemptsPerSecond = report.placementAttempts / seconds
}

async function runLayeredBuild ({ plan, physicalPlan = preparePhysicalPlan(plan), workers, readBlock, workspace, options = {}, signal, report = {}, onEvent = () => {}, settleMs = 150, naturalTimeoutMs = 120000, fillContainer = (...args) => require('../lib/physicalInventory').fillContainer(...args), afterLayer, afterLayerVerified, afterBuild, afterNaturalGeneration, recovery, constructionPlan = recovery?.constructionPlan }) {
  if (!Number.isFinite(naturalTimeoutMs) || naturalTimeoutMs < 0) throw new Error('Invalid natural generation timeout')
  const selection = selectedPhysicalTasks(plan, physicalPlan, options.bottomLayers)
  const Block = require('prismarine-block')(plan.version)
  const dirt = resolveState('dirt', {}, plan.version)
  const allTargets = new Set(plan.tasks.map(task => key(task.pos)))
  const persistentTasks = (constructionPlan?.tasks || []).map(task => ({ ...task, pos: new Vec3(task.pos.x, task.pos.y, task.pos.z) }))
  const fluidStaging = (constructionPlan?.fluidStaging || []).map(task => ({ ...task, pos: new Vec3(task.pos.x, task.pos.y, task.pos.z) }))
  const owned = new Map((recovery?.persistentOwned || []).map(task => [key(task.pos), { ...task, pos: new Vec3(task.pos.x, task.pos.y, task.pos.z) }]))
  const selectedTop = Math.max(...selection.layers)
  const constructionLayers = [...new Set([...selection.layers, ...persistentTasks.filter(task => task.pos.y <= selectedTop).map(task => task.pos.y)])].sort((a, b) => a - b)
  for (const task of persistentTasks) allTargets.add(key(task.pos))
  const wanted = new Map([...plan.tasks, ...selection.tasks].map(task => [task.state, Block.fromStateId(task.state, 0)]))
  wanted.set(dirt.stateId, dirt)
  const allSelected = plan.tasks.filter(task => selection.selected.has(task.pos.y))
  const generatedBedHeads = selection.derived.filter(task => task.reason === 'generated-by-bed')
  const active = new Set()
  const started = Date.now()
  Object.assign(report, { status: 'building', completeBlueprint: selection.completeBlueprint, completed: 0, resumedReadOnlyBlocks: 0, attempts: 0, dependencyDeferrals: 0, activeWorkers: 0, peakActiveWorkers: 0, scaffoldBlocks: 0, derivedTargets: selection.derived.length, layers: [], workers: report.workers || {} })
  report.constructionPlan = constructionPlan
  report.persistentOwned = [...owned.values()]
  report.highestPlacedLayer = recovery?.highestLayer ?? null
  delete report.blocksPerSecond
  for (const worker of workers) report.workers[worker.id] = { completed: 0, attempts: 0, errors: 0, state: 'ready', ...(report.workers[worker.id] || {}), position: worker.position }
  const emit = event => onEvent({ time: Date.now(), activeLayer: report.currentLayer, activeWorkers: active.size, ...event })
  const parkForRead = async reason => workspace?.parkForRead({ signal, reason })
  const calibrateRails = async tasks => {
    await parkForRead('rail-verification')
    await calibrateExistingRails({ tasks, version: plan.version, workers, readBlock, signal, report, emit })
    await parkForRead('rail-verification-complete')
  }
  const confirmedAir = pos => AIR.has(readBlock(pos)?.name) && workers.every(worker => !worker.executor.unconfirmedDigs?.has(key(pos)))
  const isSatisfied = task => task.type === 'dig' ? confirmedAir(task.pos) : workers.every(worker => !worker.executor.unconfirmedWaterlogs?.has(key(task.pos))) && matchesPhysicalTarget(wanted.get(task.state), readBlock(task.pos), task)
  const checkAir = (layer, temporary = new Set()) => {
    for (const pos of plan.air) {
      if (pos.y !== layer || temporary.has(key(pos)) || owned.has(key(pos))) continue
      if (!confirmedAir(pos)) throw new Error(`Expected air is occupied or unconfirmed at ${pos}; refusing to advance`)
    }
  }
  const verifyTargets = layerTasks => {
    const missing = layerTasks.filter(task => !isSatisfied(task))
    if (missing.length) throw new Error(`Layer verification after cleanup failed at ${missing[0].id}; refusing to advance`)
  }
  const runPhase = async (phase, layer, tasks, targets, temporary) => {
    const scheduler = new LayerScheduler({
      tasks,
      workers,
      signal,
      taskOwner: workspace?.ownerForTask,
      maxAttempts: phase === 'targets' && temporary.size ? Math.max(options.maxAttempts || 12, 40) : (options.maxAttempts || 12),
      execute: async (worker, task, context) => {
        if (context.layer !== report.currentLayer || task.pos.y !== report.currentLayer) throw new Error('Layer audit rejected an out-of-layer operation')
        const persistentCleanup = phase === 'persistent-cleanup' && task.type === 'dig' && owned.has(key(task.pos))
        if (recovery && task.pos.y < recovery.highestLayer && !persistentCleanup) throw new Error('Recovery audit rejected a lower-layer write')
        const status = report.workers[worker.id]
        active.add(worker.id)
        report.activeWorkers = active.size
        report.peakActiveWorkers = Math.max(report.peakActiveWorkers, active.size)
        try {
          if (workspace) await workspace.approachTask(worker, task, { signal: context.signal })
          if (task.persistent && task.type === 'place' && !owned.has(key(task.pos))) {
            const actual = readBlock(task.pos)
            if (!actual || (!AIR.has(actual.name) && !((task.replacesDerived || task.purpose === 'fluid-staging') && actual.name === 'water'))) throw new Error(`Unowned occupied persistent support at ${task.id}`)
            owned.set(key(task.pos), task)
            report.persistentOwned = [...owned.values()]
            emit({ type: 'persistent-support-claimed', phase, layer, record: task })
          }
          if (persistentCleanup && !confirmedAir(task.pos)) await reachContainer(worker, task, context.signal)
          if (task.type === 'place') report.highestPlacedLayer = Math.max(report.highestPlacedLayer ?? task.pos.y, task.pos.y)
          const success = await worker.executor.perform(task, { ...context, attempts: scheduler.records.get(task.id).attempts })
          if (success && task.type === 'place' && require('../lib/physicalInventory').isContainerTask(task)) {
            checkSignal(context.signal)
            status.state = 'filling-container'
            await reachContainer(worker, task, context.signal)
            const fill = () => fillContainer(worker.bot, task, { signal: context.signal })
            const contents = worker.executor.mutate ? await worker.executor.mutate(false, context.signal, fill) : await fill()
            if (!contents?.verified) throw new Error(`Container contents were not verified at ${task.id}`)
            status.containersFilled = (status.containersFilled || 0) + 1
            if (worker.executor.park) await worker.executor.park(context.layer, context.signal)
          }
          return success === true
        } catch (error) {
          if (error.message === 'Waiting for support in the completed structure or current layer') error.code = 'LAYER_DEPENDENCY_PENDING'
          if (error.code === 'LAYER_DEPENDENCY_PENDING') {
            status.dependencyDeferrals = (status.dependencyDeferrals || 0) + 1
          } else {
            status.errors++
            status.lastError = error.message
          }
          throw error
        } finally {
          active.delete(worker.id)
          report.activeWorkers = active.size
          status.position = worker.position
          status.state = signal?.aborted ? 'stopping' : 'ready'
        }
      },
      verifyLayer: async () => {
        await parkForRead('phase-verification')
        if (settleMs) await sleep(settleMs)
        checkSignal(signal)
        const missing = tasks.filter(task => !isSatisfied(task))
        if (!missing.length) {
          if (phase === 'cleanup' || phase === 'persistent-cleanup') verifyTargets(targets)
          checkAir(layer, phase === 'targets' ? temporary : new Set())
        }
        return missing
      },
      onEvent: event => {
        report.remainingInLayer = event.remaining
        if (event.type === 'task-start') {
          report.attempts++
          Object.assign(report.workers[event.workerId], { task: event.taskId, state: phase === 'cleanup' ? 'cleaning' : 'working' })
          report.workers[event.workerId].attempts++
        }
        if (event.type === 'task-complete') report.workers[event.workerId].completed++
        if (event.type === 'task-deferred') report.dependencyDeferrals++
        if (event.type === 'task-retry') {
          if (event.workerId && !event.error) report.workers[event.workerId].errors++
          if (event.workerId) report.workers[event.workerId].lastError = event.error || 'Target not yet satisfied'
        }
        emit({ ...event, phase, taskPos: event.taskId ? scheduler.records.get(event.taskId)?.task.pos : undefined })
      }
    })
    return scheduler.run()
  }
  const cleanPersistent = async (supports, targets) => {
    if (supports.length) await parkForRead('persistent-cleanup-planning')
    const activeLayer = report.currentLayer
    const layers = [...new Set(supports.map(task => task.pos.y))].sort((a, b) => b - a)
    for (const layer of layers) {
      const selected = supports.filter(task => task.pos.y === layer)
      for (const task of selected) {
        const actual = readBlock(task.pos)
        if (!actual || (!AIR.has(actual.name) && actual.stateId !== dirt.stateId)) throw new Error(`Owned persistent support material changed at ${task.id}; refusing to dig`)
      }
      report.currentLayer = layer
      emit({ type: 'persistent-cleanup-start', phase: 'persistent-cleanup', layer, constructionLayer: activeLayer, positions: selected.map(task => task.pos) })
      await runPhase('persistent-cleanup', layer, createSupportCleanupTasks(selected), targets, new Set())
      for (const task of selected) {
        if (!confirmedAir(task.pos)) throw new Error(`Persistent support cleanup is unconfirmed at ${task.id}`)
        owned.delete(key(task.pos))
        report.persistentOwned = [...owned.values()]
        emit({ type: 'persistent-support-removed', phase: 'persistent-cleanup', layer, record: task })
      }
      checkAir(layer)
    }
    report.currentLayer = activeLayer
  }
  try {
    await parkForRead('initial-verification')
    const verifiedLayers = new Set(recovery?.completedLayers || [])
    const recoveredSupports = recovery?.supports || []
    if (recovery) {
      if (!constructionLayers.includes(recovery.highestLayer)) throw new Error('Recovery selection must include the historical highest layer')
      report.currentLayer = recovery.highestLayer
      await calibrateRails(selection.tasks.filter(task => task.pos.y < recovery.highestLayer || verifiedLayers.has(task.pos.y)))
      for (const layer of constructionLayers.filter(layer => layer < recovery.highestLayer || verifiedLayers.has(layer))) {
        const missing = [...selection.tasks, ...generatedBedHeads].filter(task => task.pos.y === layer && !isSatisfied(task))
        if (missing.length) throw new Error(`Recovery found a damaged completed lower layer at ${missing[0].id}; lower-layer replacement is forbidden`)
        checkAir(layer)
      }
      for (const support of recoveredSupports) {
        if (support.pos.y !== recovery.highestLayer || allTargets.has(key(support.pos))) throw new Error('Recovery scaffold is outside the active layer or overlaps a target')
        const actual = readBlock(support.pos)
        if (!actual || (!AIR.has(actual.name) && actual.stateId !== dirt.stateId)) throw new Error(`Recovery scaffold material changed at ${support.id}; refusing to modify it`)
      }
    }
    for (const task of owned.values()) {
      const actual = readBlock(task.pos)
      if (!actual || (!AIR.has(actual.name) && actual.stateId !== dirt.stateId)) throw new Error(`Owned persistent support material changed at ${task.id}`)
      if (AIR.has(actual.name) && task.pos.y < (recovery?.highestLayer ?? -Infinity) && task.releaseLayer === undefined && !constructionLayers.every(layer => verifiedLayers.has(layer))) throw new Error(`Recovery found a missing lower persistent tower section at ${task.id}; lower-layer replacement is forbidden`)
    }
    for (const layer of constructionLayers) {
      checkSignal(signal)
      report.currentLayer = layer
      const targets = selection.tasks.filter(task => task.pos.y === layer)
      const verificationTargets = [...targets, ...generatedBedHeads.filter(task => task.pos.y === layer)]
      if (recovery && (layer < recovery.highestLayer || verifiedLayers.has(layer))) {
        report.completed += targets.length
        report.resumedReadOnlyBlocks += targets.length
        report.layers.push({ y: layer, blocks: targets.length, supports: 0, verifiedAt: Date.now(), resumedReadOnly: true })
        emit({ type: 'resume-layer-verified', phase: 'layer', layer, layerTotal: targets.length, completed: report.completed, total: selection.tasks.length })
        continue
      }
      emit({ type: 'layer-start', phase: 'layer', layer, layerTotal: targets.length })
      await parkForRead('layer-planning')
      const persistent = persistentTasks.filter(task => task.pos.y === layer)
      const stages = fluidStaging.filter(task => task.pos.y === layer && (owned.has(key(task.pos)) || task.dependentIds.some(id => !isSatisfied(targets.find(target => target.id === id)))))
      const stagedIds = new Set(stages.map(task => task.targetId))
      const mainTargets = targets.filter(task => !stagedIds.has(task.id))
      for (const task of [...persistent, ...stages]) {
        const actual = readBlock(task.pos)
        if (!owned.has(key(task.pos)) && (!actual || (!AIR.has(actual.name) && !((task.replacesDerived || task.purpose === 'fluid-staging') && actual.name === 'water')))) throw new Error(`Unowned occupied persistent support at ${task.id}`)
      }
      const constructionTargets = [...mainTargets, ...persistent, ...stages]
      const planned = planLayerSupports(constructionTargets, { layer, materialState: dirt.stateId, getBlock: readBlock, isTargetAt: pos => allTargets.has(key(pos)), getTargetBlock: task => wanted.get(task.state), stateControlledAttachments: workers.every(worker => worker.executor.useStateComponents === true) })
      const inherited = recoveredSupports.filter(task => task.pos.y === layer && readBlock(task.pos)?.stateId === dirt.stateId)
      const supports = [...new Map([...inherited, ...planned].map(task => [key(task.pos), task])).values()]
      const temporary = new Set([...supports, ...persistent].map(task => key(task.pos)))
      report.scaffoldBlocks += supports.length
      emit({ type: 'supports-planned', layer, count: supports.length, positions: supports.map(task => task.pos) })
      if (constructionTargets.length || supports.length) await runPhase('targets', layer, [...constructionTargets, ...supports], constructionTargets, temporary)
      checkSignal(signal)
      verifyTargets(mainTargets)
      const cleanup = createSupportCleanupTasks(supports)
      if (cleanup.length) await runPhase('cleanup', layer, cleanup, mainTargets, temporary)
      checkSignal(signal)
      verifyTargets(mainTargets)
      for (const support of supports) if (!confirmedAir(support.pos)) throw new Error(`Scaffold cleanup verification failed at ${support.id}`)
      checkAir(layer)
      if (stages.length) {
        await cleanPersistent(stages, mainTargets)
        const roots = targets.filter(task => stagedIds.has(task.id))
        emit({ type: 'fluid-staging-restore', phase: 'targets', layer, targetIds: roots.map(task => task.id) })
        await runPhase('targets', layer, roots, roots, new Set())
      }
      verifyTargets(verificationTargets)
      if (afterLayer) await afterLayer({ layer, plan, workers, signal, report, readBlock, emit })
      await calibrateRails(selection.tasks.filter(task => task.pos.y <= layer))
      await cleanPersistent([...owned.values()].filter(task => Number.isSafeInteger(task.releaseLayer) && task.releaseLayer <= layer), targets)
      checkSignal(signal)
      await calibrateRails(selection.tasks.filter(task => task.pos.y <= layer))
      await parkForRead('layer-complete')
      verifyTargets(verificationTargets)
      checkAir(layer)
      report.completed += targets.length
      report.layers.push({ y: layer, blocks: targets.length, supports: supports.length, verifiedAt: Date.now() })
      emit({ type: 'layer-complete', phase: 'layer', layer, layerTotal: targets.length, completed: report.completed, total: selection.tasks.length })
      if (afterLayerVerified) await afterLayerVerified({ layer, plan, workers, signal, report, readBlock, emit })
      checkSignal(signal)
    }
    if (selection.completeBlueprint && owned.size) await cleanPersistent([...owned.values()], selection.tasks)
    if (afterBuild) await afterBuild({ plan, workers, signal, report, readBlock, emit })
    await calibrateRails(selection.tasks)
    if (plan.entities?.length && !afterLayer && !afterBuild) throw new Error('Final verification cannot complete: blueprint entities have not been handled')
    report.status = 'verifying'
    const bubbleTargets = selection.derived.filter(task => task.name === 'bubble_column')
    let pendingBubbles = bubbleTargets.filter(task => !isSatisfied(task))
    if (pendingBubbles.length) {
      const deadline = Date.now() + naturalTimeoutMs
      report.status = 'waiting-natural-generation'
      report.derivedPending = pendingBubbles.map(task => task.id)
      emit({ type: 'natural-generation-wait', phase: 'verification', pending: report.derivedPending, timeoutMs: naturalTimeoutMs })
      while (pendingBubbles.length) {
        checkSignal(signal)
        pendingBubbles = bubbleTargets.filter(task => !isSatisfied(task))
        report.derivedPending = pendingBubbles.map(task => task.id)
        if (!pendingBubbles.length) break
        const invalid = pendingBubbles.find(task => {
          const block = readBlock(task.pos)
          return block?.name !== 'water' || String(block.getProperties().level) !== '0'
        })
        if (invalid) throw new Error(`Bubble column natural generation failed at ${invalid.id}: expected a source water block or the specified bubble direction`)
        if (Date.now() >= deadline) throw new Error(`气泡柱尚未自然生成（${pendingBubbles.length} 格）。水源已完成；若服务器冻结，请恢复游戏刻后使用原施工记录续建验收。`)
        await sleep(100)
      }
      report.status = 'verifying'
      emit({ type: 'natural-generation-complete', phase: 'verification', targets: bubbleTargets.length })
      if (afterNaturalGeneration) await afterNaturalGeneration({ plan, workers, signal, report, readBlock, emit })
    }
    if (settleMs) await sleep(Math.max(300, settleMs))
    checkSignal(signal)
    await parkForRead('final-verification')
    if (plan.entities?.length && (!report.entityVerification?.verified || !Number.isSafeInteger(report.entitiesExpected) || report.entitiesVerified !== report.entitiesExpected || (selection.completeBlueprint && report.entitiesExpected !== plan.entities.length))) throw new Error('Final entity verification did not cover every selected blueprint entity')
    const banners = allSelected.filter(task => task.name.endsWith('_banner'))
    if (banners.length && (!report.bannerVerification?.verified || report.bannerVerification.checked !== banners.length)) throw new Error('Final banner verification did not cover every selected target')
    if (plan.music) {
      report.musicVerification = verifyNoteBlockMusic(allSelected, readBlock, plan.version)
      emit({ type: 'music-verified', phase: 'verification', ...report.musicVerification })
    }
    report.placementMismatches = allSelected.filter(task => !isSatisfied(task)).map(task => task.id)
    const missing = new Set(report.placementMismatches)
    report.derivedPending = selection.derived.filter(task => missing.has(task.id)).map(task => task.id)
    report.runtimeStateDifferences = allSelected.filter(task => !matchesTarget(wanted.get(task.state), readBlock(task.pos), { exact: true })).map(task => ({ id: task.id, wanted: wanted.get(task.state).getProperties(), actual: readBlock(task.pos)?.getProperties() }))
    for (const layer of selection.layers) checkAir(layer)
    if (missing.size) throw new Error(`Final verification failed: ${missing.size} mismatches (${report.derivedPending.length} derived targets still pending)`)
    report.buildSeconds = Math.max(0.001, (Date.now() - started) / 1000)
    report.blueprintBlocksVerified = allSelected.length
    updateVerificationMetrics(report, report.buildSeconds)
    report.status = selection.completeBlueprint ? 'verified' : 'verified-selected-layers'
    emit({ type: 'complete', status: report.status, completed: report.completed, blueprintBlocksVerified: report.blueprintBlocksVerified })
    return report
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    emit({ type: 'error', phase: 'layer', layer: report.currentLayer, error: error.message })
    throw error
  }
}

async function reachContainer (worker, task, signal) {
  if (!worker.executor.interactionGoal || !worker.executor.reach) return
  const goal = worker.executor.interactionGoal(task.pos)
  await approachGoal(worker, goal, task.pos, { signal })
  await worker.executor.reach(goal, task.pos, signal)
}

async function calibrateExistingRails ({ tasks, version, workers, readBlock, signal, report, emit = () => {} }) {
  const Block = require('prismarine-block')(version)
  const pending = []
  for (const task of tasks.filter(task => RAILS.has(task.name))) {
    const wanted = Block.fromStateId(task.state, 0)
    const actual = readBlock(task.pos)
    if (matchesTarget(wanted, actual)) continue
    if (actual?.name !== wanted.name) throw new Error(`Existing rail calibration refused missing or changed material at ${task.id}`)
    const ignored = dynamicProperties(wanted.name)
    const observed = actual.getProperties()
    if (Object.entries(wanted.getProperties()).some(([name, value]) => name !== 'shape' && !ignored.has(name) && String(observed[name]) !== String(value))) throw new Error(`Existing rail calibration refused a static property difference at ${task.id}`)
    pending.push({ task, wanted, before: observed })
  }
  for (const { task, wanted, before } of pending) {
    checkSignal(signal)
    const worker = workers.filter(worker => typeof worker.executor?.adjustRail === 'function').slice().sort((a, b) => a.position.distanceTo(task.pos) - b.position.distanceTo(task.pos))[0]
    if (!worker) throw new Error(`Existing rail calibration needs an adjustment executor at ${task.id}`)
    const event = { type: 'rail-calibration', layer: task.pos.y, constructionLayer: report.currentLayer, workerId: worker.id, taskId: task.id, taskPos: task.pos, before }
    emit({ ...event, phase: 'start' })
    try {
      await reachContainer(worker, task, signal)
      checkSignal(signal)
      const current = readBlock(task.pos)
      if (current?.name !== wanted.name) throw new Error(`Rail changed before calibration at ${task.id}`)
      const result = await worker.executor.adjustRail(task, wanted, signal)
      checkSignal(signal)
      const acknowledged = worker.bot?.blockAt ? worker.bot.blockAt(task.pos) : readBlock(task.pos)
      if (result !== true || !matchesTarget(wanted, acknowledged)) throw new Error(`Existing rail calibration was not verified at ${task.id}`)
      const propagationDeadline = Date.now() + 300
      while (!matchesTarget(wanted, readBlock(task.pos))) {
        checkSignal(signal)
        if (Date.now() >= propagationDeadline) throw new Error(`Rail calibration cache propagation was not verified at ${task.id}`)
        await new Promise((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); try { checkSignal(signal) } catch (error) { reject(error) } }
          const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, Math.min(50, propagationDeadline - Date.now()))
          signal?.addEventListener('abort', cancel, { once: true })
          if (signal?.aborted) cancel()
        })
      }
      checkSignal(signal)
      const after = readBlock(task.pos)
      const record = { ...event, after: after.getProperties(), verifiedAt: Date.now() }
      report.railCalibrations ||= []
      report.railCalibrations.push(record)
      emit({ ...record, phase: 'complete' })
    } catch (error) {
      emit({ ...event, phase: 'error', error: error.message })
      throw error
    }
  }
  return pending.length
}

async function verifyBuildContents ({ tasks, workers, signal, report, emit, verifyContainer = require('../lib/physicalInventory').verifyContainer, approach = true, backend = 'physical-gui' }) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const pending = tasks.slice()
  const active = new Set()
  const results = []
  report.containersExpected = tasks.length
  report.containersVerified = 0
  report.containerVerification = { verified: false, backend, results }
  try {
    if (tasks.length && !workers.length) throw new Error('Container verification requires connected workers')
    const settled = await Promise.allSettled(workers.map(async worker => {
      try {
        while (pending.length && !controller.signal.aborted) {
          const task = pending.shift()
          checkSignal(controller.signal)
          active.add(worker.id)
          report.activeWorkers = active.size
          report.workers ||= {}
          const status = report.workers[worker.id] ||= { completed: 0, attempts: 0, errors: 0 }
          status.state = 'verifying-container'
          emit({ type: 'container-verify-start', phase: 'verification', layer: task.pos.y, taskId: task.id, workerId: worker.id, activeWorkers: active.size })
          try {
            if (approach) await reachContainer(worker, task, controller.signal)
            const result = await verifyContainer(worker.bot, task, { signal: controller.signal })
            if (!result?.verified) throw new Error(`Final container verification failed at ${task.id}`)
            checkSignal(controller.signal)
            results.push({ ...result, id: task.id, workerId: worker.id })
            report.containersVerified = results.length
            emit({ type: 'container-verify-complete', phase: 'verification', layer: task.pos.y, taskId: task.id, workerId: worker.id })
          } catch (error) {
            status.errors++
            status.lastError = error.message
            throw error
          } finally {
            active.delete(worker.id)
            report.activeWorkers = active.size
            status.position = worker.position
            status.state = controller.signal.aborted ? 'stopping' : 'ready'
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error)
        throw error
      }
    }))
    const rejected = settled.find(result => result.status === 'rejected')
    if (rejected) throw controller.signal.reason || rejected.reason
    checkSignal(controller.signal)
    report.containerVerification.verified = true
    return report.containerVerification
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

async function selectVerificationBackend (options, { signal, snapshotFactory = require('../lib/serverSnapshot').createServerSnapshot, cloneSnapshotFactory = require('../lib/serverSnapshot').createCloneSnapshot, externalSnapshotFactory = require('../lib/serverSnapshot').createExternalSnapshot } = {}) {
  checkSignal(signal)
  if (options.serverProfile) {
    const endpoint = { host: options.host, port: options.port, version: options.version }
    const snapshot = await externalSnapshotFactory(endpoint, { signal, profilePath: options.serverProfile })
    checkSignal(signal)
    return { backend: 'external-readonly-console', snapshot }
  }
  if (options.host !== '127.0.0.1') return { backend: 'physical-gui' }
  const clone = options.port === 25567
  try {
    const endpoint = { host: options.host, port: options.port, version: options.version }
    const snapshot = await (clone ? cloneSnapshotFactory : snapshotFactory)(endpoint, { signal })
    checkSignal(signal)
    return { backend: 'managed-readonly-rcon', snapshot }
  } catch (error) {
    checkSignal(signal)
    if (!clone && (error.code === 'SNAPSHOT_UNAVAILABLE' || error.code === 'ENOENT')) return { backend: 'physical-gui' }
    throw error
  }
}

async function grantManagedCloneOperators (workers, options, verification, {
  signal, onEvent = () => {}, clone = require('../scripts/server-clone'), readOperators = async state => JSON.parse(await fs.readFile(path.join(state.directory, 'ops.json'), 'utf8')), acquireLock = async () => {
    const filename = path.join(clone.ROOT, '.operation-lock')
    const lock = await fs.open(filename, 'wx', 0o600)
    return async () => { await lock.close(); await fs.unlink(filename) }
  }
} = {}) {
  if (options.serverProfile) return []
  if (options.host !== '127.0.0.1' || options.port !== 25567) return []
  if (options.version !== '1.21.4' || verification.backend !== 'managed-readonly-rcon' || !verification.snapshot?.readTickState) throw new Error('Clone operator grants require an attested managed endpoint')
  checkSignal(signal)
  const release = await acquireLock()
  try {
    const state = clone.validateState(await clone.readJson(clone.STATE))
    const results = []
    for (const worker of workers) {
      checkSignal(signal)
      const bot = worker.bot
      const username = bot?.username
      const online = () => bot?._client?.state === 'play' && !bot._client.ended && bot.entity && bot.player?.uuid
      if (!/^[A-Za-z0-9_]{1,16}$/.test(username || '') || !online()) throw new Error('Operator grants require the exact online spawned player')
      const frozen = await verification.snapshot.readTickState({ signal })
      if (frozen.frozen !== true || frozen.quiescent !== true) throw new Error('Operator grants require a frozen and quiescent clone')
      const command = `execute if entity @a[name=${username},limit=1] run op ${username}`
      const evidence = { backend: 'managed-clone-admin', command, pid: state.pid, startedAt: state.startedAt, requestedAt: new Date().toISOString() }
      onEvent({ type: 'operator-grant-intent', workerId: worker.id, username, evidence, freezeEvidence: frozen.evidence || [] })
      checkSignal(signal)
      if (!online()) throw new Error('Operator player is no longer online')
      evidence.response = await clone.commandForState(state, command)
      checkSignal(signal)
      const operators = await readOperators(state)
      const confirmed = operators.some(operator => operator.name === username && operator.uuid?.toLowerCase() === bot.player.uuid.toLowerCase() && Number.isInteger(operator.level) && operator.level >= 2)
      if (!confirmed) throw Object.assign(new Error(`Operator grant was not confirmed for ${username}`), { evidence: [evidence] })
      const result = { workerId: worker.id, username, uuid: bot.player.uuid, verified: true, evidence }
      results.push(result)
      onEvent({ type: 'operator-grant-complete', ...result })
      checkSignal(signal)
    }
    return results
  } finally {
    await release()
  }
}

async function prepareMechanismStaging (plan, { selectedLayers = new Set(plan.layers), signal, mechanisms = require('../lib/physicalMechanisms'), verificationBackend = { backend: 'physical-gui' } } = {}) {
  const staged = mechanisms.normalizeMinecartEntities(plan, { frozen: true, allowDecorations: true }).filter(entity => entity.stagedStrategy && selectedLayers.has(entity.layer))
  if (!staged.length) return { frozen: false, entityIds: [] }
  if (!['managed-readonly-rcon', 'external-readonly-console'].includes(verificationBackend.backend) || !verificationBackend.snapshot?.readTickState) throw new Error('Enclosed minecart staging requires managed or external server freeze attestation')
  checkSignal(signal)
  const attestation = await verificationBackend.snapshot.readTickState({ signal })
  checkSignal(signal)
  if (attestation?.frozen !== true || attestation?.quiescent !== true) throw new Error('Minecart staging requires a frozen and quiescent server')
  return { frozen: true, entityIds: staged.map(entity => entity.id), attestation }
}

function createMechanismHooks (plan, { selectedLayers = new Set(plan.layers), recoveredEntities = [], frozen = false, mechanisms = require('../lib/physicalMechanisms'), inventory = require('../lib/physicalInventory'), verificationBackend = { backend: 'physical-gui' }, DecorationBuilder } = {}) {
  const entities = mechanisms.normalizeMinecartEntities(plan, { frozen, allowDecorations: true }).filter(entity => selectedLayers.has(entity.layer))
  const completeBlueprint = plan.layers.every(layer => selectedLayers.has(layer))
  const decorations = (plan.entities?.length ? require('../lib/physicalDecorationsData').normalizeDecorationEntities(plan) : []).filter(entity => completeBlueprint || selectedLayers.has(Math.floor(entity.pos.y)))
  if (decorations.length && (!verificationBackend.snapshot?.readDecoration || !verificationBackend.snapshot?.verifyDecorations)) throw new Error('Decoration placement requires a strict read-only snapshot with decoration verification')
  const completed = new Map(recoveredEntities.filter(entity => entity.verified && entities.some(expected => expected.id === entity.id)).map(entity => [entity.id, entity]))
  const completedDecorations = new Map()
  const recoveryChecks = new Map(completed)
  const updateReport = report => {
    report.entitiesExpected = entities.length + decorations.length
    report.entitiesVerified = completed.size + completedDecorations.size
    report.entitiesPending = [...entities.filter(entity => !completed.has(entity.id)), ...decorations.filter(entity => !completedDecorations.has(entity.id))].map(entity => entity.id)
    report.entities = [...completed.values(), ...completedDecorations.values()]
    report.decorationsExpected = decorations.length
    report.decorationsVerified = completedDecorations.size
  }
  return {
    async afterLayer ({ layer, workers, signal, report, emit }) {
      updateReport(report)
      for (const entity of entities.filter(entity => entity.layer === layer && (!completed.has(entity.id) || recoveryChecks.has(entity.id)))) {
        checkSignal(signal)
        const previous = recoveryChecks.get(entity.id)
        const worker = workers.filter(worker => !worker.bot._client?.ended).slice()
          .sort((a, b) => a.position.distanceSquared(entity.pos) - b.position.distanceSquared(entity.pos))[0]
        if (!worker) throw new Error(`No connected worker for ${entity.id}`)
        report.workers ||= {}
        const status = report.workers[worker.id] ||= { completed: 0, attempts: 0, errors: 0 }
        status.state = previous ? 'rechecking-entity' : 'placing-entity'
        status.attempts++
        report.activeWorkers = 1
        report.peakActiveWorkers = Math.max(report.peakActiveWorkers || 0, 1)
        if (previous) {
          completed.delete(entity.id)
          updateReport(report)
        }
        const claimedIds = new Set([...completed.values()].map(record => record.entityId).filter(id => id !== undefined))
        const recoveryDetails = previous ? { previousEntityId: previous.entityId, previousLayer: previous.layer } : {}
        emit({ type: 'entity-start', phase: 'mechanism', layer, railLayer: entity.railLayer, workerId: worker.id, entityId: entity.id, activeWorkers: 1, recoveryCheck: Boolean(previous), ...recoveryDetails })
        try {
          const assertFrozen = entity.stagedStrategy
            ? async () => {
              checkSignal(signal)
              if (!['managed-readonly-rcon', 'external-readonly-console'].includes(verificationBackend.backend) || !verificationBackend.snapshot?.readTickState) throw new Error('Staged minecart requires managed or external freeze attestation')
              report.freezeEvidence ||= []
              try {
                const state = await verificationBackend.snapshot.readTickState({ signal })
                report.freezeEvidence.push(...(state.evidence || []))
                emit({ type: 'freeze-attestation', layer, entityId: entity.id, workerId: worker.id, ...state })
                checkSignal(signal)
                if (state.frozen !== true || state.quiescent !== true) throw new Error('Minecart staging requires a frozen and quiescent server')
                return state
              } catch (error) {
                report.freezeEvidence.push(...(error.evidence || []))
                throw error
              }
            }
            : undefined
          const result = await mechanisms.placeMinecart(worker.bot, entity, { signal, executor: worker.executor, claimedIds, assertFrozen, onEvent: event => emit({ ...event, layer, entityId: entity.id, workerId: worker.id }) })
          if (!result?.verified) throw new Error(`Entity placement was not verified: ${entity.id}`)
          checkSignal(signal)
          const recoveryCheck = previous ? { ...recoveryDetails, replaced: previous.entityId !== result.entityId } : undefined
          completed.set(entity.id, { ...result, id: entity.id, name: entity.name, layer, railLayer: entity.railLayer, workerId: worker.id, recoveryCheck })
          recoveryChecks.delete(entity.id)
          updateReport(report)
          emit({ type: 'entity-complete', phase: 'mechanism', layer, railLayer: entity.railLayer, workerId: worker.id, entityId: entity.id, record: completed.get(entity.id) })
          if (worker.executor.park) await worker.executor.park(layer, signal)
        } catch (error) {
          status.errors++
          status.lastError = error.message
          emit({ type: 'entity-error', phase: 'mechanism', layer, railLayer: entity.railLayer, workerId: worker.id, entityId: entity.id, error: error.message, ...recoveryDetails })
          throw error
        } finally {
          report.activeWorkers = 0
          status.state = signal?.aborted ? 'stopping' : 'ready'
          status.position = worker.position
        }
      }
    },
    async afterBuild ({ workers, signal, report, emit, readOnly = false }) {
      checkSignal(signal)
      report.verificationBackend = verificationBackend.backend
      report.verificationEvidence = []
      const snapshot = verificationBackend.snapshot
      const containers = plan.tasks.filter(task => selectedLayers.has(task.pos.y) && inventory.isContainerTask(task))
      const banners = plan.tasks.filter(task => selectedLayers.has(task.pos.y) && task.name.endsWith('_banner'))
      if (readOnly && !snapshot && (entities.length || decorations.length || containers.length)) throw new Error('Final checks after natural generation require a read-only snapshot; physical observation or container interaction is not allowed')
      const readSnapshot = async operation => {
        try {
          const result = await operation()
          report.verificationEvidence.push(...(result.evidence || []))
          return result
        } catch (error) {
          report.verificationEvidence.push(...(error.evidence || []))
          throw error
        }
      }
      updateReport(report)
      const pendingMinecarts = entities.filter(entity => !completed.has(entity.id))
      if (pendingMinecarts.length) throw new Error(`Entity verification pending: ${pendingMinecarts.map(entity => entity.id).join(', ')}`)
      if (!readOnly && decorations.length) {
        report.status = 'placing-decorations'
        const Builders = DecorationBuilder || require('../lib/physicalDecorations').PhysicalDecorations
        for (const entity of decorations.filter(entity => !completedDecorations.has(entity.id))) {
          checkSignal(signal)
          const worker = workers.filter(worker => !worker.bot._client?.ended).slice().sort((a, b) => a.position.distanceSquared(entity.pos) - b.position.distanceSquared(entity.pos))[0]
          if (!worker) throw new Error(`No connected worker for decoration ${entity.id}`)
          const builder = new Builders({ bot: worker.bot, executor: worker.executor, snapshot, signal, onEvent: event => emit({ ...event, entityId: entity.id, workerId: worker.id }) })
          const result = await builder.placeDecoration(entity, { signal })
          if (!result?.verified) throw new Error(`Decoration placement was not verified: ${entity.id}`)
          checkSignal(signal)
          const record = { ...result, id: entity.id, name: entity.name, layer: Math.floor(entity.pos.y), workerId: worker.id }
          completedDecorations.set(entity.id, record)
          updateReport(report)
          emit({ type: 'decoration-placement', action: 'complete', phase: 'decoration', entityId: entity.id, workerId: worker.id, record })
        }
      }
      let portalPlan = plan
      if (!completeBlueprint) {
        const frames = mechanisms.findPortalFrames ? mechanisms.findPortalFrames(plan) : []
        const ready = frames.filter(frame => [...frame.positions, ...frame.frame].every(pos => selectedLayers.has(pos.y)))
        const readyPositions = new Set(ready.flatMap(frame => frame.positions.map(key)))
        report.portalsDeferred = frames.length - ready.length
        portalPlan = ready.length ? { ...plan, tasks: plan.tasks.filter(task => task.name !== 'nether_portal' || readyPositions.has(key(task.pos))) } : null
      }
      if (portalPlan && !readOnly) {
        report.status = 'igniting-portals'
        emit({ type: 'portals-start', phase: 'mechanism' })
        const result = await mechanisms.ignitePortals(workers, portalPlan, { signal })
        if (!result?.verified) throw new Error('Portal ignition was not verified')
        checkSignal(signal)
        report.portals = result
        emit({ type: 'portals-complete', phase: 'mechanism', portals: result.portals, blocks: result.blocks })
      }
      report.status = 'verifying-entities'
      report.entityVerification = { verified: false, backend: verificationBackend.backend }
      let entityResult = entities.length
        ? await (snapshot ? readSnapshot(() => snapshot.verifyMinecarts(entities, { signal })) : mechanisms.verifyMinecarts(workers, entities, { signal }))
        : { verified: true, entities: 0, matches: [] }
      if (decorations.length) {
        report.decorationVerification = { verified: false, backend: verificationBackend.backend }
        const result = await readSnapshot(() => snapshot.verifyDecorations(decorations, { signal }))
        const matches = result.entities
        if (!result.verified || result.checked !== decorations.length || !Array.isArray(matches) || matches.length !== decorations.length || new Set(matches.map(match => match.id)).size !== decorations.length || decorations.some(entity => !matches.some(match => match.id === entity.id))) throw new Error('Final decoration verification did not cover every target')
        report.decorationVerification = { ...result, backend: verificationBackend.backend }
        for (const entity of decorations) completedDecorations.set(entity.id, { ...completedDecorations.get(entity.id), ...matches.find(match => match.id === entity.id), id: entity.id, name: entity.name, layer: Math.floor(entity.pos.y), verified: true })
        updateReport(report)
        entityResult = {
          ...entityResult,
          minecarts: { entities: entityResult.entities, matches: entityResult.matches },
          entities: entityResult.entities + matches.length,
          matches: [...(entityResult.matches || []), ...matches],
          decorations: report.decorationVerification
        }
      }
      report.entityVerification = { ...entityResult, backend: verificationBackend.backend }
      if (!report.entityVerification.verified) throw new Error('Final live entity verification failed')
      report.entitiesVerified = report.entityVerification.entities
      if (banners.length) {
        report.bannerVerification = { verified: false, backend: verificationBackend.backend }
        if (!snapshot?.verifyBanners) throw new Error('Banner verification requires a strict read-only snapshot')
        const result = await readSnapshot(() => snapshot.verifyBanners(banners, { signal }))
        if (!result.verified || result.checked !== banners.length) throw new Error('Final banner verification did not cover every target')
        report.bannerVerification = { ...result, backend: verificationBackend.backend }
      }
      report.status = 'verifying-containers'
      await verifyBuildContents({
        tasks: containers,
        workers,
        signal,
        report,
        emit,
        approach: !snapshot,
        backend: verificationBackend.backend,
        verifyContainer: snapshot ? (_bot, task, settings) => readSnapshot(() => snapshot.verifyContainer(task, settings)) : inventory.verifyContainer
      })
      checkSignal(signal)
      report.status = 'verifying'
    }
  }
}

async function stopBots (bots) {
  await Promise.allSettled(bots.map(bot => new Promise(resolve => {
    if (bot._client?.ended) {
      clearTimeout(bot._client.closeTimer)
      resolve()
      return
    }
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      bot.off('end', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      bot._client?.socket?.destroy()
      bot.emit('end', 'strict-build-forced-close')
      finish()
    }, 2000)
    bot.once('end', finish)
    try {
      bot.pathfinder?.setGoal(null)
      bot.stopDigging?.()
      bot.clearControlStates?.()
      bot.entity?.velocity?.set(0, 0, 0)
      bot.quit('strict-build-finished')
      if (bot._client?.ended) bot.emit('end', 'strict-build-finished')
    } catch (_) {
      bot._client?.socket?.destroy()
      bot.emit('end', 'strict-build-close-error')
      finish()
    }
  })))
}

async function connectWorker (index, options, signal, onBot) {
  const mineflayer = require('mineflayer')
  const { pathfinder } = require('mineflayer-pathfinder')
  const bot = mineflayer.createBot({ host: options.host, port: options.port, username: options.prefix + String(index).padStart(2, '0'), version: options.version, auth: 'offline', hideErrors: true })
  onBot(bot)
  bot.loadPlugin(pathfinder)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Spawn timeout: ${bot.username}`)), 45000)
    const abort = () => finish(signal.reason || new Error('Aborted'))
    const spawn = () => finish()
    const ended = reason => finish(new Error(`${bot.username} disconnected before spawn: ${reason}`))
    function finish (error) {
      clearTimeout(timer)
      bot.off('spawn', spawn)
      bot.off('error', finish)
      bot.off('end', ended)
      signal.removeEventListener('abort', abort)
      if (error) {
        if (!bot._client?.ended) bot.end()
        reject(error)
      } else resolve()
    }
    bot.once('spawn', spawn)
    bot.once('error', finish)
    bot.once('end', ended)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  require('../lib/protocolCompatibility').installProtocolCompatibility(bot)
  if (options.prepareWorkers) await require('../lib/externalWorkerSetup').prepareExternalWorker(bot, options, { signal })
  if (bot.game.gameMode !== 'creative') throw new Error(`${bot.username} requires creative mode`)
  bot.creative.startFlying()
  await bot.waitForChunksToLoad()
  return { id: bot.username, bot, get position () { return bot.entity.position } }
}

function createWorkerReporter (worker, report, recordEvent, controller) {
  const coordinates = pos => pos && { x: pos.x, y: pos.y, z: pos.z }
  return state => {
    if (state.state === 'placing') {
      checkSignal(controller.signal)
      const highest = report.highestPlacementAttemptLayer ?? report.recovery?.highestLayer
      const valid = state.pos && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(state.pos[axis])) && state.pos.y === report.currentLayer && (highest === undefined || state.pos.y >= highest)
      const event = { workerId: worker.id, activeLayer: report.currentLayer, taskPos: coordinates(state.pos), referencePos: coordinates(state.referencePos), face: state.face, useItem: state.useItem, reason: state.reason }
      if (!valid) {
        const error = new Error(`Placement audit rejected ${state.pos ? key(state.pos) : 'missing position'} at active layer ${report.currentLayer}, historical highest ${highest}`)
        controller.abort(error)
        recordEvent({ type: 'placement-audit-rejected', ...event, error: error.message })
        throw error
      }
      try {
        recordEvent({ type: 'placement-attempt', ...event })
      } catch (error) {
        controller.abort(error)
        throw error
      }
      report.highestPlacementAttemptLayer = state.pos.y
      report.placementAttempts = (report.placementAttempts || 0) + 1
      report.workers[worker.id].placementAttempts = (report.workers[worker.id].placementAttempts || 0) + 1
    }
    Object.assign(report.workers[worker.id], state, { position: worker.position })
  }
}

async function main (options = parseOptions()) {
  const plan = await loadBuildPlan(options)
  const data = require('minecraft-data')(plan.version)
  assertSchematicAlignment(plan, options)
  const physicalPlan = preparePhysicalPlan(plan)
  if (plan.min.y < -64 || plan.max.y > 320) throw new Error('Build exceeds overworld height limits')
  const inspection = inspectPlan(plan)
  const runDir = path.resolve('.runtime/builds', new Date().toISOString().replaceAll(':', '-'))
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(path.join(runDir, 'inspection.json'), JSON.stringify(inspection, null, 2))
  const selected = selectedPhysicalTasks(plan, physicalPlan, options.bottomLayers, options.inspect ? [] : inspection.issues)
  console.log(JSON.stringify({ name: plan.name, origin: plan.origin, schematicOrigin: plan.schematicOrigin, blocks: plan.tasks.length, selected: selected.tasks.length, derived: selected.derived.length, layers: selected.layers.length, runDir }))
  if (options.inspect) return inspection

  const recovery = options.resume ? await loadRecovery(options.resume, plan, options) : undefined
  const supportStart = recovery ? (recovery.completedLayers.includes(recovery.highestLayer) ? selected.layers.find(layer => layer > recovery.highestLayer) : recovery.highestLayer) : selected.layers[0]
  const constructionPlan = recovery?.constructionPlan || (supportStart === undefined ? undefined : require('../lib/constructionSupports').planConstructionSupports(plan, physicalPlan, { startLayer: supportStart, materialState: resolveState('dirt', {}, plan.version).stateId, stateControlledAttachments: data.supportFeature('itemsWithComponents') }))
  const { PhysicalBuilder } = require('../lib/physicalBuilder')
  const controller = new AbortController()
  const verificationBackend = await selectVerificationBackend(options, { signal: controller.signal })
  const mechanismStaging = await prepareMechanismStaging(plan, { selectedLayers: selected.selected, signal: controller.signal, verificationBackend })
  const mechanismHooks = createMechanismHooks(plan, { selectedLayers: selected.selected, recoveredEntities: recovery?.entities, verificationBackend, frozen: mechanismStaging.frozen })
  const afterLayerVerified = !options.fixture && verificationBackend.backend === 'managed-readonly-rcon' ? require('../lib/buildCheckpoint').createLayerCheckpoint({ runDir }) : undefined
  const bots = []
  let stopping = false
  const onSignal = () => controller.abort(new Error('Interrupted'))
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const report = { name: plan.name, target: plan.filename, version: options.version, mode: 'physical-strict-layers', origin: plan.origin, identity: buildIdentity(plan, options), recovery, constructionPlan, persistentOwned: recovery?.persistentOwned || [], host: options.host, port: options.port, verificationBackend: verificationBackend.backend, expectedBots: options.bots, connectedBots: 0, completeBlueprint: selected.completeBlueprint, status: 'connecting', placementAttempts: 0, placementAttemptsDefinition: 'Initial block or bucket placement attempts, including failed attempts and scaffolds; excludes existing satisfied targets and state adjustments.', layers: [], workers: {}, runDir }
  report.schematicOrigin = plan.schematicOrigin
  report.mechanismStaging = mechanismStaging
  report.freezeEvidence = mechanismStaging.attestation?.evidence || []
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(report, null, 2))
  await fs.writeFile(path.join(runDir, 'events.jsonl'), '')
  const events = []
  let progressTimer
  let workers = []
  let statusWrite = Promise.resolve()
  const recordEvent = event => {
    const recorded = { time: Date.now(), ...event, position: event.position ? { x: event.position.x, y: event.position.y, z: event.position.z } : undefined }
    appendFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify(recorded) + '\n')
    events.push(recorded)
    if (event.workerId && report.workers[event.workerId]) report.workers[event.workerId].position = workers.find(worker => worker.id === event.workerId)?.position
    if (event.type === 'task-retry' && event.error && event.error !== 'Waiting for support in the completed structure or current layer') console.log(`Retry ${event.taskId}: ${event.error}`)
    if (event.phase === 'layer' && (event.type === 'layer-start' || event.type === 'layer-complete')) console.log(`${event.type} y=${event.layer} blocks=${event.layerTotal} verified=${event.completed || 0}/${selected.tasks.length}`)
    if (event.type === 'natural-generation-wait') console.log(`水源已逐层放好，正在等待 ${event.pending.length} 格气泡柱自然生成。若服务器冻结，请在控制台执行 tick unfreeze；当前只等待验收，不再放置方块（最多 ${event.timeoutMs / 1000} 秒）。`)
  }
  const started = Date.now()
  try {
    const pending = []
    for (let i = 0; i < options.bots; i++) {
      if (controller.signal.aborted) break
      const connection = connectWorker(i, options, controller.signal, bot => {
        bots.push(bot)
        bot.on('error', error => controller.abort(error))
        bot.on('end', reason => { if (!stopping) controller.abort(new Error(`${bot.username} disconnected: ${reason}`)) })
      })
      connection.catch(error => controller.abort(error))
      pending.push(connection)
      await sleep(options.spawnDelay)
    }
    const connected = await Promise.allSettled(pending)
    if (controller.signal.aborted) throw controller.signal.reason
    workers = connected.map(r => {
      if (r.status === 'rejected') throw r.reason
      return r.value
    })
    if (workers.length !== options.bots) throw new Error('Incomplete worker pool')
    report.connectedBots = workers.length
    report.operatorGrants = await grantManagedCloneOperators(workers, options, verificationBackend, { signal: controller.signal, onEvent: recordEvent })
    if (mechanismStaging.frozen) {
      const connectedStaging = await prepareMechanismStaging(plan, { selectedLayers: selected.selected, signal: controller.signal, verificationBackend })
      report.mechanismStaging = connectedStaging
      report.freezeEvidence.push(...(connectedStaging.attestation.evidence || []))
      recordEvent({ type: 'freeze-attestation', phase: 'connected-workers', connectedBots: workers.length, ...connectedStaging.attestation })
    }
    console.log(`All ${workers.length} bots spawned; staging for ${selected.tasks.length} physical targets with layer barriers`)
    const dirt = resolveState('dirt', {}, options.version)
    for (const worker of workers) {
      report.workers[worker.id] = { completed: 0, attempts: 0, errors: 0, state: 'ready', position: worker.position }
      const context = createBuildContext(plan, worker.bot.world)
      if (verificationBackend.snapshot?.verifyBlockStates) context.verifyFluidRay = (blocks, settings) => verificationBackend.snapshot.verifyBlockStates(blocks, settings)
      context.onFatalMutation = error => controller.abort(error)
      context.recordMutationEvidence = event => recordEvent({ type: 'physical-mutation', workerId: worker.id, ...event })
      context.blocks[dirt.stateId] = dirt
      context.properties[dirt.stateId] = dirt.getProperties()
      context.items[dirt.stateId] = data.itemsByName.dirt
      worker.executor = new PhysicalBuilder(worker.bot, context, createWorkerReporter(worker, report, recordEvent, controller))
    }
    const workspace = createMusicWorkspace(plan, workers, { onEvent: recordEvent })
    const readBlock = workspace?.readBlock || (pos => {
      const sorted = workers.slice().sort((a, b) => a.position.distanceSquared(pos) - b.position.distanceSquared(pos))
      for (const worker of sorted) {
        const block = worker.bot.blockAt(pos)
        if (block) return block
      }
      return null
    })
    progressTimer = setInterval(() => {
      for (const worker of workers) report.workers[worker.id].position = worker.position
      updateVerificationMetrics(report, (Date.now() - started) / 1000)
      console.log(`Progress: status=${report.status} layer=${report.currentLayer ?? '-'} active=${report.activeWorkers || 0}/${workers.length} remaining=${report.remainingInLayer ?? '-'} verified=${report.completed || 0}/${selected.tasks.length} resumedReadOnly=${report.resumedReadOnlyBlocks || 0} freshVerified=${report.freshVerifiedBlocks} freshVerificationRate=${report.freshVerifiedBlocksPerSecond.toFixed(2)}/s`)
      const snapshot = JSON.stringify(report, null, 2)
      statusWrite = statusWrite.then(() => fs.writeFile(path.join(runDir, 'status.json'), snapshot)).catch(error => controller.abort(error))
    }, 5000)
    report.status = 'staging'
    await stageWorkers(workers, plan, { signal: controller.signal, onEvent: recordEvent, minimumLayer: recovery?.highestLayer, workspace })
    await runLayeredBuild({ plan, physicalPlan, workers, readBlock, workspace, options, signal: controller.signal, report, onEvent: recordEvent, recovery, constructionPlan, afterLayerVerified, ...mechanismHooks, afterNaturalGeneration: args => mechanismHooks.afterBuild({ ...args, readOnly: true }) })
    console.log(JSON.stringify({ status: report.status, bots: workers.length, peakActiveWorkers: report.peakActiveWorkers, blocks: report.blueprintBlocksVerified, resumedReadOnlyBlocks: report.resumedReadOnlyBlocks, freshVerifiedBlocks: report.freshVerifiedBlocks, freshVerifiedBlocksPerSecond: report.freshVerifiedBlocksPerSecond, placementAttempts: report.placementAttempts, layers: report.layers.length, seconds: report.buildSeconds, verifiedBlocksPerSecond: report.verifiedBlocksPerSecond, placementAttemptsPerSecond: report.placementAttemptsPerSecond, runDir }))
    return report
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    controller.abort(error)
    throw error
  } finally {
    stopping = true
    clearInterval(progressTimer)
    report.elapsedSeconds = (Date.now() - started) / 1000
    await stopBots(bots)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await statusWrite
    await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2))
    await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2))
    await fs.writeFile(path.join(runDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { parseOptions, loadBuildPlan, assertSchematicAlignment, grantManagedCloneOperators, fixturePlan, selectedPhysicalTasks, stageWorkers, runLayeredBuild, createMechanismHooks, verifyBuildContents, reachContainer, selectVerificationBackend, prepareMechanismStaging, updateVerificationMetrics, stopBots, createWorkerReporter, calibrateExistingRails, main }
