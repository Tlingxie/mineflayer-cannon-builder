const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { selectPort, rconCommand, initializeServer, queryConstructionFrozen } = require('../scripts/server-local')

test('chooses an unused port without stopping the existing listener', async (t) => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const occupied = server.address().port
  const selected = await selectPort([occupied, 0])
  assert.notEqual(selected, occupied)
  assert.ok(selected > 0)
  assert.ok(server.listening)
})

function packet (id, type, body) {
  const text = Buffer.from(body)
  const result = Buffer.alloc(text.length + 14)
  result.writeInt32LE(text.length + 10, 0)
  result.writeInt32LE(id, 4)
  result.writeInt32LE(type, 8)
  text.copy(result, 12)
  return result
}

test('authenticates RCON and collects split command output through a response marker', async (t) => {
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0)
    let commandReturned = false
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes])
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0) + 4) {
        const size = pending.readInt32LE(0) + 4
        const frame = pending.subarray(0, size)
        pending = pending.subarray(size)
        const id = frame.readInt32LE(4)
        const type = frame.readInt32LE(8)
        const command = frame.toString('utf8', 12, size - 2)
        if (type === 3) {
          socket.write(packet(id, 2, ''))
        } else if (command === 'list') {
          const reply = Buffer.concat([packet(id, 0, 'There are '), packet(id, 0, '30 players online')])
          socket.write(reply.subarray(0, 7))
          setImmediate(() => {
            commandReturned = true
            socket.write(reply.subarray(7))
          })
        } else {
          if (!commandReturned) return socket.destroy()
          setTimeout(() => socket.write(packet(id, 0, 'Unknown command')), 20)
        }
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const output = await rconCommand({ port: server.address().port, password: 'test-only' }, 'list')
  assert.equal(output, 'There are 30 players online')
})

test('fresh managed initialization freezes before setup and reports live tick state', async (t) => {
  const commands = []
  let frozen = false
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-server-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0)
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes])
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0) + 4) {
        const size = pending.readInt32LE(0) + 4
        const frame = pending.subarray(0, size)
        pending = pending.subarray(size)
        const id = frame.readInt32LE(4)
        if (frame.readInt32LE(8) === 3) socket.write(packet(id, 2, ''))
        else {
          const command = frame.toString('utf8', 12, size - 2)
          if (command !== '__builder_response_end__') commands.push(command)
          if (command === 'tick freeze') frozen = true
          socket.write(packet(id, 0, command === 'tick query' ? (frozen ? 'The game is frozen' : 'The game is running normally') : 'OK'))
        }
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const state = { rconPort: server.address().port, password: 'test-only' }
  const stateFile = path.join(directory, 'run.json')
  await initializeServer(state, stateFile)
  assert.equal(commands[0], 'tick freeze')
  assert.equal(state.initialized, true)
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).constructionFrozen, true)
  assert.equal(await queryConstructionFrozen(state), true)
  frozen = false
  assert.equal(await queryConstructionFrozen(state), false)
  const calls = commands.length
  await initializeServer(state, stateFile)
  assert.equal(commands.length, calls)
})

test('serializes commands sharing one vanilla RCON output buffer', async t => {
  let active = 0
  let peak = 0
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0)
    socket.on('data', bytes => {
      pending = Buffer.concat([pending, bytes])
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0) + 4) {
        const size = pending.readInt32LE(0) + 4
        const frame = pending.subarray(0, size)
        pending = pending.subarray(size)
        const id = frame.readInt32LE(4)
        const command = frame.toString('utf8', 12, size - 2)
        if (frame.readInt32LE(8) === 3) socket.write(packet(id, 2, ''))
        else if (id === 2) {
          active++
          peak = Math.max(peak, active)
          setTimeout(() => socket.write(packet(id, 0, command)), 10)
        } else {
          active--
          socket.write(packet(id, 0, 'marker'))
        }
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const config = { port: server.address().port, password: 'test-only' }
  assert.deepEqual(await Promise.all(['first', 'second', 'third'].map(command => rconCommand(config, command))), ['first', 'second', 'third'])
  assert.equal(peak, 1)
})

test('RCON cancellation during authentication prevents dispatching the command packet', async t => {
  const controller = new AbortController()
  const commands = []
  const server = net.createServer(socket => {
    socket.on('error', error => { assert.equal(error.code, 'ECONNRESET') })
    socket.on('data', bytes => {
      const id = bytes.readInt32LE(4)
      if (bytes.readInt32LE(8) === 3) {
        controller.abort(new Error('cancel during authentication'))
        socket.write(packet(id, 2, ''))
      } else {
        commands.push(bytes.toString('utf8', 12, bytes.length - 2))
        socket.write(packet(id, 0, 'OK'))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  await assert.rejects(rconCommand({ port: server.address().port, password: 'test-only', signal: controller.signal }, 'tick step 1'), /cancel during authentication/)
  assert.deepEqual(commands, [])
})

test('RCON rechecks cancellation after a queued command and sends no cancelled mutation', async t => {
  const controller = new AbortController()
  const commands = []
  const server = net.createServer(socket => {
    socket.on('data', bytes => {
      const id = bytes.readInt32LE(4)
      if (bytes.readInt32LE(8) === 3) socket.write(packet(id, 2, ''))
      else {
        const text = bytes.toString('utf8', 12, bytes.length - 2)
        if (id === 2) {
          commands.push(text)
          if (text === 'list') controller.abort(new Error('cancel while queued'))
        }
        socket.write(packet(id, 0, 'OK'))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const config = { port: server.address().port, password: 'test-only' }
  const first = rconCommand(config, 'list')
  const cancelled = rconCommand({ ...config, signal: controller.signal }, 'tick step 1')
  await assert.rejects(cancelled, /cancel while queued/)
  await first
  assert.deepEqual(commands, ['list'])
})
