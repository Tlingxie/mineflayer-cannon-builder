/**
 * 单个机器人工作进程
 * 由 multiBuilder.js 启动
 */

const path = require('path')
const fs = require('fs').promises
const { builder, Build } = require('mineflayer-builder')
const { Schematic } = require('prismarine-schematic')
const { pathfinder } = require('mineflayer-pathfinder')
const mineflayer = require('mineflayer')

const host = process.argv[2] || 'localhost'
const port = parseInt(process.argv[3]) || 25565
const username = process.argv[4] || 'builder_0'
const botIndex = parseInt(process.argv[5]) || 0
const useFlight = process.argv[7] !== 'false'
const parentPid = parseInt(process.argv[8], 10) || process.ppid

console.log(`[${username}] 连接到 ${host}:${port}, 飞行模式: ${useFlight}`)

// 变量声明
let exiting = false
let parentWatchdog = null
let heartbeatInterval = null
let lastHeartbeatPosition = null
let ipcAvailable = typeof process.send === 'function' && process.connected !== false
let connectionTimeout = null
let hasSpawned = false

// IPC 错误码常量
const IPC_ERROR_CODES = new Set(['EPIPE', 'ERR_IPC_CHANNEL_CLOSED'])

// 创建机器人
const bot = mineflayer.createBot({
  host,
  port,
  username,
  password: process.argv[6] || undefined,
  auth: 'offline', // 离线模式
  version: false // 自动检测版本
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(builder)

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function snapshotPosition () {
  if (!bot.entity || !bot.entity.position) return null
  const pos = bot.entity.position
  return {
    x: Number(pos.x.toFixed(2)),
    y: Number(pos.y.toFixed(2)),
    z: Number(pos.z.toFixed(2))
  }
}

// 连接超时处理（30秒）
function setConnectionTimeout () {
  clearTimeout(connectionTimeout)
  connectionTimeout = setTimeout(() => {
    if (!hasSpawned && !exiting) {
      console.error(`[${username}] 连接超时 (30秒)`)
      sendStatus({ state: 'error', reason: 'connection-timeout' })
      quickExit('connection-timeout')
    }
  }, 30000)
}

// 启动连接超时计时器
setConnectionTimeout()

function snapshotRuntimeStatus () {
  return bot.builder && bot.builder.runtimeStatus ? bot.builder.runtimeStatus : {}
}

function disableIpc () {
  ipcAvailable = false
  stopHeartbeat()
}

function isIpcError (err) {
  return err && IPC_ERROR_CODES.has(err.code)
}

function sendParentMessage (message) {
  if (!ipcAvailable) return
  if (typeof process.send !== 'function') return
  if (process.connected === false) {
    disableIpc()
    return
  }

  try {
    process.send(message, (err) => {
      if (!err) return
      if (isIpcError(err)) {
        disableIpc()
        return
      }
      console.error(`[${username}] IPC send error: ${err.message}`)
    })
  } catch (e) {
    if (isIpcError(e)) {
      disableIpc()
      return
    }
    console.error(`[${username}] IPC send threw: ${e.message}`)
  }
}

function getBotStatus (extra = {}) {
  const runtime = snapshotRuntimeStatus()
  const position = snapshotPosition()
  let moving = false

  if (position && lastHeartbeatPosition) {
    const dx = position.x - lastHeartbeatPosition.x
    const dy = position.y - lastHeartbeatPosition.y
    const dz = position.z - lastHeartbeatPosition.z
    moving = dx * dx + dy * dy + dz * dz > 0.09
  }

  if (position) lastHeartbeatPosition = position

  return {
    username,
    botIndex,
    host,
    port,
    useFlight,
    connected: !bot._client || !bot._client.ended,
    spawned: Boolean(bot.entity),
    moving,
    state: runtime.state || (bot.entity ? 'online' : 'connecting'),
    phase: runtime.phase || 'init',
    reason: runtime.reason || null,
    remainingActions: runtime.remainingActions ?? null,
    availableActions: runtime.availableActions ?? null,
    currentAction: runtime.currentAction || null,
    targetAction: runtime.targetAction || null,
    zoneFocusAction: runtime.zoneFocusAction || null,
    lastMoveAt: runtime.lastMoveAt || null,
    lastActionAt: runtime.lastActionAt || null,
    lastWorkAt: runtime.lastWorkAt || null,
    lastProgressAt: runtime.lastProgressAt || null,
    lastProgressReason: runtime.lastProgressReason || null,
    completedActions: runtime.completedActions ?? 0,
    position,
    robotId: runtime.robotId || username,
    updatedAt: Date.now(),
    ...extra
  }
}

function sendStatus (extra = {}) {
  sendParentMessage({ type: 'status', status: getBotStatus(extra) })
}

function startHeartbeat () {
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  heartbeatInterval = setInterval(() => {
    sendStatus()
  }, 1500)
}

function stopHeartbeat () {
  if (!heartbeatInterval) return
  clearInterval(heartbeatInterval)
  heartbeatInterval = null
}

function isParentAlive () {
  if (!parentPid || parentPid <= 1) return false
  try {
    process.kill(parentPid, 0)
    return true
  } catch (e) {
    return false
  }
}

function startParentWatchdog () {
  if (parentWatchdog) clearInterval(parentWatchdog)
  parentWatchdog = setInterval(() => {
    if (!isParentAlive()) {
      console.log(`[${username}] 检测到主进程已退出，子进程即将关闭`)
      quickExit('parent-lost')
    }
  }, 2000)
}

const LOCK_DIR = path.join(__dirname, '../.build_locks')
const BUILD_INFO_FILE = path.join(LOCK_DIR, 'build_info.json')

async function getBuildInfo () {
  try {
    const data = await fs.readFile(BUILD_INFO_FILE, 'utf8')
    return JSON.parse(data)
  } catch (e) {
    return null
  }
}

async function setBuildInfo (info) {
  await fs.mkdir(LOCK_DIR, { recursive: true })
  await fs.writeFile(BUILD_INFO_FILE, JSON.stringify(info))
}

async function waitForBuildInfo () {
  for (let i = 0; i < 60; i++) {
    const info = await getBuildInfo()
    if (info) return info
    await wait(1000)
  }
  return null
}

bot.once('spawn', async () => {
  clearTimeout(connectionTimeout)
  hasSpawned = true
  console.log(`[${username}] 已进入服务器`)
  sendStatus({ state: 'spawned', reason: 'spawned' })

  if (useFlight) {
    try {
      bot.chat('/gamemode creative')
      await wait(1000)
      console.log(`[${username}] 飞行模式已启用`)
      sendStatus({ state: 'preparing', reason: 'flight-enabled' })
    } catch (e) {
      console.log(`[${username}] 无法启用飞行: ${e.message}`)
      sendStatus({ state: 'preparing', reason: 'flight-enable-failed' })
    }
  }

  await wait(1000)

  const schematicPath = path.resolve(__dirname, '../schematics/smallhouse1.schem')
  const schematic = await Schematic.read(await fs.readFile(schematicPath), bot.version)

  if (botIndex === 0) {
    const at = bot.entity.position.floored()
    console.log(`[${username}] 初始化建造位置:`, at)

    await setBuildInfo({
      startPosition: { x: at.x, y: at.y, z: at.z },
      schematicPath,
      startTime: Date.now()
    })

    console.log(`[${username}] 等待其他机器人连接...`)
    sendStatus({ state: 'waiting', reason: 'awaiting-other-bots' })
    await wait(10000)
  }

  const buildInfo = botIndex === 0 ? await getBuildInfo() : await waitForBuildInfo()

  if (!buildInfo) {
    console.log(`[${username}] 无法获取建造信息，退出`)
    sendStatus({ state: 'error', reason: 'missing-build-info' })
    return
  }

  const at = new (require('vec3').Vec3)(
    buildInfo.startPosition.x,
    buildInfo.startPosition.y,
    buildInfo.startPosition.z
  )

  console.log(`[${username}] 开始建造于:`, at)
  sendStatus({ state: 'preparing', reason: 'build-starting' })

  const build = new Build(schematic, bot.world, at, username)

  try {
    await bot.builder.build(build, username, useFlight)
    console.log(`[${username}] 建造完成！`)
    sendStatus({ state: 'done', reason: 'build-complete', remainingActions: 0, availableActions: 0 })
  } catch (e) {
    console.error(`[${username}] 建造错误:`, e)
    sendStatus({ state: 'error', reason: e.message || 'build-error' })
  }
})

bot.on('builder:status', () => {
  sendStatus()
})

bot.on('error', (err) => {
  console.error(`[${username}] 机器人错误:`, err.message)
  if (err.stack) console.error(err.stack)
  sendStatus({ state: 'error', reason: err.message })
  clearTimeout(connectionTimeout)
})

bot.on('end', (reason) => {
  console.log(`[${username}] 连接结束:`, reason)
  clearTimeout(connectionTimeout)
  if (!hasSpawned && !exiting) {
    console.error(`[${username}] 连接失败，未成功进入服务器`)
    sendStatus({ state: 'error', reason: 'connection-failed', detail: reason })
  }
})

bot.on('kicked', (reason) => {
  console.error(`[${username}] 被服务器踢出:`, reason)
  clearTimeout(connectionTimeout)
  sendStatus({ state: 'error', reason: 'kicked', detail: String(reason) })
})

function cleanupLocks () {
  try {
    stopHeartbeat()

    if (parentWatchdog) {
      clearInterval(parentWatchdog)
      parentWatchdog = null
    }

    // Use LockManager so zone reservations under zones/ are also released —
    // the bespoke loop here only handled top-level *.lock and leaked zone
    // entries on every crash, which accumulated until 15s TTL per entry.
    try {
      const { LockManager } = require('../lib/locking')
      new LockManager(username).cleanupLocks()
    } catch (e) {
      // 忽略错误
    }

    try {
      const { cleanupPositionLock } = require('../lib/positionLock')
      cleanupPositionLock(username)
    } catch (e) {
      // 忽略错误
    }
  } catch (e) {
    // 忽略最外层错误
  }
}

bot.on('end', (reason) => {
  console.log(`[${username}] 断开连接:`, reason)
  sendStatus({ state: 'offline', reason: reason || 'bot-end', connected: false })
  cleanupLocks()
  if (!exiting) process.exit(0)
})

function quickExit (reason = 'shutdown') {
  if (exiting) return
  exiting = true
  clearTimeout(connectionTimeout)
  console.log(`[${username}] 正在退出: ${reason}`)
  sendStatus({ state: 'offline', reason, connected: false })
  cleanupLocks()
  try { bot.quit(reason) } catch (e) {}
  setTimeout(() => process.exit(hasSpawned ? 0 : 1), 300)
}

process.on('SIGTERM', () => quickExit('SIGTERM'))
process.on('SIGINT', () => quickExit('SIGINT'))
process.on('SIGHUP', () => quickExit('SIGHUP'))
process.on('disconnect', () => {
  disableIpc()
  quickExit('ipc-disconnect')
})
process.on('message', (message) => {
  if (message && message.type === 'shutdown') quickExit(message.signal || 'ipc-shutdown')
})
process.on('beforeExit', () => quickExit('beforeExit'))
process.on('error', (err) => {
  if (err && isIpcError(err)) {
    disableIpc()
    return
  }
  if (err) console.error(`[${username}] 进程错误: ${err.message}`)
})

startParentWatchdog()
startHeartbeat()
sendStatus({ state: 'booting', reason: 'process-started' })
