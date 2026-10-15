const { Vec3 } = require('vec3')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const FULL_NAMES = new Set(['stone', 'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'cobblestone', 'obsidian', 'crying_obsidian', 'glass', 'tinted_glass', 'slime_block', 'honey_block', 'redstone_block', 'moss_block', 'bedrock', 'netherrack', 'end_stone', 'clay', 'terracotta', 'bricks', 'bookshelf', 'note_block', 'observer', 'dispenser', 'dropper', 'target', 'piston', 'sticky_piston'])
const OFFSETS = [[-1, 0], [1, 0], [0, -1], [0, 1]]
const MAX_DISTANCE = 32
const FLUIDS = new Set(['water', 'lava', 'powder_snow'])
const FLOOR_ATTACHMENTS = new Set(['redstone_wire', 'repeater', 'comparator', 'torch', 'redstone_torch', 'rail', 'powered_rail', 'activator_rail', 'detector_rail', 'snow', 'sand', 'red_sand', 'gravel', 'fire', 'soul_fire'])
const key = pos => `${pos.x},${pos.y},${pos.z}`
const adjacent = pos => OFFSETS.map(([x, z]) => pos.offset(x, 0, z))
const distance = (left, right) => Math.abs(left.x - right.x) + Math.abs(left.z - right.z)

function fullCube (block) {
  if (!block || AIR.has(block.name)) return false
  if (Array.isArray(block.shapes)) {
    return block.shapes.some(shape => shape.length === 6 && shape[0] <= 0 && shape[1] <= 0 && shape[2] <= 0 && shape[3] >= 1 && shape[4] >= 1 && shape[5] >= 1)
  }
  return block.boundingBox === 'block'
}

function fullTarget (task, getTargetBlock) {
  if (task.name === 'piston' || task.name === 'sticky_piston') return true
  const block = getTargetBlock?.(task) || task.block
  if (block) return fullCube(block)
  if (Array.isArray(task.shapes)) return fullCube(task)
  if (task.properties?.extended) return false
  return FULL_NAMES.has(task.name) || /_(concrete|wool|terracotta|planks|log|wood|stained_glass|ore)$/.test(task.name || '') || /^(iron|gold|diamond|emerald|coal|copper|netherite|lapis)_block$/.test(task.name || '')
}

function properties (block) { return block?.getProperties?.() || block?.properties || {} }

function attachmentOffset (task, block, { stateControlledAttachments = false } = {}) {
  const props = properties(block || task)
  if (stateControlledAttachments && ((task.name === 'lever' && props.face === 'ceiling') ||
    (task.name === 'lantern' && String(props.hanging) === 'true'))) return null
  if ((task.name.endsWith('_hanging_sign') && !task.name.includes('_wall_')) ||
    (task.name === 'lantern' && String(props.hanging) === 'true')) return [0, 1, 0]
  if (props.face === 'ceiling') return [0, 1, 0]
  if (props.face === 'wall' || /wall_torch$|wall_fan$/.test(task.name) || task.name === 'tripwire_hook') {
    return { north: [0, 0, 1], south: [0, 0, -1], east: [-1, 0, 0], west: [1, 0, 0] }[props.facing] || [0, -1, 0]
  }
  if (props.face === 'floor' || FLOOR_ATTACHMENTS.has(task.name) || /_door$|_carpet$|_pressure_plate$|_concrete_powder$/.test(task.name) || block?.material === 'plant') return [0, -1, 0]
  return null
}

function referenceBlock (block) {
  if (!block || AIR.has(block.name) || FLUIDS.has(block.name) || attachmentOffset(block, block)) return false
  return Array.isArray(block.shapes) ? block.shapes.some(shape => shape[3] > shape[0] && shape[4] > shape[1] && shape[5] > shape[2]) : block.boundingBox === 'block'
}

function safeReference (block, task) {
  if (!referenceBlock(block) && block?.name !== 'powder_snow' && !(['comparator', 'repeater'].includes(block?.name) && block.shapes?.length)) return false
  if (task?.name === 'water' && Object.hasOwn(properties(block), 'waterlogged')) return false
  if (block.name !== task?.name) return true
  return !block.name.endsWith('_slab') || properties(block).type === 'double'
}

class Heap {
  constructor () { this.values = [] }

  push (value) {
    const values = this.values
    values.push(value)
    let index = values.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (values[parent].score <= value.score) break
      values[index] = values[parent]
      index = parent
    }
    values[index] = value
  }

  pop () {
    const values = this.values
    const first = values[0]
    const last = values.pop()
    if (values.length) {
      let index = 0
      while (index * 2 + 1 < values.length) {
        let child = index * 2 + 1
        if (child + 1 < values.length && values[child + 1].score < values[child].score) child++
        if (last.score <= values[child].score) break
        values[index] = values[child]
        index = child
      }
      values[index] = last
    }
    return first
  }
}

function findPath (starts, anchors, passable) {
  if (!anchors.length) return null
  const goals = new Set(anchors.map(key))
  const heuristic = pos => {
    let result = Infinity
    for (const anchor of anchors) result = Math.min(result, distance(pos, anchor))
    return result
  }
  const open = new Heap()
  const costs = new Map()
  for (const pos of starts) {
    costs.set(key(pos), 0)
    open.push({ pos, cost: 0, score: heuristic(pos), parent: null })
  }
  while (open.values.length) {
    const node = open.pop()
    if (node.cost !== costs.get(key(node.pos))) continue
    if (goals.has(key(node.pos))) {
      const path = []
      for (let current = node; current; current = current.parent) path.push(current.pos)
      return path
    }
    if (node.cost >= MAX_DISTANCE) continue
    for (const pos of adjacent(node.pos)) {
      const cost = node.cost + 1
      if (cost >= (costs.get(key(pos)) ?? Infinity) || !passable(pos)) continue
      const score = cost + heuristic(pos)
      if (score > MAX_DISTANCE) continue
      costs.set(key(pos), cost)
      open.push({ pos, cost, score, parent: node })
    }
  }
  return null
}

function planLayerSupports (tasks, { getBlock, isTargetAt, layer, materialState, getTargetBlock, stateControlledAttachments = false } = {}) {
  if (!Array.isArray(tasks) || typeof getBlock !== 'function' || typeof isTargetAt !== 'function') throw new TypeError('tasks, getBlock and isTargetAt are required')
  if (!Number.isSafeInteger(layer)) throw new TypeError('layer must be an integer')
  if (!Number.isSafeInteger(materialState) || materialState < 0) throw new TypeError('materialState must be a nonnegative integer')
  if (typeof stateControlledAttachments !== 'boolean') throw new TypeError('stateControlledAttachments must be a boolean')
  const targets = new Map()
  for (const task of tasks) {
    if (!task.pos || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(task.pos[axis])) || task.pos.y !== layer) throw new Error('Every target must have integer coordinates on the current layer')
    const id = key(task.pos)
    if (targets.has(id)) throw new Error(`Duplicate target coordinates: ${id}`)
    targets.set(id, { ...task, pos: new Vec3(task.pos.x, layer, task.pos.z) })
  }
  const blockCache = new Map()
  const read = pos => {
    const id = key(pos)
    if (!blockCache.has(id)) blockCache.set(id, getBlock(pos))
    return blockCache.get(id)
  }
  const targetBlock = task => getTargetBlock?.(task) || task.block || task
  const targetAttachment = task => attachmentOffset(task, targetBlock(task), { stateControlledAttachments })
  const actualReference = (pos, task) => safeReference(read(pos), task)
  const stable = new Map([...targets].filter(([, task]) => task.type !== 'dig' && !targetAttachment(task)))
  const skeleton = new Map([...stable].filter(([, task]) => task.name === 'powder_snow' || fullTarget(task, getTargetBlock) || referenceBlock(targetBlock(task))))
  const connected = new Set()
  const scaffolds = new Map()
  const attachments = new Map()
  const virtualReference = (pos, task) => {
    const attachment = attachments.get(key(pos))
    if (attachment && (referenceBlock(read(attachment.required)) || connected.has(key(attachment.required))) && safeReference(targetBlock(attachment.task), task)) return true
    return scaffolds.has(key(pos)) || (connected.has(key(pos)) && (fullTarget(skeleton.get(key(pos)), getTargetBlock) ? task?.name !== 'water' || !Object.hasOwn(properties(targetBlock(skeleton.get(key(pos)))), 'waterlogged') : safeReference(targetBlock(skeleton.get(key(pos))), task)))
  }
  const present = (pos, task) => {
    const actual = read(pos)
    return actual?.name === task?.name || (task?.name === 'water' && task.generatedTarget?.name === 'bubble_column' && actual?.name === task.generatedTarget.name && Number.isSafeInteger(task.generatedTarget.state) && actual.stateId === task.generatedTarget.state)
  }
  const supported = (pos, task) => present(pos, task) || actualReference(pos.offset(0, -1, 0), task) || adjacent(pos).some(next => actualReference(next, task) || virtualReference(next, task))

  // Attachments need permanent support; a temporary bridge cannot survive cleanup.
  for (const task of targets.values()) {
    if (task.type === 'dig' || stable.has(key(task.pos)) || present(task.pos, task)) continue
    const required = task.pos.offset(...targetAttachment(task))
    if (referenceBlock(read(required)) || (skeleton.has(key(required)) && skeleton.get(key(required)).name !== 'powder_snow')) {
      attachments.set(key(task.pos), { task, required })
      continue
    }
    const error = new Error(`No permanent support for attachment ${task.name} at ${key(task.pos)} on layer ${layer}`)
    error.code = 'LAYER_SUPPORT_ATTACHMENT'
    error.layer = layer
    error.taskId = task.id
    throw error
  }

  const components = []
  const unseen = new Set(skeleton.keys())
  for (const id of skeleton.keys()) {
    if (!unseen.delete(id)) continue
    const component = [skeleton.get(id).pos]
    for (let index = 0; index < component.length; index++) {
      for (const pos of adjacent(component[index])) {
        if (unseen.delete(key(pos))) component.push(skeleton.get(key(pos)).pos)
      }
    }
    components.push(component)
  }
  const markSupported = () => {
    let changed = true
    while (changed) {
      changed = false
      for (const component of components) {
        if (connected.has(key(component[0])) || !component.some(pos => supported(pos, skeleton.get(key(pos))))) continue
        for (const pos of component) connected.add(key(pos))
        changed = true
      }
    }
  }
  markSupported()

  const passable = pos => {
    const block = read(pos)
    if (!block) return false
    if (actualReference(pos) || virtualReference(pos)) return true
    if (!AIR.has(block.name)) return false
    if (targets.has(key(pos))) return skeleton.has(key(pos))
    return !isTargetAt(pos)
  }
  const entries = components.map(component => ({ component, task: skeleton.get(key(component[0])), reference: true }))
  entries.push(...[...stable].filter(([id]) => !skeleton.has(id)).map(([, task]) => ({ component: [task.pos], task, reference: false })))
  for (const { component, task, reference } of entries) {
    if (connected.has(key(component[0]))) continue
    if (!reference && supported(task.pos, task)) continue
    const xs = component.map(pos => pos.x)
    const zs = component.map(pos => pos.z)
    const minX = Math.min(...xs) - MAX_DISTANCE
    const maxX = Math.max(...xs) + MAX_DISTANCE
    const minZ = Math.min(...zs) - MAX_DISTANCE
    const maxZ = Math.max(...zs) + MAX_DISTANCE
    const anchors = []
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const pos = new Vec3(x, layer, z)
        if (passable(pos) && (actualReference(pos) || virtualReference(pos) || actualReference(pos.offset(0, -1, 0)))) anchors.push(pos)
      }
    }
    const starts = reference ? component : adjacent(task.pos).filter(pos => passable(pos) && (!targets.has(key(pos)) || skeleton.has(key(pos))))
    const path = findPath(starts, anchors, passable)
    if (!path) {
      const error = new Error(`No same-layer support route within ${MAX_DISTANCE} blocks for ${key(component[0])} on layer ${layer}`)
      error.code = 'LAYER_SUPPORT_UNREACHABLE'
      error.layer = layer
      error.taskId = task.id
      error.maxDistance = MAX_DISTANCE
      throw error
    }
    for (const pos of path) {
      const id = key(pos)
      if (skeleton.has(id)) connected.add(id)
      if (targets.has(id) || actualReference(pos) || scaffolds.has(id)) continue
      scaffolds.set(id, { id: `scaffold:${id}`, type: 'place', pos, state: materialState, name: 'dirt', scaffold: true })
    }
    if (reference) for (const pos of component) connected.add(key(pos))
    markSupported()
  }
  return [...scaffolds.values()]
}

function createSupportCleanupTasks (scaffolds) {
  if (!Array.isArray(scaffolds)) throw new TypeError('scaffolds must be an array')
  return scaffolds.slice().reverse().map(task => {
    if (!task.scaffold || task.type !== 'place' || task.name !== 'dirt' || !task.pos || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(task.pos[axis]))) throw new Error('Only temporary dirt scaffold tasks can be cleaned up')
    return { id: `cleanup:${key(task.pos)}`, type: 'dig', pos: new Vec3(task.pos.x, task.pos.y, task.pos.z), name: 'dirt', scaffold: true }
  })
}

module.exports = { planLayerSupports, createSupportCleanupTasks, attachmentOffset }
