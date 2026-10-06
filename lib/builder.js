/**
 * 建造执行器模块
 * 负责执行建筑任务的主循环逻辑
 */

const { goals, Movements } = require('mineflayer-pathfinder')
const { withTimeout, wait, hashString } = require('./utils')
const { FlightPathfinder } = require('./pathing')
const { lockPosition, getOtherBotPositions, countBotsNear } = require('./positionLock')
const { LockManager } = require('./locking')
const BlockPlacer = require('./placement')
const { StuckDetector } = require('./stuckDetector')
const interactable = require('./interactable.json')

class Builder {
  constructor (bot, build, options = {}) {
    this.bot = bot
    this.build = build
    this.robotId = options.robotId || bot.username
    this.useFlight = options.useFlight !== false

    this.mcData = require('minecraft-data')(bot.version)
    this.Item = require('prismarine-item')(bot.version)

    this.movements = new Movements(bot, this.mcData)
    this.movements.canDig = true
    this.movements.digCost = 5
    this.movements.maxDropDown = 256
    this.movements.canPlace = true
    this.movements.allow1by1towers = true
    this.movements.canFly = true
    this.movements.flySpeed = 0.5
    this.movements.maxJump = 256
    bot.pathfinder.searchRadius = 50

    this.pathfinder = new FlightPathfinder(bot, getOtherBotPositions)

    this.placer = new BlockPlacer(bot, build)

    this.exactProperties = false
    this.phaseInitialActionCount = Math.max(1, build.actions.length)

    // 高敏感卡住检测器
    this.stuckDetector = new StuckDetector(this.robotId, {
      aggressiveMode: options.aggressiveMode || false, // 激进模式：更快检测
      checkIntervalMs: options.checkIntervalMs || 1000,
      positionStuckThresholdMs: options.positionStuckThresholdMs || 5000,
      actionStuckThresholdMs: options.actionStuckThresholdMs || 8000,
      repeatedPositionThreshold: options.repeatedPositionThreshold || 4,
      sameActionFailureThreshold: options.sameActionFailureThreshold || 2,
      quickRecoveryCooldownMs: options.quickRecoveryCooldownMs || 2000
    })

    // 失败追踪
    this.consecutiveFailures = 0
    this.MAX_FAILURES = 3
    this.failureCount = new Map()
    this.MAX_FAILURES_PER_ACTION = 2

    // 区域焦点
    this.zoneFocusAction = null
    this.lastRepositionTime = 0
    this.lastRepositionKey = null

    // 脚手架追踪
    this.scaffoldBlocks = new Map()
  }

  async enableFlight () {
    try {
      if (this.bot.game.gameMode !== 'creative' && this.bot.game.gameMode !== 'spectator') {
        this.bot.chat('/gamemode creative')
        await wait(500)
      }
      console.log(`[${this.robotId}] Flight mode ready`)
    } catch (e) {
      console.log(`[${this.robotId}] Could not enable flight: ${e.message}`)
    }
  }

  getPosKey (pos) {
    return `${pos.x},${pos.y},${pos.z}`
  }

  isSameZone (left, right) {
    if (!left || !right) return false
    return this.build.getZoneKey(left) === this.build.getZoneKey(right)
  }

  updateZoneFocus (action) {
    if (!action) return
    if (this.zoneFocusAction && !this.isSameZone(this.zoneFocusAction, action)) {
      this.build.releaseZoneReservation(this.zoneFocusAction)
      this.zoneFocusAction = null
    }
    if (this.build.reserveZone(action)) {
      this.zoneFocusAction = action
    } else {
      this.zoneFocusAction = null
    }
  }

  getLiveReferenceBlock (action) {
    if (!action || action.type !== 'place') return null

    const faces = this.build.getLiveReferenceDirections(action.state, action.pos)
    for (const face of faces) {
      const refPos = action.pos.plus(face)
      const refBlock = this.bot.blockAt(refPos)
      if (refBlock && refBlock.name !== 'air') {
        return { refBlock, placeFace: face.scaled(-1) }
      }
    }

    return null
  }

