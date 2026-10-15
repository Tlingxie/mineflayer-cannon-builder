const { Vec3 } = require('vec3')
const { RaycastIterator } = require('prismarine-world/src/iterators')
const { approachGoal } = require('./physicalApproach')
const AIR = new Set(['air', 'cave_air', 'void_air'])
const RAILS = new Set(['rail', 'powered_rail', 'activator_rail', 'detector_rail'])
const CARTS = new Set(['minecart', 'chest_minecart', 'hopper_minecart'])
const DECORATIONS = new Set(['armor_stand', 'item_frame', 'glow_item_frame', 'painting'])
const active = new Set()
const key = p => `${p.x},${p.y},${p.z}`
const vec = p => new Vec3(p.x, p.y, p.z)

function abortError () {
  const error = new Error('Physical mechanism operation cancelled')
  error.name = 'AbortError'
  return error
}

function check (bot, signal) {
  if (signal?.aborted) throw abortError()
  if (bot?._client?.ended) throw new Error('Bot disconnected during mechanism operation')
}

function pause (ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => finish(abortError())
    const timer = setTimeout(() => finish(), ms)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

function normalizeMinecartEntities (plan, { frozen = false, allowDecorations = false } = {}) {
  if (allowDecorations && plan.entities?.length) {
    try { require('./physicalDecorationsData').normalizeDecorationEntities(plan) } catch (error) {
      if (error.message.startsWith('Unsupported decoration entity:')) throw new Error(error.message.replace('Unsupported decoration entity:', 'Unsupported entity:'), { cause: error })
      throw error
    }
  }
  const Block = require('prismarine-block')(plan.version)
  const definitions = require('minecraft-data')(plan.version).entitiesByName
  const shapes = new Map()
  const rails = plan.tasks.filter(t => RAILS.has(t.name))
  return (plan.entities || []).map((source, index) => {
    const data = source.data
    const name = data?.id?.replace(/^minecraft:/, '')
    if (allowDecorations && DECORATIONS.has((data || source)?.id?.replace(/^minecraft:/, ''))) return null
    if (!CARTS.has(name)) throw new Error(`Unsupported entity: ${data?.id}`)
    if (data.Items?.length) throw new Error(`Minecart inventory needs a separate GUI operation: ${data.id}`)
    if (data.Invulnerable || data.CustomName || data.NoGravity || data.Passengers?.length) throw new Error(`Unsupported minecart entity customization: ${data.id}`)
    if (!source.regionPosition) throw new Error('Litematic entity requires regionPosition, not the negative-size region minimum')
    if (!Array.isArray(data.Pos) || data.Pos.length !== 3 || !data.Pos.every(Number.isFinite)) throw new Error('Invalid minecart Pos')
    const values = ['x', 'y', 'z'].map((k, i) => source.regionPosition[k] + data.Pos[i] - plan.sourceMin[k] + plan.origin[k])
    if (!values.every(Number.isFinite)) throw new Error('Invalid entity coordinate transform')
    const pos = new Vec3(...values)
    const candidates = rails.map(rail => {
      const properties = Block.fromStateId(rail.state, 0).getProperties()
      const spawn = vec(rail.pos).offset(0.5, properties.shape?.startsWith('ascending_') ? 0.5625 : 0.0625, 0.5)
      return { rail, spawn, distance: spawn.distanceTo(pos) }
    }).filter(c => c.distance <= 1).sort((a, b) => a.distance - b.distance)
    if (!candidates.length) throw new Error(`No nearby rail supports ${name} at ${key(pos)}`)
    const rail = candidates[0].rail
    const spawnPos = candidates[0].spawn
    if (name === 'hopper_minecart' && data.Enabled === 0 && rail.name !== 'activator_rail') throw new Error('Disabled hopper minecart needs an activator rail')
    const { width, height } = definitions[name] || {}
    if (!(width > 0) || !(height > 0)) throw new Error(`Unknown minecart collision dimensions: ${name}`)
    const bounds = [pos, spawnPos].map(point => ({
      min: [point.x - width / 2, point.y, point.z - width / 2],
      max: [point.x + width / 2, point.y + height, point.z + width / 2]
    }))
    const overlapping = plan.tasks.filter(task => {
      if (!shapes.has(task.state)) shapes.set(task.state, Block.fromStateId(task.state, 0).shapes)
      const at = [task.pos.x, task.pos.y, task.pos.z]
      return bounds.some(({ min, max }) => shapes.get(task.state).some(shape => at.every((value, axis) => value + shape[axis] < max[axis] && value + shape[axis + 3] > min[axis])))
    })
    // Frozen carts initially occupy the rail center, before physics moves them to the saved pose.
    const railLayer = rail.pos.y
    const layer = overlapping.reduce((highest, task) => Math.max(highest, task.pos.y), railLayer)
    const byPosition = new Map(plan.tasks.map(task => [key(task.pos), task]))
    const cap = byPosition.get(key(vec(rail.pos).offset(0, 1, 0)))
    const railProperties = Block.fromStateId(rail.state, 0).getProperties()
    const flatShape = ['ascending_east', 'ascending_west'].includes(railProperties.shape) ? 'east_west' : 'north_south'
    const shapeValues = require('minecraft-data')(plan.version).blocksByName[rail.name].states.find(state => state.name === 'shape').values
    const shapeDistance = Math.abs(shapeValues.indexOf(railProperties.shape) - shapeValues.indexOf(flatShape))
    const oneStep = shapeDistance === 1 || shapeDistance === shapeValues.length - 1
    const full = task => task && Block.fromStateId(task.state, 0).shapes.some(shape => shape.every((value, i) => i < 3 ? value <= 0 : value >= 1))
    if (frozen && oneStep && name === 'hopper_minecart' && rail.name === 'powered_rail' && railProperties.shape?.startsWith('ascending_') && cap?.name === 'obsidian' &&
        [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]].every(offset => full(byPosition.get(key(vec(rail.pos).offset(...offset)))))) {
      const flatPos = vec(rail.pos).offset(0.5, 0.0625, 0.5)
      const low = [flatPos.x - width / 2, flatPos.y, flatPos.z - width / 2]
      const high = [flatPos.x + width / 2, flatPos.y + height, flatPos.z + width / 2]
      const collision = plan.tasks.some(task => {
        const at = [task.pos.x, task.pos.y, task.pos.z]
        return Block.fromStateId(task.state, 0).shapes.some(shape => at.every((value, axis) => value + shape[axis] < high[axis] && value + shape[axis + 3] > low[axis]))
      })
      if (!collision && flatPos.distanceTo(pos) <= 0.8) {
        throw new Error('Unsupported frozen minecart staging (without debug-stick rail changes)')
      }
    }
    return { id: `entity:${index}:${name}`, name, pos, spawnPos, normalSpawnPos: spawnPos, rail, railPos: vec(rail.pos), railLayer, layer, supportLayer: railLayer - 1, collisionTaskIds: overlapping.map(task => task.id), expectedEnabled: data.Enabled === undefined ? undefined : Boolean(data.Enabled), source }
  }).filter(Boolean)
}

