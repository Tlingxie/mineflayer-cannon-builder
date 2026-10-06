const { Vec3 } = require('vec3')
const { planLayerSupports } = require('./layerSupports')
const { isRigidRailSupport } = require('./railSupport')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const key = pos => `${pos.x},${pos.y},${pos.z}`
const order = (left, right) => left.pos.y - right.pos.y || left.pos.z - right.pos.z || left.pos.x - right.pos.x
const integerPos = pos => pos && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(pos[axis]))
function fail (code, message) { const error = new Error(message); error.code = code; throw error }

function createFoundationCleanupTasks (tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('Foundation tasks must be an array')
  for (const task of tasks) {
    if (!task.foundation || !task.scaffold || task.purpose !== 'foundation' || task.name !== 'dirt' || task.type !== 'place' || !integerPos(task.pos) || task.id !== `foundation:${key(task.pos)}`) throw new Error('Only owned foundation dirt tasks can be cleaned up')
  }
  return tasks.slice().sort(order).reverse().map(task => ({
    id: `cleanup:foundation:${key(task.pos)}`, type: 'dig', pos: new Vec3(task.pos.x, task.pos.y, task.pos.z), name: 'dirt', scaffold: true, foundation: true, purpose: 'foundation'
  }))
}

function planFoundationSupports (plan, physicalPlan, constructionPlan, { groundY, materialState, getBlock, pillars } = {}) {
  if (!Array.isArray(plan?.tasks) || !physicalPlan?.tasks?.length || !Array.isArray(constructionPlan?.tasks)) throw new TypeError('Blueprint, physical plan and construction plan are required')
  if (!Number.isSafeInteger(groundY) || !Number.isSafeInteger(materialState) || materialState < 0 || typeof getBlock !== 'function') throw new TypeError('Integer groundY, materialState and synchronous getBlock are required')
  const Block = require('prismarine-block')(plan.version || '1.21.4')
  const material = Block.fromStateId(materialState, 0)
  if (material.name !== 'dirt') throw new Error('Foundation material must be dirt')
  const firstLayer = Math.min(...physicalPlan.tasks.map(task => task.pos.y))
  if (!Number.isSafeInteger(firstLayer) || groundY >= firstLayer) throw new Error('Foundation ground must be below the first blueprint layer')
  const firstLayerTasks = [...physicalPlan.tasks, ...constructionPlan.tasks].filter(task => task.pos.y === firstLayer)
  const firstById = new Map(firstLayerTasks.map(task => [key(task.pos), task]))
  if (firstById.size !== firstLayerTasks.length) throw new Error('Duplicate first-layer target coordinates')
  const reserved = new Set(plan.tasks.map(task => key(task.pos)))
  const roots = pillars || (constructionPlan.towers?.length ? constructionPlan.towers : [firstLayerTasks[0].pos])
  if (!Array.isArray(roots) || !roots.length) throw new TypeError('At least one foundation pillar location is required')
  const unique = new Map()
  for (const root of roots) {
    if (!Number.isSafeInteger(root.x) || !Number.isSafeInteger(root.z)) throw new Error('Foundation pillar coordinates must be integers')
    const topTarget = firstById.get(`${root.x},${firstLayer},${root.z}`)
    if (!topTarget) throw new Error('Each foundation column must end directly below a first-layer target')
    const block = Block.fromStateId(topTarget.state, 0)
    const independent = ['piston', 'sticky_piston'].includes(block.name) || block.shapes.some(shape => shape.every((value, index) => value === [0, 0, 0, 1, 1, 1][index]))
    if (!independent) throw new Error('Foundation cleanup cannot remove permanent support from a first-layer attachment')
    unique.set(`${root.x},${root.z}`, { x: root.x, z: root.z, bottom: groundY + 1, top: firstLayer - 1 })
  }
  const columns = [...unique.values()].sort((left, right) => left.z - right.z || left.x - right.x)
  const cache = new Map()
  const read = pos => {
    const id = key(pos)
    if (!cache.has(id)) {
      const block = getBlock(pos)
      if (!block?.name) fail('FOUNDATION_UNKNOWN_BLOCK', `Unknown foundation/planner block at ${id}`)
      cache.set(id, block)
    }
    return cache.get(id)
  }
  const requireAir = pos => {
    const block = read(pos)
    if (!AIR.has(block.name)) fail('FOUNDATION_OCCUPIED', `Foundation requires empty space at ${key(pos)}, found ${block.name}`)
    return { pos: new Vec3(pos.x, pos.y, pos.z), expected: 'air' }
  }
  const preflight = { ground: [], columns: [], firstLayerTargets: firstLayerTasks.map(task => requireAir(task.pos)), firstLayerSupports: [] }
  const tasks = []
  for (const column of columns) {
    const pos = new Vec3(column.x, groundY, column.z)
    const ground = read(pos)
    if (!isRigidRailSupport(ground)) fail('FOUNDATION_GROUND_SUPPORT', `Foundation needs a rigid ground surface at ${key(pos)}`)
    preflight.ground.push({ pos, expected: 'rigid-top', actualName: ground.name })
    for (let y = column.bottom; y <= column.top; y++) {
      const pos = new Vec3(column.x, y, column.z)
      const id = key(pos)
      if (reserved.has(id)) throw new Error(`Foundation conflicts with blueprint target at ${id}`)
      preflight.columns.push(requireAir(pos))
      tasks.push({ id: `foundation:${id}`, type: 'place', pos, state: materialState, name: 'dirt', scaffold: true, persistent: true, foundation: true, purpose: 'foundation' })
    }
  }
  tasks.sort(order)
  const placed = new Set(tasks.map(task => key(task.pos)))
  const supportOptions = {
    isTargetAt: pos => reserved.has(key(pos)), layer: firstLayer, materialState, getTargetBlock: task => Block.fromStateId(task.state, 0)
  }
  let zeroPillarsPossible = true
  try {
    planLayerSupports(firstLayerTasks, { ...supportOptions, getBlock: read })
  } catch (error) {
    if (error.code !== 'LAYER_SUPPORT_UNREACHABLE') throw error
    zeroPillarsPossible = false
  }
  const firstLayerSupports = planLayerSupports(firstLayerTasks, { ...supportOptions, getBlock: pos => placed.has(key(pos)) ? material : read(pos) })
  preflight.firstLayerSupports = firstLayerSupports.map(task => requireAir(task.pos))
  const actualPillars = tasks.length ? columns.length : 0
  return {
    version: 1,
    groundY,
    firstLayer,
    pillars: tasks.length ? columns : [],
    tasks,
    layers: [...new Set(tasks.map(task => task.pos.y))],
    cleanupTasks: createFoundationCleanupTasks(tasks),
    cleanupAfterHigherSupports: true,
    firstLayerSupports,
    preflight,
    minimality: { proven: actualPillars === (zeroPillarsPossible ? 0 : 1), lowerBound: zeroPillarsPossible ? 0 : 1, actualPillars }
  }
}

module.exports = { planFoundationSupports, createFoundationCleanupTasks }
