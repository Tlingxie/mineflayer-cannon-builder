/**
 * 高敏感卡住检测模块
 * 快速检测机器人卡住情况并触发恢复
 */

class StuckDetector {
  constructor (robotId, options = {}) {
    this.robotId = robotId

    // 是否使用激进模式（更快检测但可能有误报）
    this.aggressiveMode = options.aggressiveMode || false

    // 配置
    this.CHECK_INTERVAL_MS = options.checkIntervalMs || (this.aggressiveMode ? 500 : 1000)
    this.POSITION_STUCK_THRESHOLD_MS = options.positionStuckThresholdMs || (this.aggressiveMode ? 2500 : 5000)
    this.ACTION_STUCK_THRESHOLD_MS = options.actionStuckThresholdMs || (this.aggressiveMode ? 4000 : 8000)
    this.REPEATED_POSITION_THRESHOLD = options.repeatedPositionThreshold || (this.aggressiveMode ? 3 : 4)
    this.SAME_ACTION_FAILURE_THRESHOLD = options.sameActionFailureThreshold || (this.aggressiveMode ? 1 : 2)
    this.QUICK_RECOVERY_COOLDOWN_MS = options.quickRecoveryCooldownMs || (this.aggressiveMode ? 1000 : 2000)

    // 状态追踪
    this.positionHistory = [] // 位置历史
    this.lastActionTime = Date.now()
    this.lastActionsCount = 0
    this.lastRecoveryTime = 0
    this.currentActionAttempts = 0 // 当前动作尝试次数
    this.lastActionKey = null

    // 检测状态
    this.isStuck = false
    this.stuckReason = null
    this.stuckCount = 0
  }

  // 记录位置（每次主循环调用）
  recordPosition (pos) {
    const now = Date.now()
    const floored = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
    const key = `${floored.x},${floored.y},${floored.z}`

    this.positionHistory.push({ key, time: now, pos: pos.clone() })

    // 只保留最近15秒的历史
    const cutoff = now - 15000
    this.positionHistory = this.positionHistory.filter(p => p.time > cutoff)

    return key
  }

  // 记录动作尝试
  recordActionAttempt (action) {
    const key = action ? `${action.type}:${action.pos.x},${action.pos.y},${action.pos.z}` : null

    if (key === this.lastActionKey) {
      this.currentActionAttempts++
    } else {
      this.currentActionAttempts = 1
      this.lastActionKey = key
    }
  }

  // 记录动作成功
  recordActionSuccess () {
    this.lastActionTime = Date.now()
    this.currentActionAttempts = 0
    this.lastActionKey = null
    this.isStuck = false
    this.stuckReason = null
  }

  // 记录动作数量变化
  recordActionsCount (count) {
    this.lastActionsCount = count
    this.lastActionTime = Date.now()
    this.isStuck = false
  }

  // 检测位置是否在循环（来回移动）
  detectPositionLoop () {
    if (this.positionHistory.length < 6) return null

    const recent = this.positionHistory.slice(-10)
    const positionCounts = new Map()

    for (const entry of recent) {
      positionCounts.set(entry.key, (positionCounts.get(entry.key) || 0) + 1)
    }

    // 检查是否有位置被重复访问超过阈值
    for (const [key, count] of positionCounts) {
      if (count >= this.REPEATED_POSITION_THRESHOLD) {
        // 确认不是正常的短期停留（检查时间间隔）
        const entries = recent.filter(e => e.key === key)
        if (entries.length >= 2) {
          const timeSpan = entries[entries.length - 1].time - entries[0].time
          if (timeSpan < 8000) { // 8秒内重复访问
            return { type: 'position_loop', position: key, visits: count }
          }
        }
      }
    }

    return null
  }

  // 检测位置停滞
  detectPositionStuck () {
    if (this.positionHistory.length < 2) return null

    const oldest = this.positionHistory[0]
    const newest = this.positionHistory[this.positionHistory.length - 1]

    // 计算实际移动距离
    const dx = newest.pos.x - oldest.pos.x
    const dy = newest.pos.y - oldest.pos.y
    const dz = newest.pos.z - oldest.pos.z
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

    // 如果时间跨度超过阈值但移动距离很小
    const timeSpan = newest.time - oldest.time
    if (timeSpan > this.POSITION_STUCK_THRESHOLD_MS && distance < 1.5) {
      return { type: 'position_stuck', distance, timeMs: timeSpan }
    }

    return null
  }

  // 检测动作停滞
  detectActionStuck (currentActionsCount) {
    const now = Date.now()
    const timeSinceLastAction = now - this.lastActionTime

    if (timeSinceLastAction > this.ACTION_STUCK_THRESHOLD_MS && currentActionsCount > 0) {
      return { type: 'action_stuck', timeMs: timeSinceLastAction, remainingActions: currentActionsCount }
    }

    return null
  }

  // 检测重复失败
  detectRepeatedFailures () {
    if (this.currentActionAttempts >= this.SAME_ACTION_FAILURE_THRESHOLD) {
      return { type: 'repeated_failure', attempts: this.currentActionAttempts, actionKey: this.lastActionKey }
    }
    return null
  }

  // 主检测方法 - 返回卡住信息或null
  detect (currentActionsCount) {
    const now = Date.now()

    // 检查恢复冷却期
    if (now - this.lastRecoveryTime < this.QUICK_RECOVERY_COOLDOWN_MS) {
      return null
    }

    // 检测各种卡住情况
    const positionLoop = this.detectPositionLoop()
    if (positionLoop) {
      this.isStuck = true
      this.stuckReason = positionLoop
      return positionLoop
    }

    const repeatedFailures = this.detectRepeatedFailures()
    if (repeatedFailures) {
      this.isStuck = true
      this.stuckReason = repeatedFailures
      return repeatedFailures
    }

    const positionStuck = this.detectPositionStuck()
    if (positionStuck) {
      this.isStuck = true
      this.stuckReason = positionStuck
      return positionStuck
    }

    const actionStuck = this.detectActionStuck(currentActionsCount)
    if (actionStuck) {
      this.isStuck = true
      this.stuckReason = actionStuck
      return actionStuck
    }

    this.isStuck = false
    this.stuckReason = null
    return null
  }

  // 标记恢复已执行
  markRecovery () {
    this.lastRecoveryTime = Date.now()
    this.stuckCount++
    this.isStuck = false
    this.stuckReason = null
    this.currentActionAttempts = 0
    this.lastActionKey = null
    // 清空位置历史以避免误报
    this.positionHistory = []
  }

  // 获取调试信息
  getDebugInfo () {
    return {
      isStuck: this.isStuck,
      stuckReason: this.stuckReason,
      stuckCount: this.stuckCount,
      positionHistorySize: this.positionHistory.length,
      currentActionAttempts: this.currentActionAttempts,
      lastActionKey: this.lastActionKey,
      timeSinceLastAction: Date.now() - this.lastActionTime
    }
  }
}

module.exports = { StuckDetector }