function findPortalFrames (plan) {
  const Block = require('prismarine-block')(plan.version)
  const all = new Map(plan.tasks.map(t => [key(t.pos), t]))
  const remaining = new Map(plan.tasks.filter(t => t.name === 'nether_portal').map(t => [key(t.pos), t]))
  const frames = []
  while (remaining.size) {
    const first = remaining.values().next().value
    const axis = Block.fromStateId(first.state, 0).getProperties().axis
    if (!['x', 'z'].includes(axis)) throw new Error('Unknown portal plane')
    const across = axis === 'x' ? 'z' : 'x'
    const cells = [first]
    remaining.delete(key(first.pos))
    for (let i = 0; i < cells.length; i++) {
      for (const [u, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const pos = vec(cells[i].pos)
        pos[axis] += u
        pos.y += y
        const next = remaining.get(key(pos))
        if (next && Block.fromStateId(next.state, 0).getProperties().axis === axis) {
          remaining.delete(key(pos))
          cells.push(next)
        }
      }
    }
    const lowU = Math.min(...cells.map(t => t.pos[axis]))
    const highU = Math.max(...cells.map(t => t.pos[axis]))
    const lowY = Math.min(...cells.map(t => t.pos.y))
    const highY = Math.max(...cells.map(t => t.pos.y))
    const width = highU - lowU + 1
    const height = highY - lowY + 1
    if (width < 2 || width > 21 || height < 3 || height > 21 || cells.length !== width * height) throw new Error('Portal targets must form a complete 2x3 to 21x21 rectangle')
    const at = (u, y) => {
      const p = vec(first.pos)
      p[axis] = u
      p[across] = first.pos[across]
      p.y = y
      return p
    }
    const frame = []
    const bottom = []
    for (let u = lowU; u <= highU; u++) {
      bottom.push(at(u, lowY - 1))
      frame.push(at(u, lowY - 1), at(u, highY + 1))
    }
    for (let y = lowY; y <= highY; y++) frame.push(at(lowU - 1, y), at(highU + 1, y))
    for (const pos of frame) if (all.get(key(pos))?.name !== 'obsidian') throw new Error(`Portal blueprint is missing obsidian at ${key(pos)}`)
    frames.push({ id: `portal:${axis}:${key(at(lowU, lowY))}`, axis, positions: cells.map(t => vec(t.pos)), frame, bottom, layer: highY + 1 })
  }
  return frames
}

function assertPortalFrame (bot, portal) {
  for (const pos of portal.frame) if (bot.blockAt(pos)?.name !== 'obsidian') throw new Error(`Incomplete obsidian frame at ${key(pos)}`)
  for (const pos of portal.positions) {
    const block = bot.blockAt(pos)
    if (!block || (!AIR.has(block.name) && block.name !== 'nether_portal')) throw new Error(`Portal interior obstructed at ${key(pos)}`)
  }
}

function portalComplete (bot, portal) {
  return portal.positions.every(pos => {
    const block = bot.blockAt(pos)
    return block?.name === 'nether_portal' && block.getProperties().axis === portal.axis
  })
}

function topFaceGoal (bot, pos, height) {
  const point = vec(pos).offset(0.5, height, 0.5)
  return {
    getFaceAndRef (eye) {
      const ray = point.minus(eye)
      const distance = ray.norm()
      if (distance > 4.5 || distance < 0.01 || eye.y <= point.y) return null
      const hit = bot.world.raycast(eye, ray.normalize(), distance + 0.001)
      if (hit && !hit.position.equals(pos)) return null
      return { ref: pos, face: new Vec3(0, -1, 0), to: point }
    }
  }
}

async function reachTop (bot, executor, pos, height, signal) {
  check(bot, signal)
  const goal = topFaceGoal(bot, pos, height)
  if (executor) {
    await approachGoal({ bot, executor }, goal, pos, { signal })
    await executor.reach(goal, pos, signal)
  }
  check(bot, signal)
  const face = goal.getFaceAndRef(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0))
  if (!face) throw new Error(`No unobstructed reachable top face at ${key(pos)}`)
  return face
}

