const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

test('managed operations share one exclusive lock and release it after failure', async t => {
  let withServerOperation
  try { ({ withServerOperation } = require('../lib/serverOperationLock')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  assert.equal(typeof withServerOperation, 'function')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'server-operation-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let nestedRan = false
  await assert.rejects(withServerOperation(async () => {
    await assert.rejects(withServerOperation(async () => { nestedRan = true }, { directory }), { code: 'EEXIST' })
    throw new Error('operation failed')
  }, { directory }), /operation failed/)
  assert.equal(nestedRan, false)
  assert.equal(await withServerOperation(async () => 'next', { directory }), 'next')
  await assert.rejects(fs.access(path.join(directory, '.operation-lock')), { code: 'ENOENT' })
})
