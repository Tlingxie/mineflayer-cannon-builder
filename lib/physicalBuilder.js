const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { getShapeFaceCenters } = require('mineflayer-pathfinder/lib/shapes')
const { PhysicalFlightPathfinder } = require('./physicalFlight')
const { matchesTarget, matchesPhysicalTarget, dynamicProperties, itemNameForBlock, pottedPlantForBlock } = require('./strictSchematic')
const { isRigidRailSupport } = require('./railSupport')
const { PhysicalMutationCoordinator } = require('./physicalMutations')
const { RaycastIterator } = require('prismarine-world/src/iterators')
const interactable = new Set(require('./interactable.json'))
const DIRECTIONS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
const AIR = new Set(['air', 'cave_air', 'void_air'])
const WIRE_SIDES = ['north', 'south', 'east', 'west']
const STANDING_TORCHES = new Set(['torch', 'redstone_torch', 'soul_torch'])
const WALL_TORCHES = new Set(['wall_torch', 'redstone_wall_torch', 'soul_wall_torch'])
const FIRES = new Set(['fire', 'soul_fire'])
const positionKey = pos => `${pos.x},${pos.y},${pos.z}`
const NATURAL = new Set(['piston_head', 'moving_piston', 'nether_portal', 'end_portal', 'end_gateway', 'bubble_column', 'fire', 'soul_fire'])

function aborted () {
  const error = new Error('Physical build cancelled')
  error.name = 'AbortError'
  return error
}

function check (bot, signal) {
  if (signal?.aborted) throw aborted()
  if (bot._client?.ended) throw new Error('Bot disconnected')
}

