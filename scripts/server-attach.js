#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { readValidatedProfile } = require('../lib/externalServerConsole')

const exec = promisify(execFile)

function check (signal) {
  if (signal?.aborted) throw Object.assign(new Error('Server attachment cancelled', { cause: signal.reason }), { name: 'AbortError' })
}

function validateOptions (options) {
  if (options?.host !== '127.0.0.1') throw new Error('Server attachment requires numeric loopback host 127.0.0.1')
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid server port')
  if (typeof options.version !== 'string' || !/^1\.[0-9]+(?:\.[0-9]+)?$/.test(options.version)) throw new Error('Invalid Minecraft version')
  if (typeof options.output !== 'string' || !options.output || !path.isAbsolute(options.output)) throw new Error('Server profile output must be an absolute path')
}

function parseOptions (args) {
  const options = { host: '127.0.0.1', port: 25566, version: '1.21.11' }
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (!['--host', '--port', '--version', '--output'].includes(flag)) throw new Error(`Unknown server attachment option: ${flag}`)
    if (seen.has(flag)) throw new Error(`Duplicate server attachment option: ${flag}`)
    seen.add(flag)
    const value = args[++index]
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--port' && !/^[0-9]+$/.test(value)) throw new Error('Invalid server port')
    options[flag.slice(2)] = flag === '--port' ? Number(value) : value
  }
  options.output = options.output ? path.resolve(options.output) : path.resolve(__dirname, '../.runtime/servers', `${options.version}-${options.port}.json`)
  validateOptions(options)
  return options
}

async function discoverProfile (options, { signal, exec: inspect = exec } = {}) {
  validateOptions(options)
  check(signal)
  const settings = { timeout: 3000, maxBuffer: 131072, encoding: 'utf8', signal }
  let listening
  try {
    listening = await inspect('lsof', ['-nP', `-iTCP:${options.port}`, '-sTCP:LISTEN', '-Fp'], settings)
  } catch (error) {
    check(signal)
    throw new Error(`Unable to find a unique listening server on port ${options.port}: ${error.code || 'inspection failed'}`)
  }
  const pids = [...new Set(listening.stdout.split('\n').filter(line => /^p[1-9][0-9]*$/.test(line)).map(line => Number(line.slice(1))))]
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0])) throw new Error(`Expected exactly one unique listening process on port ${options.port}`)
  const pid = pids[0]
  check(signal)
  const [files, started] = await Promise.all([
    inspect('lsof', ['-nP', '-a', '-p', String(pid), '-d', 'cwd,0,1,2', '-Ffn'], settings),
    inspect('ps', ['-p', String(pid), '-o', 'lstart='], settings)
  ])
  check(signal)
  const descriptors = new Map()
  let descriptor
  for (const line of files.stdout.split('\n')) {
    if (line.startsWith('f')) descriptor = line.slice(1)
    if (line.startsWith('n')) descriptors.set(descriptor, line.slice(1))
  }
  const processStart = started.stdout.trim()
  if (!processStart || !descriptors.get('cwd') || !descriptors.get('0')) throw new Error('Server process is missing its working directory, FIFO stdin or start identity')
  const directory = await fs.realpath(descriptors.get('cwd'))
  const pipe = await fs.realpath(descriptors.get('0'))
  if (!(await fs.lstat(directory)).isDirectory() || !(await fs.lstat(pipe)).isFIFO()) throw new Error('Server attachment requires a working directory and FIFO stdin')
  let log
  for (const fd of ['1', '2']) {
    if (!descriptors.has(fd)) continue
    try {
      const candidate = await fs.realpath(descriptors.get(fd))
      if ((await fs.lstat(candidate)).isFile()) { log = candidate; break }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error
    }
  }
  if (!log) throw new Error('Server attachment requires a regular console log on stdout or stderr')
  check(signal)
  return { schemaVersion: 1, kind: 'external-console', host: options.host, port: options.port, version: options.version, pid, processStart, directory, pipe, log }
}

async function pingMinecraft ({ host, port, version }, { signal } = {}) {
  check(signal)
  try {
    const status = await require('minecraft-protocol').ping({
      host,
      port,
      version,
      closeTimeout: 5000,
      noPongTimeout: 1000,
      connect: client => client.setSocket(net.createConnection({ host, port, signal }))
    })
    check(signal)
    return status
  } catch (error) {
    check(signal)
    throw new Error(`Minecraft server status query failed: ${error.code || error.message}`)
  }
}

async function outputState (filename) {
  try {
    const stat = await fs.lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Server profile output must be a regular file, not a symbolic link')
    return stat
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function attachServer (options, {
  signal,
  discoverProfile: discover = discoverProfile,
  ping = pingMinecraft,
  readValidatedProfile: validate = readValidatedProfile
} = {}) {
  validateOptions(options)
  check(signal)
  const registry = require('minecraft-data')(options.version)
  if (!registry || registry.version.minecraftVersion !== options.version) throw new Error('Unsupported Minecraft version for attachment')
  const profile = await discover(options, { signal })
  check(signal)
  const output = path.resolve(options.output)
  if ([profile.pipe, profile.log].includes(output)) throw new Error('Profile output cannot replace a server console file')
  const before = await outputState(output)
  if (before && [profile.pipe, profile.log].includes(await fs.realpath(output))) throw new Error('Profile output cannot replace a server console file through a path alias')
  const status = await ping({ host: options.host, port: options.port, version: options.version }, { signal })
  check(signal)
  if (status?.version?.name !== options.version || status.version.protocol !== registry.version.version) throw new Error(`Server status version/protocol does not match Minecraft ${options.version} (${registry.version.version})`)
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${randomUUID()}.tmp`)
  try {
    check(signal)
    await fs.writeFile(temporary, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600, signal })
    await validate(temporary, options, { signal })
    check(signal)
    const current = await outputState(output)
    if (Boolean(before) !== Boolean(current) || (before && ['dev', 'ino', 'size', 'mtimeMs'].some(field => before[field] !== current[field]))) throw new Error('Server profile output changed during attachment')
    check(signal)
    await fs.rename(temporary, output)
    return { host: profile.host, port: profile.port, version: profile.version, pid: profile.pid, profilePath: output }
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function main () {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/server-attach.js [--host 127.0.0.1] [--port 25566] [--version 1.21.11] [--output profile.json]')
    return
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    console.log(JSON.stringify(await attachServer(parseOptions(args), { signal: controller.signal }), null, 2))
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })

module.exports = { parseOptions, discoverProfile, attachServer }
