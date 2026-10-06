#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseArgs } = require('node:util')
const { spawnSync } = require('node:child_process')
const clone = require('./server-clone')
const { verifyWorldSnapshot } = require('./server-backup')
const { createCloneSnapshot } = require('../lib/serverSnapshot')

const BACKUPS = path.resolve(__dirname, '../.runtime/backups')
const RUNTIME = path.resolve(__dirname, '../.runtime/server')
const OFFICIAL_JAR_SHA1 = '4707d00eb834b446575d89a61a11b5d548d8c001'
const publicIdentity = state => Object.fromEntries(['host', 'port', 'version', 'pid', 'startedAt', 'directory'].map(key => [key, state[key]]))
const canonicalDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

function validateOptions (options) {
  if (typeof options.backup !== 'string' || !options.backup.length) throw new Error('An explicit --backup is required')
  if (!Number.isSafeInteger(options.expectedCurrentPid) || options.expectedCurrentPid <= 0) throw new Error('--expected-current-pid must be a positive integer')
  if (!canonicalDate(options.expectedStartedAt)) throw new Error('--expected-started-at must be the exact ISO process start time')
}

function parseOptions (args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { backup: { type: 'string' }, 'expected-current-pid': { type: 'string' }, 'expected-started-at': { type: 'string' } } })
  const options = { backup: values.backup, expectedCurrentPid: Number(values['expected-current-pid']), expectedStartedAt: values['expected-started-at'] }
  validateOptions(options)
  return options
}

async function preflight (options) {
  const backup = await fs.realpath(options.backup)
  const relative = path.relative(await fs.realpath(BACKUPS), backup)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Restart backup must be inside this project managed backups directory')
  const manifest = await verifyWorldSnapshot(backup)
  const source = manifest.server
  if (source?.kind !== 'initialization-clone' || source.host !== '127.0.0.1' || source.port !== 25567 || source.version !== '1.21.4' || manifest.constructionFrozen !== true || !Number.isSafeInteger(source.pid) || source.pid <= 0 || !canonicalDate(source.startedAt)) throw new Error('Restart requires a verified frozen clone backup identity')
  const sourceDirectory = await fs.realpath(source.directory)
  if (path.dirname(sourceDirectory) !== await fs.realpath(clone.ROOT) || !/^run-[0-9]+-[a-f0-9]+$/.test(path.basename(sourceDirectory))) throw new Error('Backup source is outside the owned clone directories')
  if (manifest.pending?.step || manifest.pending?.initializationTick) throw new Error('Restart source backup has an unresolved tick operation')
  const settings = { sourceDirectory, runtimeDirectory: RUNTIME, expectedJarSha1: OFFICIAL_JAR_SHA1 }
  await clone.prepareClone(backup, path.join(clone.ROOT, 'restart-preflight-only'), { ...settings, validateOnly: true })
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' })
  const major = Number(`${java.stdout || ''}${java.stderr || ''}`.match(/version "(\d+)/)?.[1])
  if (java.status !== 0 || !Number.isFinite(major) || major < 21) throw new Error('Java 21 or newer is required before stopping the current clone')
  await require('./build-observer-gate').buildObserverGate()
  const manifestSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(backup, 'manifest.json'))).digest('hex')
  return { backup, manifestSha256, source: publicIdentity(source), ...settings }
}

async function acquireLock () {
  const filename = path.join(clone.ROOT, '.operation-lock')
  const lock = await fs.open(filename, 'wx', 0o600)
  return async () => { await lock.close(); await fs.unlink(filename) }
}

async function attestNew (state) {
  const current = clone.validateState(await clone.readJson(clone.STATE))
  if (Object.entries(publicIdentity(state)).some(([field, value]) => current[field] !== value)) throw new Error('New clone identity changed during restart')
  const gate = await clone.inspectObserverGate(current)
  const snapshot = await createCloneSnapshot()
  const tick = await snapshot.readTickState()
  return { ...tick, gateMode: gate?.activeMode }
}

async function verifyPreserved (result, state) {
  if (!result?.directory || result.constructionFrozen !== true) throw new Error('Failed-world backup was not confirmed frozen')
  const manifest = await verifyWorldSnapshot(result.directory)
  if (manifest.constructionFrozen !== true || Object.entries(publicIdentity(state)).some(([field, value]) => manifest.server?.[field] !== value)) throw new Error('Failed-world backup identity differs from the current clone')
}

async function quarantineNew (state) {
  const evidence = []
  for (const command of ['whitelist on', 'tick freeze', 'tick step stop']) {
    try { evidence.push({ command, response: await clone.commandForState(state, command) }) } catch (error) { evidence.push({ command, error: error.message }) }
  }
  return evidence
}

