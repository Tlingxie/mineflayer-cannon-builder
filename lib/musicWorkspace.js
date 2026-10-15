const { Vec3 } = require('vec3')
const { setTimeout: wait } = require('node:timers/promises')

function checkSignal (signal) {
  if (signal?.aborted) throw Object.assign(new Error(signal.reason?.message || 'Music workspace cancelled'), { name: 'AbortError' })
}

function createMusicWorkspace (plan, workers, { viewDistance = 4, loadTimeoutMs = 10000, onEvent = () => {} } = {}) {
  const width = plan.max.x - plan.min.x
  if (!plan.music || width <= 128) return null
  if (!workers?.length) throw new Error('Long music construction requires bots')
  if (!Number.isInteger(viewDistance) || viewDistance < 2 || !Number.isFinite(loadTimeoutMs) || loadTimeoutMs < 0) throw new Error('Invalid music workspace coverage settings')
  const moduleCount = Math.ceil((width - 2) / 4)
  const homeY = plan.max.y + 3
  const homes = new Map()
  const ownerByModule = new Uint16Array(moduleCount)
  for (let index = 0; index < workers.length; index++) {
    const firstModule = Math.floor(index * moduleCount / workers.length)
    const endModule = Math.floor((index + 1) * moduleCount / workers.length)
    const start = index === 0 ? plan.min.x : plan.min.x + 2 + firstModule * 4
    const end = index === workers.length - 1 ? plan.max.x : plan.min.x + 2 + endModule * 4
    homes.set(workers[index].id, new Vec3(Math.floor((start + end) / 2) + 0.5, homeY, Math.floor((plan.min.z + plan.max.z) / 2) + 0.5))
    ownerByModule.fill(index, firstModule, endModule)
  }
  const ownerIndex = pos => ownerByModule[Math.min(moduleCount - 1, Math.max(0, Math.floor((pos.x - plan.min.x - 2) / 4)))]
  const ownerForTask = task => workers[ownerIndex(task.pos)].id
  const nearby = workers.map((_, index) => workers.map((worker, candidate) => ({ worker, distance: Math.abs(candidate - index) })).sort((a, b) => a.distance - b.distance).map(row => row.worker))
  const inRange = (feet, chunkX, chunkZ) => Math.max(Math.abs(Math.floor(feet.x / 16) - chunkX), Math.abs(Math.floor(feet.z / 16) - chunkZ)) <= viewDistance
  const columns = []
  for (let chunkX = Math.floor(plan.min.x / 16); chunkX <= Math.floor((plan.max.x - 1) / 16); chunkX++) {
    for (let chunkZ = Math.floor(plan.min.z / 16); chunkZ <= Math.floor((plan.max.z - 1) / 16); chunkZ++) {
      if (!workers.some(worker => inRange(homes.get(worker.id), chunkX, chunkZ))) throw new Error('Long music track exceeds bot chunk coverage; use more bots (需要更多 bot 覆盖整条轨道)')
      columns.push({ x: chunkX, z: chunkZ })
    }
  }
  const loaded = (worker, x, z) => inRange(worker.position, x, z) && Boolean(worker.bot.world?.getColumn?.(x, z))
  const readBlock = pos => {
    const chunkX = Math.floor(pos.x / 16)
    const chunkZ = Math.floor(pos.z / 16)
    for (const worker of nearby[ownerIndex(pos)]) {
      if (!loaded(worker, chunkX, chunkZ)) continue
      const block = worker.bot.blockAt(pos)
      if (block) return block
    }
    return null
  }
  const moveTo = async (worker, target, signal) => {
    while (worker.position.distanceTo(target) > 0.15) {
      checkSignal(signal)
      const previous = worker.position.clone()
      const delta = target.minus(previous)
      const distance = delta.norm()
      const destination = distance <= 8 ? target.clone() : previous.plus(delta.scaled(8 / distance))
      await worker.executor.move(destination, signal)
      checkSignal(signal)
      await worker.bot.waitForChunksToLoad()
      checkSignal(signal)
      if (worker.position.distanceTo(previous) < 0.01) throw new Error(`Music workspace flight made no progress: ${worker.id}`)
    }
  }
  const travel = async (worker, destination, signal) => {
    checkSignal(signal)
    if (worker.executor.busy || worker.executor.deadline) throw new Error(`Music workspace cannot move a busy placement owner: ${worker.id}`)
    await worker.bot.waitForChunksToLoad()
    const longDistance = Math.hypot(worker.position.x - destination.x, worker.position.z - destination.z) > 128
    const altitude = Math.max(worker.position.y, destination.y, longDistance ? Math.min(300, Math.max(200, homeY + 128)) : -Infinity)
    await moveTo(worker, new Vec3(worker.position.x, altitude, worker.position.z), signal)
    await moveTo(worker, new Vec3(destination.x, altitude, destination.z), signal)
    const overlaps = worker.executor.pathing?.collisionOverlaps(destination)
    if (overlaps?.size) {
      const message = `音乐工地集结位置被实体方块占据：${worker.id}，目标 (${destination.x}, ${destination.y}, ${destination.z})，Y=${destination.y}；蓝图最低 Y=${plan.min.y}。请选择已清空且可飞入的空地，并把原点 Y 设在地表上方。`
      onEvent({ type: 'music-travel-blocked', code: 'TARGET_BLOCKED', workerId: worker.id, position: worker.position.clone(), destination: destination.clone(), minimumY: plan.min.y })
      throw Object.assign(new Error(message), { code: 'TARGET_BLOCKED' })
    }
    await moveTo(worker, destination, signal)
  }
  const parkForRead = async ({ signal, reason = 'verification' } = {}) => {
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let firstError
    try {
      const results = await Promise.allSettled(workers.map(async worker => {
        try { await travel(worker, homes.get(worker.id), controller.signal) } catch (error) {
          if (!firstError && !controller.signal.aborted) { firstError = error; controller.abort(error) }
          throw error
        }
      }))
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected) throw firstError || controller.signal.reason || rejected.reason
      checkSignal(controller.signal)
      const deadline = Date.now() + loadTimeoutMs
      while (true) {
        checkSignal(controller.signal)
        const missing = columns.find(column => !workers.some(worker => loaded(worker, column.x, column.z)))
        if (!missing) break
        if (Date.now() >= deadline) throw new Error(`Music workspace chunk not loaded at ${missing.x},${missing.z}; refusing verification`)
        await wait(25, undefined, { signal: controller.signal })
      }
      onEvent({ type: 'music-workspace-ready', reason, columns: columns.length, homes: [...homes].map(([workerId, pos]) => ({ workerId, pos })) })
    } finally { signal?.removeEventListener('abort', abort) }
  }
  const approachTask = async (worker, task, { signal } = {}) => {
    if (worker.id !== ownerForTask(task)) throw new Error(`Music task owner mismatch: ${worker.id}`)
    const destination = new Vec3(task.pos.x + 0.5, task.pos.y + 2.2, task.pos.z + 0.5)
    if (worker.position.distanceTo(destination) > 4) await travel(worker, destination, signal)
    checkSignal(signal)
    const chunkX = Math.floor(task.pos.x / 16)
    const chunkZ = Math.floor(task.pos.z / 16)
    if (!loaded(worker, chunkX, chunkZ) || !worker.bot.blockAt(task.pos)) throw new Error(`Music target chunk not loaded for owner ${worker.id}`)
  }
  return { ownerForTask, readBlock, parkForRead, approachTask, homes }
}

module.exports = { createMusicWorkspace }
