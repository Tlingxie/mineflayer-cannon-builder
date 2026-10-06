#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { Vec3 } = require('vec3')
const { readPlan } = require('../lib/strictSchematic')
const { auditWorld } = require('../lib/worldAudit')
const { createServerSnapshot } = require('../lib/serverSnapshot')
const { verifyFrozenAssembly } = require('../lib/frozenAssembly')
const { verifyWorldSnapshot } = require('./server-backup')

const MANAGED_DIRECTORY = path.resolve(__dirname, '../.runtime/server')
const IDENTITY_FIELDS = ['directory', 'host', 'port', 'version', 'pid', 'startedAt']

async function readManagedIdentity () {
  const state = JSON.parse(await fs.readFile(path.join(MANAGED_DIRECTORY, 'run.json'), 'utf8'))
  return Object.fromEntries(IDENTITY_FIELDS.map(field => [field, state[field]]))
}

function parseArguments (args) {
  const options = {}
  const allowed = ['--world', '--schematic', '--origin', '--output', '--version']
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!allowed.includes(flag) || !value || Object.hasOwn(options, flag)) throw new Error('Expected --world <backup/world> --schematic <file> --origin x,y,z --output <new report> [--version 1.21.4]')
    options[flag] = value
  }
  if (!allowed.slice(0, 4).every(flag => options[flag])) throw new Error('--world, --schematic, --origin and --output are required')
  const values = options['--origin'].split(',')
  if (values.length !== 3 || !values.every(value => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)))) throw new Error('Invalid origin')
  return { world: path.resolve(options['--world']), schematic: path.resolve(options['--schematic']), origin: new Vec3(...values.map(Number)), output: path.resolve(options['--output']), version: options['--version'] || '1.21.4' }
}

function inside (root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function main (args = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(args)
  const actions = { readPlan, auditWorld, createServerSnapshot, verifyWorldSnapshot, readManagedIdentity, log: console.log, ...dependencies }
  const world = await fs.realpath(options.world)
  if (path.basename(world) !== 'world') throw new Error('--world must be the world directory inside a verified backup')
  const backup = path.dirname(world)
  const output = path.join(await fs.realpath(path.dirname(options.output)), path.basename(options.output))
  if (inside(backup, output) || inside(MANAGED_DIRECTORY, output)) throw new Error('Write the report outside the backup and managed server world directories')
  try {
    await fs.lstat(output)
    throw Object.assign(new Error('EEXIST: the assembly report destination already exists'), { code: 'EEXIST' })
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const manifest = await actions.verifyWorldSnapshot(backup)
  if (manifest.constructionFrozen !== true || manifest.server?.directory !== MANAGED_DIRECTORY || manifest.server?.host !== '127.0.0.1' ||
      manifest.server?.port !== 25566 || manifest.server?.version !== options.version) throw new Error('The backup must come from this frozen managed server on 127.0.0.1:25566 at the requested version')
  const attestIdentity = async () => {
    const state = await actions.readManagedIdentity()
    if (!Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.startedAt !== 'string' || !state.startedAt ||
        !IDENTITY_FIELDS.every(field => state[field] === manifest.server[field])) throw new Error('Managed server identity differs from the frozen backup source')
  }
  await attestIdentity()
  const manifestSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(backup, 'manifest.json'))).digest('hex')
  const plan = await actions.readPlan(options.schematic, options.version, options.origin)
  const worldAudit = await actions.auditWorld({ plan, regionDirectory: path.join(world, 'region') })
  for (const region of worldAudit.regions) {
    const saved = manifest.files.find(file => file.path === path.join('region', region.filename))
    if (!saved || saved.bytes !== region.bytes || saved.sha256 !== region.sha256) throw new Error('Audited region differs from the verified backup manifest')
  }
  const snapshot = await actions.createServerSnapshot({ host: '127.0.0.1', port: 25566, version: options.version })
  const report = await verifyFrozenAssembly({ plan, worldAudit, snapshot })
  await attestIdentity()
  report.provenance = {
    schematic: options.schematic,
    origin: options.origin,
    world,
    backup: { directory: backup, createdAt: manifest.createdAt, server: manifest.server, manifestSha256 },
    callerPrecondition: 'Stop all builders and external edits before the flushed backup and keep them stopped through verification. Saved block states and live NBT are separate reads; unchanged gametime cannot detect player edits.'
  }
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  actions.log(JSON.stringify({ activeAssemblyVerified: report.activeAssemblyVerified, completeBlueprintVerified: report.completeBlueprintVerified, strictContainersVerified: report.strictContainersVerified, minecartsVerified: report.minecartsVerified, naturalPending: report.naturalPending.length, output }))
  return report
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { parseArguments, main }
