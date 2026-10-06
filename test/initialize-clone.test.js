const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

function implementation () {
  let result
  try { result = require('../scripts/initialize-clone') } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  assert.ok(result, 'Guarded clone initialization is implemented')
  return result
}

function harness ({ tntAt = Infinity, malformedAt = Infinity, lostStep = false } = {}) {
  const state = { kind: 'initialization-clone', version: '1.21.4', host: '127.0.0.1', port: 25567, rconPort: 25577, directory: path.resolve(__dirname, '../.runtime/clones/run-test'), password: 'fixture-secret', pid: 12345, startedAt: 'fixture', initialized: true, pendingStep: null }
  const commands = []
  const saves = []
  const records = []
  let ticks = 0
  const options = {
    wait: async () => {},
    saveState: async value => saves.push(JSON.parse(JSON.stringify(value))),
    record: async event => records.push(event),
    command: async command => {
      commands.push(command)
      if (command === 'tick query' || command === 'tick freeze') return 'The game is frozen'
      if (command === 'tick step stop') return 'No tick step in progress'
      if (command === 'time query gametime') return `The time is ${100 + ticks}`
      if (command === 'forceload add 64 0 127 47') return 'Marked 12 chunks in minecraft:overworld from [4, 0] to [7, 2] to be force loaded'
      if (command.startsWith('forceload query ')) {
        const [, , x, z] = command.split(' ').map((part, index) => index < 2 ? part : Number(part))
        return `Chunk at [${x / 16}, ${z / 16}] in minecraft:overworld is marked for force loading`
      }
      if (command.startsWith('execute if loaded ')) return 'Test passed'
      if (command === 'data get entity @e[type=minecraft:tnt,limit=1]') {
        if (ticks >= malformedAt) return 'Malformed reply'
        return ticks >= tntAt ? 'TNT has the following entity data: {fuse:80s}' : 'No entity was found'
      }
      if (command === 'tick step 1') {
        assert.ok(saves.at(-1).pendingStep, 'Tick command must follow the durable pendingStep')
        assert.ok(saves.at(-1).initialization.pendingTick, 'TNT guard intent must be durable')
        assert.equal(records.some(record => record.type === 'tick-intent' && record.index === ticks + 1), true)
        ticks++
        if (lostStep) throw new Error('Lost tick reply fixture-secret')
        return 'Stepping 1 tick(s)'
      }
      throw new Error(`Unexpected command ${command}`)
    }
  }
  return { state, options, commands, saves, records }
}

test('initialization loads exactly the cannon chunks while frozen and brackets each single tick with TNT reads', async () => {
  const { initializeClone } = implementation()
  const h = harness()
  const result = await initializeClone(h.state, 2, h.options)
  assert.equal(result.completedTicks, 2)
  assert.equal(h.state.initialization.completedTicks, 2)
  assert.equal(h.state.pendingStep, null)
  assert.equal(h.state.initialization.pendingTick, null)
  assert.equal(h.commands.filter(command => command === 'tick step 1').length, 2)
  assert.equal(h.commands.filter(command => command.startsWith('forceload add')).length, 1)
  assert.equal(h.commands.filter(command => command.startsWith('forceload query')).length, 12)
  assert.equal(h.commands.filter(command => command.startsWith('data get entity')).length, 4)
  assert.equal(h.commands[0], 'tick query')
  const steps = h.commands.flatMap((command, index) => command === 'tick step 1' ? [index] : [])
  const reads = h.commands.flatMap((command, index) => command.startsWith('data get entity') ? [index] : [])
  assert.ok(reads[0] < steps[0] && steps[0] < reads[1] && reads[1] < reads[2] && reads[2] < steps[1] && steps[1] < reads[3])
  assert.equal(h.records.filter(record => record.type === 'tick-result').length, 2)
  assert.equal(JSON.stringify(h.records).includes(h.state.password), false)
})

test('initialization rejects invalid counts and the main server without issuing commands', async () => {
  const { initializeClone } = implementation()
  for (const count of [0, 513, -1, 1.5, NaN, '2']) {
    const h = harness()
    await assert.rejects(initializeClone(h.state, count, h.options), /1.*512/)
    assert.deepEqual(h.commands, [])
  }
  const h = harness()
  h.state.port = 25566
  await assert.rejects(initializeClone(h.state, 1, h.options), /clone state/i)
  assert.deepEqual(h.commands, [])
})

test('preexisting TNT stops initialization without requesting any tick or killing entities', async () => {
  const { initializeClone } = implementation()
  const h = harness({ tntAt: 0 })
  await assert.rejects(initializeClone(h.state, 2, h.options), /primed TNT/)
  assert.equal(h.commands.some(command => /^tick step \d/.test(command)), false)
  assert.equal(h.commands.some(command => command.startsWith('kill ')), false)
  assert.equal(h.state.initialization.halted.code, 'PRIMED_TNT')
})

test('TNT after one tick halts the batch and retains the pending guard until explicit inspection', async () => {
  const { initializeClone } = implementation()
  const h = harness({ tntAt: 1 })
  await assert.rejects(initializeClone(h.state, 10, h.options), /primed TNT/)
  assert.equal(h.commands.filter(command => command === 'tick step 1').length, 1)
  assert.equal(h.state.pendingStep.awaitingTntCheck, true)
  assert.ok(h.saves.at(-1).pendingStep)
  assert.ok(h.state.initialization.pendingTick)
  assert.equal(h.records.some(record => record.type === 'tick-result'), false)
  const before = h.commands.length
  await assert.rejects(initializeClone(h.state, 1, h.options), /pending|halted/i)
  assert.equal(h.commands.length, before)
})