  getSafeActionAnchor (action) {
    if (!action) return null

    if (action.type === 'place') {
      const liveReference = this.getLiveReferenceBlock(action)
      if (!liveReference) return null
      return liveReference.refBlock.position.offset(0.5, 1.5, 0.5)
    }

    return action.pos.offset(0.5, 1.5, 0.5)
  }

  getActionStagingAnchor (action) {
    return this.getSafeActionAnchor(action) || action.pos.offset(0.5, 1.5, 0.5)
  }

  getActionFocusPos (action) {
    return this.getActionStagingAnchor(action) || action.pos.offset(0.5, 0.5, 0.5)
  }

  getActionDistance (action) {
    const focusPos = this.getActionFocusPos(action)
    if (!focusPos) return Number.POSITIVE_INFINITY
    return this.bot.entity.position.distanceTo(focusPos)
  }

  getActionZoneKey (action) {
    const pos = action.pos
    return Math.floor(pos.x / 8) + ':' + Math.floor(pos.y / 6) + ':' + Math.floor(pos.z / 8)
  }

  buildZoneCounts (actions) {
    const zoneCounts = new Map()
    for (const action of actions) {
      const key = this.getActionZoneKey(action)
      zoneCounts.set(key, (zoneCounts.get(key) || 0) + 1)
    }
    return zoneCounts
  }

  getPhaseProgress () {
    return 1 - (this.build.actions.length / Math.max(1, this.phaseInitialActionCount))
  }

  getNearbyPreferredActions (actions, forMovement = false) {
    if (!actions || actions.length === 0) return []

    let nearestDistance = Number.POSITIVE_INFINITY
    let nearestAction = null
    for (const action of actions) {
      const distance = this.getActionDistance(action)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestAction = action
      }
    }

    if (!nearestAction) return actions

    const progress = this.getPhaseProgress()
    const baseSlack = forMovement ? 8 : 5
    const progressSlack = progress > 0.7 ? 4 : 0
    const distanceLimit = Math.min(forMovement ? 30 : 22, nearestDistance + baseSlack + progressSlack)
    const nearestZoneKey = this.getActionZoneKey(nearestAction)
    const preferred = actions.filter(action => {
      const distance = this.getActionDistance(action)
      if (distance <= distanceLimit) return true
      return progress > 0.8 && this.getActionZoneKey(action) === nearestZoneKey && distance <= distanceLimit + 6
    })

