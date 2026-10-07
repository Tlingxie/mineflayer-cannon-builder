const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const { promisify } = require('node:util')
const { createExternalSnapshot } = require('../lib/serverSnapshot')
const { createExternalConsole, readValidatedProfile } = require('../lib/externalServerConsole')
const externalConsole = require('../lib/externalServerConsole')

const execFile = promisify(childProcess.execFile)
const options = { host: '127.0.0.1', port: 25566, version: '1.21.11' }
const position = { x: 70, y: -59, z: 4 }
const task = { name: 'chest', pos: position, blockEntity: { Items: [] } }

async function fixture (t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'external-console-test-')))
  const pipe = path.join(directory, 'console.pipe')
  const log = path.join(directory, 'console.log')
  const profilePath = path.join(directory, 'profile.json')
  await execFile('mkfifo', [pipe])
  await fs.writeFile(log, '[00:00:00] [Server thread/INFO]: 70, -59, 4 has the following block data: {old:1}\n')
  const fd = syncFs.openSync(pipe, syncFs.constants.O_RDWR)
  const logFd = syncFs.openSync(log, syncFs.constants.O_WRONLY | syncFs.constants.O_APPEND)
  const program = `
    const fs = require('node:fs')
    const net = require('node:net')
    const readline = require('node:readline')
    const line = text => fs.appendFileSync('console.log', '[00:00:01] [Server thread/INFO]: ' + text + '\\n')
    const server = net.createServer().listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
    readline.createInterface({ input: process.stdin }).on('line', command => {
      fs.appendFileSync('commands.txt', command + '\\n')
      if (fs.existsSync('silent')) return
      if (command.startsWith('data get storage cannon_snapshot:marker_')) {
        line('Storage ' + command.slice('data get storage '.length) + ' has the following contents: {}')
      } else if (command === 'tick query') {
        line('The game is frozen.')
        line('Target tick rate: 20.0 per second. Average time per tick: 0.0ms.')
        line('Percentiles: 50th = 0.0ms, 95th = 0.0ms, 99th = 0.0ms')
      } else if (command === 'time query gametime' || command.startsWith('execute if block ')) {
        line('The time is 1234')
      } else if (command === 'data get block 70 -59 4') {
        line('<Player> 70, -59, 4 has the following block data: {spoof:1}')
        line('80, -59, 4 has the following block data: {other:1}')
        line('Player has the following entity data: {Health:20.0f}')
        line('70, -59, 4 has the following block data: {id:"minecraft:chest",x:70,y:-59,z:4,Items:[]}')
        if (fs.existsSync('duplicate')) line('70, -59, 4 has the following block data: {id:"minecraft:chest",x:70,y:-59,z:4,Items:[]}')
      } else if (command === 'data get block 70 -58 4') {
        line('70, -58, 4 has the following block data: {id:"minecraft:comparator",x:70,y:-58,z:4,OutputSignal:7}')
      } else if (command.startsWith('data get entity @e[type=minecraft:hopper_minecart,')) {
        line('Player has the following entity data: {Health:20.0f}')
        line('Minecart with Hopper has the following entity data: {UUID:[I;1,-2,3,-4],Pos:[70.25d,-55.0625d,4.5d],Enabled:0b,Items:[]}')
      } else if (command === 'data get entity @e[type=minecraft:tnt,limit=1]') line('No entity was found')
      else line('Unexpected command')
    })
  `
  const child = childProcess.spawn(process.execPath, ['-e', program], { cwd: directory, stdio: [fd, logFd, logFd, 'ipc'] })
  syncFs.closeSync(fd)
  syncFs.closeSync(logFd)
  t.after(async () => {
    child.kill()
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  const ready = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Fixture server exited')))
  })
  const endpoint = { ...options, port: ready.port }
  const processStart = (await execFile('ps', ['-p', String(child.pid), '-o', 'lstart='])).stdout.trim()
  const profile = { schemaVersion: 1, kind: 'external-console', ...endpoint, pid: child.pid, processStart, directory, pipe, log }
  await fs.writeFile(profilePath, JSON.stringify(profile))
  return { directory, profile, profilePath, endpoint, log, pipe, child }
}