test('unparseable post-tick TNT reads cannot clear pending state or request another tick', async () => {
  const { initializeClone } = implementation()
  const h = harness({ malformedAt: 1 })
  await assert.rejects(initializeClone(h.state, 3, h.options), /TNT.*response/)
  assert.equal(h.commands.filter(command => command === 'tick step 1').length, 1)
  assert.ok(h.state.pendingStep)
  assert.ok(h.state.initialization.pendingTick)
  assert.equal(h.state.initialization.halted.code, 'TNT_READ_INVALID')
})

test('lost step replies retain the original pending step and redact credentials from all evidence', async () => {
  const { initializeClone } = implementation()
  const h = harness({ lostStep: true })
  await assert.rejects(initializeClone(h.state, 2, h.options), error => /Lost tick reply/.test(error.message) && !error.message.includes(h.state.password))
  assert.equal(h.commands.filter(command => command === 'tick step 1').length, 1)
  assert.equal(h.state.pendingStep.ticks, 1)
  assert.equal(h.commands.includes('tick freeze'), true)
  assert.equal(JSON.stringify(h.records).includes(h.state.password), false)
  assert.ok(h.saves.at(-1).pendingStep)
})

test('a running or previously pending clone is rejected without loading or advancing the machine', async () => {
  const { initializeClone } = implementation()
  const h = harness()
  const command = h.options.command
  h.options.command = async text => text === 'tick query' ? 'The game is running normally' : command(text)
  await assert.rejects(initializeClone(h.state, 1, h.options), /frozen/)
  assert.deepEqual(h.commands, ['tick freeze', 'tick step stop'])
  const pending = harness()
  pending.state.pendingStep = { before: 100, ticks: 1, target: 101 }
  await assert.rejects(initializeClone(pending.state, 1, pending.options), /Pending/)
  assert.deepEqual(pending.commands, [])
  assert.equal(pending.state.pendingStep.target, 101)
})

test('a failed durable tick-intent write stops before dispatching the tick', async () => {
  const { initializeClone } = implementation()
  const h = harness()
  const record = h.options.record
  h.options.record = async event => {
    if (event.type === 'tick-intent') throw new Error('Evidence disk full')
    return record(event)
  }
  await assert.rejects(initializeClone(h.state, 1, h.options), /disk full/)
  assert.equal(h.commands.includes('tick step 1'), false)
  assert.ok(h.saves.at(-1).initialization.pendingTick)
})

test('cancellation after a tick preserves its TNT guard and requests no following tick', async () => {
  const { initializeClone } = implementation()
  const h = harness()
  const controller = new AbortController()
  const record = h.options.record
  h.options.record = async event => {
    await record(event)
    if (event.type === 'tick-state' && event.pendingStep?.awaitingTntCheck) controller.abort(new Error('Stop requested'))
  }
  await assert.rejects(initializeClone(h.state, 2, { ...h.options, signal: controller.signal }), /Stop requested/)
  assert.equal(h.commands.filter(command => command === 'tick step 1').length, 1)
  assert.ok(h.state.pendingStep)
  assert.ok(h.state.initialization.pendingTick)
})

test('a later successful batch accumulates exact ticks without repeating earlier requests', async () => {
  const { initializeClone } = implementation()
  const h = harness()
  await initializeClone(h.state, 2, h.options)
  const result = await initializeClone(h.state, 1, h.options)
  assert.equal(result.completedTicks, 1)
  assert.equal(result.totalTicks, 3)
  assert.equal(h.commands.filter(command => command === 'tick step 1').length, 3)
  assert.deepEqual(h.records.filter(record => record.type === 'tick-result').map(record => record.index), [1, 2, 3])
})

test('cancellation while persisting a step command intent prevents that command from being sent', async () => {
  const { initializeClone } = implementation()
  const h = harness()
  const controller = new AbortController()
  const record = h.options.record
  h.options.record = async event => {
    await record(event)
    if (event.type === 'command-intent' && event.command === 'tick step 1') controller.abort(new Error('Cancelled during intent write'))
  }
  await assert.rejects(initializeClone(h.state, 1, { ...h.options, signal: controller.signal }), /Cancelled during intent write/)
  assert.equal(h.commands.includes('tick step 1'), false)
  assert.ok(h.state.pendingStep)
})

test('cancellation while persisting the final tick result cannot report successful initialization', async () => {
  const { initializeClone } = implementation()
  const h = harness()
  const controller = new AbortController()
  const record = h.options.record
  h.options.record = async event => {
    await record(event)
    if (event.type === 'tick-result') controller.abort(new Error('Cancelled while recording result'))
  }
  await assert.rejects(initializeClone(h.state, 1, { ...h.options, signal: controller.signal }), /Cancelled while recording result/)
  assert.ok(h.state.pendingStep)
  assert.equal(h.records.some(event => event.type === 'initialization-complete'), false)
})

test('an existing live step is stopped and initialization refuses to load the cannon', async () => {
  const { initializeClone } = implementation()
  const h = harness()
  const command = h.options.command
  let stopCount = 0
  h.options.command = async text => {
    if (text === 'tick step stop' && ++stopCount === 1) { h.commands.push(text); return 'Interrupted the current tick step' }
    return command(text)
  }
  await assert.rejects(initializeClone(h.state, 1, h.options), /existing.*step|step.*progress/i)
  assert.equal(h.commands.some(text => text.startsWith('forceload')), false)
  assert.equal(h.commands.includes('tick step 1'), false)
  assert.equal(h.commands.includes('tick freeze'), true)
})
