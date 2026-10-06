const test = require('node:test')
const assert = require('node:assert/strict')

let LayerScheduler
try {
  ({ LayerScheduler } = require('../lib/layerScheduler'))
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}

const task = (id, y = 0, x = id) => ({ id, pos: { x, y, z: 0 }, state: 1 })
const worker = id => ({ id, position: { x: id, y: 0, z: 0 } })
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let complete
  const promise = new Promise(resolve => { complete = resolve })
  return { promise, resolve: complete }
}
const dependencyError = () => Object.assign(new Error('Waiting for current-layer support'), { code: 'LAYER_DEPENDENCY_PENDING' })

function scheduler (options = {}) {
  assert.equal(typeof LayerScheduler, 'function', 'LayerScheduler must be implemented')
  return new LayerScheduler({
    tasks: [],
    workers: [worker(0)],
    execute: async () => true,
    verifyLayer: async () => [],
    ...options
  })
}

test('runs 30 workers concurrently with exclusive task and worker ownership', async () => {
  const gate = deferred()
  const started = deferred()
  const activeWorkers = new Set()
  const activeTasks = new Set()
  const seen = new Set()
  let peak = 0
  const job = scheduler({
    tasks: Array.from({ length: 60 }, (_, i) => task(i)),
    workers: Array.from({ length: 30 }, (_, i) => worker(i)),
    execute: async (bot, action) => {
      assert.equal(activeWorkers.has(bot.id), false)
      assert.equal(activeTasks.has(action.id), false)
      activeWorkers.add(bot.id)
      activeTasks.add(action.id)
      peak = Math.max(peak, activeWorkers.size)
      if (activeWorkers.size === 30) started.resolve()
      await gate.promise
      seen.add(action.id)
      activeWorkers.delete(bot.id)
      activeTasks.delete(action.id)
      return true
    }
  })
  const running = job.run()
  await started.promise
  assert.equal(peak, 30)
  gate.resolve()
  const result = await running
  assert.equal(seen.size, 60)
  assert.equal(result.completed, 60)
  assert.equal(result.layersCompleted, 1)
  assert.equal(result.attempts, 60)
})

test('support dependency chains longer than the failure budget complete without consuming it', async () => {
  const complete = new Set()
  const count = 60
  const job = scheduler({
    tasks: Array.from({ length: count }, (_, i) => task(i)),
    maxAttempts: 1,
    execute: async (bot, action) => {
      if (action.id < count - 1 && !complete.has(action.id + 1)) throw dependencyError()
      complete.add(action.id)
      return true
    }
  })
  const result = await job.run()
  assert.equal(result.completed, count)
  assert.ok(result.attempts > count)
  assert.ok([...job.records.values()].every(record => record.attempts === 1))
})

test('a fully deferred layer fails after bounded propagation retries without dispatching a higher layer', async () => {
  const starts = []
  const job = scheduler({
    tasks: [task(0), task(1), task(2, 1)],
    workers: [worker(0), worker(1)],
    execute: async (bot, action) => { starts.push(action.id); throw dependencyError() }
  })
  await assert.rejects(job.run(), error => error.code === 'LAYER_DEPENDENCY_DEADLOCK')
  assert.deepEqual([...new Set(starts)].sort(), [0, 1])
  assert.ok(starts.length <= 14)
})

test('waits for another worker to observe the acknowledged support before declaring deadlock', async () => {
  let visible = false
  let timer
  const events = []
  const job = scheduler({
    tasks: [task(0), task(1), task(2, 1)],
    maxAttempts: 1,
    onEvent: event => events.push(event),
    execute: async (bot, action) => {
      if (action.id === 0) timer = setTimeout(() => { visible = true }, 75)
      if (action.id === 1 && !visible) throw dependencyError()
      if (action.id === 2) assert.equal(visible, true)
      return true
    }
  })
  try {
    const result = await job.run()
    assert.equal(result.completed, 3)
    assert.ok(events.some(event => event.type === 'dependency-wait'))
    assert.equal(job.records.get(1).attempts, 1)
  } finally { clearTimeout(timer) }
})

test('cancellation interrupts a support propagation wait before retrying or advancing', async () => {
  const controller = new AbortController()
  const starts = []
  const job = scheduler({
    tasks: [task(0), task(1, 1)],
    signal: controller.signal,
    execute: async (bot, action) => { starts.push(action.id); throw dependencyError() },
    onEvent: event => {
      if (event.type === 'dependency-wait') controller.abort(new Error('Cancelled propagation wait'))
    }
  })
  await assert.rejects(job.run(), error => error.name === 'AbortError')
  assert.deepEqual(starts, [0])
})

