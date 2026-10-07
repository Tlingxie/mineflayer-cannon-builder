const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { parseOptions, discoverProfile, attachServer } = require('../scripts/server-attach')

async function fixture (t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'server-attach-test-')))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const pipe = path.join(directory, 'console.pipe')
  const log = path.join(directory, 'console.log')
  const output = path.join(directory, 'profiles', 'server.json')
  await promisify(execFile)('mkfifo', [pipe])
  await fs.writeFile(log, 'private server log; never read or return its contents')
  await fs.mkdir(path.dirname(output))
  await fs.writeFile(output, 'previous output', { mode: 0o644 })
  const options = { host: '127.0.0.1', port: 25566, version: '1.21.11', output }
  const profile = { schemaVersion: 1, kind: 'external-console', host: options.host, port: options.port, version: options.version, pid: 4321, processStart: 'Mon Oct 5 12:34:56 2026', directory, pipe, log }
  const exec = async (command, args) => {
    if (command === 'lsof' && args.includes('-Fp')) return { stdout: 'p4321\np4321\n' }
    if (command === 'lsof' && args.includes('-Ffn')) return { stdout: `p4321\nfcwd\nn${directory}\nf0\nn${pipe}\nf1\nn${log}\nf2\nn/dev/null\n` }
    if (command === 'ps') return { stdout: profile.processStart + '\n' }
    throw new Error('Unexpected process probe')
  }
  const settings = {
    discoverProfile: value => discoverProfile(value, { exec }),
    ping: async () => ({ version: { name: '1.21.11', protocol: 774 } }),
    readValidatedProfile: async (filename, requested) => {
      assert.deepEqual(requested, options)
      assert.notEqual(filename, output)
      assert.equal(await fs.readFile(output, 'utf8'), 'previous output')
      assert.equal((await fs.stat(filename)).mode & 0o777, 0o600)
      const contents = JSON.parse(await fs.readFile(filename, 'utf8'))
      assert.deepEqual(contents, profile)
      return contents
    }
  }
  return { directory, pipe, log, options, profile, exec, settings }
}

test('attach CLI defaults to the requested loopback server and rejects ambiguous targets', () => {
  const defaults = parseOptions([])
  assert.equal(defaults.host, '127.0.0.1')
  assert.equal(defaults.port, 25566)
  assert.equal(defaults.version, '1.21.11')
  assert.ok(defaults.output.endsWith('/.runtime/servers/1.21.11-25566.json'))
  const custom = parseOptions(['--port', '25568', '--output', 'chosen.json'])
  assert.equal(custom.port, 25568)
  assert.equal(custom.output, path.resolve('chosen.json'))
  for (const args of [['--host', 'localhost'], ['--port', '0'], ['--port', '25566junk'], ['--output'], ['--unknown'], ['--version', 'latest']]) {
    assert.throws(() => parseOptions(args), /host|loopback|port|output|unknown|version|value/i)
  }
})

test('discovery derives the exact process identity from unique listener and live descriptors', async t => {
  const f = await fixture(t)
  assert.deepEqual(await discoverProfile(f.options, { exec: f.exec }), f.profile)
})

test('discovery refuses multiple listeners, non-FIFO stdin and no regular console output', async t => {
  const f = await fixture(t)
  await assert.rejects(discoverProfile(f.options, { exec: async () => ({ stdout: 'p4321\np9876\n' }) }), /unique|multiple|one/i)
  await fs.unlink(f.pipe)
  await fs.writeFile(f.pipe, '')
  await assert.rejects(discoverProfile(f.options, { exec: f.exec }), /FIFO|stdin/i)
  await fs.unlink(f.pipe)
  await promisify(execFile)('mkfifo', [f.pipe])
  await fs.unlink(f.log)
  await assert.rejects(discoverProfile(f.options, { exec: f.exec }), /regular|console|log/i)
  assert.equal(await fs.readFile(f.options.output, 'utf8'), 'previous output')
})

test('attach validates a private temporary profile then atomically replaces output with public metadata', async t => {
  const f = await fixture(t)
  const result = await attachServer(f.options, f.settings)
  assert.deepEqual(JSON.parse(await fs.readFile(f.options.output, 'utf8')), f.profile)
  assert.equal((await fs.stat(f.options.output)).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readdir(path.dirname(f.options.output)), ['server.json'])
  assert.deepEqual(result, { host: '127.0.0.1', port: 25566, version: '1.21.11', pid: 4321, profilePath: f.options.output })
  assert.equal(JSON.stringify(result).includes('private server log'), false)
  assert.equal(Object.hasOwn(result, 'log'), false)
})

test('wrong reported Minecraft version or protocol leaves the old output untouched', async t => {
  const f = await fixture(t)
  for (const version of [{ name: '1.21.4', protocol: 774 }, { name: '1.21.11', protocol: 769 }, { name: '1.21.11' }]) {
    await assert.rejects(attachServer(f.options, { ...f.settings, ping: async () => ({ version }) }), /version|protocol/i)
    assert.equal(await fs.readFile(f.options.output, 'utf8'), 'previous output')
    assert.deepEqual(await fs.readdir(path.dirname(f.options.output)), ['server.json'])
  }
})

test('identity validation failure and cancellation preserve output and remove temporary files', async t => {
  const f = await fixture(t)
  const settings = { ...f.settings, readValidatedProfile: async () => { throw new Error('Server process identity changed') } }
  await assert.rejects(attachServer(f.options, settings), /identity/)
  const controller = new AbortController()
  await assert.rejects(attachServer(f.options, {
    ...f.settings,
    signal: controller.signal,
    readValidatedProfile: async (...args) => {
      const result = await f.settings.readValidatedProfile(...args)
      controller.abort()
      return result
    }
  }), { name: 'AbortError' })
  assert.equal(await fs.readFile(f.options.output, 'utf8'), 'previous output')
  assert.deepEqual(await fs.readdir(path.dirname(f.options.output)), ['server.json'])
})

test('attach refuses console-path or symlink output without modifying server files', async t => {
  const f = await fixture(t)
  await assert.rejects(attachServer({ ...f.options, output: f.log }, f.settings), /output|console/i)
  assert.equal(await fs.readFile(f.log, 'utf8'), 'private server log; never read or return its contents')
  const alias = path.join(f.directory, 'alias.json')
  await fs.symlink(f.options.output, alias)
  await assert.rejects(attachServer({ ...f.options, output: alias }, f.settings), /output|symbolic|regular/i)
  assert.equal(await fs.readFile(f.options.output, 'utf8'), 'previous output')
})

test('attach rejects an output alias through a symlinked directory to the live console log', async t => {
  const f = await fixture(t)
  const alias = path.join(f.directory, 'directory-alias')
  await fs.symlink(f.directory, alias)
  const options = { ...f.options, output: path.join(alias, 'console.log') }
  await assert.rejects(attachServer(options, { ...f.settings, readValidatedProfile: async () => f.profile }), /output|console/i)
  assert.equal(await fs.readFile(f.log, 'utf8'), 'private server log; never read or return its contents')
})
