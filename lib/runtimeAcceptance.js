const { isDeepStrictEqual } = require('node:util')
const { normalizeItems, isContainerTask } = require('./physicalInventory')

const CAPACITY = { chest: 27, trapped_chest: 27, barrel: 27, hopper: 5, dispenser: 9, dropper: 9, shulker_box: 27 }
const DIRECTIONS = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
const INERT_CAPS = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'obsidian', 'crying_obsidian', 'bedrock', 'glass', 'tinted_glass', 'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'moss_block', 'granite', 'diorite', 'andesite', 'bricks'])
const key = pos => `${pos.x},${pos.y},${pos.z}`
const offset = (pos, direction) => ({ x: pos.x + direction[0], y: pos.y + direction[1], z: pos.z + direction[2] })
const capacity = task => CAPACITY[task.name] || (task.name.endsWith('_shulker_box') ? 27 : 0)

function check (signal) {
  if (!signal?.aborted) return
  const error = new Error('Runtime container verification cancelled')
  error.name = 'AbortError'
  throw error
}

function geometry (plan) {
  if (!Array.isArray(plan?.tasks) || !Array.isArray(plan.air) || typeof plan.version !== 'string') throw new TypeError('Runtime verification requires a complete versioned plan with explicit air')
  const Block = require('prismarine-block')(plan.version)
  const tasks = new Map()
  const states = new Map()
  for (const task of plan.tasks) {
    if (!['x', 'y', 'z'].every(axis => Number.isSafeInteger(task.pos?.[axis]))) throw new Error('Invalid plan coordinates')
    const id = key(task.pos)
    if (tasks.has(id)) throw new Error(`Duplicate plan coordinates: ${id}`)
    const block = Block.fromStateId(task.state, 0)
    if (block.name !== task.name) throw new Error(`Plan block identity differs at ${id}`)
    tasks.set(id, task)
    states.set(id, block)
  }
  return { tasks, states, known: new Set([...tasks.keys(), ...plan.air.map(key)]) }
}

function sourceEntityBounds (plan) {
  const definitions = require('minecraft-data')(plan.version).entitiesByName
  if (!Array.isArray(plan.entities)) return [null]
  return plan.entities.map(source => {
    const name = source.data?.id?.replace(/^minecraft:/, '')
    const definition = definitions[name]
    if (!definition || !source.regionPosition || !plan.sourceMin || !plan.origin || !Array.isArray(source.data?.Pos)) return null
    const position = ['x', 'y', 'z'].map((axis, index) => source.regionPosition[axis] + source.data.Pos[index] - plan.sourceMin[axis] + plan.origin[axis])
    if (!position.every(Number.isFinite) || !(definition.width > 0) || !(definition.height > 0)) return null
    return {
      min: [position[0] - definition.width / 2, position[1], position[2] - definition.width / 2],
      max: [position[0] + definition.width / 2, position[1] + definition.height, position[2] + definition.width / 2]
    }
  })
}

function identifyClosedHopperPairs (plan) {
  const { tasks, states, known } = geometry(plan)
  const entities = sourceEntityBounds(plan)
  const pairs = []
  const claimed = new Set()
  const sealing = task => {
    if (!task || task.blockEntity || !(INERT_CAPS.has(task.name) || /_(concrete|wool|terracotta|planks|stained_glass)$/.test(task.name))) return false
    return states.get(key(task.pos)).shapes.some(shape => shape.every((value, index) => value === (index < 3 ? 0 : 1)))
  }
  for (const [id, task] of tasks) {
    if (task.name !== 'hopper' || claimed.has(id)) continue
    const direction = DIRECTIONS[states.get(id).getProperties().facing]
    if (!direction || direction[1] !== 0) continue
    const peerId = key(offset(task.pos, direction))
    const peer = tasks.get(peerId)
    if (peer?.name !== 'hopper' || claimed.has(peerId)) continue
    const back = DIRECTIONS[states.get(peerId).getProperties().facing]
    if (!back || key(offset(peer.pos, back)) !== id) continue
    const members = [id, peerId].sort()
    const memberSet = new Set(members)
    const positions = members.map(member => tasks.get(member).pos)
    if (positions.some(pos => Object.values(DIRECTIONS).some(direction => !known.has(key(offset(pos, direction)))))) continue
    const caps = positions.flatMap(pos => [key(offset(pos, DIRECTIONS.down)), key(offset(pos, DIRECTIONS.up))])
    if (!caps.every(id => sealing(tasks.get(id)))) continue
    const externalInput = [...tasks].some(([otherId, other]) => {
      if (memberSet.has(otherId) || !['hopper', 'dropper', 'dispenser', 'crafter'].includes(other.name)) return false
      const facing = DIRECTIONS[states.get(otherId).getProperties().facing]
      return !facing || memberSet.has(key(offset(other.pos, facing)))
    })
    if (externalInput) continue
    // Unknown entities or nearby inventory carts cannot establish a sealed pair.
    if (entities.some(bounds => !bounds || positions.some(pos => {
      const min = [pos.x - 0.5, pos.y - 1, pos.z - 0.5]
      const max = [pos.x + 1.5, pos.y + 2, pos.z + 1.5]
      return min.every((value, axis) => value < bounds.max[axis] && max[axis] > bounds.min[axis])
    }))) continue
    members.forEach(member => claimed.add(member))
    pairs.push({ members, geometry: { caps: caps.sort(), knownSixNeighborBoundary: true, externalInventoryInputs: [], nearbySourceEntities: [] } })
  }
  return pairs.sort((a, b) => a.members[0].localeCompare(b.members[0]))
}

