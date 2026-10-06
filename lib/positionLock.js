/**
 * 机器人位置锁定模块
 * 用于多机器人协同时跟踪各机器人位置，避免碰撞
 */

const fs = require('fs')
const path = require('path')

const POS_LOCK_DIR = path.join(__dirname, '../.build_locks/positions')
const POSITION_TTL_MS = 30000
const POSITION_CACHE_TTL_MS = 250

let dirEnsured = false
const positionCache = new Map()

function ensureDir () {
  if (dirEnsured) return
  try {
    fs.mkdirSync(POS_LOCK_DIR, { recursive: true })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  dirEnsured = true
}

/**
 * 锁定机器人当前位置
 */
function lockPosition (robotId, pos) {
  ensureDir()
  const lockFile = path.join(POS_LOCK_DIR, `${robotId}.pos`)
  try {
    fs.writeFileSync(lockFile, JSON.stringify({
      robotId,
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
      timestamp: Date.now()
    }))
  } catch (e) {}
}

/**
 * 获取所有其他机器人的位置
 */
function getOtherBotPositions (myId) {
  // Cached at ~250ms — was being readdirSync+readFileSync per bot per
  // scoreAction call (twice per main-loop iteration plus FlightPathfinder).
  // With N bots writing this dir continuously, the uncached version was
  // O(N) sync FS per loop tick.
  const now = Date.now()
  const cached = positionCache.get(myId)
  if (cached && cached.expiresAt > now) return cached.positions.slice()

  ensureDir()
  const positions = []
  try {
    const files = fs.readdirSync(POS_LOCK_DIR)
    for (const file of files) {
      if (!file.endsWith('.pos')) continue
      try {
        const data = JSON.parse(fs.readFileSync(path.join(POS_LOCK_DIR, file), 'utf8'))
        if (Date.now() - data.timestamp > POSITION_TTL_MS) continue
        if (data.robotId !== myId) {
          positions.push({ x: data.x, y: data.y, z: data.z })
        }
      } catch (e) {}
    }
  } catch (e) {}
  positionCache.set(myId, { expiresAt: now + POSITION_CACHE_TTL_MS, positions })
  return positions.slice()
}

/**
 * 检查位置是否太靠近其他机器人
 */
function isTooCloseToOthers (myId, pos, minDistance = 3) {
  const others = getOtherBotPositions(myId)
  for (const other of others) {
    const dx = pos.x - other.x
    const dy = pos.y - other.y
    const dz = pos.z - other.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist < minDistance) return true
  }
  return false
}

/**
 * 计算指定半径内的机器人数量
 */
function countBotsNear (positions, pos, radius = 6) {
  let count = 0
  for (const other of positions) {
    const dx = pos.x - other.x
    const dy = pos.y - other.y
    const dz = pos.z - other.z
    if (dx * dx + dy * dy + dz * dz <= radius * radius) count++
  }
  return count
}

/**
 * 清理指定机器人的位置锁
 */
function cleanupPositionLock (robotId) {
  ensureDir()
  const lockFile = path.join(POS_LOCK_DIR, `${robotId}.pos`)
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile)
    }
  } catch (e) {}
}

module.exports = {
  lockPosition,
  getOtherBotPositions,
  isTooCloseToOthers,
  countBotsNear,
  cleanupPositionLock,
  POS_LOCK_DIR
}
