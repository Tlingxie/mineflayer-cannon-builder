/**
 * Build 类 - 建筑任务管理
 * 负责管理建筑动作、方块状态、以及与世界的同步
 */

const { Vec3 } = require('vec3')
const { LockManager } = require('./locking')

class Build {
  constructor (schematic, world, at, robotId = 'default') {
    this.schematic = schematic
    this.world = world
    this.at = at
    this.robotId = robotId

    this.min = at.plus(schematic.offset)
    this.max = this.min.plus(schematic.size)

    this.actions = []
    this.actionIndex = new Map()

    // 使用 LockManager 管理锁和区域预约
    this.lockManager = new LockManager(robotId)

    this.actionResultCache = new Map()

    // Cache of blockstate to block
    const Block = require('prismarine-block')(schematic.version)
    const mcData = require('minecraft-data')(schematic.version)
    this.blocks = {}
    this.properties = {}
    this.items = {}
    for (const stateId of schematic.palette) {
      const block = Block.fromStateId(stateId, 0)
      this.blocks[stateId] = block
      this.properties[stateId] = block.getProperties()
      this.items[stateId] = mcData.itemsByName[block.name]
    }

    this.updateActions()
  }

  getPosKey (pos) {
    return `${pos.x},${pos.y},${pos.z}`
  }

  isInBuildArea (pos) {
    return pos.x >= this.min.x && pos.x < this.max.x &&
      pos.y >= this.min.y && pos.y < this.max.y &&
      pos.z >= this.min.z && pos.z < this.max.z
  }

  invalidateActionCaches () {
    // Don't bump lockManager.actionVersion on every add/remove — that defeated
    // both actionResultCache and zoneCapacityCache, forcing O(N) rescans on
    // every placement. Local action-result cache is cleared so the next read
    // sees the updated `this.actions`; zoneCapacityCache TTL (250ms) absorbs
    // brief staleness in capacity numbers (which only feed scoring heuristics).
    this.actionResultCache.clear()
  }

  resetActionContext () {
    this.lockManager.invalidateCache()
    this.actionResultCache.clear()
    this.lockManager.setContext(
      this.actions,
      this.world,
      this.canInteractToMatch.bind(this),
      this.hasLiveReference.bind(this)
    )
  }

  invalidateLockCache (action) {
    this.lockManager.invalidateLockCache(action)
    this.actionResultCache.clear()
  }

  invalidateZoneReservationCache (action) {
    this.lockManager.invalidateZoneCache(action)
  }

  buildActionForPos (pos, options = {}) {
    const { exactProperties = true } = options
    if (!this.isInBuildArea(pos)) return null

    const worldPos = pos.clone ? pos.clone() : new Vec3(pos.x, pos.y, pos.z)
    const stateInWorld = this.world.getBlockStateId(worldPos)
    const wantedState = this.schematic.getBlockStateId(worldPos.minus(this.at))
    const blockInWorld = this.world.getBlock(worldPos)
    if (stateInWorld === wantedState) return null

    if (wantedState === 0) {
      const action = { type: 'dig', pos: worldPos }
      return this.isActionSatisfied(action, blockInWorld, { exactProperties }) ? null : action
    }

    const action = { type: 'place', pos: worldPos, state: wantedState }
    return this.isActionSatisfied(action, blockInWorld, { exactProperties }) ? null : action
  }

  replaceActionAtIndex (index, action) {
    const key = this.getPosKey(action.pos)
    this.actions[index] = action
    this.actionIndex.set(key, index)
    this.invalidateActionCaches()
  }

  addAction (action) {
    const key = this.getPosKey(action.pos)
    this.actionIndex.set(key, this.actions.length)
    this.actions.push(action)
    this.invalidateActionCaches()
  }

  removeActionAtIndex (index, { release = true } = {}) {
    if (index < 0 || index >= this.actions.length) return

    const removed = this.actions[index]
    const removedKey = this.getPosKey(removed.pos)
    const lastIndex = this.actions.length - 1
    const lastAction = this.actions[lastIndex]

    if (index !== lastIndex) {
      this.actions[index] = lastAction
      this.actionIndex.set(this.getPosKey(lastAction.pos), index)
    }

    this.actions.pop()
    this.actionIndex.delete(removedKey)
    if (release) {
      this.unlockAction(removed)
      this.releaseZoneReservation(removed)
    }
    this.invalidateActionCaches()
  }

