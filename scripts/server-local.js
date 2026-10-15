#!/usr/bin/env node
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { MAX_BOTS } = require('../lib/buildLimits')

const VERSION = '1.21.4'
const HOST = '127.0.0.1'
const RUNTIME = path.resolve(__dirname, '../.runtime/server')
const STATE = path.join(RUNTIME, 'run.json')
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const rconQueue = new Map()

async function selectPort (candidates) {
  for (const port of candidates) {
    const available = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', error => error.code === 'EADDRINUSE' ? resolve(null) : reject(error))
      server.listen(port, HOST, () => {
        const chosen = server.address().port
        server.close(() => resolve(chosen))
      })
    })
    if (available !== null) return available
  }
  throw new Error(`No free local port: ${candidates.join(', ')}`)
}

function rconPacket (id, type, text) {
  const body = Buffer.from(text)
  const packet = Buffer.alloc(body.length + 14)
  packet.writeInt32LE(body.length + 10, 0)
  packet.writeInt32LE(id, 4)
  packet.writeInt32LE(type, 8)
  body.copy(packet, 12)
  return packet
}

function checkRconSignal (signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('RCON command cancelled'), { name: 'AbortError' })
}

async function acquireRconLock (port, signal) {
  const filename = path.join(os.tmpdir(), `mineflayer-builder-rcon-127.0.0.1-${port}.lock`)
  const token = crypto.randomUUID()
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    checkRconSignal(signal)
    try {
      const handle = await fsp.open(filename, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })) } finally { await handle.close() }
      return async () => {
        const owner = await readJson(filename)
        if (owner?.token === token) await fsp.unlink(filename)
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const owner = await readJson(filename)
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && !isRunning(owner.pid)) await fsp.unlink(filename)
      } catch (readError) {
        if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw new Error(`Timed out waiting for local RCON port ${port}`)
}

async function rconCommand (config, command) {
  checkRconSignal(config.signal)
  const previous = rconQueue.get(config.port) || Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
    checkRconSignal(config.signal)
    const release = await acquireRconLock(config.port, config.signal)
    try {
      checkRconSignal(config.signal)
      return await sendRconCommand(config, command)
    } finally { await release() }
  })
  rconQueue.set(config.port, pending)
  try { return await pending } finally {
    if (rconQueue.get(config.port) === pending) rconQueue.delete(config.port)
  }
}

function sendRconCommand ({ port, password, signal }, command) {
  return new Promise((resolve, reject) => {
    checkRconSignal(signal)
    const socket = net.createConnection({ host: HOST, port })
    let buffer = Buffer.alloc(0)
    const output = []
    let complete = false
    let markerSent = false
    function finish (error) {
      if (complete) return
      complete = true
      signal?.removeEventListener('abort', cancel)
      socket.destroy()
      if (error) reject(error)
      else resolve(Buffer.concat(output).toString('utf8'))
    }
    const cancel = () => finish(signal.reason || Object.assign(new Error('RCON command cancelled'), { name: 'AbortError' }))
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) return cancel()
    socket.setTimeout(10000, () => finish(new Error('RCON timed out')))
    socket.on('error', finish)
    socket.on('close', () => finish(new Error('RCON closed before command response')))
    socket.on('connect', () => { if (!complete) socket.write(rconPacket(1, 3, password)) })
    socket.on('data', bytes => {
      if (complete) return
      buffer = Buffer.concat([buffer, bytes])
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0)
        if (size < 10 || size > 1048576) return finish(new Error('Invalid RCON packet size'))
        if (buffer.length < size + 4) return
        const packet = buffer.subarray(0, size + 4)
        buffer = buffer.subarray(size + 4)
        const id = packet.readInt32LE(4)
        const type = packet.readInt32LE(8)
        if (id === -1) return finish(new Error('RCON authentication failed'))
        if (id === 1 && type === 2) {
          if (signal?.aborted) return cancel()
          socket.write(rconPacket(2, 2, command))
        } else if (id === 2) {
          output.push(packet.subarray(12, size + 2))
          // Vanilla rejects coalesced requests; send the marker only after a response.
          if (!markerSent) {
            markerSent = true
            socket.write(rconPacket(3, 2, '__builder_response_end__'))
          }
        } else if (id === 3) return finish()
      }
    })
  })
}

