const { Vec3 } = require('vec3')

const key = pos => `${pos.x},${pos.y},${pos.z}`
const powered = block => ['true', '1'].includes(String(block?.getProperties?.().powered))

function musicTrackFromPlan (plan) {
  if (!plan?.music) throw new Error('Music follower requires a generated music schematic')
  const width = plan.max.x - plan.min.x
  if (width <= 2 || (width - 2) % 4 || plan.max.y - plan.min.y !== 5 || plan.max.z - plan.min.z !== 29) throw new Error('Unsupported music track dimensions')
  const Block = require('prismarine-block')(plan.version)
  const byPosition = new Map(plan.tasks.map(task => [key(task.pos), task]))
  const button = plan.min.offset(1, 4, 14)
  if (byPosition.get(key(button))?.name !== 'stone_button') throw new Error('Music track start button is missing')
  const modules = []
  for (let index = 0; index < (width - 2) / 4; index++) {
    const pos = plan.min.offset(2 + 4 * index, 3, 14)
    const task = byPosition.get(key(pos))
    if (task?.name !== 'repeater') throw new Error(`Music module ${index} repeater is missing`)
    const properties = Block.fromStateId(task.state, 0).getProperties()
    if (properties.facing !== 'west' || ![1, 2, 3, 4].includes(Number(properties.delay))) throw new Error(`Music module ${index} has an unsupported repeater`)
    modules.push({ pos, delay: Number(properties.delay) })
  }
  return {
    button,
    home: plan.min.offset(1.5, 8, 18.5),
    modules,
    notes: new Set(plan.tasks.filter(task => task.name === 'note_block').map(task => key(task.pos)))
  }
}

function createMusicFollower (bot, track, { onEvent = () => {}, now = Date.now } = {}) {
  if (!track?.modules?.length || !bot?.entity?.position) throw new Error('Music follower requires a spawned bot and track modules')
  const indices = new Map(track.modules.map((module, index) => [key(module.pos), index]))
  let phase = 'idle'
  let moduleIndex = -1
  let runs = 0
  let notesHeard = 0
  let lastSignalAt = 0
  let finishedAt = 0
  let lastStepAt = now()
  let target = track.home.clone()
  let blocked = false

  const emit = (type, details = {}) => onEvent({ type, at: now(), run: runs, moduleIndex, ...details })
  const fault = reason => { phase = 'fault'; emit('music-follow-fault', { reason }) }

  function blockUpdate (oldBlock, block) {
    if (phase === 'stopped' || phase === 'fault' || !block?.position) return
    const id = key(block.position)
    const isButton = id === key(track.button)
    const index = indices.get(id)
    if (!isButton && index === undefined) return
    if (block.name !== (isButton ? 'stone_button' : 'repeater')) {
      fault(`Track changed at ${id}`)
      return
    }
    // Chunk snapshots and falling edges must not start or advance a playback.
    if (!oldBlock || oldBlock.name !== block.name || powered(oldBlock) || !powered(block)) return
    if (isButton) {
      if (phase !== 'idle') { emit('music-follow-button-ignored', { phase }); return }
      phase = 'playing'
      moduleIndex = -1
      notesHeard = 0
      finishedAt = 0
      lastSignalAt = now()
      runs++
      emit('music-follow-started')
      return
    }
    if (!['playing', 'stalled'].includes(phase) || index <= moduleIndex) return
    moduleIndex = index
    lastSignalAt = now()
    phase = 'playing'
    if (index === track.modules.length - 1) finishedAt = now() + 1000
    emit('music-follow-progress', { x: block.position.x, modules: track.modules.length })
  }

  function noteHeard (block) {
    if (!['playing', 'stalled'].includes(phase) || !block?.position || !track.notes?.has(key(block.position))) return
    notesHeard++
  }

  function step () {
    const time = now()
    const seconds = Math.max(0, Math.min(0.05, (time - lastStepAt) / 1000))
    lastStepAt = time
    if (['stopped', 'fault', 'idle'].includes(phase)) return
    if (finishedAt && time >= finishedAt && phase !== 'returning') {
      phase = 'returning'
      emit('music-follow-finished', { notesHeard })
    }
    if (phase === 'returning') target = track.home.clone()
    else {
      if (time - lastSignalAt > 15000 && phase !== 'stalled') {
        phase = 'stalled'
        emit('music-follow-stalled')
      }
      const current = moduleIndex < 0 ? track.button : track.modules[moduleIndex].pos
      const next = track.modules[moduleIndex + 1]
      // Interpolate only as far as the next repeater. A stopped signal never
      // becomes a wall-clock journey through the rest of the song.
      const fraction = next ? Math.max(0, Math.min(1, (time - lastSignalAt) / (next.delay * 100))) : 0
      const x = current.x + 0.5 + (next ? (next.pos.x - current.x) * fraction : 0)
      target = new Vec3(x, track.home.y, track.home.z)
    }
    const position = bot.entity?.position
    if (!position) return
    const delta = target.minus(position)
    const distance = delta.norm()
    const destination = distance <= 48 * seconds ? target.clone() : position.plus(delta.scaled(48 * seconds / distance))
    const clear = pos => {
      const block = bot.blockAt(pos)
      return block && Array.isArray(block.shapes) && block.shapes.length === 0
    }
    if (!clear(destination) || !clear(destination.offset(0, 1.7, 0))) {
      if (!blocked) emit('music-follow-flight-blocked', { position: destination })
      blocked = true
      return
    }
    blocked = false
    bot.entity.velocity?.set(0, 0, 0)
    bot.entity.position = destination
    bot.entity.onGround = false
    bot.entity.yaw = phase === 'returning' ? Math.PI / 2 : -1.1
    bot.entity.pitch = -0.55
    if (phase === 'returning' && destination.distanceTo(track.home) < 0.01) {
      phase = 'idle'
      finishedAt = 0
      emit('music-follow-ready')
    }
  }

  function stop () {
    phase = 'stopped'
    bot.off('blockUpdate', blockUpdate)
    bot.off('noteHeard', noteHeard)
  }

  bot.on('blockUpdate', blockUpdate)
  bot.on('noteHeard', noteHeard)
  return {
    step,
    stop,
    get status () {
      return { phase, moduleIndex, modules: track.modules.length, runs, notesHeard, lastSignalAt, blocked, position: bot.entity?.position, target }
    }
  }
}

module.exports = { musicTrackFromPlan, createMusicFollower }