async function restartConstructionClone (options, dependencies = {}) {
  validateOptions(options)
  const operations = {
    acquireLock,
    readCurrent: async () => clone.validateState(await clone.readJson(clone.STATE)),
    preflight,
    backupCurrent: () => clone.backupClone(),
    verifyPreserved,
    stopCurrent: () => clone.stopClone(),
    startNew: (backup, settings) => clone.startClone(backup, settings),
    attestNew,
    openWhitelist: state => clone.commandForState(state, 'whitelist off'),
    quarantineNew,
    ...dependencies
  }
  const journal = path.join(clone.ROOT, `restart-${Date.now()}-${crypto.randomUUID()}.jsonl`)
  const record = operations.record || (async event => fs.appendFile(journal, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 }))
  const release = await operations.acquireLock()
  let current
  let preserved
  let started
  const assertCurrent = async () => {
    const observed = await operations.readCurrent()
    if (observed.pid !== options.expectedCurrentPid || observed.startedAt !== options.expectedStartedAt || (current && ['directory', 'host', 'port', 'version', 'password'].some(field => observed[field] !== current[field]))) throw new Error('Expected current clone identity changed; restart refused')
    return observed
  }
  const assertFrozen = attestation => {
    if (attestation.frozen !== true || attestation.quiescent !== true || attestation.gateMode !== 'HOLD') throw new Error('New clone must be frozen, quiescent and HOLD before opening its whitelist')
  }
  try {
    current = await assertCurrent()
    const ready = await operations.preflight(options, current)
    await record({ type: 'preflight-complete', current: publicIdentity(current), source: ready })
    await assertCurrent()
    await record({ type: 'preserve-intent', current: publicIdentity(current) })
    await assertCurrent()
    preserved = await operations.backupCurrent()
    await operations.verifyPreserved(preserved, current)
    await record({ type: 'preserved', preserved, current: publicIdentity(current) })
    await record({ type: 'stop-intent', current: publicIdentity(current), preserved })
    await assertCurrent()
    const stopped = await operations.stopCurrent()
    if (stopped.running !== false || stopped.pid !== current.pid) throw new Error('Current clone did not confirm stopped; replacement was not started')
    await record({ type: 'stopped', current: publicIdentity(current) })
    await record({ type: 'start-intent', backup: ready.backup, manifestSha256: ready.manifestSha256, observerHold: true })
    await assertCurrent()
    const launched = await operations.startNew(ready.backup, { observerHold: true, sourceDirectory: ready.sourceDirectory, runtimeDirectory: ready.runtimeDirectory, expectedJarSha1: ready.expectedJarSha1, expectedManifestSha256: ready.manifestSha256 })
    const replacement = await operations.readCurrent()
    if (Object.entries(publicIdentity(launched)).some(([field, value]) => replacement[field] !== value) || replacement.pid === current.pid || replacement.directory === current.directory) throw new Error('Replacement clone identity was not established in a new process and directory')
    started = replacement
    const frozen = await operations.attestNew(started)
    assertFrozen(frozen)
    await record({ type: 'frozen-new-clone', current: publicIdentity(started), attestation: frozen })
    await record({ type: 'whitelist-open-intent', current: publicIdentity(started) })
    const response = (await operations.openWhitelist(started)).trim()
    if (response !== 'Whitelist is now turned off' && response !== 'Whitelist is already turned off') throw new Error('Clone did not confirm disabled whitelist')
    await record({ type: 'whitelist-open-result', current: publicIdentity(started), response })
    const final = await operations.attestNew(started)
    assertFrozen(final)
    const result = { current: publicIdentity(started), source: ready, preserved, frozen: final, whitelistOpen: true, journal }
    await record({ type: 'complete', ...result })
    return result
  } catch (error) {
    const redact = value => [current?.password, started?.password].filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), String(value))
    error.message = redact(error.message)
    if (started) {
      try { await record({ type: 'failed-new-clone-quarantine', current: publicIdentity(started), evidence: await operations.quarantineNew(started) }) } catch (cleanupError) { error.message += `; cleanup evidence failed: ${redact(cleanupError.message)}` }
    }
    await record({ type: 'failed', message: error.message, preserved, current: started ? publicIdentity(started) : current && publicIdentity(current), retainedWorld: current?.directory })
    throw error
  } finally {
    await release()
  }
}

if (require.main === module) restartConstructionClone(parseOptions()).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { parseOptions, preflight, restartConstructionClone }