function offlineUuid (name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function readJson (file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function saveJson (file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

async function fetchJson (url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`)
  return response.json()
}

async function downloadServer () {
  const jar = path.join(RUNTIME, `minecraft_server.${VERSION}.jar`)
  let metadata = await readJson(path.join(RUNTIME, 'download.json'))
  if (metadata?.version === VERSION && fs.existsSync(jar)) {
    const hash = crypto.createHash('sha1').update(await fsp.readFile(jar)).digest('hex')
    if (hash === metadata.sha1) return jar
    throw new Error(`Cached server checksum mismatch: ${jar}`)
  }
  const manifest = await fetchJson(MANIFEST)
  const release = manifest.versions.find(item => item.id === VERSION)
  if (!release) throw new Error(`Version ${VERSION} missing from official Mojang manifest`)
  const version = await fetchJson(release.url)
  metadata = { version: VERSION, manifest: MANIFEST, metadataUrl: release.url, ...version.downloads.server }
  const response = await fetch(metadata.url, { signal: AbortSignal.timeout(180000) })
  if (!response.ok) throw new Error(`Server download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = crypto.createHash('sha1').update(bytes).digest('hex')
  if (actual !== metadata.sha1 || bytes.length !== metadata.size) throw new Error('Official server download failed integrity verification')
  await fsp.writeFile(`${jar}.partial`, bytes)
  await fsp.rename(`${jar}.partial`, jar)
  await saveJson(path.join(RUNTIME, 'download.json'), metadata)
  return jar
}

function isRunning (pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function visibleState (state, extra = {}) {
  const { password, ...publicState } = state
  return { ...publicState, ...extra }
}

async function commandForState (state, command) {
  return rconCommand({ port: state.rconPort, password: state.password }, command)
}

async function queryConstructionFrozen (state) {
  const result = await commandForState(state, 'tick query')
  if (result.includes('The game is frozen')) return true
  if (/The game is (running|sprinting)/.test(result)) return false
  return null
}

async function runningState (state, extra = {}) {
  const [players, constructionFrozen] = await Promise.all([commandForState(state, 'list'), queryConstructionFrozen(state)])
  return visibleState(state, { running: true, players, constructionFrozen, ...extra })
}

async function initializeServer (state, stateFile = STATE) {
  if (state.initialized) return
  await commandForState(state, 'tick freeze')
  if (await queryConstructionFrozen(state) !== true) throw new Error('Managed construction server did not confirm frozen ticks')
  const commands = ['gamerule doMobSpawning false', 'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule randomTickSpeed 0', 'gamerule spawnChunkRadius 0', 'gamerule sendCommandFeedback false', 'gamerule logAdminCommands false', 'time set day', 'weather clear', 'setworldspawn 0 -60 0']
  for (const command of commands) await commandForState(state, command)
  state.initialized = true
  state.constructionFrozen = true
  await saveJson(stateFile, state)
}

async function startServer (args) {
  await fsp.mkdir(RUNTIME, { recursive: true, mode: 0o700 })
  const previous = await readJson(STATE)
  if (previous && previous.version !== VERSION) throw new Error('Refusing to change the version of an existing managed world')
  if (!previous && fs.existsSync(path.join(RUNTIME, 'world'))) throw new Error('Unmanaged world exists in runtime directory; choose a clean checkout')
  if (previous && isRunning(previous.pid)) {
    await initializeServer(previous)
    return runningState(previous, { reused: true })
  }
  const eula = path.join(RUNTIME, 'eula.txt')
  const accepted = fs.existsSync(eula) && /^eula=true$/m.test(await fsp.readFile(eula, 'utf8'))
  if (!accepted && !args.includes('--accept-eula')) {
    throw new Error('First launch requires --accept-eula. Review https://aka.ms/MinecraftEULA before accepting.')
  }
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' })
  const major = Number(`${java.stdout || ''}${java.stderr || ''}`.match(/version "(\d+)/)?.[1])
  if (java.status !== 0 || major < 21 || !Number.isFinite(major)) throw new Error('Java 21 or newer is required on PATH')
  const port = await selectPort(previous ? [previous.port] : [25565, 25566])
  const rconPort = await selectPort(previous ? [previous.rconPort] : [port + 10, port + 20])
  const jar = await downloadServer()
  const password = previous?.password || crypto.randomBytes(24).toString('hex')
  const properties = {
    'server-ip': HOST,
    'server-port': port,
    'online-mode': false,
    'enforce-secure-profile': false,
    'max-players': 128,
    gamemode: 'creative',
    'force-gamemode': true,
    difficulty: 'peaceful',
    'level-name': 'world',
    'level-type': 'minecraft:flat',
    'generator-settings': JSON.stringify({ biome: 'minecraft:plains', features: false, lakes: false, layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:dirt', height: 2 }, { block: 'minecraft:grass_block', height: 1 }], structure_overrides: [] }),
    'generate-structures': false,
    'allow-flight': true,
    'allow-nether': true,
    'spawn-protection': 0,
    'spawn-animals': false,
    'spawn-monsters': false,
    'spawn-npcs': false,
    'view-distance': 4,
    'simulation-distance': 4,
    'entity-broadcast-range-percentage': 50,
    'network-compression-threshold': 256,
    'enable-rcon': true,
    'rcon.port': rconPort,
    'rcon.password': password,
    'broadcast-rcon-to-ops': false,
    'broadcast-console-to-ops': false,
    'op-permission-level': 4,
    'enable-command-block': false,
    'sync-chunk-writes': false,
    'max-tick-time': 60000,
    'player-idle-timeout': 0,
    'pause-when-empty-seconds': -1,
    'rate-limit': 0,
    motd: 'Local Mineflayer construction | 1.21.4'
  }
  await fsp.writeFile(eula, '# Accepted explicitly by the local server launcher. https://aka.ms/MinecraftEULA\neula=true\n')
  await fsp.writeFile(path.join(RUNTIME, 'server.properties'), Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
  const ops = await readJson(path.join(RUNTIME, 'ops.json')) || []
  for (let i = 0; i < MAX_BOTS; i++) {
    const name = `builder${String(i).padStart(2, '0')}`
    if (!ops.some(op => op.name === name)) ops.push({ uuid: offlineUuid(name), name, level: 4, bypassesPlayerLimit: true })
  }
  await saveJson(path.join(RUNTIME, 'ops.json'), ops)
  const logFile = path.join(RUNTIME, 'server.log')
  const log = fs.openSync(logFile, 'a')
  const offset = fs.fstatSync(log).size
  const child = spawn('java', ['-Xms512M', '-Xmx2G', '-XX:ActiveProcessorCount=4', '-Dio.netty.eventLoopThreads=4', '-jar', jar, 'nogui'], { cwd: RUNTIME, detached: true, stdio: ['ignore', log, log] })
  child.unref()
  fs.closeSync(log)
  const state = { version: VERSION, host: HOST, port, rconPort, pid: child.pid, directory: RUNTIME, logFile, startedAt: new Date().toISOString(), password }
  await saveJson(STATE, state)
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (!isRunning(state.pid)) throw new Error(`Server exited during startup. See ${logFile}`)
    const output = (await fsp.readFile(logFile)).subarray(offset).toString('utf8')
    if (output.includes('Done (')) {
      try {
        await initializeServer(state)
        return runningState(state)
      } catch (error) {
        if (error.code !== 'ECONNREFUSED') throw error
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`Server startup timed out. See ${logFile}`)
}

async function runAction () {
  const [action = 'status', ...args] = process.argv.slice(2)
  if (action === 'start') console.log(JSON.stringify(await startServer(args), null, 2))
  else if (action === 'status') {
    const state = await readJson(STATE)
    if (!state) return console.log(JSON.stringify({ running: false, directory: RUNTIME }))
    const running = isRunning(state.pid)
    console.log(JSON.stringify(running ? await runningState(state) : visibleState(state, { running, players: null, constructionFrozen: null }), null, 2))
  } else if (action === 'command' || action === 'stop') {
    const state = await readJson(STATE)
    if (!state || !isRunning(state.pid)) throw new Error('Managed server is not running')
    const command = action === 'stop' ? 'stop' : args.join(' ')
    if (!command) throw new Error('Supply a Minecraft command after command')
    if (action === 'stop') await commandForState(state, 'save-all flush')
    try { console.log(await commandForState(state, command)) } catch (error) {
      if (action !== 'stop' || !error.message.includes('closed before')) throw error
    }
  } else throw new Error('Usage: node scripts/server-local.js start [--accept-eula] | status | command <command> | stop')
}

async function main () {
  return require('../lib/serverOperationLock').withServerOperation(runAction)
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { selectPort, rconCommand, offlineUuid, initializeServer, queryConstructionFrozen }
