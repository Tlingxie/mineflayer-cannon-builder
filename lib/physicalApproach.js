function check (signal) {
  if (!signal?.aborted) return
  const error = new Error(signal.reason?.message || 'Physical approach cancelled')
  error.name = 'AbortError'
  throw error
}

async function approachGoal (worker, goal, pos, { signal } = {}) {
  const { executor, bot } = worker
  const position = () => worker.position || bot.entity.position
  check(signal)
  const eyeHeight = bot.entity?.eyeHeight || 1.62
  if (goal.getFaceAndRef(position().offset(0, eyeHeight, 0))) return
  if (position().distanceTo(pos) <= 8 || !executor.pathing || !executor.move) return
  const candidates = []
  const add = feet => {
    if (executor.pathing.positionClear(feet) && goal.getFaceAndRef(feet.offset(0, eyeHeight, 0))) candidates.push(feet)
  }
  const delta = position().minus(pos)
  const distance = delta.norm()
  for (const radius of [16, 12, 8]) {
    add(pos.plus(delta.scaled(radius / distance)))
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) add(pos.offset(x * radius, y * radius, z * radius))
  }
  for (let y = -3; y <= 3; y++) {
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        const feet = pos.offset(x + 0.5, y + 0.1, z + 0.5)
        add(feet)
      }
    }
  }
  candidates.sort((a, b) => a.distanceTo(position()) - b.distanceTo(position()))
  let lastError
  for (const candidate of candidates.slice(0, 8)) {
    check(signal)
    const route = executor.pathing.findFlightPath(position(), candidate, 2, 8000)
    if (!route) continue
    try {
      for (const point of route) {
        while (position().distanceTo(point) > 0.15) {
          check(signal)
          const previous = position().clone()
          const delta = point.minus(previous)
          const distance = delta.norm()
          const destination = distance <= 8 ? point.clone() : previous.plus(delta.scaled(8 / distance))
          await executor.move(destination, signal)
          check(signal)
          if (bot.waitForChunksToLoad) await bot.waitForChunksToLoad()
          check(signal)
          if (position().distanceTo(previous) < 0.01) throw new Error('Physical approach made no progress')
        }
      }
      return
    } catch (error) {
      check(signal)
      lastError = error
    }
  }
  throw lastError || new Error(`No collision-free long-distance approach to ${pos}`)
}

module.exports = { approachGoal }
