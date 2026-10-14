#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { readPlan } = require('../lib/strictSchematic')
const { prepareExternalWorker } = require('../lib/externalWorkerSetup')
const { createMusicFollowConsole } = require('../lib/musicFollowConsole')

function parseArguments (args) {
  const flags = new Map()
  const allowed = ['--schematic', '--origin', '--host', '--port', '--version', '--server-profile', '--username', '--state-dir']
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]
    if (!allowed.includes(flag) || !value || flags.has(flag)) throw new Error('Invalid or duplicate music follow argument')
    flags.set(flag, value)
  }
  for (const flag of ['--schematic', '--origin', '--server-profile', '--state-dir']) if (!flags.has(flag)) throw new Error(`${flag} is required`)
  for (const flag of ['--schematic', '--server-profile', '--state-dir']) if (!path.isAbsolute(flags.get(flag))) throw new Error(`${flag} requires an absolute path`)
  const origin = flags.get('--origin').split(',')
  if (origin.length !== 3 || !origin.every(value => /^-?[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)))) throw new Error('Invalid music track origin')
  const options = { schematic: flags.get('--schematic'), origin: new Vec3(...origin.map(Number)), host: flags.get('--host') || '127.0.0.1', port: Number(flags.get('--port') || 25566), version: flags.get('--version') || '1.21.11', serverProfile: flags.get('--server-profile'), username: flags.get('--username') || 'MusicFollow', stateDir: flags.get('--state-dir') }
  if (options.host !== '127.0.0.1' || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !/^1\.[0-9]+(?:\.[0-9]+)?$/.test(options.version) || !/^[A-Za-z0-9_]{1,16}$/.test(options.username)) throw new Error('Invalid local server endpoint, version or follower username')
  return options
}

function authenticatedChat (bot, packet) {
  if (typeof packet?.sender !== 'string' || !/^[0-9a-f-]{36}$/i.test(packet.sender) || typeof packet.plainMessage !== 'string' || packet.plainMessage.length > 128 || /[\r\n\0]/.test(packet.plainMessage)) return null
  const matches = Object.entries(bot.players || {}).filter(([name, player]) => /^[A-Za-z0-9_]{1,16}$/.test(name) && player?.username === name && player.uuid?.toLowerCase() === packet.sender.toLowerCase())
  if (matches.length !== 1 || matches[0][0] === bot.username) return null
  return { username: matches[0][0], message: packet.plainMessage }
}