    return preferred.length > 0 ? preferred : actions
  }

  scoreAction (action, zoneCounts, otherBots, forMovement = false) {
    const focusPos = this.getActionFocusPos(action)
    if (!focusPos) return Number.NEGATIVE_INFINITY

    const reservationState = this.build.getZoneReservationState(action)
    const reservedBySelf = reservationState.ownCount > 0
    const zoneFullForOthers = !reservedBySelf && reservationState.totalCount >= reservationState.capacity
    const distance = this.bot.entity.position.distanceTo(focusPos)
    const crowd = countBotsNear(otherBots, focusPos, forMovement ? 7 : 5)
    const zoneLoad = zoneCounts.get(this.getActionZoneKey(action)) || 1
    const progress = this.getPhaseProgress()
    const lateGameBoost = progress > 0.7 ? (progress - 0.7) / 0.3 : 0
    const actionBias = action.type === 'dig' ? 6 : 0
    const crowdPenalty = crowd * (forMovement ? 16 : 26)
    const distancePenalty = distance * (forMovement ? (1.25 + lateGameBoost * 0.5) : (1.7 + lateGameBoost * 0.8))
    const frontierBonus = Math.min(zoneLoad, 16) * (forMovement ? (16 - lateGameBoost * 6) : (10 - lateGameBoost * 4))
    const reservationBonus = reservedBySelf ? 18 : 0
    const zonePressurePenalty = reservationState.otherCount * (forMovement ? (6 - lateGameBoost * 2) : (10 - lateGameBoost * 3))
    const fullZonePenalty = zoneFullForOthers ? (forMovement ? (18 - lateGameBoost * 6) : (28 - lateGameBoost * 10)) : 0
    const spareCapacityBonus = !zoneFullForOthers && reservationState.capacity > reservationState.totalCount ? Math.min(2, reservationState.capacity - reservationState.totalCount) * (forMovement ? 6 : 4) : 0
    const nearbyBonus = Math.max(0, (forMovement ? 18 : 24) - distance) * (forMovement ? 1.6 : 2.2)
    const tieBreaker = (hashString(this.robotId + ':' + action.pos.x + ',' + action.pos.y + ',' + action.pos.z) % 100) / 100
    return frontierBonus + actionBias + reservationBonus + spareCapacityBonus + nearbyBonus + tieBreaker - crowdPenalty - distancePenalty - zonePressurePenalty - fullZonePenalty
  }

  pickBestAction (actions, forMovement = false) {
    if (!actions || actions.length === 0) return null

    const preferredActions = this.getNearbyPreferredActions(actions, forMovement)
    const zoneCounts = this.buildZoneCounts(preferredActions)
    const otherBots = getOtherBotPositions(this.robotId)
    let bestAction = null
    let bestScore = Number.NEGATIVE_INFINITY

    for (const action of preferredActions) {
      const score = this.scoreAction(action, zoneCounts, otherBots, forMovement)
      if (score > bestScore) {
        bestScore = score
        bestAction = action
      }
    }

    return bestAction
  }

  sortActionsForAllocation (actions, forMovement = false) {
    const preferredActions = this.getNearbyPreferredActions(actions, forMovement)
    const zoneCounts = this.buildZoneCounts(preferredActions)
    const otherBots = getOtherBotPositions(this.robotId)
    // Score once per action — comparator must not call scoreAction (which does
    // synchronous fs reads via getZoneReservationState). Calling it inside
    // Array.sort would invoke it O(n log n) times and produce non-transitive
    // comparisons if zone state shifted mid-sort.
    const scored = new Array(preferredActions.length)
    for (let i = 0; i < preferredActions.length; i++) {
      scored[i] = { action: preferredActions[i], score: this.scoreAction(preferredActions[i], zoneCounts, otherBots, forMovement) }
    }
    scored.sort((l, r) => r.score - l.score)
    return scored.map(s => s.action)
  }

  getUnsatisfiedActions () {
    return this.build.actions.filter(action => !this.build.isActionSatisfied(action, this.bot.world.getBlock(action.pos), { exactProperties: this.exactProperties }))
  }

  pickNearestPendingAction (actions) {
    if (!actions || actions.length === 0) return null

    let bestAction = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const action of actions) {
      const distance = this.getActionDistance(action)
      if (distance < bestDistance) {
        bestDistance = distance
        bestAction = action
      }
    }
    return bestAction
  }

  pickRecoveryAction () {
    return this.pickBestAction(this.build.getAvailableActions({ exactProperties: this.exactProperties }), true) ||
      this.pickBestAction(this.build.getAvailableActions({ exactProperties: this.exactProperties, includeLocked: true }), true) ||
      this.pickNearestPendingAction(this.getUnsatisfiedActions())
  }

  markMovementProgress () {
    this.stuckDetector.recordActionSuccess()
  }

  updateMovementProgress () {
    const pos = this.bot.entity.position
    this.stuckDetector.recordPosition(pos)
  }

  resetWorkFocus () {
    this.bot.pathfinder.stop()
    if (typeof this.bot.clearControlStates === 'function') this.bot.clearControlStates()
    this.build.cleanupLocks()
    this.failureCount.clear()
    if (this.zoneFocusAction) this.build.releaseZoneReservation(this.zoneFocusAction)
    this.zoneFocusAction = null
  }

  async proactivelyMoveTowards (action, reason = 'reposition') {
    if (!action) return false

    const key = reason + ':' + action.type + ':' + action.pos.x + ',' + action.pos.y + ',' + action.pos.z + ':' + (this.exactProperties ? 'exact' : 'type')
    const now = Date.now()
    if (key === this.lastRepositionKey && now - this.lastRepositionTime < 1500) return false

    const goal = this.getApproachGoal(action)
    if (!goal) return false
    if (goal.isEnd(this.bot.entity.position.floored())) return false

    this.lastRepositionKey = key
    this.lastRepositionTime = now

    try {
      this.bot.pathfinder.setMovements(this.movements)
      await withTimeout(this.bot.pathfinder.goto(goal), 5000, 'Proactive path timeout')
      return true
    } catch (moveErr) {
      if (!this.useFlight) return false

      const anchor = this.getSafeActionAnchor(action)
      if (!anchor) return false

      try {
        this.bot.creative.startFlying()
        await withTimeout(this.pathfinder.flyTo(anchor, 0.75), 8000, 'Proactive fly timeout')
        return true
      } catch (flyErr) {
        return false
      }
    }
  }

  getApproachGoal (action) {
    if (!action) return null

    if (action.type === 'place') {
      const properties = this.build.properties[action.state] || {}
      const half = properties.half ? properties.half : properties.type
      const faces = this.build.getLiveReferenceDirections(action.state, action.pos)
      if (faces.length > 0) {
        const { facing, is3D } = this.build.getFacing(action.state, properties.facing)
        return new goals.GoalPlaceBlock(action.pos, this.bot.world, {
          faces,
          facing,
          facing3D: is3D,
          half
        })
      }
    }

    return new goals.GoalNear(action.pos.x, action.pos.y, action.pos.z, 4)
  }

  async equipItem (id) {
    if (this.bot.inventory.items().length > 30) {
      this.bot.chat('/clear')
      await wait(1000)
    }
    if (!this.bot.inventory.items().find(x => x.type === id)) {
      const slot = this.bot.inventory.firstEmptyInventorySlot()
      await this.bot.creative.setInventorySlot(slot !== null ? slot : 36, new this.Item(id, 1))
    }
    const item = this.bot.inventory.items().find(x => x.type === id)
    await this.bot.equip(item, 'hand')
  }

  async placeBlock (action) {
    const properties = this.build.properties[action.state]
    const half = properties.half ? properties.half : properties.type
    const faces = this.build.getLiveReferenceDirections(action.state, action.pos)
    if (faces.length === 0) return false

    const { facing, is3D } = this.build.getFacing(action.state, properties.facing)
    const goal = new goals.GoalPlaceBlock(action.pos, this.bot.world, {
      faces,
      facing,
      facing3D: is3D,
      half
    })

    if (!goal.isEnd(this.bot.entity.position.floored())) {
      this.bot.pathfinder.setMovements(this.movements)
      try {
        await withTimeout(this.bot.pathfinder.goto(goal), 20000, 'Place path timeout')
      } catch (moveErr) {
        if (!this.useFlight) throw moveErr

        const anchor = this.getSafeActionAnchor(action)
        if (!anchor) return false

        try {
          this.bot.creative.startFlying()
          await withTimeout(this.pathfinder.flyTo(anchor, 0.75), 10000, 'Place fly timeout')
        } catch (flyErr) {
          return false
        }
      }
    }

    const item = this.build.getItemForState(action.state)
    if (!item) return false
    await this.equipItem(item.id)

    const liveReference = this.getLiveReferenceBlock(action)
    if (!liveReference) return false

    const fallbackRefBlock = liveReference.refBlock
    const fallbackPlaceFace = liveReference.placeFace
    const faceAndRef = goal.getFaceAndRef(this.bot.entity.position.floored().offset(0.5, 1.6, 0.5))

    const refBlock = faceAndRef ? this.bot.blockAt(faceAndRef.ref) : fallbackRefBlock
    if (!refBlock || refBlock.name === 'air') return false

    const placeFace = faceAndRef ? faceAndRef.face.scaled(-1) : fallbackPlaceFace
    const delta = faceAndRef ? faceAndRef.to.minus(faceAndRef.ref) : null
    const sneak = interactable.indexOf(refBlock.name) >= 0

    let placeErr = null
    if (sneak) this.bot.setControlState('sneak', true)
    try {
      try {
        if (delta) {
          await this.bot._placeBlockWithOptions(refBlock, placeFace, { half, delta })
        } else {
          await this.bot._placeBlockWithOptions(refBlock, placeFace, { half })
        }
      } catch (err) {
        placeErr = err
        try {
          await this.bot.placeBlock(refBlock, placeFace)
          placeErr = null
        } catch (fallbackErr) {
          placeErr = fallbackErr
        }
      }
    } finally {
      if (sneak) this.bot.setControlState('sneak', false)
    }

    return !placeErr
  }

  async executeAction (action) {
    if (action.type === 'place') {
      const currentBlock = this.bot.blockAt(action.pos)

      if (this.exactProperties && this.build.canInteractToMatch(action, currentBlock)) {
        const interactGoal = new goals.GoalNear(action.pos.x, action.pos.y, action.pos.z, 3)
        if (!interactGoal.isEnd(this.bot.entity.position.floored())) {
          this.bot.pathfinder.setMovements(this.movements)
          try {
            await withTimeout(this.bot.pathfinder.goto(interactGoal), 15000, 'Interact path timeout')
          } catch (moveErr) {
            if (this.useFlight) {
              this.bot.creative.startFlying()
              await withTimeout(this.pathfinder.flyTo(action.pos.offset(0.5, 1.5, 0.5), 0.75), 15000, 'Interact fly timeout')
            } else {
              throw moveErr
            }
          }
        }

        this.build.touchActionLock(action)
        await this.bot.lookAt(currentBlock.position.offset(0.5, 0.5, 0.5), true)
        await withTimeout(this.bot.activateBlock(currentBlock), 5000, 'Activate block timeout')
        await wait(80)
        return this.build.isActionSatisfied(action, this.bot.blockAt(action.pos), { exactProperties: this.exactProperties })
      }

      if (currentBlock && currentBlock.name !== 'air') {
        const clearGoal = new goals.GoalNear(action.pos.x, action.pos.y, action.pos.z, 3)
        if (!clearGoal.isEnd(this.bot.entity.position.floored())) {
          this.bot.pathfinder.setMovements(this.movements)
          try {
            await withTimeout(this.bot.pathfinder.goto(clearGoal), 15000, 'Clear path timeout')
          } catch (moveErr) {
            if (this.useFlight) {
              this.bot.creative.startFlying()
              await withTimeout(this.pathfinder.flyTo(action.pos.offset(0.5, 1.5, 0.5), 0.75), 15000, 'Clear fly timeout')
            } else {
              throw moveErr
            }
          }
        }

        this.build.touchActionLock(action)
        await withTimeout(this.bot.dig(currentBlock, true), 15000, 'Clear wrong block timeout')
        this.lastActionTime = Date.now()
        this.markMovementProgress()
        this.build.unlockAction(action)
        await wait(50)
        return 'retry'
      }

      const placed = await this.placeBlock(action)
      return placed && this.build.isActionSatisfied(action, this.bot.world.getBlock(action.pos), { exactProperties: this.exactProperties })
    } else if (action.type === 'dig') {
      const block = this.bot.blockAt(action.pos)
      if (!block || block.name === 'air') return true

      const digGoal = new goals.GoalNear(action.pos.x, action.pos.y, action.pos.z, 3)
      if (!digGoal.isEnd(this.bot.entity.position.floored())) {
        this.bot.pathfinder.setMovements(this.movements)
        try {
          await withTimeout(this.bot.pathfinder.goto(digGoal), 15000, 'Dig path timeout')
        } catch (moveErr) {
          if (this.useFlight) {
            this.bot.creative.startFlying()
            await withTimeout(this.pathfinder.flyTo(action.pos.offset(0.5, 1.5, 0.5), 0.75), 15000, 'Dig fly timeout')
          } else {
            throw moveErr
          }
        }
      }

      this.build.touchActionLock(action)
      await withTimeout(this.bot.dig(block, true), 15000, 'Dig timeout')
      return true
    }
    return false
  }

  async run () {
    const intervals = []

    // Touch our own zone reservation; try to be cleanup leader (one bot wins
    // the leader file at a time, so global cleanup runs at most once per 5s
    // across all bots instead of N×).
    intervals.push(setInterval(() => {
      LockManager.tryRunCleanupAsLeader(this.robotId)
      if (this.zoneFocusAction && !this.build.touchZoneReservation(this.zoneFocusAction)) {
        this.zoneFocusAction = null
      }
    }, 5000))

    // Event-driven block sync — replaces the per-bot 3s full-bbox rescan.
    // Mineflayer fires blockUpdate for any change in loaded chunks; Build
    // filters via isInBuildArea so events outside the schematic are cheap.
    const onBlockUpdate = (oldBlock, newBlock) => {
      const pos = (newBlock && newBlock.position) || (oldBlock && oldBlock.position)
      if (!pos) return
      this.build.updateBlock(pos, { exactProperties: this.exactProperties })
    }
    this.bot.on('blockUpdate', onBlockUpdate)

    // 定期更新位置锁
    intervals.push(setInterval(() => {
      this.updateMovementProgress()
      lockPosition(this.robotId, this.bot.entity.position)
    }, 1000))

    // 高敏感卡住检测检查（每秒）
    let stuckRunning = false
    intervals.push(setInterval(async () => {
      this.updateMovementProgress()
      if (stuckRunning) return

      const stuckInfo = this.stuckDetector.detect(this.build.actions.length)
      if (!stuckInfo) return

      stuckRunning = true
      try {
        console.log(`[${this.robotId}] 检测到卡住:`, stuckInfo.type, stuckInfo)
        this.stuckDetector.markRecovery()
        this.resetWorkFocus()
        const recoveryAction = this.pickRecoveryAction()
        if (recoveryAction) {
          this.updateZoneFocus(recoveryAction)
          try {
            await this.proactivelyMoveTowards(recoveryAction, 'stuck-recovery')
          } catch (e) {
            console.log(`[${this.robotId}] 恢复移动失败:`, e.message)
          }
        }
      } finally {
        stuckRunning = false
      }
    }, 1000))

    try {
      const phases = [
        { name: 'type', exactProperties: false },
        { name: 'properties', exactProperties: true }
      ]

      for (const phase of phases) {
        this.exactProperties = phase.exactProperties
        this.failureCount.clear()
        this.consecutiveFailures = 0

        if (this.exactProperties) {
          console.log(`[${this.robotId}] Type placement complete, starting property correction...`)
          await wait(500)
        } else {
          console.log(`[${this.robotId}] Starting type-first placement...`)
        }

        this.build.updateActions({ exactProperties: this.exactProperties })
        this.phaseInitialActionCount = Math.max(1, this.build.actions.length)
        this.stuckDetector.recordActionsCount(this.build.actions.length)

        const phaseTarget = this.pickBestAction(this.build.getAvailableActions({ exactProperties: this.exactProperties, includeLocked: true }), true)
        if (phaseTarget) {
          this.updateZoneFocus(phaseTarget)
          if (await this.proactivelyMoveTowards(phaseTarget, this.exactProperties ? 'phase-exact' : 'phase-type')) {
            this.markMovementProgress()
          }
        }

        while (this.build.actions.length > 0) {
          this.updateMovementProgress()
          lockPosition(this.robotId, this.bot.entity.position)

          const actions = this.build.getAvailableActions({ exactProperties: this.exactProperties })
          console.log(`[${this.robotId}] ${actions.length} available actions, ${this.build.actions.length} remaining`)

          if (actions.length === 0) {
            console.log(`[${this.robotId}] No actions available, repositioning...`)
            const pendingAction = this.pickRecoveryAction()
            if (pendingAction) {
              this.updateZoneFocus(pendingAction)
              if (await this.proactivelyMoveTowards(pendingAction, 'no-actions')) {
                this.markMovementProgress()
              }
            } else {
              await wait(150)
            }
            this.build.updateActions({ exactProperties: this.exactProperties })
            if (this.build.actions.length === 0) {
              console.log(`[${this.robotId}] All actions completed!`)
              break
            }
            continue
          }

          const validActions = actions.filter(action => {
            const key = `${action.pos.x},${action.pos.y},${action.pos.z}`
            const fails = this.failureCount.get(key) || 0
            return fails < this.MAX_FAILURES_PER_ACTION
          })

          if (validActions.length === 0) {
            console.log(`[${this.robotId}] All actions failed too many times, resetting...`)
            this.failureCount.clear()
            const fallbackAction = this.pickRecoveryAction() || this.pickBestAction(actions, true)
            if (fallbackAction) {
              this.updateZoneFocus(fallbackAction)
              if (await this.proactivelyMoveTowards(fallbackAction, 'failed-actions')) {
                this.markMovementProgress()
              }
            } else {
              await wait(150)
            }
            continue
          }

          const sortedActions = this.sortActionsForAllocation(validActions)
          const broadSortedActions = validActions.length === sortedActions.length
            ? sortedActions
            : validActions.slice().sort((left, right) => this.getActionDistance(left) - this.getActionDistance(right))

          let action = null
          for (const candidate of sortedActions) {
            if (this.build.lockAction(candidate)) {
              this.updateZoneFocus(candidate)
              action = candidate
              break
            }
          }

          if (!action) {
            for (const candidate of broadSortedActions) {
              if (this.build.lockAction(candidate)) {
                this.updateZoneFocus(candidate)
                action = candidate
                break
              }
            }
          }

          if (!action) {
            if (this.zoneFocusAction) this.build.releaseZoneReservation(this.zoneFocusAction)
            this.zoneFocusAction = null
            const relocationTarget = this.pickRecoveryAction() || broadSortedActions[0] || sortedActions[0]
            if (relocationTarget) {
              this.updateZoneFocus(relocationTarget)
              if (await this.proactivelyMoveTowards(relocationTarget, 'lock-wait')) {
                this.markMovementProgress()
              }
            }
            await wait(50)
            continue
          }

          let success = false
          // 记录动作尝试
          this.stuckDetector.recordActionAttempt(action)

          try {
            const result = await this.executeAction(action)
            if (result === 'retry') {
              continue
            }
            success = result
          } catch (e) {
            console.log(`[${this.robotId}] Error: ${e.message}`)
            const key = `${action.pos.x},${action.pos.y},${action.pos.z}`
            this.failureCount.set(key, (this.failureCount.get(key) || 0) + 1)
            this.build.unlockAction(action)
            this.consecutiveFailures++
            if (this.consecutiveFailures >= this.MAX_FAILURES) {
              console.log(`[${this.robotId}] Too many failures, switching targets...`)
              this.resetWorkFocus()
              await wait(200)
              this.consecutiveFailures = 0
            }
            await wait(80)
            continue
          }

          if (success) {
            this.consecutiveFailures = 0
            this.stuckDetector.recordActionSuccess()
            this.build.removeAction(action)
            await wait(50)
          } else {
            this.build.unlockAction(action)
            await this.proactivelyMoveTowards(action, 'place-failed')
            await wait(50)
          }
        }
      }
    } finally {
      for (const interval of intervals) {
        clearInterval(interval)
      }
      this.bot.removeListener('blockUpdate', onBlockUpdate)
      this.build.cleanupLocks()
      if (this.zoneFocusAction) this.build.releaseZoneReservation(this.zoneFocusAction)
      this.bot.builder.currentRobotId = null
    }
  }
}

module.exports = { Builder }
