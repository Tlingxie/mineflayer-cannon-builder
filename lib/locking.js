/**
 * 动作锁定和区域预约模块
 * 用于多机器人协同时避免冲突
 */

const fs = require('fs')
const path = require('path')

const LOCK_DIR = path.join(__dirname, '../.build_locks')
const ZONE_RESERVATION_DIR = path.join(LOCK_DIR, 'zones')

// 配置常量
const LOCK_TTL_MS = 30000
const ZONE_RESERVATION_TTL_MS = 15000
const ZONE_SIZE = { x: 8, y: 6, z: 8 }
const MIN_ZONE_RESERVATION_CAPACITY = 1
const MAX_ZONE_RESERVATION_CAPACITY = 10
const LOCK_CACHE_TTL_MS = 120
const ZONE_RESERVATION_CACHE_TTL_MS = 180
const ZONE_CAPACITY_CACHE_TTL_MS = 250
const MAX_CACHE_ENTRIES = 4096

let lockDirEnsured = false
let zoneDirEnsured = false

function setBounded (map, key, value) {
  if (map.size >= MAX_CACHE_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

function readJsonFile (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

function writeJsonAtomic (file, data) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, file)
}

function ensureLockDir () {
  if (lockDirEnsured) return
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  lockDirEnsured = true
}

function ensureZoneReservationDir () {
  if (zoneDirEnsured) return
  ensureLockDir()
  try {
    fs.mkdirSync(ZONE_RESERVATION_DIR, { recursive: true })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  zoneDirEnsured = true
}

class LockManager {
  constructor (robotId) {
    this.robotId = robotId
    this.lockDir = LOCK_DIR
    this.zoneReservationDir = ZONE_RESERVATION_DIR
    this.lockStateCache = new Map()
    this.zoneReservationCache = new Map()
    this.zoneCapacityCache = new Map()
    this.actionVersion = 0
    this.skipLocks = false

    ensureLockDir()
    ensureZoneReservationDir()
  }

  getLockKey (action) {
    const pos = action.pos
    return `${pos.x}_${pos.y}_${pos.z}`
  }

  getZoneKeyFromPos (pos) {
    return `${Math.floor(pos.x / ZONE_SIZE.x)}_${Math.floor(pos.y / ZONE_SIZE.y)}_${Math.floor(pos.z / ZONE_SIZE.z)}`
  }

  getZoneKey (action) {
    return this.getZoneKeyFromPos(action.pos)
  }

  invalidateCache () {
    this.actionVersion++
    this.zoneCapacityCache.clear()
  }

  invalidateLockCache (action) {
    if (!action) return
    this.lockStateCache.delete(this.getLockKey(action))
  }

  invalidateZoneCache (action) {
    if (!action) return
    this.zoneReservationCache.delete(this.getZoneKey(action))
  }

  // === 动作锁定 ===

  isActionLocked (action) {
    if (this.skipLocks) return false

    const key = this.getLockKey(action)
    const now = Date.now()
    const cached = this.lockStateCache.get(key)
    if (cached && cached.expiresAt > now) return cached.locked

    const lockFile = path.join(this.lockDir, `${key}.lock`)
    let lockData
    try {
      lockData = readJsonFile(lockFile)
    } catch (e) {
      setBounded(this.lockStateCache, key, { expiresAt: now + LOCK_CACHE_TTL_MS, locked: false })
      return false
    }
    if (!lockData) {
      setBounded(this.lockStateCache, key, { expiresAt: now + LOCK_CACHE_TTL_MS, locked: false })
      return false
    }
    if (Date.now() - lockData.timestamp > LOCK_TTL_MS) {
      try { fs.unlinkSync(lockFile) } catch (_) {}
      setBounded(this.lockStateCache, key, { expiresAt: now + LOCK_CACHE_TTL_MS, locked: false })
      return false
    }
    const locked = lockData.robotId !== this.robotId
    setBounded(this.lockStateCache, key, { expiresAt: now + LOCK_CACHE_TTL_MS, locked })
    return locked
  }

  lockAction (action, _depth = 0) {
    if (this.skipLocks) return true

    const key = this.getLockKey(action)
    this.invalidateLockCache(action)
    const lockFile = path.join(this.lockDir, `${key}.lock`)
    const lockData = {
      robotId: this.robotId,
      timestamp: Date.now(),
      type: action.type,
      pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }
    }

    try {
      const fd = fs.openSync(lockFile, 'wx')
      fs.writeFileSync(fd, JSON.stringify(lockData))
      fs.closeSync(fd)
      setBounded(this.lockStateCache, key, { expiresAt: Date.now() + LOCK_CACHE_TTL_MS, locked: false })
      return true
    } catch (e) {
      if (e.code === 'EEXIST') {
        let existing = null
        try { existing = readJsonFile(lockFile) } catch (_) {}
        if (existing && existing.robotId === this.robotId) {
          try {
            writeJsonAtomic(lockFile, lockData)
            setBounded(this.lockStateCache, key, { expiresAt: Date.now() + LOCK_CACHE_TTL_MS, locked: false })
            return true
          } catch (_) {
            return false
          }
        }
        if (_depth < 2 && (!existing || Date.now() - existing.timestamp > LOCK_TTL_MS)) {
          try { fs.unlinkSync(lockFile) } catch (_) {}
          return this.lockAction(action, _depth + 1)
        }
        setBounded(this.lockStateCache, key, { expiresAt: Date.now() + LOCK_CACHE_TTL_MS, locked: true })
        return false
      }

      console.error(`Failed to lock action ${key}:`, e.message)
      return false
    }
  }

  touchActionLock (action) {
    const key = this.getLockKey(action)
    this.invalidateLockCache(action)
    const lockFile = path.join(this.lockDir, `${key}.lock`)
    let statBefore
    try {
      statBefore = fs.statSync(lockFile)
    } catch (e) {
      return false
    }
    let lockData
    try {
      lockData = readJsonFile(lockFile)
    } catch (e) {
      return false
    }
    if (!lockData || lockData.robotId !== this.robotId) return false
    let statAfter
    try {
      statAfter = fs.statSync(lockFile)
    } catch (e) {
      return false
    }
    if (statBefore.mtimeMs !== statAfter.mtimeMs || statBefore.ino !== statAfter.ino) return false
    lockData.timestamp = Date.now()
    try {
      writeJsonAtomic(lockFile, lockData)
    } catch (e) {
      return false
    }
    setBounded(this.lockStateCache, key, { expiresAt: Date.now() + LOCK_CACHE_TTL_MS, locked: false })
    return true
  }

  unlockAction (action) {
    const key = this.getLockKey(action)
    this.invalidateLockCache(action)
    const lockFile = path.join(this.lockDir, `${key}.lock`)
    let lockData
    try {
      lockData = readJsonFile(lockFile)
    } catch (e) {
      return
    }
    if (!lockData) return
    if (lockData.robotId === this.robotId) {
      try { fs.unlinkSync(lockFile) } catch (_) {}
    }
    setBounded(this.lockStateCache, key, { expiresAt: Date.now() + LOCK_CACHE_TTL_MS, locked: false })
  }

  // === 区域预约 ===

  getZoneReservationFile (action) {
    return path.join(this.zoneReservationDir, `${this.getZoneKey(action)}.zone`)
  }

  getZoneReservationCapacity (action, actions, world, canInteractToMatch, hasLiveReference) {
    const zoneKey = this.getZoneKey(action)
    const now = Date.now()
    const cached = this.zoneCapacityCache.get(zoneKey)
    if (cached && cached.expiresAt > now && cached.actionVersion === this.actionVersion) {
      return cached.capacity
    }

    const zoneActions = actions.filter(candidate => this.getZoneKey(candidate) === zoneKey)
    const zoneLoad = zoneActions.length
    let frontierLoad = 0

    for (const candidate of zoneActions) {
      if (candidate.type === 'dig') {
        frontierLoad++
      } else {
        const block = world.getBlock(candidate.pos)
        if (canInteractToMatch(candidate, block) || hasLiveReference(candidate.state, candidate.pos)) {
          frontierLoad++
        }
      }
    }

    const totalActions = actions.length
    let capacity = MIN_ZONE_RESERVATION_CAPACITY

    if (zoneLoad >= 24) capacity = MAX_ZONE_RESERVATION_CAPACITY
    else if (zoneLoad >= 12) capacity = 3
    else if (zoneLoad >= 4) capacity = 2

    capacity = Math.max(capacity, Math.min(MAX_ZONE_RESERVATION_CAPACITY, frontierLoad + 1))

    if (totalActions <= 160) capacity = Math.max(capacity, Math.min(MAX_ZONE_RESERVATION_CAPACITY, Math.max(2, zoneLoad + 1)))
    if (totalActions <= 64) capacity = Math.max(capacity, Math.min(MAX_ZONE_RESERVATION_CAPACITY, Math.max(4, zoneLoad + 1, frontierLoad + 2)))
    if (totalActions <= 24) capacity = Math.max(capacity, Math.min(MAX_ZONE_RESERVATION_CAPACITY, Math.max(5, zoneLoad + 2, frontierLoad + 3)))

    capacity = Math.max(MIN_ZONE_RESERVATION_CAPACITY, Math.min(MAX_ZONE_RESERVATION_CAPACITY, capacity))
    setBounded(this.zoneCapacityCache, zoneKey, {
      expiresAt: now + ZONE_CAPACITY_CACHE_TTL_MS,
      actionVersion: this.actionVersion,
      capacity
    })
    return capacity
  }

  normalizeZoneReservationData (action, reservation) {
    const zoneKey = this.getZoneKey(action)
    const capacity = this.getZoneReservationCapacity(action, this.actions || [], this.world, this.canInteractToMatch, this.hasLiveReference)
    const now = Date.now()
    const reservations = []

    if (reservation) {
      if (Array.isArray(reservation.reservations)) {
        for (const entry of reservation.reservations) {
          if (!entry || !entry.robotId || !entry.timestamp) continue
          if (now - entry.timestamp > ZONE_RESERVATION_TTL_MS) continue
          reservations.push({
            robotId: entry.robotId,
            timestamp: entry.timestamp,
            pos: entry.pos || null
          })
        }
      } else if (reservation.robotId && reservation.timestamp && now - reservation.timestamp <= ZONE_RESERVATION_TTL_MS) {
        reservations.push({
          robotId: reservation.robotId,
          timestamp: reservation.timestamp,
          pos: reservation.pos || null
        })
      }
    }

    const deduped = []
    const seen = new Set()
    for (const entry of reservations) {
      if (seen.has(entry.robotId)) continue
      seen.add(entry.robotId)
      deduped.push(entry)
    }

    return { zoneKey, capacity, reservations: deduped }
  }

  cloneZoneReservationData (data) {
    return {
      zoneKey: data.zoneKey,
      capacity: data.capacity,
      reservations: data.reservations.map(entry => ({
        robotId: entry.robotId,
        timestamp: entry.timestamp,
        pos: entry.pos ? { ...entry.pos } : null
      }))
    }
  }

  readZoneReservationData (action, getCapacityFn) {
    const zoneKey = this.getZoneKey(action)
    const now = Date.now()
    const cached = this.zoneReservationCache.get(zoneKey)
    if (cached && cached.expiresAt > now) return this.cloneZoneReservationData(cached.data)

    const zoneFile = this.getZoneReservationFile(action)
    let reservation
    try {
      reservation = readJsonFile(zoneFile)
    } catch (e) {
      reservation = null
    }
    const normalized = this.normalizeZoneReservationData(action, reservation)
    if (reservation && normalized.reservations.length === 0) {
      try { fs.unlinkSync(zoneFile) } catch (_) {}
    }

    setBounded(this.zoneReservationCache, zoneKey, {
      expiresAt: now + ZONE_RESERVATION_CACHE_TTL_MS,
      data: this.cloneZoneReservationData(normalized)
    })
    return this.cloneZoneReservationData(normalized)
  }

  writeZoneReservationData (action, data) {
    const zoneFile = this.getZoneReservationFile(action)
    const zoneKey = this.getZoneKey(action)
    if (!data || !data.reservations || data.reservations.length === 0) {
      try { fs.unlinkSync(zoneFile) } catch (_) {}
      setBounded(this.zoneReservationCache, zoneKey, {
        expiresAt: Date.now() + ZONE_RESERVATION_CACHE_TTL_MS,
        data: this.normalizeZoneReservationData(action, null)
      })
      return true
    }

    const normalized = this.normalizeZoneReservationData(action, data)
    try {
      writeJsonAtomic(zoneFile, normalized)
      setBounded(this.zoneReservationCache, zoneKey, {
        expiresAt: Date.now() + ZONE_RESERVATION_CACHE_TTL_MS,
        data: this.cloneZoneReservationData(normalized)
      })
      return true
    } catch (e) {
      this.invalidateZoneCache(action)
      return false
    }
  }

  getZoneReservationState (action, getCapacityFn) {
    const data = this.readZoneReservationData(action, getCapacityFn)
    const ownCount = data.reservations.filter(entry => entry.robotId === this.robotId).length
    const totalCount = data.reservations.length
    return {
      zoneKey: data.zoneKey,
      capacity: data.capacity,
      ownCount,
      otherCount: Math.max(0, totalCount - ownCount),
      totalCount,
      reservations: data.reservations
    }
  }

  reserveZone (action, getCapacityFn) {
    const data = this.readZoneReservationData(action, getCapacityFn)
    const now = Date.now()
    const existingIndex = data.reservations.findIndex(entry => entry.robotId === this.robotId)

    if (existingIndex !== -1) {
      data.reservations[existingIndex] = {
        robotId: this.robotId,
        timestamp: now,
        pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }
      }
      return this.writeZoneReservationData(action, data)
    }

    if (data.reservations.length >= data.capacity) return false

    data.reservations.push({
      robotId: this.robotId,
      timestamp: now,
      pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }
    })
    return this.writeZoneReservationData(action, data)
  }

  touchZoneReservation (action, getCapacityFn) {
    const data = this.readZoneReservationData(action, getCapacityFn)
    const existingIndex = data.reservations.findIndex(entry => entry.robotId === this.robotId)
    if (existingIndex === -1) return false

    data.reservations[existingIndex] = {
      ...data.reservations[existingIndex],
      timestamp: Date.now(),
      pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }
    }
    return this.writeZoneReservationData(action, data)
  }

  releaseZoneReservation (action, getCapacityFn) {
    const data = this.readZoneReservationData(action, getCapacityFn)
    const filtered = data.reservations.filter(entry => entry.robotId !== this.robotId)
    if (filtered.length === data.reservations.length) return
    this.writeZoneReservationData(action, { ...data, reservations: filtered })
  }

  cleanupLocks () {
    try {
      if (!fs.existsSync(this.lockDir)) return
      const files = fs.readdirSync(this.lockDir)
      for (const file of files) {
        if (file.endsWith('.lock')) {
          const lockFile = path.join(this.lockDir, file)
          try {
            const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
            if (lockData.robotId === this.robotId) {
              fs.unlinkSync(lockFile)
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      console.error('Failed to cleanup locks:', e.message)
    }
    this.lockStateCache.clear()
    this.zoneReservationCache.clear()
    this.cleanupZoneReservations()
  }

  cleanupZoneReservations () {
    try {
      if (!fs.existsSync(this.zoneReservationDir)) return
      const files = fs.readdirSync(this.zoneReservationDir)
      for (const file of files) {
        if (!file.endsWith('.zone')) continue
        const zoneFile = path.join(this.zoneReservationDir, file)
        try {
          const raw = JSON.parse(fs.readFileSync(zoneFile, 'utf8'))
          const normalized = Array.isArray(raw.reservations)
            ? { ...raw, reservations: raw.reservations.filter(entry => entry && entry.robotId !== this.robotId) }
            : (raw.robotId === this.robotId ? { ...raw, reservations: [] } : raw)
          const hasEntries = Array.isArray(normalized.reservations) ? normalized.reservations.length > 0 : Boolean(normalized.robotId)
          if (!hasEntries) fs.unlinkSync(zoneFile)
          else fs.writeFileSync(zoneFile, JSON.stringify(normalized))
        } catch (e) {
          try { fs.unlinkSync(zoneFile) } catch (_) {}
        }
      }
    } catch (e) {}
  }

  // 保存上下文以支持容量计算
  setContext (actions, world, canInteractToMatch, hasLiveReference) {
    this.actions = actions
    this.world = world
    this.canInteractToMatch = canInteractToMatch
    this.hasLiveReference = hasLiveReference
  }
}

// 静态清理方法
LockManager.ensureDirs = function () {
  ensureLockDir()
  ensureZoneReservationDir()
}

LockManager.cleanupExpired = function () {
  ensureLockDir()
  ensureZoneReservationDir()
  const now = Date.now()
  const filesToDelete = []

  // 清理过期锁
  try {
    const files = fs.readdirSync(LOCK_DIR)
    for (const file of files) {
      if (!file.endsWith('.lock')) continue
      const lockFile = path.join(LOCK_DIR, file)
      try {
        const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
        if (now - lockData.timestamp > LOCK_TTL_MS) {
          filesToDelete.push(lockFile)
        }
      } catch (e) {
        filesToDelete.push(lockFile)
      }
    }
  } catch (e) {
    console.error('Failed to cleanup expired locks:', e.message)
  }

  for (const file of filesToDelete) {
    try {
      fs.unlinkSync(file)
    } catch (e) {}
  }

  // 清理过期区域预约
  try {
    const files = fs.readdirSync(ZONE_RESERVATION_DIR)
    for (const file of files) {
      if (!file.endsWith('.zone')) continue
      const zoneFile = path.join(ZONE_RESERVATION_DIR, file)
      try {
        const reservation = JSON.parse(fs.readFileSync(zoneFile, 'utf8'))
        let nextReservation = reservation

        if (Array.isArray(reservation.reservations)) {
          nextReservation = {
            ...reservation,
            reservations: reservation.reservations.filter(entry =>
              entry && entry.robotId && entry.timestamp && now - entry.timestamp <= ZONE_RESERVATION_TTL_MS
            )
          }
          if (nextReservation.reservations.length === 0) fs.unlinkSync(zoneFile)
          else fs.writeFileSync(zoneFile, JSON.stringify(nextReservation))
          continue
        }

        if (!reservation.timestamp || now - reservation.timestamp > ZONE_RESERVATION_TTL_MS) {
          fs.unlinkSync(zoneFile)
        }
      } catch (e) {
        try { fs.unlinkSync(zoneFile) } catch (_) {}
      }
    }
  } catch (e) {}
}

// Leader-elected cleanup. Without this, every bot ran the full LOCK_DIR scan
// every 5s, giving O(N_bots * N_files) sync FS work that grew with build size.
// One bot at a time wins the leader file (O_EXCL); the others skip cleanly.
const CLEANUP_LEADER_FILE = path.join(LOCK_DIR, '.cleanup-leader')
const CLEANUP_LEADER_STALE_MS = 30000

LockManager.tryRunCleanupAsLeader = function (robotId) {
  ensureLockDir()
  const now = Date.now()
  let acquired = false
  try {
    const fd = fs.openSync(CLEANUP_LEADER_FILE, 'wx')
    fs.writeFileSync(fd, JSON.stringify({ robotId, timestamp: now }))
    fs.closeSync(fd)
    acquired = true
  } catch (e) {
    if (e.code !== 'EEXIST') return false
    let existing = null
    try { existing = JSON.parse(fs.readFileSync(CLEANUP_LEADER_FILE, 'utf8')) } catch (_) {}
    if (existing && now - existing.timestamp < CLEANUP_LEADER_STALE_MS) return false
    try {
      fs.unlinkSync(CLEANUP_LEADER_FILE)
      const fd = fs.openSync(CLEANUP_LEADER_FILE, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ robotId, timestamp: now }))
      fs.closeSync(fd)
      acquired = true
    } catch (_) {
      return false
    }
  }
  if (!acquired) return false
  try {
    LockManager.cleanupExpired()
  } finally {
    try { fs.unlinkSync(CLEANUP_LEADER_FILE) } catch (_) {}
  }
  return true
}

module.exports = {
  LockManager,
  LOCK_DIR,
  ZONE_RESERVATION_DIR,
  ZONE_SIZE,
  MIN_ZONE_RESERVATION_CAPACITY,
  MAX_ZONE_RESERVATION_CAPACITY
}