  updateActions (options = {}) {
    const { exactProperties = true } = options
    this.actions = []
    this.actionIndex = new Map()
    const cursor = new Vec3(0, 0, 0)

    for (cursor.y = this.min.y; cursor.y < this.max.y; cursor.y++) {
      for (cursor.z = this.min.z; cursor.z < this.max.z; cursor.z++) {
        for (cursor.x = this.min.x; cursor.x < this.max.x; cursor.x++) {
          const action = this.buildActionForPos(cursor, { exactProperties })
          if (!action) continue
          this.actionIndex.set(this.getPosKey(action.pos), this.actions.length)
          this.actions.push(action)
        }
      }
    }

    this.resetActionContext()

    // 调试日志
    console.log(`[${this.lockManager.robotId}] updateActions: exactProperties=${exactProperties}, actions=${this.actions.length}, min=${this.min.x},${this.min.y},${this.min.z}, max=${this.max.x},${this.max.y},${this.max.z}`)
  }

  updateBlock (pos, options = {}) {
    if (!this.isInBuildArea(pos)) return

    const key = this.getPosKey(pos)
    const existingIndex = this.actionIndex.has(key) ? this.actionIndex.get(key) : -1
    const nextAction = this.buildActionForPos(pos, options)

    if (!nextAction) {
      if (existingIndex !== -1) this.removeActionAtIndex(existingIndex)
      return
    }

    if (existingIndex === -1) {
      this.addAction(nextAction)
      return
    }

    const existing = this.actions[existingIndex]
    if (this.isActionSame(existing, nextAction)) return
    this.replaceActionAtIndex(existingIndex, nextAction)
  }

  getTargetBlock (stateId) {
    return this.blocks[stateId] || null
  }

  getTargetBlockName (stateId) {
    const block = this.getTargetBlock(stateId)
    return block ? block.name : null
  }

  isBlockTypeSatisfied (action, block = this.world.getBlock(action.pos)) {
    if (action.type === 'dig') {
      return !block || block.name === 'air'
    }

    const wantedName = this.getTargetBlockName(action.state)
    return Boolean(block) && block.name !== 'air' && block.name === wantedName
  }

  isActionSame (left, right) {
    if (!left || !right) return false
    if (left.type !== right.type) return false
    if (left.type === 'place' && left.state !== right.state) return false
    return left.pos.x === right.pos.x && left.pos.y === right.pos.y && left.pos.z === right.pos.z
  }

  findActionIndex (action) {
    if (!action) return -1
    const key = this.getPosKey(action.pos)
    const index = this.actionIndex.has(key) ? this.actionIndex.get(key) : -1
    if (index === -1) return -1
    return this.isActionSame(this.actions[index], action) ? index : -1
  }

  getBlockProperties (block) {
    if (!block || typeof block.getProperties !== 'function') return {}
    return block.getProperties()
  }

  getPropertyDifferences (stateId, block) {
    const wanted = this.properties[stateId] || {}
    const current = this.getBlockProperties(block)
    const keys = new Set([...Object.keys(wanted), ...Object.keys(current)])
    const differences = []

    for (const key of keys) {
      if (wanted[key] !== current[key]) differences.push(key)
    }

    return differences
  }

  getDynamicPropertyKeys (blockName) {
    const keys = new Set()

    if (blockName.endsWith('_wall')) {
      keys.add('north')
      keys.add('south')
      keys.add('east')
      keys.add('west')
      keys.add('up')
    }

    if (blockName.endsWith('_fence') || blockName.endsWith('_pane') || blockName === 'iron_bars' || blockName.includes('glass_pane')) {
      keys.add('north')
      keys.add('south')
      keys.add('east')
      keys.add('west')
    }

    if (blockName.endsWith('_stairs')) {
      keys.add('shape')
    }

    return keys
  }

  canIgnorePropertyDifferences (stateId, block) {
    const wantedBlock = this.blocks[stateId]
    if (!block || !wantedBlock || block.name !== wantedBlock.name) return false

    const differences = this.getPropertyDifferences(stateId, block)
    if (differences.length === 0) return true

    const dynamicKeys = this.getDynamicPropertyKeys(block.name)
    return dynamicKeys.size > 0 && differences.every(key => dynamicKeys.has(key))
  }

