/**
 * 多机器人协同建造示例
 * 启动多个机器人进程同时建造一个建筑
 *
 * 使用方法:
 *   node multiBuilder.js [host] [port] [botCount] [usernamePrefix] [flight] [uiPort] [uiHost] [spawnDelay]
 *
 * 参数:
 *   host - 服务器地址 (默认: localhost)
 *   port - 服务器端口 (默认: 25565)
 *   botCount - 机器人数量 (默认: 20)
 *   usernamePrefix - 用户名前缀 (默认: builder)
 *   flight - 是否启用飞行 (默认: true)
 *   uiPort - Web 面板端口 (默认: 3000)
 *   uiHost - Web 面板监听地址 (默认: 127.0.0.1)
 *   spawnDelay - 启动间隔毫秒数 (默认: 3000，增加此值可避免服务器连接限制)
 */

const { spawn } = require('child_process')
const http = require('http')
const path = require('path')

const host = process.argv[2] || 'localhost'
const port = process.argv[3] || 25565
const botCount = parseInt(process.argv[4]) || 20
const usernamePrefix = process.argv[5] || 'builder'
const useFlight = process.argv[6] !== 'false'
const uiPort = parseInt(process.argv[7], 10) || 3000
const uiHost = process.argv[8] || '127.0.0.1'
const spawnDelay = parseInt(process.argv[9]) || 3000 // 启动间隔（毫秒）

console.log(`启动 ${botCount} 个机器人协同建造`)
console.log(`服务器: ${host}:${port}`)
console.log(`用户名前缀: ${usernamePrefix}`)
console.log(`飞行模式: ${useFlight}`)
console.log(`启动间隔: ${spawnDelay}ms`)
console.log(`Web 面板: http://${uiHost}:${uiPort}`)

const processes = new Map()
const botStates = new Map()
const buildStartedAt = Date.now()
let statusInterval = null
let dashboardServer = null
let isShuttingDown = false
let successfulConnections = 0
let failedConnections = 0
const connectionRetryCount = new Map()
const MAX_RETRY_ATTEMPTS = 5

function getAliveCount () {
  let aliveCount = 0
  for (const entry of processes.values()) {
    const child = entry.process
    const exited = entry.exited || child.exitCode !== null || child.signalCode !== null || child.killed
    if (!exited) aliveCount++
  }
  return aliveCount
}

// 预定义的状态集合常量
const ACTION_STATES = new Set(['acting', 'placing', 'digging', 'interacting'])
const RECOVERY_STATES = new Set(['moving', 'recovering'])
const STARTUP_STATES = new Set(['starting', 'spawned', 'preparing', 'switching-phase'])
const WORK_STATES = new Set(['acting', 'placing', 'digging', 'interacting', 'moving', 'recovering'])

function getBotActivityClass (entry) {
  if (!entry) return 'offline'
  const child = entry.process
  const exited = entry.exited || child.exitCode !== null || child.signalCode !== null || child.killed
  if (exited) return 'offline'

  const status = entry.status
  if (!status) return 'starting'

  const now = Date.now()
  const age = now - (status.updatedAt || 0)
  if (age > 15000) return 'stale'
  if (status.state === 'done' || status.remainingActions === 0) return 'done'
  if (status.state === 'error') return 'error'

  const lastMoveAgo = status.lastMoveAt ? now - status.lastMoveAt : Number.POSITIVE_INFINITY
  const lastActionAgo = status.lastActionAt ? now - status.lastActionAt : Number.POSITIVE_INFINITY
  const lastProgressAgo = status.lastProgressAt ? now - status.lastProgressAt : Math.min(lastMoveAgo, lastActionAgo)
  const lastWorkAgo = status.lastWorkAt ? now - status.lastWorkAt : Math.min(lastMoveAgo, lastActionAgo, lastProgressAgo)

  const hasRecentMovement = status.moving || lastMoveAgo <= 3500
  const hasRecentAction = lastActionAgo <= 5000
  const hasRecentProgress = lastProgressAgo <= 6000
  const hasRecentWork = lastWorkAgo <= 6000

  // 快速路径检查
  if (STARTUP_STATES.has(status.state) && age <= 8000) return 'starting'
  if (ACTION_STATES.has(status.state) && (hasRecentAction || hasRecentProgress)) return 'working'
  if (RECOVERY_STATES.has(status.state) && (hasRecentMovement || hasRecentProgress || age <= 3000)) return 'working'
  if (status.state === 'success' && hasRecentWork) return 'working'

  const hasTarget = !!(status.currentAction || status.targetAction || status.zoneFocusAction)
  if ((hasRecentWork || hasRecentProgress) && hasTarget) return 'working'

  const remainingActions = status.remainingActions ?? 0
  if (remainingActions > 0 && WORK_STATES.has(status.state)) return 'working'

  return 'idle'
}

