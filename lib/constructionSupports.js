const { Vec3 } = require('vec3')
const { isRigidRailSupport } = require('./railSupport')

const key = pos => `${pos.x},${pos.y},${pos.z}`

function planConstructionSupports (plan, physicalPlan, { startLayer, materialState } = {}) {
  if (!Number.isSafeInteger(startLayer) || !Number.isSafeInteger(materialState) || materialState < 0) throw new TypeError('Integer startLayer and materialState are required')
  if (!Array.isArray(plan?.tasks) || !Array.isArray(physicalPlan?.tasks) || !Array.isArray(physicalPlan?.derived) || !plan.min || !plan.max) throw new TypeError('Decoded blueprint and physical plan are required')
  const active = new Map(physicalPlan.tasks.map(task => [key(task.pos), task]))
  const derived = new Map(physicalPlan.derived.map(task => [key(task.pos), task]))
  const layers = [...new Set(physicalPlan.tasks.map(task => task.pos.y))].sort((left, right) => left - right)
  if (!layers.length) return { version: 1, startLayer, topLayer: startLayer, tasks: [], towers: [], fluidReferences: [], fluidStaging: [], railReferences: [] }
  const topLayer = layers[layers.length - 1]
  if (startLayer < plan.min.y || startLayer > topLayer) throw new Error('Support start layer is outside the active blueprint')
  const tasks = new Map()
  const towers = []
  const fluidReferences = []
  const fluidStaging = new Map()
  const railReferences = []
  const add = (pos, purpose, properties = {}) => {
    const id = key(pos)
    if (pos.y < startLayer || pos.y > topLayer || active.has(id)) throw new Error(`Auxiliary support conflicts with active construction at ${id}`)
    if (tasks.has(id)) {
      const existing = tasks.get(id)
      if (existing.releaseLayer !== undefined) {
        if (properties.releaseLayer === undefined) delete existing.releaseLayer
        else existing.releaseLayer = Math.max(existing.releaseLayer, properties.releaseLayer)
      }
      return existing
    }
    const task = { id: `aux:${purpose}:${id}`, type: 'place', pos, state: materialState, name: 'dirt', scaffold: true, persistent: true, purpose, ...properties }
    tasks.set(id, task)
    return task
  }

  // A vertical gap cannot be bridged when the first isolated upper layer is reached.
  const gaps = layers.slice(1).flatMap((layer, index) => layer > layers[index] + 1 && layer >= startLayer ? [{ lower: layers[index], upper: layer }] : [])
  if (gaps.length) {
    const pos = new Vec3(plan.max.x + 2, startLayer, Math.floor((plan.min.z + plan.max.z - 1) / 2))
    if (![pos.x, pos.y, pos.z, topLayer].every(Number.isSafeInteger)) throw new Error('Invalid blueprint bounds for auxiliary tower')
    towers.push({ x: pos.x, z: pos.z, bottom: startLayer, top: topLayer, gaps })
    for (let y = startLayer; y <= topLayer; y++) add(new Vec3(pos.x, y, pos.z), 'tower')
  }

  for (const target of physicalPlan.tasks) {
    if (!['water', 'powder_snow', 'lava'].includes(target.name) || target.pos.y <= startLayer) continue
    const below = target.pos.offset(0, -1, 0)
    const belowId = key(below)
    const floor = derived.get(belowId)
    // Flowing water has no clickable surface. Reserve its cell before closing this layer.
    if (!active.has(belowId) && floor?.name === 'water' && floor.reason === 'generated-by-source-water') {
      const support = add(below, 'fluid-reference', { releaseLayer: target.pos.y, replacesDerived: floor.id })
      fluidReferences.push({ targetId: target.id, supportId: support.id, releaseLayer: target.pos.y })
    }
  }
  const planned = new Map([...plan.tasks, ...physicalPlan.tasks].map(task => [key(task.pos), task]))
  const horizontal = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]
  for (const target of physicalPlan.tasks) {
    if (target.name !== 'water' || target.pos.y < startLayer) continue
    if (fluidReferences.some(reference => reference.targetId === target.id)) continue
    const neighbors = horizontal.map(offset => active.get(key(target.pos.offset(...offset))))
    const references = [...neighbors, planned.get(key(target.pos.offset(0, -1, 0)))]
    if (!references.every(reference => reference?.name === 'water')) continue
    const root = neighbors.find(neighbor => fluidReferences.some(reference => reference.targetId === neighbor.id))
    if (!root) throw new Error(`Water target ${target.id} has only fluid references and no supported same-layer staging root`)
    let staged = fluidStaging.get(root.id)
    if (!staged) {
      staged = {
        id: `aux:fluid-staging:${root.id}`,
        type: 'place',
        pos: new Vec3(root.pos.x, root.pos.y, root.pos.z),
        state: materialState,
        name: 'dirt',
        scaffold: true,
        persistent: true,
        purpose: 'fluid-staging',
        targetId: root.id,
        dependentIds: [],
        releaseLayer: root.pos.y
      }
      fluidStaging.set(root.id, staged)
    }
    staged.dependentIds.push(target.id)
  }

  const isRail = task => task && (task.name === 'rail' || task.name.endsWith('_rail'))
  const rails = physicalPlan.tasks.filter(task => isRail(task) && task.pos.y >= startLayer)
    .sort((left, right) => left.pos.y - right.pos.y || left.pos.z - right.pos.z || left.pos.x - right.pos.x)
  if (rails.length) {
    const Block = require('prismarine-block')(plan.version || '1.21.4')
    const data = require('minecraft-data')(plan.version || '1.21.4')
    const air = new Set((plan.air || []).map(key))
    const offsets = { east: [1, 0, 0], west: [-1, 0, 0], north: [0, 0, -1], south: [0, 0, 1] }
    const rigidSupport = task => task && isRigidRailSupport(Block.fromStateId(task.state, 0))
    if (!rigidSupport({ state: materialState })) throw new Error('Rail calibration requires a RIGID auxiliary support material')
    for (const rail of rails) {
      const wanted = Block.fromStateId(rail.state, 0)
      const values = data.blocksByName[rail.name]?.states.find(property => property.name === 'shape')?.values
      const targetShape = wanted.getProperties().shape
      if (wanted.name !== rail.name || !values?.includes(targetShape)) throw new Error(`Invalid rail calibration target at ${rail.id}`)
      const neighbors = Object.entries(offsets).map(([direction, offset]) => {
        const pos = rail.pos.offset(...offset)
        const id = key(pos)
        return { direction, pos, id, target: planned.get(id), auxiliary: tasks.get(id), upper: planned.get(key(pos.offset(0, 1, 0))), source: air.has(id) ? 'litematic-air' : 'outside-litematic-regions' }
      })
      const nativeSupports = neighbors.filter(neighbor => rigidSupport(neighbor.target))
      // A solid neighbor alone cannot make vanilla select an ascent: it also needs an upper rail.
      const nativeShapes = nativeSupports.filter(neighbor => isRail(neighbor.upper)).map(neighbor => `ascending_${neighbor.direction}`)
      const targetDirection = targetShape.startsWith('ascending_') && targetShape.slice('ascending_'.length)
      if (targetDirection && !nativeSupports.some(neighbor => neighbor.direction === targetDirection)) throw new Error(`Rail calibration target at ${rail.id} lacks a permanent RIGID ${targetDirection} support`)
      const existing = neighbors.filter(neighbor => rigidSupport(neighbor.auxiliary) && !neighbor.target && !active.has(neighbor.id) && !derived.has(neighbor.id))
      const candidates = neighbors.filter(neighbor => !neighbor.target && !active.has(neighbor.id) && !derived.has(neighbor.id) && !neighbor.auxiliary &&
        neighbor.pos.x >= plan.min.x - 1 && neighbor.pos.x <= plan.max.x && neighbor.pos.z >= plan.min.z - 1 && neighbor.pos.z <= plan.max.z)
      const route = (from, supported) => {
        const safe = shape => !shape.startsWith('ascending_') || supported.has(shape.slice('ascending_'.length))
        if (!safe(from) || !safe(targetShape)) return null
        return [1, -1].map(step => {
          const shapes = []
          for (let index = values.indexOf(from); values[index] !== targetShape;) {
            index = (index + step + values.length) % values.length
            shapes.push(values[index])
          }
          return { from, reverse: step < 0, shapes }
        }).filter(path => path.shapes.every(safe)).sort((left, right) => left.shapes.length - right.shapes.length)[0] || null
      }
      const choices = []
      for (let mask = 0; mask < 2 ** candidates.length; mask++) {
        const added = candidates.filter((candidate, index) => (mask & (1 << index)) !== 0)
        const supported = new Set([...nativeSupports, ...existing, ...added].map(neighbor => neighbor.direction))
        const paths = nativeShapes.map(shape => route(shape, supported))
        if (paths.every(Boolean)) choices.push({ added, paths, unknown: added.filter(neighbor => neighbor.source === 'outside-litematic-regions').length })
      }
      choices.sort((left, right) => left.added.length - right.added.length || left.unknown - right.unknown)
      const choice = choices[0]
      if (!choice) throw new Error(`No safe rail calibration cycle at ${rail.id}; neighboring targets cannot be replaced`)
      const used = new Set(choice.paths.flatMap(path => [path.from, ...path.shapes]).filter(shape => shape.startsWith('ascending_')).map(shape => shape.slice('ascending_'.length)))
      const releaseLayer = Math.min(rail.pos.y + 1, topLayer)
      const supports = [...choice.added, ...existing.filter(neighbor => used.has(neighbor.direction))].map(neighbor => {
        const support = add(neighbor.pos, 'rail-calibration', { releaseLayer, requiresEmpty: true, source: neighbor.source })
        return { supportId: support.id, pos: support.pos, direction: neighbor.direction, source: support.source || 'existing-auxiliary', requiresEmpty: true }
      })
      railReferences.push({ targetId: rail.id, targetShape, nativeShapes, shapeValues: values, nativeSupports: nativeSupports.map(neighbor => ({ direction: neighbor.direction, targetId: neighbor.target.id })), supportIds: supports.map(support => support.supportId), supports, releaseLayer, paths: choice.paths })
    }
  }
  return {
    version: 1,
    startLayer,
    topLayer,
    tasks: [...tasks.values()].sort((left, right) => left.pos.y - right.pos.y || left.pos.z - right.pos.z || left.pos.x - right.pos.x),
    towers,
    fluidReferences,
    fluidStaging: [...fluidStaging.values()],
    railReferences
  }
}

module.exports = { planConstructionSupports }