  canInteractToMatch (action, block) {
    if (!action || action.type !== 'place') return false

    const wantedBlock = this.blocks[action.state]
    if (!block || !wantedBlock || block.name !== wantedBlock.name) return false

    const differences = this.getPropertyDifferences(action.state, block)
    if (differences.length === 0) return false

    const supportsOpenToggle = block.name.includes('trapdoor') || block.name.endsWith('_door') || block.name.endsWith('_fence_gate')
    if (!supportsOpenToggle) return false

    return differences.every(key => key === 'open')
  }

  isActionSatisfied (action, block = this.world.getBlock(action.pos), options = {}) {
    const { exactProperties = true } = options

    if (action.type === 'dig') {
      return !block || block.name === 'air'
    }

    if (!this.isBlockTypeSatisfied(action, block)) return false
    if (!exactProperties) return true
    if (block.stateId === action.state) return true

    return this.canIgnorePropertyDifferences(action.state, block)
  }

  getItemForState (stateId) {
    return this.items[stateId]
  }

  getFacing (stateId, facing) {
    if (!facing) return { facing: null, faceDirection: false, is3D: false }
    const block = this.blocks[stateId]
    const data = require('./facingData.json')[block.name]
    if (data.inverted) {
      if (facing === 'up') facing = 'down'
      else if (facing === 'down') facing = 'up'
      else if (facing === 'north') facing = 'south'
      else if (facing === 'south') facing = 'north'
      else if (facing === 'west') facing = 'east'
      else if (facing === 'east') facing = 'west'
    }
    return { facing, faceDirection: data.faceDirection, is3D: data.is3D }
  }

  getLiveReferenceDirections (stateId, pos) {
    const properties = this.properties[stateId] || {}
    const half = properties.half ? properties.half : properties.type
    const { getShapeFaceCenters } = require('mineflayer-pathfinder/lib/shapes')

    return this.getPossibleDirections(stateId, pos).filter(dir => {
      const block = this.world.getBlock(pos.plus(dir))
      if (!block || block.name === 'air' || !block.shapes) return false
      return getShapeFaceCenters(block.shapes, dir.scaled(-1), half).length > 0
    })
  }

  hasLiveReference (stateId, pos) {
    return this.getLiveReferenceDirections(stateId, pos).length > 0
  }

  getPossibleDirections (stateId, pos) {
    const faces = [true, true, true, true, true, true]
    const properties = this.properties[stateId]
    const block = this.blocks[stateId]
    if (properties.axis) {
      if (properties.axis === 'x') faces[0] = faces[1] = faces[2] = faces[3] = false
      if (properties.axis === 'y') faces[2] = faces[3] = faces[4] = faces[5] = false
      if (properties.axis === 'z') faces[0] = faces[1] = faces[4] = faces[5] = false
    }
    if (properties.half === 'upper') return []
    if (properties.half === 'top' || properties.type === 'top') faces[0] = faces[1] = false
    if (properties.half === 'bottom' || properties.type === 'bottom') faces[0] = faces[1] = false
    if (properties.facing) {
      const { facing, faceDirection } = this.getFacing(stateId, properties.facing)
      if (faceDirection) {
        if (facing === 'north') faces[0] = faces[1] = faces[2] = faces[4] = faces[5] = false
        else if (facing === 'south') faces[0] = faces[1] = faces[3] = faces[4] = faces[5] = false
        else if (facing === 'west') faces[0] = faces[1] = faces[2] = faces[3] = faces[4] = false
        else if (facing === 'east') faces[0] = faces[1] = faces[2] = faces[3] = faces[5] = false
        else if (facing === 'up') faces[1] = faces[2] = faces[3] = faces[4] = faces[5] = false
        else if (facing === 'down') faces[0] = faces[2] = faces[3] = faces[4] = faces[5] = false
      }
    }
    if (properties.hanging) faces[0] = faces[2] = faces[3] = faces[4] = faces[5] = false
    if (block.material === 'plant') faces[1] = faces[2] = faces[3] = faces[4] = faces[5] = false

    const dirs = []
    const faceDir = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
    for (let i = 0; i < faces.length; i++) {
      if (faces[i]) dirs.push(faceDir[i])
    }

    const half = properties.half ? properties.half : properties.type
    const { getShapeFaceCenters } = require('mineflayer-pathfinder/lib/shapes')
    const filteredDirs = dirs.filter(dir => {
      const block = this.world.getBlock(pos.plus(dir))
      if (!block || !block.shapes) return true
      return getShapeFaceCenters(block.shapes, dir.scaled(-1), half).length > 0
    })

    return filteredDirs.length > 0 ? filteredDirs : dirs
  }

