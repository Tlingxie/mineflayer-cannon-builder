#!/usr/bin/env node
const { readPlan, inspectPlan, preparePhysicalPlan } = require('../lib/strictSchematic')
const { selectedPhysicalTasks } = require('../examples/strictBuilder')
const { normalizeMinecartEntities, findPortalFrames } = require('../lib/physicalMechanisms')
const { normalizeItems, isContainerTask } = require('../lib/physicalInventory')

async function inspect (filename, version) {
  const plan = await readPlan(filename, version, { x: 0, y: 0, z: 0 })
  const physical = preparePhysicalPlan(plan)
  const summary = inspectPlan(plan)
  selectedPhysicalTasks(plan, physical, Infinity, summary.issues)
  if (!physical.tasks.length) throw new Error('Blueprint has no directly placeable blocks')
  const entities = normalizeMinecartEntities(plan, { frozen: true })
  findPortalFrames(plan)
  for (const task of plan.tasks) {
    if (task.blockEntity?.components && Object.keys(task.blockEntity.components).length) throw new Error('Unsupported block entity components')
    if (isContainerTask(task)) normalizeItems(task.blockEntity.Items, version)
  }
  const requiresFrozen = entities.some(entity => entity.stagedStrategy) || physical.tasks.some(task => ['water', 'lava'].includes(task.name))
  const warnings = []
  const requiresAlignment = /Mk\.?6\.1\b/i.test(plan.name || '')
  if (requiresAlignment) warnings.push('此炮型的蓝图原点 X、Y、Z 都必须能被 16 整除。')
  if (requiresFrozen) warnings.push('包含流体或封闭矿车，需要服务器已处于冻结状态；网页不会自动冻结服务器。')
  if (physical.derived.length) warnings.push(`${physical.derived.length} 个方块由门、活塞、流体或传送门自然生成；bot 主动放置仍严格按层。`)
  const top = new Map()
  for (const task of plan.tasks) {
    const key = `${task.pos.x},${task.pos.z}`
    if (!top.has(key) || top.get(key).y < task.pos.y) top.set(key, { x: task.pos.x, y: task.pos.y, z: task.pos.z })
  }
  const cells = [...top.values()]
  const stride = Math.max(1, Math.ceil(cells.length / 4000))
  return {
    name: plan.name || null,
    blocks: plan.tasks.length,
    activeBlocks: physical.tasks.length,
    derivedBlocks: physical.derived.length,
    layers: plan.layers.length,
    dimensions: Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, plan.max[axis] - plan.min[axis]])),
    sourceMin: plan.sourceMin || null,
    min: plan.min,
    max: plan.max,
    requiresAlignment,
    requiresFrozen,
    warnings,
    preview: cells.filter((cell, index) => index % stride === 0)
  }
}

if (require.main === module) inspect(process.argv[2], process.argv[3]).then(result => process.stdout.write(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1 })

module.exports = { inspect }
