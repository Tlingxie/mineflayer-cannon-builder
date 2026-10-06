const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const server = require('../scripts/server-local')
const { createCloneSnapshot } = require('../lib/serverSnapshot')

const frozen = 'The game is frozen\nTarget tick rate: 20.0 per second.'
function comparator (x, output) {
  return { id: `${x},-33,27`, name: 'comparator', pos: { x, y: -33, z: 27 }, blockEntity: { id: 'minecraft:comparator', x: 1, y: 2, z: 3, OutputSignal: output } }
}
function response (task, patch = {}) {
  const data = { id: 'minecraft:comparator', ...task.pos, OutputSignal: task.blockEntity.OutputSignal, ...patch }
  return `${task.pos.x}, ${task.pos.y}, ${task.pos.z} has the following block data: ${JSON.stringify(data)}`
}
function fixture (t, respond) {
  const root = path.resolve(__dirname, '../.runtime/clones')
  const state = { kind: 'initialization-clone', host: '127.0.0.1', port: 25567, version: '1.21.4', rconPort: 25577, password: 'comparator-secret', pid: process.pid, startedAt: '2026-10-03T01:02:03.000Z', directory: path.join(root, 'run-comparator-test') }
  const commands = []
  t.mock.method(fs, 'readFile', async filename => { assert.equal(filename, path.join(root, 'run.json')); return JSON.stringify(state) })
  t.mock.method(server, 'rconCommand', async (credentials, command) => {
    assert.deepEqual(credentials, { port: 25577, password: state.password })
    commands.push(command)
    const result = respond?.(command)
    return result === undefined ? (command === 'tick query' ? frozen : 'The time is 100') : result
  })
  return { state, commands }
}

test('comparator verification covers every source target including zero with frozen evidence around the entire batch', async t => {
  const tasks = [comparator(87, 0), comparator(88, 9), comparator(89, 15)]
  const f = fixture(t, command => {
    if (command.startsWith('data get block ')) return response(tasks.find(task => command === `data get block ${task.pos.x} -33 27`))
  })
  const snapshot = await createCloneSnapshot()
  assert.equal(typeof snapshot.verifyComparators, 'function')
  const result = await snapshot.verifyComparators({ tasks: [{ id: 'stone', name: 'stone' }, ...tasks] })
  assert.equal(result.verified, true)
  assert.equal(result.comparators, 3)
  assert.deepEqual(result.matches.map(match => match.id), tasks.map(task => task.id))
  assert.deepEqual(result.matches.map(match => match.outputSignal), [0, 9, 15])
  assert.deepEqual(result.verifiedProperties, ['id', 'position', 'OutputSignal'])
  assert.equal(result.tickState.before.gameTime, result.tickState.after.gameTime)
  assert.equal(result.evidence.length, 11)
  assert.equal(f.commands.filter(command => command.startsWith('data get block')).length, 3)
  assert.ok(f.commands.every(command => /^(data get block |tick query$|time query gametime$)/.test(command)))
  assert.equal(JSON.stringify(result).includes(f.state.password), false)
})

test('all valid output mismatches are reported after checking the last target and preserving quiescence evidence', async t => {
  const tasks = [comparator(87, 9), comparator(88, 1)]
  const f = fixture(t, command => {
    if (command.startsWith('data get block ')) {
      const task = tasks.find(task => command === `data get block ${task.pos.x} -33 27`)
      return response(task, { OutputSignal: task.pos.x === 87 ? 10 : 0 })
    }
  })
  const snapshot = await createCloneSnapshot()
  await assert.rejects(snapshot.verifyComparators({ tasks }), error => {
    assert.match(error.message, /OutputSignal/)
    assert.deepEqual(error.mismatches.map(item => item.id), tasks.map(task => task.id))
    assert.equal(error.checked, 2)
    assert.equal(error.evidence.length, 10)
    return true
  })
  assert.equal(f.commands.at(-1), 'tick query')
})