function railFaceGoal (bot, pos, height) {
  const shapes = [[0, 0, 0, 1, height, 1]]
  const faces = [
    { direction: new Vec3(0, 1, 0), index: 1, point: pos.offset(0.5, height, 0.5) },
    { direction: new Vec3(0, 0, -1), index: 2, point: pos.offset(0.5, height / 2, 0) },
    { direction: new Vec3(0, 0, 1), index: 3, point: pos.offset(0.5, height / 2, 1) },
    { direction: new Vec3(-1, 0, 0), index: 4, point: pos.offset(0, height / 2, 0.5) },
    { direction: new Vec3(1, 0, 0), index: 5, point: pos.offset(1, height / 2, 0.5) }
  ]
  return {
    getFaceAndRef (eye) {
      for (const face of faces) {
        const delta = face.point.minus(eye)
        const distance = delta.norm()
        if (distance > 4.5 || distance < 0.01) continue
        const direction = delta.scaled(1 / distance)
        const targetHit = new RaycastIterator(eye, direction, distance + 0.001).intersect(shapes, pos)
        if (!targetHit || targetHit.face !== face.index) continue
        const hit = bot.world.raycast(eye, direction, distance + 0.001, (block, iterator) => {
          const outline = RAILS.has(block.name) ? [[0, 0, 0, 1, block.getProperties().shape?.startsWith('ascending_') ? 0.625 : 0.125, 1]] : block.name === 'powder_snow' ? [[0, 0, 0, 1, 1, 1]] : block.shapes
          const hit = iterator.intersect(outline, block.position)
          if (!hit) return false
          block.face = hit.face
          return true
        })
        if (hit && (!hit.position.equals(pos) || hit.face !== face.index)) continue
        return { ref: pos, face: face.direction.scaled(-1), to: face.point }
      }
      return null
    }
  }
}

async function withItem (bot, name, signal, action) {
  const data = require('minecraft-data')(bot.version).itemsByName[name]
  if (!data) throw new Error(`Unavailable mechanism item: ${name}`)
  const Item = require('prismarine-item')(bot.registry || bot.version)
  const saved = bot.inventory.slots[44]
  const selected = bot.quickBarSlot
  try {
    check(bot, signal)
    if (saved) await bot.creative.setInventorySlot(44, null)
    await bot.creative.setInventorySlot(44, new Item(data.id, 1))
    check(bot, signal)
    bot.setQuickBarSlot(8)
    return await action()
  } finally {
    if (!bot._client?.ended) {
      await bot.creative.setInventorySlot(44, null)
      if (saved) await bot.creative.setInventorySlot(44, saved)
      bot.setQuickBarSlot(selected)
    }
  }
}