function getDashboardData () {
  const bots = []
  let working = 0
  let idle = 0
  let stale = 0
  let done = 0
  let offline = 0
  let error = 0
  let remainingActions = 0
  let availableActions = 0

  for (const [index, entry] of processes.entries()) {
    const activity = getBotActivityClass(entry)
    const status = entry.status || null
    if (activity === 'working') working++
    else if (activity === 'idle') idle++
    else if (activity === 'stale') stale++
    else if (activity === 'done') done++
    else if (activity === 'error') error++
    else if (activity === 'offline') offline++

    if (status && typeof status.remainingActions === 'number') remainingActions = Math.max(remainingActions, status.remainingActions)
    if (status && typeof status.availableActions === 'number') availableActions += status.availableActions

    bots.push({
      index,
      username: entry.username,
      activity,
      exited: entry.exited,
      exitCode: entry.exitCode,
      signal: entry.signal,
      status,
      lastUpdatedAgoMs: status ? Date.now() - status.updatedAt : null
    })
  }

  bots.sort((left, right) => left.index - right.index)

  return {
    summary: {
      host,
      port,
      botCount,
      useFlight,
      uiPort,
      uiHost,
      alive: getAliveCount(),
      working,
      idle,
      stale,
      done,
      offline,
      error,
      remainingActions,
      availableActions,
      uptimeMs: Date.now() - buildStartedAt,
      updatedAt: Date.now()
    },
    bots
  }
}

