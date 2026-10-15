const { Vec3 } = require('vec3')
const { RaycastIterator } = require('prismarine-world/src/iterators')
const { approachGoal } = require('./physicalApproach')
const { decorationEntityData, decorationDifferences } = require('./physicalDecorationsData')

const SUPPORTED = new Set(['armor_stand', 'painting', 'item_frame', 'glow_item_frame'])
const FACES = [
  new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1),
  new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)
]
const vector = value => Array.isArray(value) ? new Vec3(...value) : new Vec3(value.x, value.y, value.z)
const key = pos => `${pos.x},${pos.y},${pos.z}`
const overlaps = (a, b) => a.min.every((low, i) => low < b.max[i] - 1e-7 && a.max[i] > b.min[i] + 1e-7)
const bounds = (pos, width, height) => ({ min: [pos.x - width / 2, pos.y, pos.z - width / 2], max: [pos.x + width / 2, pos.y + height, pos.z + width / 2] })
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle))

function check (bot, signal) {
  if (signal?.aborted) {
    const error = new Error('Physical decoration operation cancelled')
    error.name = 'AbortError'
    throw error
  }
  if (bot?._client?.ended) throw new Error('Bot disconnected during decoration operation')
}

function pause (ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => {
      try { check(null, signal) } catch (error) { finish(error) }
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

function standYaw (entity) {
  const value = Array.isArray(entity.rotation) ? entity.rotation[0] : entity.rotation?.yaw ?? entity.source?.Rotation?.[0] ?? 0
  if (!Number.isFinite(value) || Math.abs(value / 45 - Math.round(value / 45)) > 1e-5) throw new Error('Armor stand placement requires a yaw divisible by 45 degrees')
  // Vanilla faces the stand opposite the player and quantizes its yaw to 45 degrees.
  return wrap(-value * Math.PI / 180)
}

function yawTopPoint (eye, pos, yaw) {
  const direction = [-Math.sin(yaw), -Math.cos(yaw)]
  let low = 0.01
  let high = Infinity
  for (const [i, axis] of ['x', 'z'].entries()) {
    if (Math.abs(direction[i]) < 1e-10) {
      if (eye[axis] < pos[axis] + 0.08 || eye[axis] > pos[axis] + 0.92) return null
      continue
    }
    const a = (pos[axis] + 0.08 - eye[axis]) / direction[i]
    const b = (pos[axis] + 0.92 - eye[axis]) / direction[i]
    low = Math.max(low, Math.min(a, b))
    high = Math.min(high, Math.max(a, b))
  }
  if (high < low || !Number.isFinite(high)) return null
  const middle = (pos.x + 0.5 - eye.x) * direction[0] + (pos.z + 0.5 - eye.z) * direction[1]
  const distance = Math.max(low, Math.min(high, middle))
  return new Vec3(eye.x + direction[0] * distance, pos.y + 1, eye.z + direction[1] * distance)
}

class PhysicalDecorations {
  constructor ({ bot, executor, snapshot, onEvent = () => {}, signal } = {}) {
    if (!bot || typeof snapshot?.readDecoration !== 'function') throw new Error('Physical decorations require a bot and authoritative decoration snapshot')
    this.bot = bot
    this.executor = executor
    this.snapshot = snapshot
    this.onEvent = onEvent
    this.signal = signal
    this.registry = bot.registry || require('minecraft-data')(bot.version)
    this.Item = require('prismarine-item')(this.registry)
    this.claimed = new Map()
    this.running = false
  }

  eye () {
    return this.bot.entity.position.offset(0, this.bot.entity.eyeHeight || 1.62, 0)
  }

  assertEntity (entity) {
    if (!SUPPORTED.has(entity?.name)) throw new Error(`Unsupported physical decoration: ${entity?.name}`)
    if (!['x', 'y', 'z'].every(axis => Number.isFinite(entity.pos?.[axis]))) throw new Error('Invalid decoration target position')
    if (entity.name === 'armor_stand') standYaw(entity)
  }

  collisionClear (box) {
    for (let x = Math.floor(box.min[0]); x <= Math.floor(box.max[0] - 1e-7); x++) {
      for (let y = Math.floor(box.min[1]); y <= Math.floor(box.max[1] - 1e-7); y++) {
        for (let z = Math.floor(box.min[2]); z <= Math.floor(box.max[2] - 1e-7); z++) {
          const block = this.bot.blockAt(new Vec3(x, y, z))
          if (!block) return false
          if ((block.shapes || []).some(shape => overlaps(box, { min: [x + shape[0], y + shape[1], z + shape[2]], max: [x + shape[3], y + shape[4], z + shape[5]] }))) return false
        }
      }
    }
    for (const entity of Object.values(this.bot.entities || {})) {
      if (entity.id === this.bot.entity.id || !entity.position) continue
      const definition = this.registry.entitiesByName[entity.name]
      const width = entity.width || definition?.width || 0.6
      const height = entity.height || definition?.height || 1.8
      if (overlaps(box, bounds(entity.position, width, height))) return false
    }
    return true
  }

  initialBox (entity, ref, face) {
    const anchor = ref.plus(face)
    if (entity.name === 'armor_stand') return bounds(anchor.offset(0.5, 0, 0.5), 0.5, 1.975)
    const center = anchor.offset(0.5, 0.5, 0.5).minus(face.scaled(0.46875))
    const size = entity.name === 'painting' ? 1 : 0.75
    const dimensions = ['x', 'y', 'z'].map(axis => face[axis] ? 0.0625 : size)
    return { min: ['x', 'y', 'z'].map((axis, i) => center[axis] - dimensions[i] / 2), max: ['x', 'y', 'z'].map((axis, i) => center[axis] + dimensions[i] / 2) }
  }

  sourceCandidates (entity) {
    const origin = entity.pos.floored()
    const candidates = []
    const faces = entity.name === 'armor_stand' ? [1] : entity.name === 'painting' ? [2, 3, 4, 5] : [1, 2, 3, 4, 5, 0]
    for (let x = -4; x <= 4; x++) {
      for (let y = -4; y <= 4; y++) {
        for (let z = -4; z <= 4; z++) {
          const ref = origin.offset(x, y, z)
          const block = this.bot.blockAt(ref)
          if (!block?.shapes?.some(shape => shape.every((value, i) => i < 3 ? value <= 0 : value >= 1))) continue
          for (const index of faces) {
            const face = FACES[index]
            const point = ref.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5))
            if (point.distanceTo(entity.pos) > 4.5) continue
            const box = this.initialBox(entity, ref, face)
            if (!this.collisionClear(box)) continue
            candidates.push({ ref, face, index, point, box, stateId: block.stateId })
          }
        }
      }
    }
    return candidates.sort((a, b) => a.point.distanceTo(entity.pos) - b.point.distanceTo(entity.pos))
  }

  reachableFace (entity, source, eye) {
    if (eye.distanceTo(entity.pos) > 4.5) return null
    const current = this.bot.blockAt(source.ref)
    if (!current || current.stateId !== source.stateId || !this.collisionClear(source.box)) return null
    const feet = eye.offset(0, -(this.bot.entity.eyeHeight || 1.62), 0)
    if (overlaps(source.box, bounds(feet, 0.6, 1.8))) return null
    const point = entity.name === 'armor_stand' ? yawTopPoint(eye, source.ref, standYaw(entity)) : source.point
    if (!point || eye.minus(point).dot(source.face) < 0.001) return null
    const ray = point.minus(eye)
    const distance = ray.norm()
    if (distance > 4.5 || distance < 0.01) return null
    const direction = ray.scaled(1 / distance)
    const intersection = new RaycastIterator(eye, direction, distance + 0.001).intersect(current.shapes, source.ref)
    if (!intersection || intersection.face !== source.index) return null
    const hit = this.executor?.selectionRaycast
      ? this.executor.selectionRaycast(eye, direction, distance + 0.001)
      : this.bot.world.raycast(eye, direction, distance + 0.001, (block, iterator) => {
        const shapes = this.executor?.selectionShapes?.(block) || block.shapes
        const hit = iterator.intersect(shapes, block.position)
        if (!hit) return false
        block.face = hit.face
        return true
      })
    if (!hit?.position.equals(source.ref) || hit.face !== source.index) return null
    return { ...source, to: point, point, face: source.face.scaled(-1) }
  }

  async clickFace (entity, signal) {
    const nearGoal = { getFaceAndRef: eye => eye.distanceTo(entity.pos) <= 4.5 ? { ref: entity.pos.floored(), to: entity.pos, face: new Vec3(0, -1, 0) } : null }
    if (this.executor) await approachGoal({ bot: this.bot, executor: this.executor }, nearGoal, entity.pos.floored(), { signal })
    check(this.bot, signal)
    const sources = this.sourceCandidates(entity)
    if (!sources.length) throw new Error(`No clear existing support face near decoration ${entity.id || key(entity.pos)}`)
    const goal = {
      getFaceAndRef: eye => {
        for (const source of sources) {
          const face = this.reachableFace(entity, source, eye)
          if (face) return face
        }
        return null
      }
    }
    if (this.executor?.reach) await this.executor.reach(goal, entity.pos.floored(), signal)
    check(this.bot, signal)
    const face = goal.getFaceAndRef(this.eye())
    if (!face) throw new Error(`No unobstructed reachable decoration interaction face near ${key(entity.pos)}`)
    return face
  }

  checkedSnapshot (entity, observed, reused) {
    if (!observed) return null
    const differences = observed.differences || decorationDifferences(entity, observed.entity)
    if (differences.length) {
      const error = new Error(`Decoration ${entity.id} differs from its blueprint: ${differences.join(', ')}`)
      error.evidence = observed.evidence
      throw error
    }
    if (typeof observed.uuid !== 'string' || !observed.uuid) throw new Error(`Decoration ${entity.id} snapshot is missing its UUID`)
    const previous = this.claimed.get(entity.id)
    if (previous && previous !== observed.uuid) throw new Error(`Decoration ${entity.id} UUID identity changed`)
    for (const [id, uuid] of this.claimed) if (id !== entity.id && uuid === observed.uuid) throw new Error(`Decoration UUID is already claimed by ${id}`)
    this.claimed.set(entity.id, observed.uuid)
    const pos = vector(observed.pos || observed.entity?.Pos || entity.pos)
    return { verified: true, reused, id: entity.id, uuid: observed.uuid, pos, position: pos, evidence: observed.evidence || [] }
  }

  async readSnapshot (entity, signal, reused) {
    check(this.bot, signal)
    const observed = await this.snapshot.readDecoration(entity, { signal })
    check(this.bot, signal)
    return this.checkedSnapshot(entity, observed, reused)
  }

  async settle (signal) {
    if (!this.bot.waitForTicks) return pause(100, signal)
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        this.bot.removeListener?.('end', end)
        signal?.removeEventListener('abort', cancel)
        if (error) reject(error)
        else resolve()
      }
      const end = () => finish(new Error('Bot disconnected while verifying decoration position'))
      const cancel = () => {
        try { check(this.bot, signal) } catch (error) { finish(error) }
      }
      const timer = setTimeout(() => finish(new Error('No physics updates while verifying decoration position')), 2000)
      this.bot.once?.('end', end)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) return cancel()
      Promise.resolve().then(() => this.bot.waitForTicks(2)).then(() => finish(), finish)
    })
  }

  async withItem (entity, signal, action) {
    check(this.bot, signal)
    const definition = this.registry.itemsByName[entity.name]
    const type = this.registry.entitiesByName[entity.name]
    if (!definition || !type || !this.registry.supportFeature('itemsWithComponents')) throw new Error(`Entity-data item components are unavailable for ${entity.name}`)
    const material = new this.Item(definition.id, 1)
    const component = { type: 'entity_data', data: { type: type.id, data: decorationEntityData(entity) } }
    material.components.push(component)
    material.componentMap.set(component.type, component)
    const saved = this.bot.inventory.slots[44]
    const selected = this.bot.quickBarSlot
    try {
      if (saved) await this.bot.creative.setInventorySlot(44, null)
      check(this.bot, signal)
      await this.bot.creative.setInventorySlot(44, material)
      check(this.bot, signal)
      this.bot.setQuickBarSlot(8)
      return await action()
    } finally {
      if (!this.bot._client?.ended) {
        await this.bot.creative.setInventorySlot(44, null)
        if (saved) await this.bot.creative.setInventorySlot(44, saved)
        this.bot.setQuickBarSlot(selected)
      }
    }
  }

  async placeDecoration (entity, { signal = this.signal } = {}) {
    check(this.bot, signal)
    this.assertEntity(entity)
    if (this.running) throw new Error('Decoration placement is already running on this bot')
    this.running = true
    try {
      const existing = await this.readSnapshot(entity, signal, true)
      if (existing) {
        this.onEvent({ type: 'decoration', phase: 'reused', ...existing })
        return existing
      }
      const selected = await this.clickFace(entity, signal)
      const operation = async () => {
        check(this.bot, signal)
        const duplicate = await this.readSnapshot(entity, signal, true)
        if (duplicate) return duplicate
        return this.withItem(entity, signal, async () => {
          if (this.executor?.orient) await this.executor.orient(selected.point, signal)
          else await this.bot.lookAt(selected.point, true)
          check(this.bot, signal)
          const face = this.reachableFace(entity, { ...selected, face: selected.face.scaled(-1) }, this.eye())
          if (!face || face.to.distanceTo(selected.point) > 0.01) throw new Error('Decoration interaction face or source clearance changed before placement')
          const sneaking = this.bot.getControlState?.('sneak') || false
          const sneak = value => this.executor?.setSneaking ? this.executor.setSneaking(value) : this.bot.setControlState('sneak', value)
          try {
            sneak(true)
            this.onEvent({ type: 'decoration', phase: 'placing', id: entity.id, name: entity.name, target: entity.pos, reference: face.ref, click: face.to })
            await this.bot._genericPlace(this.bot.blockAt(face.ref), face.face.scaled(-1), { delta: face.to.minus(face.ref), forceLook: 'ignore', swingArm: 'right' })
          } finally { sneak(sneaking) }
          for (let attempt = 0; attempt < 20; attempt++) {
            check(this.bot, signal)
            const observed = await this.readSnapshot(entity, signal, false)
            if (observed) {
              await this.settle(signal)
              check(this.bot, signal)
              const settled = await this.readSnapshot(entity, signal, false)
              if (!settled) throw new Error(`Decoration ${entity.id} disappeared after placement`)
              this.onEvent({ type: 'decoration', phase: 'verified', ...settled })
              return settled
            }
            await pause(100, signal)
          }
          throw new Error(`Decoration ${entity.id} placement was sent but authoritative readback found no matching entity`)
        })
      }
      return this.executor?.mutate ? await this.executor.mutate(true, signal, operation) : await operation()
    } finally { this.running = false }
  }

  async verifyDecorations (entities, { signal = this.signal } = {}) {
    const results = []
    for (const entity of entities) {
      check(this.bot, signal)
      this.assertEntity(entity)
      const observed = await this.readSnapshot(entity, signal, true)
      if (!observed) throw new Error(`Missing decoration ${entity.id} at ${key(entity.pos)}`)
      results.push(observed)
    }
    return { verified: true, checked: results.length, entities: results.map(({ id, uuid, pos }) => ({ id, uuid, pos })), evidence: results.flatMap(result => result.evidence) }
  }
}

module.exports = { PhysicalDecorations }