async function acquireLock (directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const filename = path.join(directory, 'process.json')
  let handle
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await fs.open(filename, 'wx', 0o600); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const stat = await fs.lstat(filename)
      const owner = JSON.parse(await fs.readFile(filename, 'utf8'))
      if (!stat.isFile() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid music follow process lock')
      try { process.kill(owner.pid, 0); throw new Error(`Music follower already running as PID ${owner.pid}`) } catch (error) { if (error.code !== 'ESRCH') throw error }
      const current = await fs.lstat(filename)
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('Music follow process lock changed')
      await fs.unlink(filename)
    }
  }
  if (!handle) throw new Error('Music follower already running')
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n')
  const own = await handle.stat()
  await handle.close()
  return async () => {
    try {
      const stat = await fs.lstat(filename)
      if (stat.dev === own.dev && stat.ino === own.ino) await fs.unlink(filename)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

async function stageBot (bot, console, track, timeoutMs = 15000, signal) {
  if (signal?.aborted) throw new Error('Music follower staging aborted')
  await new Promise((resolve, reject) => {
    const finish = error => { cleanup(); if (error) reject(error); else resolve() }
    const timeout = setTimeout(() => finish(new Error('Music follower initial staging timed out')), timeoutMs)
    const cancelled = () => finish(new Error('Music follower staging aborted'))
    const moved = () => {
      if (bot.entity?.position?.distanceTo(track.home) < 0.5) finish()
    }
    function cleanup () { clearTimeout(timeout); bot.off('forcedMove', moved); bot.off('move', moved); signal?.removeEventListener('abort', cancelled) }
    bot.on('forcedMove', moved)
    bot.on('move', moved)
    signal?.addEventListener('abort', cancelled, { once: true })
    Promise.resolve().then(() => console.sendCommand(`tp ${bot.username} ${track.home.x} ${track.home.y} ${track.home.z} -90 20`)).catch(finish)
  })
}

function waitForSpawn (bot, signal) {
  return new Promise((resolve, reject) => {
    const done = error => {
      clearTimeout(timeout)
      for (const [event, handler] of [['spawn', spawned], ['end', ended], ['error', failed]]) bot.off(event, handler)
      signal?.removeEventListener('abort', cancelled)
      if (error) reject(error)
      else resolve()
    }
    const spawned = () => done()
    const ended = () => done(new Error('Music follower disconnected before spawn'))
    const failed = error => done(error)
    const cancelled = () => done(new Error('Music follower connection aborted'))
    const timeout = setTimeout(() => done(new Error('Music follower connection timed out')), 15000)
    bot.on('spawn', spawned)
    bot.on('end', ended)
    bot.on('error', failed)
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
  })
}

async function waitForTrackChunks (bot, track, signal) {
  if (signal?.aborted) throw new Error('Music follower chunk loading aborted')
  await new Promise((resolve, reject) => {
    const done = error => { clearTimeout(timeout); signal?.removeEventListener('abort', cancelled); if (error) reject(error); else resolve() }
    const cancelled = () => done(new Error('Music follower chunk loading aborted'))
    const timeout = setTimeout(() => done(new Error('Music follower initial chunk loading timed out')), 15000)
    signal?.addEventListener('abort', cancelled, { once: true })
    Promise.resolve().then(() => bot.waitForChunksToLoad()).then(() => done(), done)
  })
  if (bot.blockAt(track.button)?.name !== 'stone_button' || bot.blockAt(track.modules[0].pos)?.name !== 'repeater') throw new Error('Music start button or first repeater is missing or not loaded')
}

async function createFollowSession (options, { track, emit, saveStatus, signal, createBot = (...args) => require('mineflayer').createBot(...args), prepare = prepareExternalWorker, console: suppliedConsole, createFollower = (...args) => require('../lib/musicFollower').createMusicFollower(...args), createSpectators = (...args) => require('../lib/musicSpectators').createMusicSpectators(...args) }) {
  if (signal?.aborted) throw new Error('Music follower stopped before connection')
  const console = suppliedConsole || await createMusicFollowConsole(options, { profilePath: options.serverProfile, username: options.username })
  if (signal?.aborted) throw new Error('Music follower stopped before connection')
  const bot = createBot({ host: options.host, port: options.port, version: options.version, username: options.username, auth: 'offline', hideErrors: true })
  let follower, spectators, stepping, saving
  let stopping
  const errors = error => emit({ type: 'music-follow-error', error: error.message })
  bot.on('error', errors)
  const ended = new Promise(resolve => bot.once('end', resolve))
  const stop = () => {
    if (stopping) return stopping
    stopping = (async () => {
      clearInterval(stepping)
      clearInterval(saving)
      follower?.stop()
      bot._client.off('playerChat', chat)
      try { await spectators?.stop() } finally { bot.quit('Music follower stopped') }
    })()
    return stopping
  }
  const status = () => ({ username: options.username, endpoint: `${options.host}:${options.port}`, version: options.version, schematic: options.schematic, origin: options.origin, button: track.button, home: track.home, ...(follower?.status || { phase: 'connecting' }), viewers: spectators?.viewerCount || 0, updatedAt: new Date().toISOString() })
  const chat = packet => {
    const message = authenticatedChat(bot, packet)
    if (!message) return
    if (message.message === '!music status') {
      const current = status()
      bot.chat(`MusicFollow: ${current.phase}, module ${current.moduleIndex ?? -1}/${track.modules.length}; !watch / !unwatch`)
    } else spectators?.handleChat(message.username, message.message).catch(errors)
  }
  try {
    await waitForSpawn(bot, signal)
    if (signal?.aborted) throw new Error('Music follower stopped before preparation')
    await prepare(bot, options, { signal })
    bot.physicsEnabled = false
    await stageBot(bot, console, track, 15000, signal)
    await waitForTrackChunks(bot, track, signal)
    bot._client.write('abilities', { flags: 2 })
    follower = createFollower(bot, track, { onEvent: emit })
    spectators = createSpectators(bot, { sendCommand: command => console.sendCommand(command), capturePosition: username => console.capturePosition(username), onEvent: emit, stateFile: path.join(options.stateDir, 'viewers.json') })
    await spectators.ready
    bot._client.on('playerChat', chat)
    stepping = setInterval(() => { try { follower.step() } catch (error) { errors(error); stop().catch(errors) } }, 50)
    saving = setInterval(() => saveStatus(status()).catch(errors), 1000)
    emit({ type: 'music-follow-ready', username: bot.username, home: track.home, button: track.button, modules: track.modules.length })
    await saveStatus(status())
    return { bot, stop, status, ended }
  } catch (error) { await stop(); throw error }
}

async function main (args = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(args)
  const release = await acquireLock(options.stateDir)
  const abort = new AbortController()
  let session, wake
  let writing = Promise.resolve()
  const eventFile = path.join(options.stateDir, 'events.jsonl')
  const emit = event => {
    const value = { at: new Date().toISOString(), ...event }
    writing = writing.then(() => fs.appendFile(eventFile, JSON.stringify(value) + '\n', { mode: 0o600 })).catch(error => process.stderr.write(error.message + '\n'))
    if (!['music-follow-position', 'music-follow-progress'].includes(event.type)) process.stdout.write(JSON.stringify(value) + '\n')
  }
  let saves = Promise.resolve()
  const saveStatus = value => {
    saves = saves.catch(() => {}).then(async () => {
      const temporary = path.join(options.stateDir, 'status.json.tmp')
      await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
      await fs.rename(temporary, path.join(options.stateDir, 'status.json'))
    })
    return saves
  }
  const shutdown = () => { abort.abort(); wake?.(); session?.stop().catch(error => emit({ type: 'music-follow-shutdown-error', error: error.message })) }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  try {
    const plan = await (dependencies.readPlan || readPlan)(options.schematic, options.version, options.origin)
    const track = (dependencies.musicTrackFromPlan || require('../lib/musicFollower').musicTrackFromPlan)(plan)
    emit({ type: 'music-follow-starting', pid: process.pid, schematic: options.schematic, endpoint: `${options.host}:${options.port}`, origin: options.origin, home: track.home, button: track.button, modules: track.modules.length })
    while (!abort.signal.aborted) {
      try {
        session = await (dependencies.createFollowSession || createFollowSession)(options, { track, emit, saveStatus, signal: abort.signal })
        if (abort.signal.aborted) await session.stop()
        else await session.ended
      } catch (error) {
        emit({ type: 'music-follow-disconnected', error: error.message })
        await saveStatus({ phase: 'disconnected', error: error.message, username: options.username, updatedAt: new Date().toISOString() })
      } finally {
        try { await session?.stop() } catch (error) { emit({ type: 'music-follow-cleanup-error', error: error.message }) }
        session = null
      }
      if (!abort.signal.aborted) await new Promise(resolve => { const timer = setTimeout(resolve, 5000); wake = () => { clearTimeout(timer); resolve() } })
    }
  } finally {
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
    await session?.stop()
    await Promise.all([writing, saves])
    await release()
  }
}

if (require.main === module) main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
module.exports = { parseArguments, authenticatedChat, acquireLock, stageBot, waitForTrackChunks, createFollowSession, main }