test('a deferred dependency does not exempt ordinary failures from their attempt limit', async () => {
  let failed = 0
  const job = scheduler({
    tasks: [task(0), task(1)],
    maxAttempts: 2,
    execute: async (bot, action) => {
      if (action.id === 0) throw dependencyError()
      failed++
      return false
    }
  })
  await assert.rejects(job.run(), error => error.code === 'LAYER_ATTEMPT_LIMIT')
  assert.equal(failed, 2)
})

test('waits for the slow worker and full verification before starting the next layer', async () => {
  const slow = deferred()
  const verifying = deferred()
  const verified = deferred()
  const events = []
  const starts = []
  let inFlight = 0
  const job = scheduler({
    tasks: [task(2, 2), task(0, -1), task(1, -1)],
    workers: [worker(0), worker(1)],
    onEvent: event => events.push(event),
    execute: async (bot, action) => {
      starts.push(action.pos.y)
      inFlight++
      if (action.id === 1) await slow.promise
      inFlight--
      return true
    },
    verifyLayer: async y => {
      assert.equal(inFlight, 0)
      if (y === -1) {
        verifying.resolve()
        await verified.promise
      }
      return []
    }
  })
  const running = job.run()
  await nextTurn()
  assert.deepEqual(starts, [-1, -1])
  assert.equal(events.some(event => event.type === 'layer-complete'), false)
  slow.resolve()
  await verifying.promise
  assert.deepEqual(starts, [-1, -1])
  verified.resolve()
  await running
  assert.deepEqual(starts, [-1, -1, 2])
  const firstComplete = events.findIndex(event => event.type === 'layer-complete' && event.layer === -1)
  const nextStart = events.findIndex(event => event.type === 'layer-start' && event.layer === 2)
  assert.ok(firstComplete >= 0 && firstComplete < nextStart)
})

test('defers failed tasks behind untouched tasks and retries only within the current layer', async () => {
  const order = []
  const job = scheduler({
    tasks: [task(0), task(1), task(2, 1)],
    execute: async (bot, action) => {
      order.push(action.id)
      return action.id !== 0 || order.filter(id => id === 0).length > 1
    }
  })
  await job.run()
  assert.deepEqual(order, [0, 1, 0, 2])
})

test('retries failed verification before advancing and accounts for its attempts', async () => {
  const order = []
  let checks = 0
  const job = scheduler({
    tasks: [task(0), task(1, 1)],
    execute: async (bot, action) => { order.push(action.id); return true },
    verifyLayer: async (y, tasks) => y === 0 && checks++ === 0 ? tasks : []
  })
  const result = await job.run()
  assert.deepEqual(order, [0, 0, 1])
  assert.equal(result.attempts, 3)
  assert.equal(result.completed, 2)
})

test('fails at the attempt limit without starting a higher layer', async () => {
  const order = []
  const job = scheduler({
    tasks: [task(0), task(1, 1)],
    maxAttempts: 2,
    execute: async (bot, action) => { order.push(action.id); return false }
  })
  await assert.rejects(job.run(), /attempt|limit/i)
  assert.deepEqual(order, [0, 0])
})

test('verification retries respect the same attempt limit', async () => {
  const order = []
  const events = []
  const job = scheduler({
    tasks: [task(0), task(1, 1)],
    maxAttempts: 2,
    onEvent: event => events.push(event),
    execute: async (bot, action) => { order.push(action.id); return true },
    verifyLayer: async (y, tasks) => tasks
  })
  await assert.rejects(job.run(), /attempt|limit/i)
  assert.deepEqual(order, [0, 0])
  assert.equal(events.at(-1).remaining, 1)
})

test('abort prevents new dispatch and waits for in-flight work to terminate', async () => {
  const controller = new AbortController()
  const gate = deferred()
  const order = []
  const executionSignals = []
  let settled = false
  const job = scheduler({
    tasks: [task(0), task(1), task(2), task(3, 1)],
    workers: [worker(0), worker(1)],
    signal: controller.signal,
    execute: async (bot, action, { signal }) => {
      order.push(action.id)
      executionSignals.push(signal)
      await gate.promise
      return true
    }
  })
  const running = job.run()
  const rejection = assert.rejects(running, { name: 'AbortError' }).then(() => { settled = true })
  await nextTurn()
  controller.abort()
  await nextTurn()
  assert.equal(order.length, 2)
  assert.equal(executionSignals.every(signal => signal.aborted), true)
  assert.equal(settled, false)
  gate.resolve()
  await rejection
  assert.equal(order.length, 2)
})

