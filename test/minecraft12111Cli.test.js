const test = require('node:test')
const assert = require('node:assert/strict')
const { parseOptions, loadBuildPlan, selectVerificationBackend, prepareMechanismStaging } = require('../examples/strictBuilder')

test('default fixture resolves physical block states for the target 1.21.11 server', async () => {
  const options = parseOptions(['--fixture'])
  const plan = await loadBuildPlan(options)
  assert.equal(plan.version, '1.21.11')
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.port, 25566)
  assert.equal(options.bots, 30)
  const data = require('minecraft-data')('1.21.11')
  for (const task of plan.tasks) assert.equal(data.blocksByStateId[task.state].name, task.name)
  assert.equal((await loadBuildPlan(parseOptions(['--fixture', '--version', '1.21.4']))).version, '1.21.4')
})

test('external worker preparation requires an explicit local server profile', () => {
  assert.throws(() => parseOptions(['--fixture', '--prepare-workers']), /server-profile/)
  assert.throws(() => parseOptions(['--fixture', '--server-profile', 'server.json', '--host', '192.0.2.1']), /127\.0\.0\.1/)
  const options = parseOptions(['--fixture', '--server-profile', '.runtime/target.json', '--prepare-workers'])
  assert.equal(options.serverProfile, require('node:path').resolve('.runtime/target.json'))
  assert.equal(options.prepareWorkers, true)
})

test('external profile selects its own attested snapshot and cannot fall back to an old managed world', async () => {
  const options = { host: '127.0.0.1', port: 25566, version: '1.21.11', serverProfile: '/target.json' }
  const settings = {
    snapshotFactory: async () => assert.fail('must not inspect the old managed server'),
    cloneSnapshotFactory: async () => assert.fail('must not inspect the old clone'),
    externalSnapshotFactory: async (endpoint, supplied) => {
      assert.deepEqual(endpoint, { host: '127.0.0.1', port: 25566, version: '1.21.11' })
      assert.equal(supplied.profilePath, '/target.json')
      return { backend: 'external-console' }
    }
  }
  const result = await selectVerificationBackend(options, settings)
  assert.equal(result.backend, 'external-readonly-console')
  assert.equal(result.snapshot.backend, 'external-console')
  await assert.rejects(selectVerificationBackend(options, { ...settings, externalSnapshotFactory: async () => { throw new Error('External process changed') } }), /process changed/)
})

test('enclosed minecarts accept a verified external freeze but still reject a running external world', async () => {
  const plan = { layers: [64] }
  const mechanisms = { normalizeMinecartEntities: () => [{ id: 'cart', layer: 64, stagedStrategy: { type: 'frozen-flat-rail' } }] }
  const verificationBackend = { backend: 'external-readonly-console', snapshot: { readTickState: async () => ({ frozen: true, quiescent: true }) } }
  const result = await prepareMechanismStaging(plan, { mechanisms, verificationBackend })
  assert.equal(result.frozen, true)
  assert.deepEqual(result.entityIds, ['cart'])
  verificationBackend.snapshot.readTickState = async () => ({ frozen: false, quiescent: false })
  await assert.rejects(prepareMechanismStaging(plan, { mechanisms, verificationBackend }), /frozen and quiescent/)
})
