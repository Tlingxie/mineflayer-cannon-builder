#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseArgs } = require('node:util')
const { Vec3 } = require('vec3')
const { RaycastIterator } = require('prismarine-world/src/iterators')
const { readPlan, preparePhysicalPlan } = require('../lib/strictSchematic')
const { buildIdentity } = require('../lib/buildRecovery')

const VERSION = '1.21.4'
const SOURCE_SHA256 = '8c2d8bf4dc8059cb083a28368da2efa1be2bd2dd4999d8b8062d115c4c758632'
const ORIGIN = { x: 101, y: -5, z: 102 }
const SCHEMATIC_ORIGIN = { x: 128, y: 0, z: 128 }
const Block = require('prismarine-block')(VERSION)
const registry = require('minecraft-data')(VERSION)
const key = pos => `${pos?.x},${pos?.y},${pos?.z}`
const validPos = pos => pos && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(pos[axis]))
const samePos = (a, b) => validPos(a) && validPos(b) && key(a) === key(b)
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

function blockStateCommand (blocks) {
  const seen = new Set()
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 64) throw new Error('Invalid fluid corridor block count')
  const predicates = blocks.map(row => {
    if (!validPos(row.pos) || seen.has(key(row.pos)) || !Number.isSafeInteger(row.stateId) || !registry.blocksByStateId[row.stateId]) throw new Error('Invalid or duplicate fluid corridor block')
    seen.add(key(row.pos))
    const block = Block.fromStateId(row.stateId, 0)
    const properties = Object.entries(block.getProperties()).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`)
    return `if block ${row.pos.x} ${row.pos.y} ${row.pos.z} minecraft:${block.name}${properties.length ? `[${properties.join(',')}]` : ''}`
  })
  return `execute ${predicates.join(' ')} run time query gametime`
}

function verifyFence (event, expectedGameTime) {
  if (!validPos(event.target) || !validPos(event.reference) || !event.eye || !['x', 'y', 'z'].every(axis => Number.isFinite(event.eye[axis])) || !Number.isFinite(event.yaw) || !Number.isFinite(event.pitch) || !Number.isInteger(event.face) || event.face < 0 || event.face > 5) throw new Error('Fluid pose or reference evidence is incomplete')
  const command = blockStateCommand(event.blocks)
  const fence = event.fence
  if (fence?.verified !== true || fence.checked !== event.blocks.length || !equal(fence.blocks, event.blocks) || fence.gameTime !== expectedGameTime) throw new Error('Fluid fence is incomplete or from another gametime')
  for (const tick of [fence.tickState?.before, fence.tickState?.after]) if (tick?.frozen !== true || tick.quiescent !== true || tick.gameTime !== expectedGameTime) throw new Error('Fluid fence lacks matching frozen quiescence')
  if (!fence.evidence?.some(row => row.backend === 'clone-rcon' && row.command === command && row.response?.trim() === `The time is ${expectedGameTime}`)) throw new Error('Fluid fence lacks its exact successful atomic block-state command')
  const positions = new Map(event.blocks.map(row => [key(row.pos), row]))
  if (!positions.has(key(event.target)) || !positions.has(key(event.reference))) throw new Error('Fluid fence omits its target or reference')
  const eye = new Vec3(event.eye.x, event.eye.y, event.eye.z)
  const direction = new Vec3(-Math.sin(event.yaw) * Math.cos(event.pitch), Math.sin(event.pitch), -Math.cos(event.yaw) * Math.cos(event.pitch))
  const iterator = new RaycastIterator(eye, direction, 4.5)
  let pos = eye.floored()
  let reached = false
  while (pos) {
    if (!positions.has(key(pos))) throw new Error('Fluid fence omits an intervening ray cell')
    const block = Block.fromStateId(positions.get(key(pos)).stateId, 0)
    const ignored = ['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name)
    const fullCube = equal(block.shapes, [[0, 0, 0, 1, 1, 1]])
    const slab = block.name.endsWith('_slab') && ['top', 'bottom', 'double'].includes(block.getProperties().type)
    if (!ignored && !fullCube && !slab) throw new Error('Fluid ray has an unproven selection shape')
    const hit = iterator.intersect(ignored ? [] : block.shapes, new Vec3(pos.x, pos.y, pos.z))
    if (hit) {
      if (!samePos(pos, event.reference) || hit.face !== event.face) throw new Error('Fluid ray does not hit its declared reference face first')
      reached = true
      break
    }
    pos = iterator.next()
  }
  if (!reached) throw new Error('Fluid reference is outside its logged ray reach')
}

function auditRecords ({ foundation, runs, source }) {
  const issues = []
  const pending = []
  const fail = (code, detail = {}) => issues.push({ code, ...detail })
  const expectedLayers = Array.from({ length: 51 }, (_, index) => index - 5)
  const layerCounts = new Map(expectedLayers.map(layer => [layer, source.active.filter(task => task.pos.y === layer).length]))
  const sourceTasks = new Map(source.active.map(task => [key(task.pos), task]))
  if (source.sha256 !== SOURCE_SHA256 || source.active.length !== 12045 || !equal(source.layers, expectedLayers) || !samePos(source.identity.origin, ORIGIN)) fail('source-scope-mismatch')
  const expectedServer = foundation.report.serverIdentity
  if (expectedServer?.host !== '127.0.0.1' || expectedServer.port !== 25567 || expectedServer.version !== VERSION || !Number.isSafeInteger(expectedServer.pid) || expectedServer.pid <= 0 || !Number.isFinite(Date.parse(expectedServer.startedAt)) || !Number.isSafeInteger(expectedServer.gameTime)) fail('foundation-server-identity-invalid')
  if (!samePos(foundation.report.schematicOrigin, SCHEMATIC_ORIGIN)) fail('foundation-origin-mismatch')
  const foundationTasks = new Set((foundation.report.foundation?.tasks || []).map(task => key(task.pos)))
  const foundationLayers = Array.from({ length: 55 }, (_, index) => index - 60)
  let lastTime = -Infinity
  let highestPlacement = -Infinity
  let activeLayer
  let layerOpen = false
  let foundationPlacements = 0
  const foundationDone = new Set()
  const foundationPlaced = new Set()
  for (const [index, event] of foundation.events.entries()) {
    if (!Number.isFinite(event.time) || event.time < lastTime) fail('foundation-time-order', { line: index + 1 })
    lastTime = event.time
    if (event.type === 'layer-start') {
      if (layerOpen || !foundationLayers.includes(event.layer) || (event.layer > -60 && !foundationDone.has(event.layer - 1))) fail('foundation-layer-barrier', { line: index + 1, layer: event.layer })
      activeLayer = event.layer
      layerOpen = true
    }
    if (event.type === 'placement-attempt') {
      foundationPlacements++
      if (!layerOpen || !validPos(event.taskPos) || event.taskPos.y !== event.activeLayer || event.activeLayer !== activeLayer || event.taskPos.y < highestPlacement || !foundationTasks.has(key(event.taskPos)) || foundationPlaced.has(key(event.taskPos))) fail('foundation-placement-order', { line: index + 1 })
      foundationPlaced.add(key(event.taskPos))
      highestPlacement = event.taskPos?.y
    }
    if (event.type === 'layer-complete') {
      if (!layerOpen || event.layer !== activeLayer || !foundationPlaced.has(`161,${event.layer},125`)) fail('foundation-completion-evidence', { line: index + 1 })
      foundationDone.add(event.layer)
      layerOpen = false
    }
  }
  if (foundation.report.status !== 'complete' || foundationPlacements !== 55 || foundationDone.size !== 55 || foundationTasks.size !== 55 || !equal(foundation.report.layers, foundationLayers) || foundation.report.placementAttempts !== 55) fail('foundation-incomplete')
  const completeLayers = new Map()
  const runSummaries = []
  let placements = 0
  let peak = 0
  let fluidsDispatched = 0
  let fluidsConfirmed = 0
  let fluidIntents = 0
  let fencesChecked = 0
  const workerNames = new Set()
  for (const [runIndex, run] of runs.entries()) {
    const report = run.report
    if (!equal(report.identity, source.identity) || !samePos(report.origin, ORIGIN) || !samePos(report.schematicOrigin, SCHEMATIC_ORIGIN)) fail('run-blueprint-identity-mismatch', { run: run.directory })
    if (runIndex === 0 && report.recovery) fail('first-run-has-unprovided-history', { run: run.directory })
    if (runIndex > 0 && path.resolve(report.recovery?.sourceDir || '') !== path.resolve(runs[runIndex - 1].directory)) fail('run-is-not-direct-same-world-resume', { run: run.directory })
    if (runIndex < runs.length - 1 && !run.finalReport) fail('nonfinal-history-input', { run: run.directory })
    if (report.connectedBots !== 30) pending.push({ code: 'thirty-workers-not-yet-confirmed', run: run.directory })
    const grants = new Set()
    const staged = new Set()
    const working = new Map()
    const fences = new Map()
    const intentions = new Map()
    const sequences = new Map()
    let flight = null
    let localPlacements = 0
    let localPeak = 0
    activeLayer = null
    layerOpen = false
    for (const [index, event] of run.events.entries()) {
      const where = { run: run.directory, line: index + 1 }
      if (!Number.isFinite(event.time) || event.time < lastTime) fail('run-time-order-or-discarded-branch', where)
      lastTime = event.time
      if (event.type === 'operator-grant-complete') {
        if (event.verified !== true || event.evidence?.pid !== expectedServer.pid || event.evidence?.startedAt !== expectedServer.startedAt) fail('different-world-process', where)
        grants.add(event.workerId)
      }
      if (event.type === 'stage-start') staged.add(event.workerId)
      if (event.type === 'resume-layer-verified') {
        if (!completeLayers.has(event.layer) || event.layerTotal !== layerCounts.get(event.layer)) fail('unproven-readonly-resume-layer', where)
      }
      if (event.phase === 'layer' && event.type === 'layer-start') {
        if (layerOpen || !expectedLayers.includes(event.layer) || completeLayers.has(event.layer) || (event.layer > -5 && !completeLayers.has(event.layer - 1)) || (event.layer === -5 && !foundationDone.has(-6))) fail('main-layer-barrier-missing', { ...where, layer: event.layer })
        activeLayer = event.layer
        layerOpen = true
      }
      if (event.type === 'task-start') {
        if (working.has(event.workerId)) fail('worker-has-multiple-inflight-tasks', where)
        working.set(event.workerId, event.taskId)
        localPeak = Math.max(localPeak, working.size)
      }
      if (['task-complete', 'task-retry', 'task-deferred', 'task-failed'].includes(event.type)) {
        if (event.type === 'task-retry' && event.reason === 'verification' && event.workerId === undefined) {
          if (working.size || !layerOpen || event.layer !== activeLayer) fail('verification-retry-before-drain', where)
        } else {
          if (working.get(event.workerId) !== event.taskId) fail('task-completion-without-ownership', where)
          working.delete(event.workerId)
        }
      }
      if (event.type === 'placement-attempt') {
        placements++
        localPlacements++
        workerNames.add(event.workerId)
        if (!layerOpen || !validPos(event.taskPos) || event.taskPos.y !== activeLayer || event.activeLayer !== activeLayer || event.taskPos.y < highestPlacement) fail('main-placement-layer-or-monotonicity', { ...where, activeLayer, position: event.taskPos })
        highestPlacement = event.taskPos?.y
        if (flight) fail('placement-during-fluid-exclusive-window', where)
        if (event.useItem) {
          fluidIntents++
          const id = `${event.workerId}:${key(event.taskPos)}`
          if (intentions.has(id)) fail('fluid-intent-replaced-without-dispatch', where)
          intentions.set(id, event)
        }
      }
      if (event.type === 'physical-mutation') {
        const id = `${event.workerId}:${key(event.target)}`
        if (event.phase === 'mutation-halted') fail('mutation-outcome-unknown', where)
        if (event.phase === 'fluid-fenced') {
          try { verifyFence(event, expectedServer.gameTime); fencesChecked++ } catch (error) { fail('invalid-fluid-fence', { ...where, message: error.message }) }
          if (flight) fail('fluid-fence-during-inflight-fluid', where)
          fences.set(id, event)
        }
        if (event.phase === 'fluid-dispatched') {
          fluidsDispatched++
          const fenced = fences.get(id)
          const intent = intentions.get(id)
          if (flight || !fenced || !intent || !layerOpen || event.target?.y !== activeLayer || intent.activeLayer !== activeLayer || intent.face !== event.face || !samePos(intent.referencePos, event.reference) || !equal(Object.fromEntries(['eye', 'yaw', 'pitch', 'reference', 'face', 'blocks', 'fence'].map(field => [field, event[field]])), Object.fromEntries(['eye', 'yaw', 'pitch', 'reference', 'face', 'blocks', 'fence'].map(field => [field, fenced?.[field]])))) fail('fluid-dispatch-without-unique-fenced-intent', where)
          flight = { id, event, where }
          fences.delete(id)
          intentions.delete(id)
        }
        if (event.phase === 'fluid-ack') {
          const wanted = sourceTasks.get(key(event.target))
          const ack = event.rawACK
          if (!flight || flight.id !== id || !wanted || !samePos(ack?.pos, event.target) || ack.stateId !== wanted.state || !Number.isSafeInteger(ack.sequence) || ack.sequence < 0 || ack.sequence <= (sequences.get(event.workerId) ?? -1)) fail('invalid-fluid-raw-ack-or-sequence', where)
          else { fluidsConfirmed++; sequences.set(event.workerId, ack.sequence) }
          flight = null
        }
      }
      if (event.phase === 'layer' && event.type === 'layer-complete') {
        if (!layerOpen || event.layer !== activeLayer || working.size || flight || event.activeWorkers !== 0 || event.layerTotal !== layerCounts.get(event.layer)) fail('main-layer-completion-before-drain-or-source-count', { ...where, layer: event.layer })
        if (intentions.size) fail('unproven-fluid-intent-at-layer-completion', { ...where, count: intentions.size })
        completeLayers.set(event.layer, { y: event.layer, blocks: event.layerTotal, run: run.directory, line: index + 1, time: event.time })
        layerOpen = false
      }
    }
    if (flight) {
      if (run.finalReport) fail('fluid-dispatch-without-confirmation', flight.where)
      else pending.push({ code: 'fluid-still-inflight', ...flight.where })
    }
    if (intentions.size) {
      if (run.finalReport) fail('fluid-intent-without-dispatch-evidence', { run: run.directory, count: intentions.size })
      else pending.push({ code: 'fluid-intent-awaiting-dispatch-evidence', run: run.directory, count: intentions.size })
    }
    if (run.truncatedJournal) pending.push({ code: 'partial-last-journal-line', run: run.directory })
    if (grants.size !== 30 || staged.size !== 30) pending.push({ code: 'thirty-online-workers-not-evidenced', run: run.directory, grants: grants.size, staged: staged.size })
    if (localPeak > 30) fail('worker-pool-exceeds-thirty', { run: run.directory, peak: localPeak })
    peak = Math.max(peak, localPeak)
    runSummaries.push({ directory: run.directory, status: report.status, error: report.error, connectedBots: report.connectedBots, grantedWorkers: grants.size, stagedWorkers: staged.size, declaredPeak: report.peakActiveWorkers || 0, observedPeak: localPeak, placementAttempts: localPlacements, resumedReadOnlyBlocks: report.resumedReadOnlyBlocks || 0, finalReport: run.finalReport })
  }
  if (!runs.length) fail('no-main-run-input')
  const last = runs.at(-1)?.report
  const completedLayers = [...completeLayers.values()].sort((a, b) => a.y - b.y)
  const verifiedBlocks = completedLayers.reduce((sum, row) => sum + (Number.isInteger(row.blocks) ? row.blocks : 0), 0)
  const completeReport = last && last.completed === 12045 && last.layers?.length === 51 && last.layers.every(row => row.blocks === layerCounts.get(row.y) && completeLayers.has(row.y))
  if (completedLayers.length !== 51 || verifiedBlocks !== 12045 || !completeReport) pending.push({ code: 'not-all-source-layers-verified', completedLayers: completedLayers.length, verifiedBlocks })
  if (peak !== 30) pending.push({ code: 'peak-thirty-not-observed', peak })
  const orderComplete = issues.length === 0 && pending.length === 0 && fluidIntents === fluidsDispatched && fluidsDispatched === fluidsConfirmed
  return {
    schema: 1,
    auditedAt: new Date().toISOString(),
    status: issues.length ? 'invalid' : orderComplete ? 'complete' : 'incomplete',
    validSoFar: issues.length === 0,
    orderComplete,
    assemblyVerified: null,
    scope: 'Recorded physical placement order only. Natural generation, current world contents, containers and entity correctness require separate assembly verification. Placement attempts are pre-send intents, not successful write counts.',
    source: { sha256: source.sha256, identity: source.identity, schematicOrigin: SCHEMATIC_ORIGIN, activeTargets: source.active.length },
    serverIdentity: expectedServer,
    foundation: { placementAttempts: foundationPlacements, completedLayers: [...foundationDone].sort((a, b) => a - b) },
    main: { placementAttempts: placements, activeTargetsVerified: verifiedBlocks, completedLayers, highestPlacement },
    workers: { requested: 30, observedPeak: peak, distinctPlacementWorkers: workerNames.size },
    fluids: { placementIntents: fluidIntents, fencesChecked, dispatched: fluidsDispatched, confirmed: fluidsConfirmed, sequenceMeaning: 'Recorded originating request sequence; runtime waits for acknowledge_player_digging >= this value. block_change itself carries no request sequence.' },
    runs: runSummaries,
    issues,
    pending
  }
}

function parseJournal (bytes) {
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  const events = []
  let truncatedJournal = false
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch (error) {
      if (index === lines.length - 1 && !text.endsWith('\n')) truncatedJournal = true
      else throw new Error(`Invalid journal JSON at line ${index + 1}: ${error.message}`)
    }
  }
  return { events, truncatedJournal }
}

async function loadAudit (options) {
  const inputs = []
  const read = async (filename, role) => {
    filename = path.resolve(filename)
    const bytes = await fs.readFile(filename)
    inputs.push({ path: filename, role, bytes: bytes.length, sha256: digest(bytes) })
    return bytes
  }
  const foundationPath = path.resolve(options.foundation)
  const foundationReport = JSON.parse(await read(foundationPath, 'foundation-report'))
  const prefix = path.resolve(foundationReport.output || '')
  if (`${prefix}-report.json` !== foundationPath) throw new Error('Foundation report output does not identify its explicit evidence files')
  const foundation = { report: foundationReport, ...parseJournal(await read(`${prefix}.jsonl`, 'foundation-events')) }
  if (foundation.truncatedJournal) throw new Error('Completed foundation journal has a partial record')
  const foundationPlan = JSON.parse(await read(`${prefix}-plan.json`, 'foundation-plan'))
  if (!equal(foundationPlan, foundationReport.foundation)) throw new Error('Foundation plan differs from its completion report')
  const runs = []
  const seen = new Set()
  for (const requested of options.runs) {
    const directory = path.resolve(requested)
    if (seen.has(directory)) throw new Error('Duplicate main run directory')
    seen.add(directory)
    const manifest = JSON.parse(await read(path.join(directory, 'run.json'), 'run-manifest'))
    let report = manifest
    let finalReport = false
    try { report = JSON.parse(await read(path.join(directory, 'report.json'), 'run-final-report')); finalReport = true } catch (error) {
      if (error.code !== 'ENOENT') throw error
      try { report = JSON.parse(await read(path.join(directory, 'status.json'), 'run-status')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!equal(report.identity, manifest.identity) || path.resolve(report.runDir || '') !== directory) throw new Error('Run report differs from its immutable input identity or directory')
    runs.push({ directory, report, finalReport, ...parseJournal(await read(path.join(directory, 'events.jsonl'), 'run-events')) })
  }
  if (!runs.length) throw new Error('At least one explicit main run is required')
  const filename = runs[0].report.identity?.target
  const bytes = await read(filename, 'source-schematic')
  if (digest(bytes) !== SOURCE_SHA256) throw new Error('Source schematic SHA256 differs from the authorized cannon')
  const plan = await readPlan(filename, VERSION, new Vec3(ORIGIN.x, ORIGIN.y, ORIGIN.z))
  if (digest(await fs.readFile(filename)) !== digest(bytes)) throw new Error('Source schematic changed while reading the plan')
  const source = { sha256: digest(bytes), identity: buildIdentity(plan, { host: '127.0.0.1', port: 25567 }), active: preparePhysicalPlan(plan).tasks, layers: plan.layers }
  const result = auditRecords({ foundation, runs, source })
  return { ...result, inputFiles: inputs }
}

async function writeAudit (filename, result) {
  await fs.writeFile(filename, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o400 })
}

async function main (args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { foundation: { type: 'string' }, run: { type: 'string', multiple: true }, output: { type: 'string' } } })
  if (!values.foundation || !values.run?.length) throw new Error('Usage: node scripts/audit-construction-order.js --foundation <report.json> --run <main-run-dir> [--run <later-same-world-resume>] [--output <new.json>]')
  const output = path.resolve(values.output || `.runtime/construction-order-audit-${Date.now()}-${crypto.randomUUID()}.json`)
  const result = await loadAudit({ foundation: values.foundation, runs: values.run })
  await writeAudit(output, result)
  console.log(JSON.stringify({ output, status: result.status, orderComplete: result.orderComplete, layers: result.main.completedLayers.length, activeTargetsVerified: result.main.activeTargetsVerified, fluidDispatched: result.fluids.dispatched, fluidConfirmed: result.fluids.confirmed, issues: result.issues.length, pending: result.pending.length }, null, 2))
  process.exitCode = result.status === 'invalid' ? 1 : result.status === 'incomplete' ? 2 : 0
  return result
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { auditRecords, blockStateCommand, loadAudit, writeAudit, main }