test('invalid source outputs, source type, duplicate coordinates and missing plan are rejected before commands', async t => {
  const f = fixture(t)
  const snapshot = await createCloneSnapshot()
  for (const value of [undefined, -1, 16, 1.5, '1', null]) {
    await assert.rejects(snapshot.verifyComparators({ tasks: [comparator(87, value)] }), /source.*OutputSignal/i)
  }
  await assert.rejects(snapshot.verifyComparators({ tasks: [{ ...comparator(87, 1), blockEntity: { id: 'minecraft:chest', OutputSignal: 1 } }] }), /source.*identity/i)
  await assert.rejects(snapshot.verifyComparators({ tasks: [comparator(87, 1), comparator(87, 1)] }), /Duplicate/)
  await assert.rejects(snapshot.verifyComparators([]), /plan/i)
  assert.deepEqual(f.commands, [])
})

test('readComparator rejects wrong NBT coordinates, identity, absent fields and out-of-range or fractional outputs', async t => {
  const task = comparator(87, 9)
  let current
  fixture(t, command => command.startsWith('data get block ') ? current : undefined)
  const snapshot = await createCloneSnapshot()
  for (const patch of [{ id: 'minecraft:chest' }, { x: 88 }, { OutputSignal: undefined }, { OutputSignal: -1 }, { OutputSignal: 16 }, { OutputSignal: 1.5 }, { OutputSignal: '9' }]) {
    current = response(task, patch)
    await assert.rejects(snapshot.readComparator(task), error => {
      assert.match(error.message, /identity|OutputSignal/)
      assert.ok(error.evidence.some(item => item.command === 'data get block 87 -33 27'))
      return true
    })
  }
  current = 'The target block is not a block entity'
  await assert.rejects(snapshot.readComparator(task), /data response/)
  for (const text of [
    '{id:"minecraft:comparator",x:87,y:-33,z:27,OutputSignal:"9",components:{OutputSignal:9}}',
    '{id:"minecraft:comparator",x:87,y:-33,z:27,OutputSignal:9,OutputSignal:9}',
    '{id:"minecraft:comparator",x:87,y:-33,z:27,OutputSignal:9.0f}'
  ]) {
    current = `87, -33, 27 has the following block data: ${text}`
    await assert.rejects(snapshot.readComparator(task), /OutputSignal/)
  }
})

test('comparator reads stop on changed snapshot identity before any command or before the next target', async t => {
  const tasks = [comparator(87, 9), comparator(88, 1)]
  let mutate = false
  const f = fixture(t, command => {
    if (command.startsWith('data get block ')) { if (mutate) f.state.pid++; return response(tasks[0]) }
  })
  const snapshot = await createCloneSnapshot()
  f.state.startedAt = '2026-10-03T02:00:00.000Z'
  await assert.rejects(snapshot.verifyComparators({ tasks }), /identity changed/)
  assert.deepEqual(f.commands, [])
  f.state.startedAt = '2026-10-03T01:02:03.000Z'
  mutate = true
  await assert.rejects(snapshot.verifyComparators({ tasks }), error => {
    assert.match(error.message, /identity changed/)
    assert.ok(error.evidence.some(item => item.command === 'data get block 87 -33 27'))
    return true
  })
  assert.equal(f.commands.filter(command => command.startsWith('data get block ')).length, 1)
})

test('gametime movement between the comparator batch and final frozen sample prevents verified success', async t => {
  const task = comparator(87, 9)
  let read = false
  fixture(t, command => {
    if (command.startsWith('data get block ')) { read = true; return response(task) }
    if (command === 'time query gametime') return `The time is ${read ? 101 : 100}`
  })
  const snapshot = await createCloneSnapshot()
  await assert.rejects(snapshot.verifyComparators({ tasks: [task] }), /gametime.*changed/i)
})

test('unfrozen or already cancelled comparator verification performs no block reads', async t => {
  const f = fixture(t, () => 'The game is running\nTarget tick rate: 20.0 per second.')
  const snapshot = await createCloneSnapshot()
  await assert.rejects(snapshot.verifyComparators({ tasks: [comparator(87, 9)] }, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.deepEqual(f.commands, [])
  await assert.rejects(snapshot.verifyComparators({ tasks: [comparator(87, 9)] }), /frozen/)
  assert.deepEqual(f.commands, ['tick query'])
})