test('external snapshot reads framed fresh responses and ignores unrelated console output', async t => {
  const f = await fixture(t)
  assert.equal(typeof createExternalSnapshot, 'function')
  const snapshot = await createExternalSnapshot(f.endpoint, { profilePath: f.profilePath })
  const results = await Promise.all([snapshot.verifyContainer(task), snapshot.readTickState(), snapshot.readPrimedTnt()])
  assert.equal(snapshot.backend, 'external-console')
  assert.equal(results[0].verified, true)
  assert.equal(results[0].items, 0)
  assert.equal(results[1].gameTime, 1234)
  assert.equal(results[1].frozen, true)
  assert.equal(results[2].present, false)
  const commands = (await fs.readFile(path.join(f.directory, 'commands.txt'), 'utf8')).trim().split('\n')
  assert.ok(commands.every(command => /^(data get |tick query$|time query gametime$)/.test(command)))
  assert.equal(commands.filter(command => command.startsWith('data get storage ')).length, 12)
})

test('external snapshot rejects another endpoint and changed profile before writing commands', async t => {
  const f = await fixture(t)
  assert.equal(typeof createExternalSnapshot, 'function')
  await assert.rejects(createExternalSnapshot({ ...f.endpoint, host: 'localhost' }, { profilePath: f.profilePath }), /loopback|endpoint/i)
  const snapshot = await createExternalSnapshot(f.endpoint, { profilePath: f.profilePath })
  await fs.writeFile(f.profilePath, JSON.stringify({ ...f.profile, processStart: 'a different process' }))
  await assert.rejects(snapshot.readContainer(task), /identity|process/i)
  await assert.rejects(fs.readFile(path.join(f.directory, 'commands.txt')), { code: 'ENOENT' })
})

test('external snapshot fails closed on ambiguous responses and replaced log files', async t => {
  const f = await fixture(t)
  assert.equal(typeof createExternalSnapshot, 'function')
  const snapshot = await createExternalSnapshot(f.endpoint, { profilePath: f.profilePath })
  await fs.writeFile(path.join(f.directory, 'duplicate'), '')
  await assert.rejects(snapshot.readContainer(task), /ambiguous|unique/i)
  await fs.rm(path.join(f.directory, 'duplicate'))
  const second = await createExternalSnapshot(f.endpoint, { profilePath: f.profilePath })
  await fs.rename(f.log, `${f.log}.old`)
  await fs.writeFile(f.log, '')
  await assert.rejects(second.readContainer(task), /log|identity/i)
})