function matchingMinecarts (bot, expected) {
  return Object.values(bot.entities || {}).filter(e => e.id !== undefined && e.name === expected.name && e.position.distanceTo(expected.pos) <= 0.8)
}

function claimMinecart (observed, claimedIds, reused, entity) {
  if (claimedIds?.has(observed.id) || claimedIds?.has(String(observed.id))) throw new Error(`Minecart entity ${observed.id} is already claimed by another target`)
  claimedIds?.add(observed.id)
  return { verified: true, reused, entityId: observed.id, position: observed.position.clone(), expected: entity.pos.clone(), tolerance: 0.8 }
}

async function placeMinecart (bot, entity, options = {}) {
  check(bot, options.signal)
  if (entity.stagedStrategy) throw new Error('Unsupported frozen minecart staging (without debug-stick rail changes)')
  if (active.has(entity.id)) throw new Error(`Minecart placement already running: ${entity.id}`)
  active.add(entity.id)
  try {
    return await placeMinecartNormal(bot, entity, options)
  } finally {
    active.delete(entity.id)
  }
}

async function placeMinecartNormal (bot, entity, { signal, executor, claimedIds, beforeUse } = {}) {
  check(bot, signal)
  const rail = bot.blockAt(entity.railPos)
  if (!rail || !RAILS.has(rail.name) || rail.name !== entity.rail.name) throw new Error(`Expected supporting rail at ${key(entity.railPos)}`)
  const height = rail.getProperties().shape?.startsWith('ascending_') ? 0.625 : 0.125
  const goal = railFaceGoal(bot, entity.railPos, height)
  if (executor) {
    await approachGoal({ bot, executor }, goal, entity.railPos, { signal })
    await executor.reach(goal, entity.railPos, signal)
  }
  check(bot, signal)
  if (!goal.getFaceAndRef(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0))) throw new Error(`No unobstructed reachable rail face at ${key(entity.railPos)}`)
  const tracked = matchingMinecarts(bot, entity)
  if (tracked.length > 1) throw new Error(`Multiple minecarts already occupy ${key(entity.pos)}`)
  if (tracked.length === 1) return claimMinecart(tracked[0], claimedIds, true, entity)
  const before = new Set(Object.keys(bot.entities || {}))
  return await withItem(bot, entity.name, signal, async () => {
    check(bot, signal)
    const current = bot.blockAt(entity.railPos)
    if (!current || current.name !== rail.name) throw new Error('Supporting rail changed before minecart placement')
    bot.setControlState('sneak', false)
    const face = goal.getFaceAndRef(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0))
    if (!face) throw new Error('Rail interaction face changed before minecart placement')
    if (beforeUse) await beforeUse()
    check(bot, signal)
    await bot.activateBlock(current, face.face.scaled(-1), face.to.minus(entity.railPos))
    for (let attempt = 0; attempt < 50; attempt++) {
      check(bot, signal)
      const found = matchingMinecarts(bot, entity).find(e => !before.has(String(e.id)))
      if (found) return claimMinecart(found, claimedIds, false, entity)
      await pause(50, signal)
    }
    throw new Error(`Minecart verification failed near ${key(entity.pos)}; no matching new entity observed`)
  })
}

async function trackMinecart (worker, expected, signal) {
  const bot = worker.bot
  check(bot, signal)
  const goal = {
    getFaceAndRef: eye => eye.distanceTo(expected.pos) <= 16 ? { ref: expected.railPos, face: new Vec3(0, -1, 0), to: expected.pos } : null
  }
  if (worker.executor) {
    await approachGoal(worker, goal, expected.railPos, { signal })
    await worker.executor.reach(goal, expected.railPos, signal)
  }
  check(bot, signal)
  if (!goal.getFaceAndRef(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0))) throw new Error(`Unable to enter minecart tracking range at ${key(expected.pos)}`)
  // Player tracking still updates while simulation ticks are frozen.
  await pause(150, signal)
  for (let attempt = 0; attempt < 20; attempt++) {
    check(bot, signal)
    const matches = matchingMinecarts(bot, expected)
    if (matches.length) {
      return matches.map(observed => ({
        id: expected.id,
        entityId: observed.id,
        position: observed.position.clone(),
        expected: expected.pos.clone(),
        distance: observed.position.distanceTo(expected.pos),
        workerId: worker.id || bot.username
      }))
    }
    await pause(50, signal)
  }
  throw new Error(`Missing minecart ${expected.id} near ${key(expected.pos)}`)
}

