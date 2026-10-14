const fs = require('node:fs')
const path = require('node:path')

const playerName = /^[A-Za-z0-9_]{1,16}$/
const playerUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const gameModes = ['survival', 'creative', 'adventure', 'spectator']
const dimensions = ['overworld', 'the_nether', 'the_end']

function modeName (value) {
  return Number.isInteger(value) ? gameModes[value] : gameModes.includes(value) ? value : undefined
}

function returnPosition (value) {
  const dimension = typeof value?.dimension === 'string' ? value.dimension.replace(/^minecraft:/, '') : ''
  if (!dimensions.includes(dimension) || !['x', 'y', 'z', 'yaw', 'pitch'].every(key => Number.isFinite(value?.[key])) || Math.abs(value.x) > 29999984 || Math.abs(value.z) > 29999984 || Math.abs(value.y) > 2048 || Math.abs(value.pitch) > 90) throw new Error('Invalid music spectator return position')
  return { x: value.x, y: value.y, z: value.z, yaw: value.yaw, pitch: value.pitch, dimension }
}

function commandNumber (value) {
  const decimal = value.toFixed(12).replace(/\.?0+$/, '')
  return decimal === '-0' ? '0' : decimal
}

function createMusicSpectators (bot, { sendCommand, capturePosition, onEvent = () => {}, stateFile } = {}) {
  if (!playerName.test(bot?.username) || typeof bot.on !== 'function' || typeof sendCommand !== 'function') throw new Error('Music spectators require a valid bot and command sender')
  const viewers = new Map()
  let stopped = false
  let stopping
  let queue = Promise.resolve()

  const onlinePlayer = username => {
    if (typeof username !== 'string' || !playerName.test(username) || username === bot.username || !Object.hasOwn(bot.players || {}, username)) return null
    const player = bot.players[username]
    return player?.username === username && playerUuid.test(player.uuid) ? player : null
  }
  const samePlayer = viewer => onlinePlayer(viewer.username)?.uuid.toLowerCase() === viewer.uuid
  const viewerCount = () => [...viewers.values()].filter(viewer => viewer.status === 'watching' && samePlayer(viewer)).length
  const emit = event => {
    try { onEvent({ ...event, viewerCount: viewerCount() }) } catch {}
  }
  const persist = () => {
    if (!stateFile) return
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    const temporary = `${stateFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, viewers: [...viewers.values()] }, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, stateFile)
  }
  if (stateFile && fs.existsSync(stateFile)) {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (saved.version !== 1 || !Array.isArray(saved.viewers)) throw new Error('Invalid music spectator recovery state')
    for (const viewer of saved.viewers) {
      if (!viewer || !playerName.test(viewer.username) || viewer.username === bot.username || !playerUuid.test(viewer.uuid) || !gameModes.includes(viewer.mode) || !['watching', 'restore'].includes(viewer.status) || viewers.has(viewer.uuid.toLowerCase())) throw new Error('Invalid music spectator recovery entry')
      viewers.set(viewer.uuid.toLowerCase(), { username: viewer.username, uuid: viewer.uuid.toLowerCase(), mode: viewer.mode, status: viewer.status, ...(viewer.returnPosition ? { returnPosition: returnPosition(viewer.returnPosition) } : {}) })
    }
  }
  const enqueue = operation => {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  const sendFor = async (viewer, command) => {
    if (!samePlayer(viewer)) throw new Error(`Music spectator is no longer online: ${viewer.username}`)
    await sendCommand(command)
  }
  const restore = async viewer => {
    viewer.status = 'restore'
    persist()
    if (!samePlayer(viewer)) return false
    const errors = []
    if (modeName(onlinePlayer(viewer.username).gamemode ?? onlinePlayer(viewer.username).gameMode) === 'spectator') {
      try { await sendFor(viewer, `execute as ${viewer.username} run spectate`) } catch (error) { errors.push(error) }
    }
    if (viewer.returnPosition) {
      const { x, y, z, yaw, pitch, dimension } = viewer.returnPosition
      // A player must stay in spectator mode if returning to safety failed.
      const coordinates = [x, y, z, yaw, pitch].map(commandNumber).join(' ')
      try { await sendFor(viewer, `execute in minecraft:${dimension} run tp ${viewer.username} ${coordinates}`) } catch (error) {
        throw new AggregateError([...errors, error], `Music spectator return failed: ${error.message}`)
      }
    }
    try { await sendFor(viewer, `gamemode ${viewer.mode} ${viewer.username}`) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, `Music spectator recovery failed: ${errors.map(error => error.message).join('; ')}`)
    viewers.delete(viewer.uuid)
    persist()
    emit({ type: 'music-spectator-stopped', username: viewer.username })
    return true
  }
  const attach = async viewer => {
    viewer.status = 'watching'
    persist()
    try {
      await sendFor(viewer, `gamemode spectator ${viewer.username}`)
      await sendFor(viewer, `spectate ${bot.username} ${viewer.username}`)
      emit({ type: 'music-spectator-started', username: viewer.username })
    } catch (error) {
      try { await restore(viewer) } catch (recoveryError) { error.recoveryError = recoveryError }
      emit({ type: 'music-spectator-error', username: viewer.username, error: error.message })
      throw error
    }
  }
  const recoverPlayer = async username => {
    const player = onlinePlayer(username)
    if (!player) return
    const viewer = viewers.get(player.uuid.toLowerCase())
    if (!viewer) return
    viewer.username = username
    if (viewer.status === 'restore') await restore(viewer)
    else await attach(viewer)
  }
  const joined = player => {
    if (stopped || !player) return
    enqueue(() => recoverPlayer(player.username)).catch(error => emit({ type: 'music-spectator-error', username: player.username, error: error.message }))
  }
  bot.on('playerJoined', joined)
  const ready = enqueue(async () => {
    for (const username of Object.keys(bot.players || {})) await recoverPlayer(username)
  })

  return {
    ready,
    idle: () => queue,
    get viewerCount () { return viewerCount() },
    handleChat (username, message) {
      if (stopped || typeof message !== 'string' || !['!watch', '!unwatch'].includes(message.trim()) || !onlinePlayer(username)) return Promise.resolve(false)
      const requestUuid = onlinePlayer(username).uuid.toLowerCase()
      return enqueue(async () => {
        const player = onlinePlayer(username)
        if (stopped || !player || player.uuid.toLowerCase() !== requestUuid) return false
        const existing = viewers.get(requestUuid)
        if (message.trim() === '!unwatch') {
          if (existing) await restore(existing)
          return true
        }
        if (existing?.status === 'watching') return true
        const mode = existing?.mode || modeName(player.gamemode ?? player.gameMode)
        if (!mode) throw new Error(`Cannot recover unknown game mode for ${username}`)
        let position
        if (!existing) {
          if (typeof capturePosition !== 'function') throw new Error('Music spectators require position capture before watching')
          position = returnPosition(await capturePosition(username))
          if (onlinePlayer(username)?.uuid.toLowerCase() !== requestUuid) return false
        }
        const viewer = existing || { username, uuid: requestUuid, mode, status: 'watching', returnPosition: position }
        viewer.username = username
        viewers.set(requestUuid, viewer)
        await attach(viewer)
        return true
      })
    },
    stop () {
      if (stopping) return stopping
      stopped = true
      bot.removeListener('playerJoined', joined)
      stopping = enqueue(async () => {
        const errors = []
        for (const viewer of [...viewers.values()]) {
          try { await restore(viewer) } catch (error) { errors.push(error) }
        }
        if (errors.length) throw new AggregateError(errors, 'Music spectator shutdown recovery failed')
      })
      return stopping
    }
  }
}

module.exports = { createMusicSpectators }