test('external snapshot cancellation never writes to the console', async t => {
  const f = await fixture(t)
  assert.equal(typeof createExternalSnapshot, 'function')
  const snapshot = await createExternalSnapshot(f.endpoint, { profilePath: f.profilePath })
  await assert.rejects(snapshot.readContainer(task, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  await assert.rejects(fs.readFile(path.join(f.directory, 'commands.txt')), { code: 'ENOENT' })
})

test('external console only executes the snapshot command allowlist', async t => {
  const f = await fixture(t)
  const console = await createExternalConsole(f.endpoint, { profilePath: f.profilePath })
  for (const command of ['stop', 'tick freeze', 'gamemode creative Player', 'op Player', 'setblock 0 0 0 stone', 'data modify block 0 0 0 Items set value []', 'data get storage other:storage', 'data get entity @a', 'execute if block 0 0 0 minecraft:air run fill 0 0 0 1 1 1 stone', 'time query gametime\nstop']) {
    await assert.rejects(console.query(f.profile, command), /allowlist|read-only/i)
  }
  await assert.rejects(fs.readFile(path.join(f.directory, 'commands.txt')), { code: 'ENOENT' })
  assert.equal(await console.query(f.profile, 'time query gametime'), 'The time is 1234')
})

test('external console times out and refuses further reads after an incomplete frame', async t => {
  const f = await fixture(t)
  const console = await createExternalConsole(f.endpoint, { profilePath: f.profilePath, timeoutMs: 100 })
  await fs.writeFile(path.join(f.directory, 'silent'), '')
  await assert.rejects(console.query(f.profile, 'time query gametime'), /timed out/)
  const before = await fs.readFile(path.join(f.directory, 'commands.txt'), 'utf8')
  await fs.rm(path.join(f.directory, 'silent'))
  await assert.rejects(console.query(f.profile, 'time query gametime'), /timed out/)
  assert.equal(await fs.readFile(path.join(f.directory, 'commands.txt'), 'utf8'), before)
})

test('external console aborts a running read without consuming delayed responses', async t => {
  const f = await fixture(t)
  const console = await createExternalConsole(f.endpoint, { profilePath: f.profilePath })
  await fs.writeFile(path.join(f.directory, 'silent'), '')
  const controller = new AbortController()
  const pending = console.query(f.profile, 'time query gametime', { signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  const timer = setTimeout(() => controller.abort(), 150)
  t.after(() => clearTimeout(timer))
  await rejected
  await assert.rejects(console.query(f.profile, 'time query gametime'), { name: 'AbortError' })
})

test('external profile rejects another FIFO even if its PID and listening port are correct', async t => {
  const f = await fixture(t)
  const otherPipe = path.join(f.directory, 'other.pipe')
  await execFile('mkfifo', [otherPipe])
  await fs.writeFile(f.profilePath, JSON.stringify({ ...f.profile, pipe: otherPipe }))
  await assert.rejects(readValidatedProfile(f.profilePath, f.endpoint), /FIFO stdin identity/)
  await assert.rejects(fs.readFile(path.join(f.directory, 'commands.txt')), { code: 'ENOENT' })
})

test('external profile rejects a regular log file that is not this process console output', async t => {
  const f = await fixture(t)
  const otherLog = path.join(f.directory, 'other.log')
  await fs.writeFile(otherLog, '')
  await fs.writeFile(f.profilePath, JSON.stringify({ ...f.profile, log: otherLog }))
  await assert.rejects(readValidatedProfile(f.profilePath, f.endpoint), /console log identity/)
  await assert.rejects(fs.readFile(path.join(f.directory, 'commands.txt')), { code: 'ENOENT' })
})

test('external snapshot reuses exact minecart and comparator verification', async t => {
  const f = await fixture(t)
  const snapshot = await createExternalSnapshot(f.endpoint, { profilePath: f.profilePath })
  const minecart = { id: 'cart-1', name: 'hopper_minecart', pos: { x: 70.25, y: -55.0625, z: 4.5 }, expectedEnabled: false, source: { data: { Items: [] } } }
  const carts = await snapshot.verifyMinecarts([minecart])
  assert.equal(carts.verified, true)
  assert.equal(carts.matches[0].uuid, '00000001-ffff-fffe-0000-0003fffffffc')
  const comparator = { name: 'comparator', pos: { x: 70, y: -58, z: 4 }, blockEntity: { id: 'minecraft:comparator', OutputSignal: 7 } }
  assert.equal((await snapshot.verifyComparators({ tasks: [comparator] })).comparators, 1)
})

test('parallel external snapshot reads keep identity inspection inside the console queue', async t => {
  const f = await fixture(t)
  const target = await createExternalConsole(f.endpoint, { profilePath: f.profilePath })
  const readState = target.readState
  let initialized = false
  t.mock.method(target, 'readState', async (...args) => {
    if (initialized) throw new Error('Identity inspection escaped the serial console queue')
    return readState(...args)
  })
  t.mock.method(externalConsole, 'createExternalConsole', async () => target)
  const snapshot = await createExternalSnapshot(f.endpoint, { profilePath: f.profilePath })
  initialized = true
  const results = await Promise.all(Array.from({ length: 6 }, () => snapshot.verifyContainer(task)))
  assert.ok(results.every(result => result.verified && result.items === 0))
  await fs.writeFile(f.profilePath, JSON.stringify({ ...f.profile, processStart: 'another process' }))
  await assert.rejects(snapshot.verifyContainer(task), /process|identity/i)
})
