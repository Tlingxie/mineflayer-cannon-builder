const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { Vec3 } = require('vec3')
const { resolveState, preparePhysicalPlan } = require('./strictSchematic')

const key = pos => `${pos.x},${pos.y},${pos.z}`
const validPos = pos => pos && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(pos[axis]))
function canonical (value) {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function buildIdentity (plan, options) {
  const content = {
    tasks: plan.tasks.map(task => ({ pos: key(task.pos), state: task.state, blockEntity: task.blockEntity })).sort((a, b) => a.pos.localeCompare(b.pos)),
    air: (plan.air || []).map(key).sort(),
    entities: plan.entities || []
  }
  return {
    target: plan.filename ? path.resolve(plan.filename) : `fixture:${plan.name}`,
    version: plan.version,
    origin: { ...plan.origin },
    server: { host: options.host, port: options.port },
    blueprintHash: createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex')
  }
}

function parseRecovery (report, events, { plan, options, runDir }) {
  const expected = buildIdentity(plan, options)
  const legacyIdentity = !report.identity
  if (legacyIdentity) {
    if (options.host !== '127.0.0.1' || options.port !== 25566) throw new Error('Legacy recovery requires the explicit original endpoint 127.0.0.1:25566')
    if (!report.target || path.resolve(report.target) !== expected.target || report.version !== expected.version || JSON.stringify(canonical(report.origin)) !== JSON.stringify(canonical(expected.origin))) throw new Error('Legacy recovery target file, origin or version identity differs')
  } else if (JSON.stringify(canonical(report.identity)) !== JSON.stringify(canonical(expected))) {
    throw new Error('Recovery identity differs: server, target, origin, version or blueprint hash')
  }
  const constructionPlan = report.constructionPlan || report.recovery?.constructionPlan
  const dirt = resolveState('dirt', {}, plan.version)
  const allTargets = new Set(plan.tasks.map(task => key(task.pos)))
  const derivedWater = new Set(preparePhysicalPlan(plan).derived.filter(task => task.name === 'water' && task.reason === 'generated-by-source-water').map(task => key(task.pos)))
  const persistentPlanned = new Map()
  const fluidStaging = new Set((constructionPlan?.fluidStaging || []).map(task => task.id))
  for (const task of [...(constructionPlan?.tasks || []), ...(constructionPlan?.fluidStaging || [])]) {
    if (!validPos(task.pos) || task.type !== 'place' || task.name !== 'dirt' || task.state !== dirt.stateId || !task.persistent || !task.scaffold || task.pos.y < constructionPlan.startLayer || task.pos.y > Math.max(...plan.layers)) throw new Error('Invalid persistent support plan')
    if (fluidStaging.has(task.id)) {
      const target = plan.tasks.find(target => target.id === task.targetId && key(target.pos) === key(task.pos))
      if (task.purpose !== 'fluid-staging' || target?.name !== 'water' || task.releaseLayer !== task.pos.y || !Array.isArray(task.dependentIds) || !task.dependentIds.length || task.dependentIds.some(id => !plan.tasks.some(target => target.id === id && target.name === 'water' && target.pos.y === task.pos.y))) throw new Error('Invalid fluid staging support audit')
    } else if (allTargets.has(key(task.pos)) && !derivedWater.has(key(task.pos))) throw new Error('Persistent support plan overlaps an active target')
    if (persistentPlanned.has(key(task.pos))) throw new Error('Duplicate persistent support coordinates')
    persistentPlanned.set(key(task.pos), { ...task, pos: new Vec3(task.pos.x, task.pos.y, task.pos.z) })
  }
  const persistentOwned = new Map()
  const recordOwnership = (task, removed = false) => {
    const planned = task?.pos && persistentPlanned.get(key(task.pos))
    if (!planned || task.id !== planned.id) throw new Error('Persistent support audit references an unplanned coordinate')
    if (removed) persistentOwned.delete(key(task.pos))
    else persistentOwned.set(key(task.pos), planned)
  }
  for (const task of report.persistentOwned || report.recovery?.persistentOwned || []) recordOwnership(task)
  const layers = new Set([...plan.layers, ...[...persistentPlanned.values()].map(task => task.pos.y)])
  const completed = new Set([...(report.recovery?.completedLayers || []), ...(report.layers || []).map(layer => layer.y)])
  const observed = [report.currentLayer, report.highestPlacedLayer, report.recovery?.highestLayer]
  const recordedSupports = [...(report.recovery?.supports || []).map(task => ({ layer: task.pos.y, positions: [task.pos] }))]
  const entities = new Map([...(report.recovery?.entities || []), ...(report.entities || [])].map(entity => [entity.id, entity]))
  for (const event of events) {
    if (event.type === 'layer-complete' && event.phase === 'layer') completed.add(event.layer)
    if (event.type === 'resume-layer-verified') completed.add(event.layer)
    if ((event.type === 'layer-start' && event.phase === 'layer') || event.type === 'task-start') observed.push(event.layer)
    if (event.type === 'supports-planned') recordedSupports.push(event)
    if (event.type === 'entity-complete' && event.record) entities.set(event.record.id, event.record)
    if (event.type === 'persistent-support-claimed') recordOwnership(event.record)
    if (event.type === 'persistent-support-removed') recordOwnership(event.record, true)
  }
  for (const layer of [...completed, ...observed.filter(layer => layer !== undefined && layer !== null)]) {
    if (!Number.isSafeInteger(layer) || !layers.has(layer)) throw new Error('Recovery audit references an invalid blueprint layer')
  }
  const highestLayer = Math.max(...plan.layers.slice(0, 1), ...observed.filter(Number.isSafeInteger), ...completed)
  for (const layer of layers) if (layer < highestLayer && !completed.has(layer)) throw new Error(`Recovery audit is missing completed lower layer ${layer}`)
  const supports = new Map()
  for (const event of recordedSupports) {
    if (!Number.isSafeInteger(event.layer) || !layers.has(event.layer) || !Array.isArray(event.positions)) throw new Error('Invalid scaffold audit')
    for (const pos of event.positions) {
      if (!validPos(pos) || pos.y !== event.layer || allTargets.has(key(pos))) throw new Error('Scaffold audit overlaps a target or has invalid coordinates')
      if (completed.has(event.layer)) continue
      if (event.layer !== highestLayer) throw new Error('Scaffold audit is outside the unfinished active layer')
      supports.set(key(pos), { id: `scaffold:${key(pos)}`, type: 'place', pos: new Vec3(pos.x, pos.y, pos.z), state: dirt.stateId, name: 'dirt', scaffold: true })
    }
  }
  return { sourceDir: runDir, highestLayer, completedLayers: [...completed].sort((a, b) => a - b), supports: [...supports.values()], entities: [...entities.values()], legacyIdentity, constructionPlan, persistentOwned: [...persistentOwned.values()], checkpoint: report.checkpoint }
}

async function loadRecovery (runDir, plan, options) {
  const readJSON = async name => JSON.parse(await fs.readFile(path.join(runDir, name), 'utf8'))
  const manifest = await readJSON('run.json').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  const report = await readJSON('report.json').catch(error => { if (manifest) return manifest; throw error })
  const checkpoint = report.checkpoint || manifest?.checkpoint
  if (checkpoint) {
    const expectedManifest = path.resolve(runDir, '../manifest.json')
    if (checkpoint.schema !== 1 || checkpoint.worldManifestPath !== expectedManifest) throw new Error('Invalid build checkpoint world manifest reference')
    const contents = await fs.readFile(expectedManifest)
    if (createHash('sha256').update(contents).digest('hex') !== checkpoint.worldManifestSha256) throw new Error('Build checkpoint world manifest checksum differs')
  }
  const journal = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const lines = journal.trimEnd().split('\n').filter(Boolean)
  const events = lines.flatMap((line, index) => {
    try { return [JSON.parse(line)] } catch (error) {
      if (index === lines.length - 1 && !journal.endsWith('\n')) return []
      throw new Error(`Invalid recovery event journal: ${error.message}`)
    }
  })
  return parseRecovery({ ...manifest, ...report }, events, { plan, options, runDir: path.resolve(runDir) })
}

module.exports = { buildIdentity, parseRecovery, loadRecovery }