  removeAction (action) {
    const index = this.findActionIndex(action)
    if (index !== -1) {
      this.removeActionAtIndex(index)
      return
    }
    this.unlockAction(action)
    this.releaseZoneReservation(action)
  }

  getPendingActions (options = {}) {
    const { exactProperties = true, includeLocked = false } = options
    const cacheKey = `pending:${exactProperties ? 1 : 0}:${includeLocked ? 1 : 0}:${this.lockManager.actionVersion}`
    const now = Date.now()
    const cached = this.actionResultCache.get(cacheKey)
    if (cached && cached.expiresAt > now) return cached.actions.slice()

    const actions = this.actions.filter(action => {
      if (!includeLocked && this.isActionLocked(action)) return false
      return !this.isActionSatisfied(action, this.world.getBlock(action.pos), { exactProperties })
    })

    this.actionResultCache.set(cacheKey, { expiresAt: now + 2000, actions }) // 2秒缓存
    return actions.slice()
  }

  getAvailableActions (options = {}) {
    const { exactProperties = true, includeLocked = false } = options
    const cacheKey = `available:${exactProperties ? 1 : 0}:${includeLocked ? 1 : 0}:${this.lockManager.actionVersion}`
    const now = Date.now()
    const cached = this.actionResultCache.get(cacheKey)
    if (cached && cached.expiresAt > now) return cached.actions.slice()

    const pending = this.getPendingActions({ exactProperties, includeLocked })
    const actions = pending.filter(action => {
      if (action.type === 'dig') return true
      // exactProperties 模式下，可以通过交互完成的动作也算可用
      if (exactProperties && this.canInteractToMatch(action, this.world.getBlock(action.pos))) return true
      // 有参考方块的动作优先
      if (this.hasLiveReference(action.state, action.pos)) return true
      // 非精确模式下，返回所有待处理动作（让建造器自己判断是否可达）
      if (!exactProperties) return true
      return false
    })

    // 调试日志
    if (actions.length === 0 && this.actions.length > 0) {
      console.log(`[${this.lockManager.robotId}] Debug: total=${this.actions.length}, pending=${pending.length}, available=${actions.length}, exactProperties=${exactProperties}`)
    }

    this.actionResultCache.set(cacheKey, { expiresAt: now + 2000, actions })
    return actions.slice()
  }

  // === 代理 LockManager 方法 ===

  getLockKey (action) {
    return this.lockManager.getLockKey(action)
  }

  getZoneKeyFromPos (pos) {
    return this.lockManager.getZoneKeyFromPos(pos)
  }

  getZoneKey (action) {
    return this.lockManager.getZoneKey(action)
  }

  getZoneReservationCapacity (action) {
    return this.lockManager.getZoneReservationCapacity(
      action,
      this.actions,
      this.world,
      this.canInteractToMatch.bind(this),
      this.hasLiveReference.bind(this)
    )
  }

  getZoneReservations (action) {
    return this.lockManager.readZoneReservationData(action).reservations
  }

  getZoneReservationState (action) {
    return this.lockManager.getZoneReservationState(
      action,
      this.getZoneReservationCapacity.bind(this)
    )
  }

  reserveZone (action) {
    return this.lockManager.reserveZone(
      action,
      this.getZoneReservationCapacity.bind(this)
    )
  }

  touchZoneReservation (action) {
    return this.lockManager.touchZoneReservation(
      action,
      this.getZoneReservationCapacity.bind(this)
    )
  }

  releaseZoneReservation (action) {
    return this.lockManager.releaseZoneReservation(
      action,
      this.getZoneReservationCapacity.bind(this)
    )
  }

  lockAction (action) {
    return this.lockManager.lockAction(action)
  }

  touchActionLock (action) {
    return this.lockManager.touchActionLock(action)
  }

  unlockAction (action) {
    return this.lockManager.unlockAction(action)
  }

  isActionLocked (action) {
    return this.lockManager.isActionLocked(action)
  }

  cleanupLocks () {
    return this.lockManager.cleanupLocks()
  }

  // === 静态方法 ===

  static cleanupExpiredLocks () {
    LockManager.cleanupExpired()
  }

  static cleanupExpiredZoneReservations () {
    LockManager.cleanupExpired()
  }
}

module.exports = Build