async function verifyMinecarts (workers, entities, { signal } = {}) {
  check(null, signal)
  const candidates = []
  const visited = new Set()
  for (const expected of entities) {
    check(null, signal)
    const ordered = workers.filter(worker => worker.bot && !worker.bot._client?.ended).slice()
      .sort((a, b) => Number(visited.has(a)) - Number(visited.has(b)) || a.bot.entity.position.distanceTo(expected.pos) - b.bot.entity.position.distanceTo(expected.pos))
    let matches
    const errors = []
    for (const worker of ordered) {
      try {
        matches = await trackMinecart(worker, expected, signal)
        visited.add(worker)
        break
      } catch (error) {
        if (signal?.aborted) throw abortError()
        errors.push(error.message)
      }
    }
    if (!matches) throw new Error(`Minecart final verification failed: ${[...new Set(errors)].join('; ') || 'no connected workers'}`)
    candidates.push(matches.sort((a, b) => a.distance - b.distance))
  }
  // Augmenting paths avoid assigning one observed entity twice when tolerances overlap.
  const owner = new Map()
  const matches = Array(entities.length)
  function assign (index, seen) {
    for (const match of candidates[index]) {
      const identity = String(match.entityId)
      if (seen.has(identity)) continue
      seen.add(identity)
      const previous = owner.get(identity)
      if (previous === undefined || assign(previous, seen)) {
        owner.set(identity, index)
        matches[index] = match
        return true
      }
    }
    return false
  }
  for (let i = 0; i < entities.length; i++) {
    if (!assign(i, new Set())) throw new Error(`No unique minecart entity matches every target; conflict at ${entities[i].id}`)
  }
  return { verified: true, entities: matches.length, matches }
}

async function ignitePortals (workers, plan, { signal } = {}) {
  check(null, signal)
  const portals = findPortalFrames(plan)
  const results = []
  for (const portal of portals) {
    check(null, signal)
    const ordered = workers.filter(w => w.bot && !w.bot._client?.ended).slice()
      .sort((a, b) => a.bot.entity.position.distanceTo(portal.bottom[0]) - b.bot.entity.position.distanceTo(portal.bottom[0]))
    let completed = false
    const errors = []
    for (const worker of ordered) {
      const bot = worker.bot
      if (portalComplete(bot, portal)) {
        results.push({ id: portal.id, verified: true, reused: true, blocks: portal.positions.length })
        completed = true
        break
      }
      for (const bottom of portal.bottom) {
        try {
          await reachTop(bot, worker.executor, bottom, 1, signal)
          assertPortalFrame(bot, portal)
          const interior = bottom.offset(0, 1, 0)
          if (!AIR.has(bot.blockAt(interior)?.name)) continue
          await withItem(bot, 'flint_and_steel', signal, async () => {
            check(bot, signal)
            assertPortalFrame(bot, portal)
            bot.setControlState('sneak', false)
            await bot.activateBlock(bot.blockAt(bottom), new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5))
          })
          for (let attempt = 0; attempt < 40 && !portalComplete(bot, portal); attempt++) await pause(50, signal)
          if (!portalComplete(bot, portal)) throw new Error('Portal ignition did not generate the complete target plane')
          results.push({ id: portal.id, verified: true, reused: false, blocks: portal.positions.length, workerId: worker.id || bot.username })
          completed = true
          break
        } catch (error) {
          if (signal?.aborted) throw abortError()
          errors.push(error.message)
        }
      }
      if (completed) break
    }
    if (!completed) throw new Error(`Unable to ignite ${portal.id}: ${[...new Set(errors)].join('; ') || 'no connected workers'}`)
  }
  for (const portal of portals) {
    if (!workers.some(worker => !worker.bot?._client?.ended && worker.bot && portalComplete(worker.bot, portal))) throw new Error(`Portal did not remain complete: ${portal.id}`)
  }
  return { verified: true, portals: results.length, blocks: results.reduce((sum, p) => sum + p.blocks, 0), results }
}

module.exports = { normalizeMinecartEntities, placeMinecart, verifyMinecarts, findPortalFrames, assertPortalFrame, ignitePortals }