test('hard failure aborts and drains other workers before rejecting', async () => {
  const gate = deferred()
  let siblingSignal
  let settled = false
  const job = scheduler({
    tasks: [task(0), task(1), task(2, 1)],
    workers: [worker(0), worker(1)],
    maxAttempts: 1,
    execute: async (bot, action, { signal }) => {
      if (action.id === 0) return false
      siblingSignal = signal
      await gate.promise
      return true
    }
  })
  const rejection = assert.rejects(job.run(), /attempt|limit/i).then(() => { settled = true })
  await nextTurn()
  assert.equal(siblingSignal.aborted, true)
  assert.equal(settled, false)
  gate.resolve()
  await rejection
})

test('verification errors stop the build before the next layer', async () => {
  const order = []
  const job = scheduler({
    tasks: [task(0), task(1, 1)],
    execute: async (bot, action) => { order.push(action.id); return true },
    verifyLayer: async () => { throw new Error('world unavailable') }
  })
  await assert.rejects(job.run(), /world unavailable/)
  assert.deepEqual(order, [0])
})

test('treats execution exceptions and non-boolean truthy returns as failures', async () => {
  let attempts = 0
  const job = scheduler({
    tasks: [task(0)],
    execute: async () => {
      attempts++
      if (attempts === 1) throw new Error('temporary placement failure')
      return attempts === 2 ? 'retry' : true
    }
  })
  assert.equal((await job.run()).attempts, 3)
})

test('selects nearby tasks using the current worker position', async () => {
  const order = []
  const job = scheduler({
    tasks: [task(0, 0, 90), task(1, 0, 1)],
    execute: async (bot, action) => { order.push(action.id); return true }
  })
  await job.run()
  assert.deepEqual(order, [1, 0])
})

test('rejects duplicate positions and ids before any tasks can compete', () => {
  assert.throws(() => scheduler({ tasks: [task(0, 0, 1), task(1, 0, 1)] }), /duplicate.*(position|coordinate)/i)
  assert.throws(() => scheduler({ tasks: [task(0), task(0, 1)] }), /duplicate.*id/i)
})

test('rejects invalid coordinates and an empty worker pool', () => {
  for (const y of [NaN, Infinity, 0.5, undefined]) {
    assert.throws(() => scheduler({ tasks: [{ id: 0, pos: { x: 0, y, z: 0 } }] }), /coordinate|integer/i)
  }
  assert.throws(() => scheduler({ workers: [] }), /worker/i)
})

test('empty tasks finish without verification or execution', async () => {
  const result = await scheduler({
    execute: async () => assert.fail('unexpected execution'),
    verifyLayer: async () => assert.fail('unexpected verification')
  }).run()
  assert.deepEqual(result, { total: 0, completed: 0, attempts: 0, layersCompleted: 0 })
})

test('already-aborted runs never dispatch work', async () => {
  const controller = new AbortController()
  controller.abort()
  const job = scheduler({
    tasks: [task(0)],
    signal: controller.signal,
    execute: async () => assert.fail('unexpected execution')
  })
  await assert.rejects(job.run(), { name: 'AbortError' })
})

test('rejects verification output that is not a subset of the current layer', async () => {
  const job = scheduler({
    tasks: [task(0), task(1, 1)],
    verifyLayer: async () => [task(1, 1)]
  })
  await assert.rejects(job.run(), /verification|current layer/i)
})

test('abort during verification waits for verification and prevents layer completion', async () => {
  const controller = new AbortController()
  const checking = deferred()
  const gate = deferred()
  const events = []
  let settled = false
  const job = scheduler({
    tasks: [task(0), task(1, 1)],
    signal: controller.signal,
    onEvent: event => events.push(event),
    verifyLayer: async () => {
      checking.resolve()
      await gate.promise
      return []
    }
  })
  const rejection = assert.rejects(job.run(), { name: 'AbortError' }).then(() => { settled = true })
  await checking.promise
  controller.abort()
  await nextTurn()
  assert.equal(settled, false)
  gate.resolve()
  await rejection
  assert.equal(events.some(event => event.type === 'layer-complete'), false)
  assert.equal(events.filter(event => event.type === 'layer-start').length, 1)
})