function pause (ms, signal) {
  if (signal?.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => finish(aborted())
    const timer = setTimeout(() => finish(), ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

function assertSingleBlock (block) {
  const properties = block.getProperties()
  const bedFoot = block.name.endsWith('_bed') && properties.part === 'foot'
  if ((block.name.endsWith('_door') ? properties.half === 'upper' : ['upper', 'lower'].includes(properties.half)) ||
      (properties.part && !bedFoot) || block.name === 'piston_head' || block.name === 'moving_piston') {
    throw new Error(`Unsupported multi-block operation: ${block.name}`)
  }
}

class PhysicalBuilder {
  constructor (bot, buildContext, report = () => {}) {
    this.bot = bot
    this.build = buildContext
    this.report = report
    this.mutations = buildContext.mutations || new PhysicalMutationCoordinator()
    this.rawObservers = new Set()
    this.Item = require('prismarine-item')(bot.registry || bot.version)
    this.Block = require('prismarine-block')(bot.registry || bot.version)
    this.mcData = require('minecraft-data')(bot.version)
    this.useStateComponents = this.mcData.supportFeature('itemsWithComponents') && buildContext.useBlockStateComponents !== false
    this.pathing = new PhysicalFlightPathfinder(bot, () => Object.values(bot.entities || {})
      .filter(entity => entity.type === 'player' && entity.id !== bot.entity.id)
      .map(entity => entity.position))
    this.unconfirmedDigs = new Set()
    this.unconfirmedWaterlogs = new Map()
    const observe = (pos, state) => {
      const key = positionKey(pos)
      if (AIR.has(this.mcData.blocksByStateId[state]?.name)) this.unconfirmedDigs.delete(key)
      if (this.unconfirmedWaterlogs.get(key) === state) this.unconfirmedWaterlogs.delete(key)
      for (const observer of this.rawObservers) observer(pos, state)
    }
    const single = packet => observe(packet.location, packet.type)
    const multi = packet => {
      const section = packet.chunkCoordinates
      if (!section) return
      for (const record of packet.records) {
        observe({ x: section.x * 16 + ((record >> 8) & 15), y: section.y * 16 + (record & 15), z: section.z * 16 + ((record >> 4) & 15) }, Math.floor(record / 4096))
      }
    }
    bot._client.on('block_change', single)
    bot._client.on('multi_block_change', multi)
    bot.once('end', () => {
      bot._client.removeListener('block_change', single)
      bot._client.removeListener('multi_block_change', multi)
    })
    this.busy = false
  }

  satisfied (task) {
    const actual = this.bot.blockAt(task.pos)
    if (task.type === 'dig') return Boolean(actual) && AIR.has(actual.name) && !this.unconfirmedDigs.has(positionKey(task.pos))
    return matchesPhysicalTarget(this.build.getTargetBlock(task.state), actual, task) && !this.unconfirmedWaterlogs.has(positionKey(task.pos))
  }

  async mutate (exclusive, signal, operation) {
    const release = await this.mutations.acquire(exclusive, signal)
    try {
      check(this.bot, signal)
      if (this.deadline) this.deadline = Date.now() + 5000
      return await operation()
    } finally { release() }
  }

  async acknowledgedMutation (task, signal, send, { fluid = false, required = false, accept = () => true } = {}) {
    if (!fluid && !required && !this.build.mutations) return send()
    check(this.bot, signal)
    if (this.mutations.halted) throw this.mutations.halted
    let received
    let dispatched = false
    let sequence
    let acknowledgedSequence = -1
    const nextSequence = this.bot._nextSequence
    const captureSequence = () => {
      check(this.bot, signal)
      if (this.mutations.halted) throw this.mutations.halted
      sequence = nextSequence.call(this.bot)
      return sequence
    }
    const acknowledgeSequence = packet => { acknowledgedSequence = Math.max(acknowledgedSequence, packet.sequenceId) }
    const observe = (pos, stateId) => {
      if (dispatched && positionKey(pos) === positionKey(task.pos) && accept(this.Block.fromStateId(stateId, 0))) received = { pos: { x: pos.x, y: pos.y, z: pos.z }, stateId }
    }
    this.rawObservers.add(observe)
    if (nextSequence) this.bot._nextSequence = captureSequence
    this.bot._client.on('acknowledge_player_digging', acknowledgeSequence)
    try {
      check(this.bot, signal)
      dispatched = true
      await send()
      for (let count = 0; count < 40; count++) {
        if (received && (!nextSequence || (Number.isInteger(sequence) && acknowledgedSequence >= sequence))) break
        await pause(40, signal)
        check(this.bot, signal)
      }
      if (!received || (nextSequence && (!Number.isInteger(sequence) || acknowledgedSequence < sequence))) throw new Error(`${fluid ? 'Fluid placement' : 'World mutation'} was not confirmed by server`)
      if (nextSequence) received.sequence = sequence
      this.mutations.confirmed.set(positionKey(task.pos), received)
      if (fluid) this.build.recordMutationEvidence?.({ phase: 'fluid-ack', target: task.pos.clone(), rawACK: received })
      return received
    } catch (cause) {
      if (dispatched && (!received || (nextSequence && (!Number.isInteger(sequence) || acknowledgedSequence < sequence)))) {
        const error = Object.assign(new Error(`${fluid ? 'Fluid placement' : 'World mutation'} outcome unknown: ${cause.message}`, { cause }), { code: fluid ? 'FLUID_OUTCOME_UNKNOWN' : 'MUTATION_OUTCOME_UNKNOWN' })
        this.mutations.halt(error)
        try { this.build.recordMutationEvidence?.({ phase: 'mutation-halted', target: task.pos.clone(), code: error.code, reason: cause.message }) } finally { this.build.onFatalMutation?.(error) }
        throw error
      }
      throw cause
    } finally {
      this.rawObservers.delete(observe)
      this.bot._client.removeListener('acknowledge_player_digging', acknowledgeSequence)
      if (nextSequence && this.bot._nextSequence === captureSequence) this.bot._nextSequence = nextSequence
    }
  }

  async fenceFluid (task, reference, face, signal) {
    if (typeof this.build.verifyFluidRay !== 'function') throw new Error('Fluid placement requires a managed readonly ray fence')
    const eye = this.eye().clone()
    const { yaw, pitch } = this.bot.entity
    const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    const iterator = new RaycastIterator(eye, direction, 4.5)
    const states = new Map()
    let pos = eye.floored()
    let found = false
    while (pos) {
      const block = this.bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!block) throw new Error('Fluid ray traverses an unloaded block')
      // Collision shapes alone do not prove the server's OUTLINE ray (rails,
      // honey, scaffolding, hoppers). Soul sand has an explicit outline below.
      const fullCube = JSON.stringify(block.shapes) === '[[0,0,0,1,1,1]]'
      const slab = block.name.endsWith('_slab') && ['top', 'bottom', 'double'].includes(block.getProperties().type)
      if (!AIR.has(block.name) && !['water', 'lava', 'bubble_column'].includes(block.name) && !fullCube && !slab && block.name !== 'soul_sand') throw new Error(`Fluid ray crosses unproven selection shape: ${block.name} at ${positionKey(block.position)}`)
      states.set(positionKey(block.position), { pos: block.position.clone(), stateId: block.stateId })
      const hit = iterator.intersect(this.selectionShapes(block), block.position)
      if (hit) {
        if (!block.position.equals(reference) || hit.face !== face) throw new Error('Fluid ray changed before world fence')
        found = true
        break
      }
      pos = iterator.next()
    }
    if (!found) throw new Error('Fluid ray has no confirmed reference')
    const target = this.bot.blockAt(task.pos)
    if (!target) throw new Error('Fluid target is not loaded')
    states.set(positionKey(task.pos), { pos: task.pos.clone(), stateId: target.stateId })
    const blocks = [...states.values()]
    const fence = await this.build.verifyFluidRay(blocks, { signal })
    check(this.bot, signal)
    if (fence?.verified !== true || fence.checked !== blocks.length) throw new Error('Incomplete fluid ray world fence')
    if (this.eye().distanceTo(eye) > 0.000001 || this.bot.entity.yaw !== yaw || this.bot.entity.pitch !== pitch || blocks.some(row => this.bot.blockAt(row.pos)?.stateId !== row.stateId)) throw new Error('Fluid ray or cached world changed during world fence')
    const hit = this.selectionRaycast(this.eye(), direction, 4.5)
    if (!hit?.position.equals(reference) || hit.face !== face) throw new Error('Fluid ray changed after world fence')
    const evidence = { target: task.pos.clone(), reference: reference.clone(), face, eye, yaw, pitch, blocks, fence }
    this.build.recordMutationEvidence?.({ phase: 'fluid-fenced', ...evidence })
    check(this.bot, signal)
    return evidence
  }

  placementProperties (block) {
    if (!this.useStateComponents) return {}
    const properties = block.getProperties()
    const ignored = dynamicProperties(block.name)
    for (const property of ['powered', 'power', 'extended', 'locked', 'triggered', 'enabled', 'attached', 'occupied']) ignored.add(property)
    if (block.name === 'redstone_wire' && WIRE_SIDES.every(side => properties[side] === 'none')) {
      for (const side of WIRE_SIDES) ignored.delete(side)
    }
    return Object.fromEntries(Object.entries(properties).filter(([key]) => !ignored.has(key)).map(([key, value]) => [key, String(value)]))
  }

  setSneaking (state) {
    this.bot.setControlState('sneak', state)
    const actionType = this.mcData.protocol.play.toServer.types.packet_entity_action?.[1]?.find(field => field.name === 'actionId')?.type
    const mappings = Array.isArray(actionType) && actionType[0] === 'mapper' ? actionType[1].mappings : {}
    // 1.21.3-1.21.5 have player_input but still require a separate sneak action.
    if (this.mcData.supportFeature('newPlayerInputPacket') && Object.values(mappings).includes('start_sneaking')) {
      this.bot._client.write('entity_action', { entityId: this.bot.entity.id, actionId: state ? 'start_sneaking' : 'stop_sneaking', jumpBoost: 0 })
    }
  }

  async equip (name, signal, properties = {}, extraComponents = []) {
    check(this.bot, signal)
    const item = this.mcData.itemsByName[itemNameForBlock(name)]
    if (!item) throw new Error(`Unsupported inventory item: ${name}`)
    const pairs = Object.entries(properties).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value: String(value) }))
    const desiredComponents = [...extraComponents]
    if (pairs.length) desiredComponents.push({ type: 'block_state', data: { properties: pairs } })
    const componentKey = stack => JSON.stringify((stack?.components || []).map(c => [c.type, c.data]).sort(([a], [b]) => a.localeCompare(b)))
    const desiredKey = componentKey({ components: desiredComponents })
    const matches = stack => stack?.type === item.id && componentKey(stack) === desiredKey
    if (matches(this.bot.heldItem)) return
    let slot = this.bot.inventory.slots.findIndex((stack, index) => index >= 36 && index <= 44 && matches(stack))
    if (slot < 0) {
      slot = 36 + item.id % 9
      const material = new this.Item(item.id, Math.min(item.stackSize || 64, 64))
      for (const component of desiredComponents) {
        material.components.push(component)
        material.componentMap.set(component.type, component)
      }
      // Prismarine Item.equal currently ignores components; clear before changing them.
      if (this.bot.inventory.slots[slot]?.type === item.id && componentKey(this.bot.inventory.slots[slot]) !== desiredKey) {
        await this.bot.creative.setInventorySlot(slot, null)
        check(this.bot, signal)
      }
      await this.bot.creative.setInventorySlot(slot, material)
      check(this.bot, signal)
    }
    this.bot.setQuickBarSlot(slot - 36)
  }

  async equipDebugStick (name, property, signal) {
    check(this.bot, signal)
    const item = this.mcData.itemsByName.debug_stick
    if (!item || !this.mcData.supportFeature('itemsWithComponents')) throw new Error('Debug-stick components are unavailable')
    const data = { type: 'compound', value: { ['minecraft:' + name]: { type: 'string', value: property } } }
    const matches = stack => stack?.type === item.id && JSON.stringify(stack.components?.find(c => c.type === 'debug_stick_state')?.data) === JSON.stringify(data)
    if (matches(this.bot.heldItem)) return
    const slot = 36 + item.id % 9
    if (!matches(this.bot.inventory.slots[slot])) {
      const material = new this.Item(item.id, 1)
      const component = { type: 'debug_stick_state', data }
      material.components.push(component)
      material.componentMap.set(component.type, component)
      if (this.bot.inventory.slots[slot]?.type === item.id) await this.bot.creative.setInventorySlot(slot, null)
      check(this.bot, signal)
      await this.bot.creative.setInventorySlot(slot, material)
      check(this.bot, signal)
    }
    this.bot.setQuickBarSlot(slot - 36)
  }

  async move (destination, signal) {
    check(this.bot, signal)
    const bot = this.bot
    const path = this.pathing.findFlightPath(bot.entity.position, destination, 2, 8000)
    if (!path) {
      const code = this.pathing.lastSearchFailure || 'NO_ROUTE'
      const reasons = {
        TARGET_BLOCKED: 'destination intersects solid blocks',
        TARGET_UNLOADED: 'destination chunks are not loaded',
        SEARCH_BUDGET: 'flight route search exceeded its time budget',
        NO_ROUTE: 'no route found within the search bounds'
      }
      const error = new Error(`No collision-free flight route [${code}]: ${reasons[code] || reasons.NO_ROUTE}; bot=${bot.username || 'unknown'}; start=${bot.entity.position}; target=${destination}`)
      error.code = code
      throw error
    }
    const started = Date.now()
    bot.pathfinder?.setGoal(null)
    bot.creative.startFlying()
    this.report({ state: 'moving', reason: 'flying-to-placement' })
    try {
      for (const point of path) {
        while (bot.entity.position.distanceTo(point) > 0.15) {
          check(bot, signal)
          // Chunk decoding for many bots can delay the shared movement timers.
          if (Date.now() - started > 10000 || (this.deadline && Date.now() > this.deadline)) throw new Error('Flight deadline exceeded')
          const delta = point.minus(bot.entity.position)
          const distance = delta.norm()
          const next = bot.entity.position.plus(delta.scaled(Math.min(0.9, distance) / distance))
          if (!this.pathing.segmentClear(bot.entity.position, next)) throw new Error('Flight route obstructed')
          bot.entity.velocity.set(0, 0, 0)
          bot.entity.position.set(next.x, next.y, next.z)
          await pause(50, signal)
        }
      }
      check(bot, signal)
    } finally {
      bot.entity.velocity.set(0, 0, 0)
    }
  }

  eye () {
    return this.bot.entity.position.offset(0, this.bot.entity.eyeHeight || 1.62, 0)
  }

  placementClear (task, feet = this.bot.entity.position) {
    const shapes = this.build.getTargetBlock(task.state).shapes
    const positions = [feet, ...Object.values(this.bot.entities || {})
      .filter(entity => entity.type === 'player' && entity.id !== this.bot.entity.id)
      .map(entity => entity.position)]
    return positions.every(position => shapes.every(shape => {
      const x = task.pos.x
      const y = task.pos.y
      const z = task.pos.z
      return !(x + shape[0] < position.x + 0.3 && x + shape[3] > position.x - 0.3 &&
        y + shape[1] < position.y + 1.8 && y + shape[4] > position.y &&
        z + shape[2] < position.z + 0.3 && z + shape[5] > position.z - 0.3)
    }))
  }

  safeReference (block, wanted, targetPos) {
    if (wanted.name === 'water' && Object.hasOwn(block.getProperties(), 'waterlogged')) return false
    if (block.name !== wanted.name) return true
    // These items can replace the clicked block instead of the adjacent target.
    if (block.name.endsWith('_slab')) {
      const type = block.getProperties().type
      if (type === 'double') return true
      // The occupied side-half is outside SlabBlock's merge region. Restrict
      // this to same-height neighbours; vertical clicks can merge other layers.
      return Boolean(this.useStateComponents && targetPos && block.position.y === targetPos.y &&
        Math.abs(block.position.x - targetPos.x) + Math.abs(block.position.z - targetPos.z) === 1 &&
        type === wanted.getProperties().type)
    }
    return !['snow', 'sea_pickle', 'turtle_egg'].includes(block.name) && !block.name.endsWith('candle')
  }

  canReplaceWater (task, block) {
    return block?.name === 'water' && task.scaffold === true && task.persistent === true &&
      task.name === 'dirt' && this.build.getTargetBlock(task.state).name === 'dirt' &&
      (task.purpose === 'fluid-staging' || (typeof task.replacesDerived === 'string' && task.replacesDerived.length > 0))
  }

  selectionShapes (block) {
    if (block.name === 'bubble_column') return []
    // Vanilla 1.21.11 SoulSandBlock inherits getShape() = Shapes.block();
    // its separate getCollisionShape() is only 14/16 high.
    if (block.name === 'soul_sand') return [[0, 0, 0, 1, 1, 1]]
    if (block.name === 'powder_snow') return [[0, 0, 0, 1, 1, 1]]
    if (block.name.endsWith('_pressure_plate')) {
      const properties = block.getProperties()
      const active = Number(properties.power || 0) > 0 || properties.powered === true || properties.powered === 'true'
      return [[1, 0, 1, 15, active ? 0.5 : 1, 15].map(value => value / 16)]
    }
    if (block.name.endsWith('_wall_sign')) {
      const bounds = {
        north: [0, 4.5, 14, 16, 12.5, 16],
        south: [0, 4.5, 0, 16, 12.5, 2],
        west: [14, 4.5, 0, 16, 12.5, 16],
        east: [0, 4.5, 0, 2, 12.5, 16]
      }
      return [bounds[block.getProperties().facing].map(value => value / 16)]
    }
    if (block.name.endsWith('_sign') && !block.name.endsWith('_hanging_sign')) return [[4 / 16, 0, 4 / 16, 12 / 16, 1, 12 / 16]]
    if (block.name.endsWith('_wall_banner')) {
      const bounds = {
        north: [0, 0, 14, 16, 12.5, 16],
        south: [0, 0, 0, 16, 12.5, 2],
        west: [14, 0, 0, 16, 12.5, 16],
        east: [0, 0, 0, 2, 12.5, 16]
      }
      return [bounds[block.getProperties().facing].map(value => value / 16)]
    }
    if (block.name.endsWith('_banner')) return [[4 / 16, 0, 4 / 16, 12 / 16, 1, 12 / 16]]
    if (STANDING_TORCHES.has(block.name)) return [[6, 0, 6, 10, 10, 10].map(value => value / 16)]
    if (WALL_TORCHES.has(block.name)) {
      const bounds = {
        north: [5.5, 3, 11, 10.5, 13, 16],
        south: [5.5, 3, 0, 10.5, 13, 5],
        west: [11, 3, 5.5, 16, 13, 10.5],
        east: [0, 3, 5.5, 5, 13, 10.5]
      }
      return [bounds[block.getProperties().facing].map(value => value / 16)]
    }
    if (block.name === 'lever') {
      // Vanilla LeverBlock outlines are independent of its empty collision shape.
      const { face, facing } = block.getProperties()
      if (face === 'wall') {
        const bounds = {
          north: [5, 4, 10, 11, 12, 16],
          south: [5, 4, 0, 11, 12, 6],
          west: [10, 4, 5, 16, 12, 11],
          east: [0, 4, 5, 6, 12, 11]
        }
        return [bounds[facing].map(value => value / 16)]
      }
      const y = face === 'ceiling' ? 10 : 0
      const bounds = ['east', 'west'].includes(facing) ? [4, y, 5, 12, y + 6, 11] : [5, y, 4, 11, y + 6, 12]
      return [bounds.map(value => value / 16)]
    }
    return block.shapes
  }

  selectionRaycast (from, direction, range) {
    return this.bot.world.raycast(from, direction, range, (block, iterator) => {
      const hit = iterator.intersect(this.selectionShapes(block), block.position)
      if (!hit) return false
      block.face = hit.face
      block.intersect = hit.pos
      return true
    })
  }

  async reach (goal, pos, signal) {
    check(this.bot, signal)
    this.approached = true
    const deadline = Math.min(this.deadline || Infinity, Date.now() + 5000)
    const clear = feet => !goal.placementTask || this.placementClear(goal.placementTask, feet)
    if (clear(this.bot.entity.position) && goal.getFaceAndRef(this.eye()) && this.bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 1) return
    const candidates = []
    for (let y = -3; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) {
        for (let z = -3; z <= 3; z++) {
          if (x === 0 && z === 0 && y >= -1 && y <= 0) continue
          const feet = pos.offset(x + 0.5, y + 0.1, z + 0.5)
          if (clear(feet) && this.pathing.positionClear(feet) && goal.getFaceAndRef(feet.offset(0, this.bot.entity.eyeHeight || 1.62, 0))) candidates.push(feet)
        }
      }
    }
    const score = point => point.distanceTo(this.bot.entity.position) + Math.abs(point.y - (pos.y + 1.1)) * 3
    candidates.sort((a, b) => score(a) - score(b))
    for (const candidate of candidates.slice(0, 8)) {
      check(this.bot, signal)
      if (Date.now() > deadline) throw new Error('Placement approach deadline exceeded')
      try {
        await this.move(candidate, signal)
        if (clear(this.bot.entity.position) && goal.getFaceAndRef(this.eye())) return
      } catch (error) {
        check(this.bot, signal)
        this.report({ state: 'retrying', reason: error.message })
      }
    }
    throw new Error('No reachable face within 4.5 blocks; no access blocks were removed')
  }

  makeGoal (task) {
    const properties = this.build.properties[task.state] || {}
    const name = this.build.getTargetBlock(task.state).name
    const controlled = this.placementProperties(this.build.getTargetBlock(task.state))
    const controlledCeilingLever = name === 'lever' && controlled.face === 'ceiling'
    const half = controlled.half || controlled.type ? undefined : properties.half || properties.type
    const facing = { ...this.build.getFacing(task.state, properties.facing) }
    let directions = this.build.getPossibleDirections(task.state, task.pos)
    // Hopper outputs and trapdoor hinges do not require a permanent attachment.
    if (controlled.axis || controlled.hanging || (controlled.facing && (!facing.faceDirection || name === 'hopper' || name === 'end_rod' || name.endsWith('_trapdoor')))) directions = DIRECTIONS
    if (controlled.type && name.endsWith('_slab')) directions = DIRECTIONS
    if (name.endsWith('_door') || name.endsWith('_bed')) directions = [DIRECTIONS[0]]
    if ((name.endsWith('_banner') && !name.includes('_wall_')) || (name.endsWith('_sign') && !name.includes('_wall_') && !name.endsWith('_hanging_sign'))) directions = [DIRECTIONS[0]]
    if (name.endsWith('_hanging_sign') && !name.includes('_wall_')) directions = [DIRECTIONS[1]]
    if (name.endsWith('_wall_sign') || name.endsWith('_wall_banner')) directions = [{ north: DIRECTIONS[3], south: DIRECTIONS[2], east: DIRECTIONS[4], west: DIRECTIONS[5] }[properties.facing]]
    if (FIRES.has(name)) directions = [DIRECTIONS[0]]
    // StandingAndWallBlockItem prioritizes the clicked support when choosing its block type.
    if (STANDING_TORCHES.has(name) || ((name.endsWith('_skull') || name.endsWith('_head')) && !name.includes('_wall_'))) directions = [DIRECTIONS[0]]
    if ((name.endsWith('_stairs') || name.endsWith('_slab')) && ['top', 'bottom', 'double'].includes(half)) {
      directions = DIRECTIONS.filter(direction => direction.y === 0 || (half === 'top' ? direction.y === 1 : direction.y === -1))
    }
    if (properties.face === 'floor') directions = [DIRECTIONS[0]]
    if (properties.face === 'ceiling') directions = controlledCeilingLever ? DIRECTIONS : [DIRECTIONS[1]]
    if (properties.face === 'wall') {
      directions = [{ north: DIRECTIONS[3], south: DIRECTIONS[2], east: DIRECTIONS[4], west: DIRECTIONS[5] }[properties.facing]]
    }
    if (controlled.facing && !name.endsWith('_bed')) facing.facing = null
    if (!controlled.shape && (name === 'rail' || name.endsWith('_rail'))) {
      if (['east_west', 'ascending_east', 'ascending_west'].includes(properties.shape)) facing.facing = 'east'
      if (['north_south', 'ascending_north', 'ascending_south'].includes(properties.shape)) facing.facing = 'north'
    }
    // GoalPlaceBlock reverses horizontal look rays, but not vertical rays.
    if (facing.is3D && ['up', 'down'].includes(facing.facing)) facing.facing = facing.facing === 'up' ? 'down' : 'up'
    const selectionWorld = { getBlock: pos => this.bot.blockAt(pos), raycast: (from, direction, range) => this.selectionRaycast(from, direction, range) }
    const goal = new goals.GoalPlaceBlock(task.pos, selectionWorld, {
      faces: directions,
      range: 4.5,
      half,
      facing: facing.facing,
      facing3D: facing.is3D,
      LOS: true
    })
    goal.placementTask = task
    const checkFacing = goal.checkFacing.bind(goal)
    goal.checkFacing = ray => {
      if (!checkFacing(ray)) return false
      if (goal.options.facing < 0) return true
      if (goal.options.facing3D && goal.options.facing >= 4) return Math.abs(ray.y) > Math.hypot(ray.x, ray.z) * 1.15
      return Math.max(Math.abs(ray.x), Math.abs(ray.z)) > Math.min(Math.abs(ray.x), Math.abs(ray.z)) * 1.15
    }
    goal.facesPos = []
    for (const direction of directions) {
      const ref = task.pos.plus(direction)
      const block = this.bot.blockAt(ref)
      if (!block || AIR.has(block.name) || !this.safeReference(block, this.build.getTargetBlock(task.state), task.pos)) continue
      for (const center of getShapeFaceCenters(this.selectionShapes(block), direction.scaled(-1), direction.y === 0 ? half : null)) {
        if (name.endsWith('_door')) {
          const right = properties.hinge === 'right'
          if (properties.facing === 'north') center.x = right ? 0.8 : 0.2
          if (properties.facing === 'south') center.x = right ? 0.2 : 0.8
          if (properties.facing === 'east') center.z = right ? 0.8 : 0.2
          if (properties.facing === 'west') center.z = right ? 0.2 : 0.8
        }
        goal.facesPos.push([direction, center.add(ref), ref])
      }
    }
    return goal
  }

  interactionGoal (pos) {
    return {
      getFaceAndRef: head => {
        const block = this.bot.blockAt(pos)
        if (!block) return null
        if (block.name === 'redstone_wire' || block.name === 'rail' || block.name.endsWith('_rail')) {
          // Dust and rails have selectable outlines but no collision shapes.
          const height = block.name === 'redstone_wire' ? 1 / 16 : String(block.getProperties().shape).startsWith('ascending_') ? 5 / 8 : 1 / 8
          const to = pos.offset(0.5, height, 0.5)
          const ray = to.minus(head)
          const distance = ray.norm()
          if (head.y <= to.y || distance > 4.5 || distance === 0) return null
          const hit = this.selectionRaycast(head, ray.scaled(1 / distance), distance)
          if (hit && !hit.position.equals(pos)) return null
          return { ref: pos, face: new Vec3(0, -1, 0), to }
        }
        for (let index = 0; index < DIRECTIONS.length; index++) {
          const direction = DIRECTIONS[index]
          for (const center of getShapeFaceCenters(this.selectionShapes(block), direction)) {
            const to = pos.plus(center)
            const ray = to.minus(head)
            if (ray.norm() > 4.5 || ray.norm() === 0) continue
            const hit = this.selectionRaycast(head, ray.normalize(), 4.5)
            if (hit?.position.equals(pos) && hit.face === index) return { ref: pos, face: direction.scaled(-1), to }
          }
        }
        return null
      }
    }
  }

  async orient (point, signal) {
    check(this.bot, signal)
    await this.bot.lookAt(point, true)
    check(this.bot, signal)
    // Forced look updates client angles immediately; the next physics tick sends them.
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        this.bot.removeListener('physicsTick', tick)
        this.bot.removeListener('end', end)
        signal?.removeEventListener('abort', cancel)
        if (error) reject(error)
        else resolve()
      }
      const tick = () => finish()
      const end = () => finish(new Error('Bot disconnected'))
      const cancel = () => finish(aborted())
      const timer = setTimeout(() => finish(new Error('No physics update after aiming')), 2000)
      this.bot.once('physicsTick', tick)
      this.bot.once('end', end)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    check(this.bot, signal)
  }

  async clickPlace (task, signal, options = {}) {
    return this.mutate(Boolean(options.activateItem), signal, () => this.clickPlaceLocked(task, signal, options))
  }

  async clickPlaceLocked (task, signal, options = {}) {
    const wanted = this.build.getTargetBlock(task.state)
    this.assertRailSupport(task, wanted)
    const fire = FIRES.has(wanted.name)
    if (fire) this.assertFireSupport(task, wanted)
    const { itemName = wanted.name, expectedName = wanted.name, activateItem = false, stateProperties = this.placementProperties(wanted) } = options
    if (activateItem) this.setSneaking(false)
    let goal = this.makeGoal(task)
    if (!goal.facesPos.length) throw new Error('Waiting for support in the completed structure or current layer')
    await this.reach(goal, task.pos, signal)
    check(this.bot, signal)
    goal = this.makeGoal(task)
    const face = goal.getFaceAndRef(this.eye())
    if (!face || !face.ref.minus(face.face).equals(task.pos)) throw new Error('Placement face changed')
    if (fire && (!face.ref.equals(task.pos.offset(0, -1, 0)) || !face.face.equals(DIRECTIONS[0]))) throw new Error('Fire placement requires the lower support top face')
    const ref = this.bot.blockAt(face.ref)
    await this.equip(itemName, signal, itemName === wanted.name ? stateProperties : {}, require('./physicalBanners').bannerItemComponents(task))
    check(this.bot, signal)
    const scaffoldingReference = itemName === 'scaffolding' && ref.name === 'scaffolding'
    const sneak = !activateItem && (scaffoldingReference || interactable.has(ref.name) || ref.name.startsWith('potted_') || ref.name.endsWith('_trapdoor') || wanted.name === 'chest' || wanted.name === 'trapped_chest')
    try {
      if (sneak) this.setSneaking(true)
      await this.orient(face.to, signal)
      check(this.bot, signal)
      const current = this.bot.blockAt(task.pos)
      if (!current || (!AIR.has(current.name) && !this.canReplaceWater(task, current))) return this.satisfied(task)
      if (!this.placementClear(task)) throw new Error('A player occupies the placement target')
      if (this.bot.blockAt(face.ref)?.stateId !== ref.stateId) throw new Error('Placement support changed')
      if (!this.safeReference(ref, wanted, task.pos)) throw new Error('Placement would modify the support block')
      this.assertRailSupport(task, wanted)
      if (fire) this.assertFireSupport(task, wanted)
      const expectedFace = DIRECTIONS.findIndex(direction => direction.equals(face.face.scaled(-1)))
      const reportPlacement = () => this.report({ state: 'placing', reason: wanted.name, pos: task.pos.clone(), referencePos: face.ref.clone(), face: expectedFace, useItem: activateItem })
      if (activateItem) {
        if (Math.abs((this.bot.entity.eyeHeight || 1.62) - 1.62) > 0.001) throw new Error('Fluid placement requires standing eye height')
        const { yaw, pitch } = this.bot.entity
        const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
        const hit = this.selectionRaycast(this.eye(), direction, 4.5)
        if (!hit?.position.equals(face.ref) || hit.face !== expectedFace) throw new Error('Fluid aiming ray no longer matches the placement face')
        const evidence = await this.fenceFluid(task, face.ref, expectedFace, signal)
        reportPlacement()
        check(this.bot, signal)
        await this.acknowledgedMutation(task, signal, () => {
          this.build.recordMutationEvidence?.({ phase: 'fluid-dispatched', ...evidence })
          check(this.bot, signal)
          this.bot.activateItem()
        }, { fluid: true, accept: block => (block.name === expectedName && String(block.getProperties().level) === '0') || (task.generatedTarget && matchesPhysicalTarget(wanted, block, task)) })
      } else {
        reportPlacement()
        await this.acknowledgedMutation(task, signal, () => this.bot._genericPlace(ref, face.face.scaled(-1), { delta: face.to.minus(face.ref), forceLook: 'ignore', swingArm: 'right' }), fire ? { required: true, accept: block => matchesTarget(wanted, block) } : {})
      }
      check(this.bot, signal)
      for (let count = 0; count < 25; count++) {
        const actual = this.bot.blockAt(task.pos)
        if (actual && !AIR.has(actual.name)) {
          if (actual.name === expectedName || (task.generatedTarget && matchesPhysicalTarget(wanted, actual, task))) return true
          if (!this.canReplaceWater(task, actual)) return false
        }
        await pause(40, signal)
        check(this.bot, signal)
      }
      return false
    } finally {
      if (sneak) this.setSneaking(false)
    }
  }

  async dig (task, signal) {
    return this.mutate(false, signal, () => this.digLocked(task, signal))
  }

  async digLocked (task, signal) {
    check(this.bot, signal)
    let block = this.bot.blockAt(task.pos)
    if (!block) throw new Error('Chunk not loaded')
    if (AIR.has(block.name)) {
      if (this.unconfirmedDigs.has(positionKey(task.pos))) throw new Error('Dig was not confirmed by server')
      return
    }
    assertSingleBlock(block)
    const goal = this.interactionGoal(task.pos)
    await this.reach(goal, task.pos, signal)
    check(this.bot, signal)
    block = this.bot.blockAt(task.pos)
    if (!block || AIR.has(block.name)) return
    assertSingleBlock(block)
    await this.equip('diamond_pickaxe', signal)
    check(this.bot, signal)
    const outline = block.name === 'redstone_wire' || block.name === 'rail' || block.name.endsWith('_rail') ||
      (block.shapes.length === 0 && this.selectionShapes(block).length > 0)
    if (outline) {
      const face = goal.getFaceAndRef(this.eye())
      if (!face) throw new Error('Digging face changed')
      await this.orient(face.to, signal)
    }
    const cancel = () => this.bot.stopDigging()
    const timer = setTimeout(cancel, 5000)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      this.report({ state: 'digging', reason: block.name })
      const key = positionKey(task.pos)
      this.unconfirmedDigs.add(key)
      await this.acknowledgedMutation(task, signal, () => this.bot.dig(block, outline ? 'ignore' : true), { accept: block => AIR.has(block.name) })
      for (let count = 0; count < 30 && this.unconfirmedDigs.has(key); count++) {
        await pause(40, signal)
        check(this.bot, signal)
      }
      if (this.unconfirmedDigs.has(key)) throw new Error('Dig was not confirmed by server')
    } catch (error) {
      check(this.bot, signal)
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
    check(this.bot, signal)
  }

  async waterlogSlab (task, signal) {
    const wanted = this.build.getTargetBlock(task.state)
    const key = positionKey(task.pos)
    const drySlab = block => block?.name === wanted.name && block.getProperties().type === 'top' && block.getProperties().waterlogged === false
    let current = this.bot.blockAt(task.pos)
    if (!current) throw new Error('Chunk not loaded')
    if (matchesTarget(wanted, current)) {
      if (this.unconfirmedWaterlogs.has(key)) throw new Error('Waterlogging was not confirmed by server')
      return true
    }
    if (!drySlab(current)) {
      if (current.name === 'water') throw new Error('Waterlogged slab placement cannot replace existing water')
      if (!AIR.has(current.name)) await this.dig(task, signal)
      check(this.bot, signal)
      const stateProperties = this.placementProperties(wanted)
      if (this.useStateComponents) stateProperties.waterlogged = 'false'
      if (!await this.clickPlace(task, signal, { stateProperties })) return false
      current = this.bot.blockAt(task.pos)
      if (!drySlab(current)) throw new Error('Dry top slab placement was not confirmed')
    }
    return this.mutate(true, signal, () => this.waterlogSlabLocked(task, signal, wanted, drySlab, key))
  }

  async waterlogSlabLocked (task, signal, wanted, drySlab, key) {
    // A bucket invokes vanilla placeLiquid, which also schedules the water tick.
    const goal = {
      getFaceAndRef: head => {
        if (!drySlab(this.bot.blockAt(task.pos))) return null
        const to = task.pos.offset(0.5, 1, 0.5)
        const ray = to.minus(head)
        if (head.y <= to.y || ray.norm() === 0 || ray.norm() > 4.5) return null
        const hit = this.selectionRaycast(head, ray.normalize(), 4.5)
        if (!hit?.position.equals(task.pos) || hit.face !== 1) return null
        return { ref: task.pos, face: DIRECTIONS[0], to }
      }
    }
    this.setSneaking(false)
    await this.reach(goal, task.pos, signal)
    await this.equip('water_bucket', signal)
    check(this.bot, signal)
    const face = goal.getFaceAndRef(this.eye())
    if (!face) throw new Error('Waterlogging top face changed')
    await this.orient(face.to, signal)
    check(this.bot, signal)
    if (!drySlab(this.bot.blockAt(task.pos))) throw new Error('Waterlogging target changed')
    if (Math.abs((this.bot.entity.eyeHeight || 1.62) - 1.62) > 0.001) throw new Error('Waterlogging requires standing eye height')
    const { yaw, pitch } = this.bot.entity
    const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    const hit = this.selectionRaycast(this.eye(), direction, 4.5)
    if (!hit?.position.equals(task.pos) || hit.face !== 1) throw new Error('Waterlogging aiming ray no longer matches the slab top')
    const evidence = await this.fenceFluid(task, task.pos, 1, signal)
    this.report({ state: 'placing', reason: 'waterlogging', pos: task.pos.clone(), referencePos: task.pos.clone(), face: 1, useItem: true })
    check(this.bot, signal)
    this.unconfirmedWaterlogs.set(key, wanted.stateId)
    await this.acknowledgedMutation(task, signal, () => {
      this.build.recordMutationEvidence?.({ phase: 'fluid-dispatched', ...evidence })
      check(this.bot, signal)
      this.bot.activateItem()
    }, { fluid: true, accept: block => block.stateId === wanted.stateId })
    check(this.bot, signal)
    for (let count = 0; count < 30; count++) {
      if (this.satisfied(task)) return true
      await pause(40, signal)
      check(this.bot, signal)
    }
    throw new Error('Waterlogging was not confirmed by server')
  }

  async interact (task, signal, { itemName, delayMs = 100, debugProperty, reverse = false } = {}) {
    return this.mutate(false, signal, () => this.interactLocked(task, signal, { itemName, delayMs, debugProperty, reverse }))
  }

  async interactLocked (task, signal, { itemName, delayMs, debugProperty, reverse }) {
    const goal = this.interactionGoal(task.pos)
    await this.reach(goal, task.pos, signal)
    check(this.bot, signal)
    const face = goal.getFaceAndRef(this.eye())
    if (!face) throw new Error('Interaction face changed')
    const block = this.bot.blockAt(task.pos)
    if (debugProperty) await this.equipDebugStick(block.name, debugProperty, signal)
    else await this.equip(itemName || block.name, signal)
    this.setSneaking(reverse)
    try {
      await this.orient(face.to, signal)
      check(this.bot, signal)
      await this.acknowledgedMutation(task, signal, () => this.bot._genericPlace(block, face.face.scaled(-1), { delta: face.to.minus(task.pos), forceLook: 'ignore', swingArm: 'right' }))
      await pause(delayMs, signal)
      check(this.bot, signal)
    } finally {
      if (reverse) this.setSneaking(false)
    }
  }

  async adjustRail (task, wanted, signal) {
    if (matchesTarget(wanted, this.bot.blockAt(task.pos))) return true
    const current = this.bot.blockAt(task.pos)
    if (current?.name !== wanted.name) return false
    const expected = wanted.getProperties()
    const observed = current.getProperties()
    const ignored = dynamicProperties(wanted.name)
    if (Object.keys(expected).some(key => key !== 'shape' && !ignored.has(key) && String(expected[key]) !== String(observed[key]))) return false
    const values = this.mcData.blocksByName[wanted.name].states.find(state => state.name === 'shape')?.values || []
    const from = values.indexOf(observed.shape)
    const to = values.indexOf(expected.shape)
    if (from < 0 || to < 0) return false
    const directions = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }
    const safe = shape => {
      if (!shape.startsWith('ascending_')) return true
      const offset = directions[shape.slice('ascending_'.length)]
      const support = this.bot.blockAt(task.pos.offset(...offset))
      return isRigidRailSupport(support)
    }
    const paths = [1, -1].map(step => {
      const shapes = []
      for (let index = from; index !== to;) {
        index = (index + step + values.length) % values.length
        shapes.push(values[index])
      }
      return { reverse: step < 0, shapes }
    }).filter(path => path.shapes.every(safe)).sort((a, b) => a.shapes.length - b.shapes.length)
    if (!paths.length) return false
    for (const shape of paths[0].shapes) {
      check(this.bot, signal)
      if (!safe(shape)) return false
      await this.interact(task, signal, { debugProperty: 'shape', reverse: paths[0].reverse })
      const actual = this.bot.blockAt(task.pos)
      if (actual?.name !== wanted.name || actual.getProperties().shape !== shape) throw new Error('Rail shape calibration was not acknowledged')
    }
    return matchesTarget(wanted, this.bot.blockAt(task.pos))
  }

  assertRailSupport (task, wanted) {
    if (wanted.name !== 'rail' && !wanted.name.endsWith('_rail')) return
    const supports = [task.pos.offset(0, -1, 0)]
    const shape = wanted.getProperties().shape
    const directions = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }
    if (shape?.startsWith('ascending_')) supports.push(task.pos.offset(...directions[shape.slice('ascending_'.length)]))
    for (const pos of supports) {
      if (isRigidRailSupport(this.bot.blockAt(pos))) continue
      const error = new Error(`Waiting for rigid rail support at ${positionKey(pos)}`)
      error.code = 'LAYER_DEPENDENCY_PENDING'
      throw error
    }
  }

  async adjust (task, signal) {
    const wanted = this.build.getTargetBlock(task.state)
    if (wanted.name === 'rail' || wanted.name.endsWith('_rail')) return this.adjustRail(task, wanted, signal)
    if (wanted.name.endsWith('copper_bulb')) {
      if (this.satisfied(task)) return true
      if (this.bot.blockAt(task.pos)?.name !== wanted.name) return false
      await this.interact(task, signal, { debugProperty: 'lit' })
      if (!this.satisfied(task)) throw new Error('Copper bulb calibration was not acknowledged')
      return true
    }
    if (wanted.name === 'redstone_wire') {
      if (this.satisfied(task)) return true
      const current = this.bot.blockAt(task.pos)
      if (current?.name !== wanted.name) return false
      const properties = current.getProperties()
      if (!['none', 'side'].some(value => WIRE_SIDES.every(side => properties[side] === value))) return false
      await this.interact(task, signal)
      return this.satisfied(task)
    }
    const keys = { repeater: 'delay', comparator: 'mode', note_block: 'note', lever: 'powered', daylight_detector: 'inverted', composter: 'level' }
    const key = keys[wanted.name]
    const limit = wanted.name === 'note_block' ? 25 : wanted.name === 'composter' ? 10 : 4
    for (let index = 0; index < limit; index++) {
      check(this.bot, signal)
      if (this.satisfied(task)) return true
      const current = this.bot.blockAt(task.pos)
      if (!current || current.name !== wanted.name) return false
      const expected = wanted.getProperties()
      const observed = current.getProperties()
      const ignored = dynamicProperties(wanted.name)
      const adjustable = key && Object.keys(expected).every(property => property === key || ignored.has(property) || String(expected[property]) === String(observed[property]))
      if (!adjustable && (wanted.name === 'iron_door' || !this.build.canInteractToMatch(task, current))) return false
      if (wanted.name === 'composter') {
        const level = Number(observed.level)
        const target = Number(expected.level)
        if (level === 7 && target === 8) await pause(1200, signal)
        else if (level > target && level !== 8) return false
        else await this.interact(task, signal, { itemName: 'pumpkin_pie' })
      } else await this.interact(task, signal)
    }
    return this.satisfied(task)
  }

  async transform (task, signal, base, itemName) {
    let current = this.bot.blockAt(task.pos)
    if (!current) throw new Error('Chunk not loaded')
    if (current.name !== base) {
      if (!AIR.has(current.name)) await this.dig(task, signal)
      check(this.bot, signal)
      if (!await this.clickPlace(task, signal, { itemName: base, expectedName: base })) return false
      current = this.bot.blockAt(task.pos)
    }
    if (current.name !== base) return false
    await this.interact(task, signal, { itemName })
    return this.satisfied(task)
  }

  async potPlant (task, signal, plantName) {
    let current = this.bot.blockAt(task.pos)
    if (!current) throw new Error('Chunk not loaded')
    if (current.name !== 'flower_pot') {
      if (!AIR.has(current.name)) await this.dig(task, signal)
      check(this.bot, signal)
      if (!await this.clickPlace(task, signal, { itemName: 'flower_pot', expectedName: 'flower_pot' })) return false
      current = this.bot.blockAt(task.pos)
    }
    if (current?.name !== 'flower_pot') return this.satisfied(task)
    return this.mutate(false, signal, () => this.potPlantLocked(task, signal, plantName))
  }

  async potPlantLocked (task, signal, plantName) {
    const wanted = this.build.getTargetBlock(task.state)
    if (this.satisfied(task)) return true
    if (this.bot.blockAt(task.pos)?.name !== 'flower_pot') return false
    const goal = this.interactionGoal(task.pos)
    this.setSneaking(false)
    await this.reach(goal, task.pos, signal)
    await this.equip(plantName, signal)
    check(this.bot, signal)
    if (this.satisfied(task)) return true
    if (this.bot.blockAt(task.pos)?.name !== 'flower_pot') return false
    const face = goal.getFaceAndRef(this.eye())
    if (!face || !face.ref.equals(task.pos)) throw new Error('Planting interaction face changed')
    await this.orient(face.to, signal)
    check(this.bot, signal)
    if (this.satisfied(task)) return true
    if (this.bot.blockAt(task.pos)?.name !== 'flower_pot') return false
    const expectedFace = DIRECTIONS.findIndex(direction => direction.equals(face.face.scaled(-1)))
    const { yaw, pitch } = this.bot.entity
    const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    const hit = this.selectionRaycast(this.eye(), direction, 4.5)
    if (!hit?.position.equals(task.pos) || hit.face !== expectedFace) throw new Error('Planting aiming ray no longer matches the empty pot')
    this.report({ state: 'placing', reason: wanted.name, pos: task.pos.clone(), referencePos: task.pos.clone(), face: expectedFace, useItem: false })
    check(this.bot, signal)
    const pot = this.bot.blockAt(task.pos)
    if (pot?.name !== 'flower_pot') return this.satisfied(task)
    await this.acknowledgedMutation(task, signal, () => this.bot._genericPlace(pot, face.face.scaled(-1), { delta: face.to.minus(task.pos), forceLook: 'ignore', swingArm: 'right' }), { required: true, accept: block => matchesTarget(wanted, block) })
    check(this.bot, signal)
    for (let count = 0; count < 25; count++) {
      if (this.satisfied(task)) return true
      await pause(40, signal)
      check(this.bot, signal)
    }
    return false
  }

  assertFireSupport (task, wanted) {
    const support = this.bot.blockAt(task.pos.offset(0, -1, 0))
    const allowed = wanted.name === 'fire' ? ['netherrack'] : ['soul_sand', 'soul_soil']
    if (!allowed.includes(support?.name)) throw new Error(`${wanted.name} requires ${allowed.join(' or ')} directly below its target`)
  }

  async ignite (task, signal) {
    const wanted = this.build.getTargetBlock(task.state)
    this.assertFireSupport(task, wanted)
    const current = this.bot.blockAt(task.pos)
    if (!current) throw new Error('Chunk not loaded')
    if (!AIR.has(current.name)) return this.satisfied(task)
    if (!await this.clickPlace(task, signal, { itemName: 'flint_and_steel' })) return false
    return this.satisfied(task)
  }

  async park (layer, signal) {
    check(this.bot, signal)
    const feet = this.bot.entity.position
    if (feet.y >= layer + 1.2) return
    try {
      await this.move(new Vec3(feet.x, layer + 1.2, feet.z), signal)
      this.report({ state: 'parked', reason: 'above-active-layer' })
    } catch (error) {
      check(this.bot, signal)
      this.report({ state: 'parking-blocked', reason: error.message })
    }
  }

  async perform (raw, { signal, layer, attempts = 0 } = {}) {
    check(this.bot, signal)
    if (this.mutations.halted) throw this.mutations.halted
    if (!raw.pos || !['x', 'y', 'z'].every(key => Number.isInteger(raw.pos[key]))) throw new Error('Invalid task coordinates')
    if (!Number.isInteger(layer) || raw.pos.y !== layer) throw new Error('Task is outside the active layer')
    if (!['place', 'dig'].includes(raw.type)) throw new Error('Unknown physical build action')
    if (this.busy) throw new Error('Physical builder already has an active task')
    const task = { ...raw, attempts, pos: new Vec3(raw.pos.x, raw.pos.y, raw.pos.z) }
    this.busy = true
    this.deadline = Date.now() + 5000
    this.approached = false
    try {
      if (this.satisfied(task)) return true
      if (task.type === 'dig') {
        await this.dig(task, signal)
        return this.satisfied(task)
      }
      const wanted = this.build.getTargetBlock(task.state)
      if (!wanted) throw new Error(`Unknown target state: ${task.state}`)
      const properties = wanted.getProperties()
      if (FIRES.has(wanted.name)) return await this.ignite(task, signal)
      if (NATURAL.has(wanted.name) || (wanted.name.endsWith('_door') && properties.half === 'upper') ||
          (['water', 'lava'].includes(wanted.name) && Number(properties.level) > 0)) return false
      assertSingleBlock(wanted)
      if (properties.type === 'double' && !this.useStateComponents) throw new Error(`Unsupported ordinary placement: ${wanted.name}`)
      if (wanted.name === 'dirt_path') return await this.transform(task, signal, 'dirt', 'diamond_shovel')
      if (wanted.name === 'lava_cauldron') return await this.transform(task, signal, 'cauldron', 'lava_bucket')
      const plantName = pottedPlantForBlock(wanted.name)
      if (plantName) return await this.potPlant(task, signal, plantName)
      if (wanted.name.endsWith('_door')) {
        const upper = this.bot.blockAt(task.pos.offset(0, 1, 0))
        if (!upper || (!AIR.has(upper.name) && upper.name !== wanted.name)) throw new Error('Door upper space is occupied; no other layer will be cleared')
      }
      if (wanted.name.endsWith('_bed')) {
        const delta = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }[properties.facing]
        const head = this.bot.blockAt(task.pos.offset(...delta))
        if (!head || (!AIR.has(head.name) && !(head.name === wanted.name && head.getProperties().part === 'head' && head.getProperties().facing === properties.facing))) throw new Error('Bed head space is occupied')
      }
      if (wanted.name.endsWith('_slab') && properties.type === 'top' && properties.waterlogged === true) return await this.waterlogSlab(task, signal)
      if (await this.adjust(task, signal)) return true
      this.assertRailSupport(task, wanted)
      const current = this.bot.blockAt(task.pos)
      if (!current) throw new Error('Chunk not loaded')
      if (current.name === 'bubble_column') throw new Error('Existing bubble column differs from the declared natural target; refusing to replace it')
      if (current.name === 'water' && !this.canReplaceWater(task, current)) throw new Error('Only audited temporary dirt supports may replace water')
      if (!AIR.has(current.name) && !this.canReplaceWater(task, current)) await this.dig(task, signal)
      check(this.bot, signal)
      const bucket = ['water', 'lava', 'powder_snow'].includes(wanted.name)
      if (!await this.clickPlace(task, signal, bucket ? { itemName: `${wanted.name}_bucket`, activateItem: wanted.name !== 'powder_snow' } : {})) return false
      return await this.adjust(task, signal)
    } finally {
      this.deadline = 0
      try {
        if (!signal?.aborted && !this.bot._client?.ended && (this.approached || this.satisfied(task))) await this.park(layer, signal)
      } finally {
        this.busy = false
      }
    }
  }
}

module.exports = { PhysicalBuilder }