function canonical (value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function itemIdentity (item) {
  return {
    name: item.name,
    metadata: item.metadata,
    components: [...(item.components || [])].map(canonical).sort((a, b) => a.type.localeCompare(b.type)),
    removedComponents: [...(item.removedComponents || [])].sort()
  }
}

function canonicalSlots (entries, task, data) {
  if (!Array.isArray(entries)) throw new Error('Snapshot container entries must be an array')
  const used = new Set()
  const result = entries.map(({ slot, item }) => {
    if (!Number.isInteger(slot) || slot < 0 || slot >= capacity(task) || used.has(slot)) throw new Error(`Container slot exceeds capacity or is duplicated at ${key(task.pos)}`)
    used.add(slot)
    const definition = data.itemsByName[item?.name]
    if (!definition || definition.id !== item.type || !Number.isInteger(item.count) || item.count < 1 || item.count > definition.stackSize || !Number.isInteger(item.metadata)) throw new Error('Invalid normalized snapshot item')
    return { slot, ...itemIdentity(item), count: item.count }
  })
  return result.sort((a, b) => a.slot - b.slot)
}

function totals (members) {
  const aggregate = new Map()
  for (const slots of members) {
    for (const { slot, count, ...identity } of slots) {
      const key = JSON.stringify(identity)
      const current = aggregate.get(key)
      if (current) current.count += count
      else aggregate.set(key, { ...identity, count })
    }
  }
  return [...aggregate].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
}

// The caller validates final block geometry and freezes the post-tick world first.
// Initial provenance records a separate strict slot audit; it never replaces reads.
async function verifyRuntimeContainers (plan, snapshot, { strictInitialSnapshot, quiescent = false, signal } = {}) {
  check(signal)
  if (!snapshot || typeof snapshot.readContainer !== 'function') throw new TypeError('Runtime verification requires snapshot.readContainer')
  if (!strictInitialSnapshot || strictInitialSnapshot.validated !== true || ![strictInitialSnapshot.path, strictInitialSnapshot.source].some(value => typeof value === 'string' && value.length > 0)) throw new Error('Validated strict initial snapshot provenance is required')
  const pairs = identifyClosedHopperPairs(plan)
  if (pairs.length && quiescent !== true) throw new Error('Closed hopper pair verification requires a quiescent snapshot')
  const data = require('minecraft-data')(plan.version)
  const emptyNonContainers = []
  for (const task of plan.tasks) {
    if (capacity(task) || !Object.hasOwn(task.blockEntity || {}, 'Items')) continue
    const items = task.blockEntity.Items
    if (!Array.isArray(items) || items.length) throw new Error(`Unsupported runtime inventory: ${task.name}`)
    emptyNonContainers.push({ id: key(task.pos), name: task.name, reason: 'empty-non-container-items' })
  }
  const containers = plan.tasks.filter(task => capacity(task) || isContainerTask(task))
  const expected = new Map(containers.map(task => {
    if (!capacity(task)) throw new Error(`Unsupported runtime container: ${task.name}`)
    return [key(task.pos), canonicalSlots(normalizeItems(task.blockEntity?.Items, plan.version), task, data)]
  }))
  const observed = new Map()
  for (const task of containers) {
    check(signal)
    const read = await snapshot.readContainer(task, { signal })
    check(signal)
    if (read?.name !== task.name || !['x', 'y', 'z'].every(axis => read.pos?.[axis] === task.pos[axis])) throw new Error(`Snapshot container identity differs at ${key(task.pos)}`)
    observed.set(key(task.pos), { slots: canonicalSlots(read.entries, task, data), evidence: read.evidence })
  }
  const result = {
    verified: true,
    strictInitialSnapshot: Object.fromEntries(['validated', 'path', 'source', 'sha256'].filter(field => strictInitialSnapshot[field] !== undefined).map(field => [field, strictInitialSnapshot[field]])),
    requiresQuiescentSnapshot: pairs.length > 0,
    containerCount: containers.length,
    emptyNonContainers,
    containers: [],
    pairs: [],
    errors: []
  }
  const paired = new Set(pairs.flatMap(pair => pair.members))
  for (const task of containers) {
    const id = key(task.pos)
    if (paired.has(id)) continue
    const expectedSlots = expected.get(id)
    const actualSlots = observed.get(id).slots
    const verified = isDeepStrictEqual(expectedSlots, actualSlots)
    result.containers.push({ id, name: task.name, mode: 'exact-slots', verified, expectedSlots, actualSlots, evidence: [observed.get(id).evidence] })
    if (!verified) result.errors.push({ id, mode: 'exact-slots', reason: 'Container slot contents differ' })
  }
  for (const pair of pairs) {
    const expectedTotals = totals(pair.members.map(id => expected.get(id)))
    const actualTotals = totals(pair.members.map(id => observed.get(id).slots))
    const verified = isDeepStrictEqual(expectedTotals, actualTotals)
    result.pairs.push({
      ...pair,
      verified,
      runtimePhaseAllowance: 'closed-pair-item-redistribution',
      expectedTotals,
      actualTotals,
      memberContents: pair.members.map(id => ({ id, expectedSlots: expected.get(id), actualSlots: observed.get(id).slots, exactSlotsMatched: isDeepStrictEqual(expected.get(id), observed.get(id).slots) })),
      evidence: pair.members.map(id => observed.get(id).evidence)
    })
    if (!verified) result.errors.push({ members: pair.members, mode: 'closed-pair-item-redistribution', reason: 'Closed hopper pair item totals differ' })
  }
  result.verified = result.errors.length === 0
  return result
}

module.exports = { identifyClosedHopperPairs, verifyRuntimeContainers }
