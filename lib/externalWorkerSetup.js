const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')

const identityFields = ['schemaVersion', 'kind', 'host', 'port', 'version', 'pid', 'processStart', 'directory', 'pipe', 'log']

function checkSignal (signal) {
  if (signal?.aborted) throw Object.assign(new Error('External worker preparation cancelled', { cause: signal.reason }), { name: 'AbortError' })
}

function onlineIdentity (bot) {
  const username = bot?.username
  const player = bot?.player
  if (!/^[A-Za-z0-9_]{1,16}$/.test(username || '') || bot._client?.state !== 'play' || bot._client.ended || !bot.entity ||
      player?.username !== username || bot.players?.[username]?.uuid !== player.uuid ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player.uuid || '')) {
    throw new Error('External worker preparation requires the exact online spawned player and UUID')
  }
  return { username, uuid: player.uuid }
}

function sameFifo (expected, actual) {
  return actual.isFIFO() && !actual.isSymbolicLink() && expected.dev === actual.dev && expected.ino === actual.ino
}

async function pause (ms, signal) {
  checkSignal(signal)
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => { try { checkSignal(signal) } catch (error) { finish(error) } }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

async function prepareExternalWorker (bot, options, {
  signal,
  readValidatedProfile = (...args) => require('./externalServerConsole').readValidatedProfile(...args),
  fs: filesystem = fs,
  timeoutMs = 15000,
  pollIntervalMs = 25
} = {}) {
  checkSignal(signal)
  const identity = onlineIdentity(bot)
  if (!options?.serverProfile) throw new Error('External worker preparation requires a server profile')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('Invalid external worker confirmation timeout')
  let disconnected = false
  const ended = () => { disconnected = true }
  const checkWorker = () => {
    checkSignal(signal)
    const current = onlineIdentity(bot)
    if (disconnected || current.username !== identity.username || current.uuid !== identity.uuid) throw new Error('External worker disconnected or changed player identity')
  }
  bot.on('end', ended)
  try {
    const profile = await readValidatedProfile(options.serverProfile, options, { signal })
    checkWorker()
    const expectedFifo = await filesystem.lstat(profile.pipe)
    if (!expectedFifo.isFIFO() || expectedFifo.isSymbolicLink()) throw new Error('External console pipe must be a FIFO, not a symbolic link')
    checkWorker()
    // Nonblocking open rejects an abandoned console; no-follow and inode checks reject replacements.
    const handle = await filesystem.open(profile.pipe, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      if (!sameFifo(expectedFifo, await handle.stat())) throw new Error('External console FIFO identity changed')
      const current = await readValidatedProfile(options.serverProfile, options, { signal })
      if (!identityFields.every(field => current[field] === profile[field])) throw new Error('External server process identity changed')
      if (!sameFifo(expectedFifo, await filesystem.lstat(profile.pipe))) throw new Error('External console FIFO identity changed')
      checkWorker()
      const commands = Buffer.from(`execute if entity @a[name=${identity.username},limit=1] run op ${identity.username}\ngamemode creative @a[name=${identity.username},limit=1]\n`)
      // One write below PIPE_BUF keeps both targeted commands together with concurrent workers.
      const result = await handle.write(commands, 0, commands.length, null)
      if (result.bytesWritten !== commands.length) throw new Error('External console did not accept the complete worker preparation request')
    } finally {
      await handle.close()
    }
    const deadline = Date.now() + timeoutMs
    while (true) {
      checkWorker()
      let operators = []
      try {
        operators = JSON.parse(await filesystem.readFile(path.join(profile.directory, 'ops.json'), { encoding: 'utf8', signal }))
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
      checkWorker()
      if (!Array.isArray(operators)) throw new Error('External server operator confirmation is invalid')
      const operator = operators.find(entry => entry?.name === identity.username && entry.uuid?.toLowerCase() === identity.uuid.toLowerCase() && Number.isInteger(entry.level) && entry.level >= 2)
      if (bot.game?.gameMode === 'creative' && operator) return { ...identity, gameMode: 'creative', operatorLevel: operator.level }
      if (Date.now() >= deadline) throw new Error(`External worker preparation timed out confirming creative mode and operator permission for ${identity.username}`)
      await pause(Math.min(pollIntervalMs, deadline - Date.now()), signal)
    }
  } finally {
    bot.off('end', ended)
  }
}

module.exports = { prepareExternalWorker }