function renderDashboardHtml () {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoBuildingMC Dashboard</title>
<style>
body{font-family:Inter,system-ui,sans-serif;background:#0b1020;color:#e8ecf3;margin:0;padding:20px}
h1{margin:0 0 12px;font-size:28px}
.sub{color:#9ca7b8;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.card{background:#141c2f;border:1px solid #24304a;border-radius:12px;padding:14px}
.label{font-size:12px;color:#8fa0b8;margin-bottom:6px}
.value{font-size:26px;font-weight:700}
.table{width:100%;border-collapse:collapse;background:#141c2f;border:1px solid #24304a;border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;border-bottom:1px solid #24304a;text-align:left;font-size:13px;vertical-align:top}
th{color:#93a4bd;background:#11182a;position:sticky;top:0}
.badge{display:inline-block;padding:4px 8px;border-radius:999px;font-size:12px;font-weight:700}
.working{background:#14361f;color:#77f2a8}.idle{background:#3a2d10;color:#ffd46e}.stale{background:#402029;color:#ff93ad}
.done{background:#163247;color:#84d4ff}.offline{background:#2a2f3d;color:#aeb8c9}.error{background:#4b1f1f;color:#ff8f8f}.starting{background:#23355b;color:#9cc0ff}
small{color:#9ca7b8}
code{font-family:ui-monospace,SFMono-Regular,monospace}
</style>
</head>
<body>
<h1>AutoBuildingMC 系统面板</h1>
<div class="sub" id="subtitle">加载中...</div>
<div class="grid" id="summary"></div>
<table class="table">
<thead><tr><th>Bot</th><th>活动</th><th>阶段</th><th>状态</th><th>剩余</th><th>可用</th><th>位置</th><th>当前动作</th><th>原因</th><th>心跳</th></tr></thead>
<tbody id="bots"></tbody>
</table>
<script>
const fmtMs = (ms) => { if (ms == null) return '-'; const sec = Math.floor(ms / 1000); if (sec < 60) return sec + 's'; const min = Math.floor(sec / 60); const rem = sec % 60; return min + 'm ' + rem + 's' }
const fmtPos = (pos) => pos ? [pos.x, pos.y, pos.z].join(', ') : '-'
const fmtAction = (action) => action && action.pos ? action.type + '@' + action.pos.x + ',' + action.pos.y + ',' + action.pos.z : '-'
const summaryKeys = [['alive', '活跃进程'], ['working', '工作中'], ['idle', '空闲'], ['stale', '失联'], ['done', '完成'], ['remainingActions', '剩余动作'], ['availableActions', '可用动作']]
async function refresh () {
  const res = await fetch('/api/status', { cache: 'no-store' })
  const data = await res.json()
  const s = data.summary
  document.getElementById('subtitle').textContent = s.host + ':' + s.port + ' · bots ' + s.botCount + ' · flight ' + s.useFlight + ' · 运行 ' + fmtMs(s.uptimeMs)
  document.getElementById('summary').innerHTML = summaryKeys.map(function (entry) { const key = entry[0]; const label = entry[1]; return '<div class="card"><div class="label">' + label + '</div><div class="value">' + (s[key] ?? '-') + '</div></div>' }).join('')
  document.getElementById('bots').innerHTML = data.bots.map(function (bot) {
    const st = bot.status || {}
    return '<tr>' +
      '<td><strong>' + bot.username + '</strong><br><small>#' + bot.index + '</small></td>' +
      '<td><span class="badge ' + bot.activity + '">' + bot.activity + '</span></td>' +
      '<td>' + (st.phase || '-') + '</td>' +
      '<td>' + (st.state || '-') + '</td>' +
      '<td>' + (st.remainingActions ?? '-') + '</td>' +
      '<td>' + (st.availableActions ?? '-') + '</td>' +
      '<td><code>' + fmtPos(st.position) + '</code></td>' +
      '<td><code>' + fmtAction(st.currentAction || st.targetAction || st.zoneFocusAction) + '</code></td>' +
      '<td>' + (st.reason || '-') + '</td>' +
      '<td>' + fmtMs(bot.lastUpdatedAgoMs) + '</td>' +
    '</tr>'
  }).join('')
}
refresh().catch(console.error)
setInterval(function () { refresh().catch(console.error) }, 1000)
</script>
</body>
</html>`
}

function startDashboardServer () {
  dashboardServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/api/status') {
      const data = JSON.stringify(getDashboardData())
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(data)
      return
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(renderDashboardHtml())
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  })

  dashboardServer.listen(uiPort, uiHost, () => {
    console.log(`[UI] Dashboard ready at http://${uiHost}:${uiPort}`)
  })
}

function stopDashboardServer () {
  if (!dashboardServer) return
  try {
    dashboardServer.close()
  } catch (e) {}
  dashboardServer = null
}

function startBot (index, retryAttempt = 0) {
  const username = `${usernamePrefix}_${index}`

  const botProcess = spawn('node', [
    path.join(__dirname, 'workerBot.js'),
    host,
    port,
    username,
    index,
    '',
    useFlight.toString(),
    String(process.pid)
  ], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })

  botProcess.on('error', (err) => {
    console.error(`[${username}] 进程错误:`, err.message)
    failedConnections++
  })

  botProcess.on('message', (message) => {
    if (!message || message.type !== 'status' || !message.status) return
    const current = processes.get(index)
    if (!current || current.process !== botProcess) return

    const wasStarting = current.status?.state === 'starting'
    current.status = message.status
    current.lastHeartbeat = Date.now()
    botStates.set(index, message.status)

    // 检测首次成功连接
    if (wasStarting && message.status.state !== 'starting' && message.status.state !== 'offline') {
      successfulConnections++
      connectionRetryCount.delete(index)
      console.log(`[${username}] 成功连接! (${successfulConnections}/${botCount})`)
    }
  })

  botProcess.on('exit', (code, signal) => {
    const current = processes.get(index)

    console.log(`[${username}] 进程退出 (code: ${code}, signal: ${signal})`)

    if (current && current.process === botProcess) {
      current.exited = true
      current.exitCode = code
      current.signal = signal
      current.status = {
        ...(current.status || {}),
        username,
        botIndex: index,
        state: 'offline',
        reason: signal || `exit:${code}`,
        updatedAt: Date.now()
      }
      botStates.set(index, current.status)
    }

    if (!isShuttingDown && code !== 0 && code !== null) {
      const retries = connectionRetryCount.get(index) || 0

      if (retries < MAX_RETRY_ATTEMPTS) {
        connectionRetryCount.set(index, retries + 1)
        // 启动失败时延迟更久再重试
        const delay = 5000 + retries * 3000
        console.log(`[${username}] ${delay / 1000}秒后重启... (重试 ${retries + 1}/${MAX_RETRY_ATTEMPTS})`)
        setTimeout(() => {
          if (!isShuttingDown) startBot(index, retries + 1)
        }, delay)
      } else {
        console.error(`[${username}] 达到最大重试次数，放弃启动`)
        failedConnections++
        connectionRetryCount.delete(index)
      }
    }
  })

  processes.set(index, {
    process: botProcess,
    username,
    index,
    exited: false,
    exitCode: null,
    signal: null,
    status: {
      username,
      botIndex: index,
      state: 'starting',
      phase: 'init',
      reason: 'process-launch',
      updatedAt: Date.now()
    },
    lastHeartbeat: Date.now()
  })
}

// 使用更大的启动间隔避免服务器连接限制
for (let i = 0; i < botCount; i++) {
  setTimeout(() => {
    console.log(`[${i + 1}/${botCount}] 启动机器人: ${usernamePrefix}_${i}`)
    startBot(i)
  }, i * spawnDelay)
}

// 定期报告连接状态
setInterval(() => {
  const alive = getAliveCount()
  const total = botCount
  const retrying = connectionRetryCount.size
  console.log(`[连接状态] 成功: ${successfulConnections} | 存活: ${alive}/${total} | 重试中: ${retrying} | 失败: ${failedConnections}`)
}, 10000)

function shutdown (signal = 'SIGTERM') {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('\n正在关闭所有机器人...')

  if (statusInterval) clearInterval(statusInterval)
  stopDashboardServer()

  for (const entry of processes.values()) {
    const child = entry.process
    try {
      if (child.connected) child.send({ type: 'shutdown', signal })
    } catch (e) {}
  }

  setTimeout(() => {
    for (const entry of processes.values()) {
      const child = entry.process
      try {
        if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGTERM')
      } catch (e) {}
    }
  }, 200)

  setTimeout(() => {
    for (const entry of processes.values()) {
      const child = entry.process
      try {
        if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL')
      } catch (e) {}
    }
    process.exit(0)
  }, 1500)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
process.on('beforeExit', () => shutdown('beforeExit'))
process.on('uncaughtException', (err) => {
  console.error('[multiBuilder] 未捕获异常:', err)
  shutdown('uncaughtException')
})
process.on('unhandledRejection', (err) => {
  console.error('[multiBuilder] 未处理拒绝:', err)
  shutdown('unhandledRejection')
})

statusInterval = setInterval(() => {
  const data = getDashboardData()
  console.log(`\n[状态] 活跃进程: ${data.summary.alive}/${botCount} | 工作中: ${data.summary.working} | 空闲: ${data.summary.idle} | 失联: ${data.summary.stale} | 剩余动作: ${data.summary.remainingActions}`)
}, 15000)

startDashboardServer()
