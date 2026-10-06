const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

test('vanilla update requests bind source, clone identity and the exact operation allowlist', () => {
  let helper
  try { helper = require('../scripts/request-vanilla-updates') } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  assert.equal(typeof helper?.encodeRequest, 'function')
  const status = { pid: 123, session: randomUUID(), activeMode: 'HOLD', controlValid: true, hooksReady: true, worldReady: true, requestPending: null, requestHalted: false }
  const valid = [{ type: 'WATER_TICK', x: 90, y: -52, z: 15 }]
  assert.match(helper.encodeRequest(valid, { status, expectedGameTime: 123, requestId: randomUUID() }), /^OG_UPDATE_V1\n123\n/)
  assert.throws(() => helper.encodeRequest([{ type: 'WATER_TICK', x: 0, y: 0, z: 0 }], { status, expectedGameTime: 123 }), /allowlist/)
  assert.throws(() => helper.encodeRequest([...valid, ...valid], { status, expectedGameTime: 123 }), /Duplicate/)
  assert.throws(() => helper.encodeRequest(valid, { status: { ...status, activeMode: 'OFF' }, expectedGameTime: 123 }), /HOLD/)
  assert.throws(() => helper.encodeRequest(valid, { status: { ...status, worldReady: false }, expectedGameTime: 123 }), /world/)
})
