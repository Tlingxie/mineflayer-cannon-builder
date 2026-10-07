const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createWebServer, parseOptions } = require('../scripts/web-server')

async function fixture (t, overrides = {}) {
  const calls = []
  const manager = {
    snapshot: async () => ({ server: { status: 'online' }, job: null }),
    upload: async (filename, body) => { calls.push(['upload', filename, body.toString()]); return { id: 'blueprint', filename } },
    start: async value => { calls.push(['start', value]); return { id: 'job', status: 'preparing' } },
    stop: async id => { calls.push(['stop', id]); return { id, status: 'stopping' } },
    ...overrides
  }
  const server = createWebServer({ manager, maxUploadBytes: 16 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const url = `http://127.0.0.1:${server.address().port}`
  const config = await (await fetch(url + '/api/config')).json()
  const headers = { 'X-CSRF-Token': config.csrfToken, 'Content-Type': 'application/json' }
  return { server, calls, url, headers, config }
}

test('local web defaults and fixed loopback binding reject invalid ports', () => {
  assert.deepEqual(parseOptions([]), { port: 3210 })
  assert.deepEqual(parseOptions(['--port', '3211']), { port: 3211 })
  for (const args of [['--port', '0'], ['--port', '3.2'], ['--host', '0.0.0.0'], ['--port', '65536'], ['--port']]) assert.throws(() => parseOptions(args))
})

test('configuration, same-origin mutations and read-only status use the manager contract', async t => {
  const f = await fixture(t)
  assert.equal(f.config.defaults.port, 25566)
  assert.equal(f.config.defaults.bots, 30)
  assert.equal(f.config.maxUploadBytes, 16)
  assert.ok(f.config.csrfToken.length >= 32)
  assert.equal((await (await fetch(f.url + '/api/status')).json()).job, null)
  const upload = await fetch(f.url + '/api/blueprints?name=test.schem', { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/octet-stream', Origin: f.url }, body: 'sample' })
  assert.equal(upload.status, 201)
  assert.deepEqual(await upload.json(), { id: 'blueprint', filename: 'test.schem' })
  const value = { blueprintId: 'blueprint', origin: { x: 128, y: 0, z: 128 }, originMode: 'schematic', bots: 30 }
  assert.equal((await fetch(f.url + '/api/builds', { method: 'POST', headers: f.headers, body: JSON.stringify(value) })).status, 202)
  assert.equal((await fetch(f.url + '/api/builds/job/stop', { method: 'POST', headers: f.headers, body: '{}' })).status, 202)
  assert.deepEqual(f.calls, [['upload', 'test.schem', 'sample'], ['start', value], ['stop', 'job']])
})

test('cross-origin and missing-token requests cannot invoke the builder', async t => {
  const f = await fixture(t)
  for (const headers of [{}, { ...f.headers, Origin: 'https://unrelated.example' }, { ...f.headers, 'Sec-Fetch-Site': 'cross-site' }, { ...f.headers, 'X-CSRF-Token': '\u00e9'.repeat(64) }]) {
    assert.equal((await fetch(f.url + '/api/builds', { method: 'POST', headers, body: '{}' })).status, 403)
  }
  assert.equal((await fetch(f.url + '/api/config', { headers: { Origin: 'null' } })).status, 403)
  const status = await new Promise((resolve, reject) => {
    const req = http.get(f.url + '/api/config', { headers: { Host: 'unrelated.example' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
  })
  assert.equal(status, 403)
  assert.deepEqual(f.calls, [])
})

test('upload and JSON limits reject before manager invocation', async t => {
  const f = await fixture(t)
  for (const value of ['x'.repeat(17), '']) {
    const result = await fetch(f.url + '/api/blueprints?name=bad.schem', { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/octet-stream' }, body: value })
    assert.equal(result.status, value ? 413 : 400)
  }
  assert.equal((await fetch(f.url + '/api/builds', { method: 'POST', headers: f.headers, body: '{broken' })).status, 400)
  assert.equal((await fetch(f.url + '/api/builds', { method: 'POST', headers: f.headers, body: 'null' })).status, 400)
  assert.equal((await fetch(f.url + '/api/builds', { method: 'POST', headers: f.headers, body: ' '.repeat(17000) })).status, 413)
  assert.deepEqual(f.calls, [])
})

test('manager errors preserve actionable messages and status codes', async t => {
  const f = await fixture(t, { start: async () => { throw Object.assign(new Error('A construction job is already active'), { statusCode: 409 }) } })
  const result = await fetch(f.url + '/api/builds', { method: 'POST', headers: f.headers, body: '{}' })
  assert.equal(result.status, 409)
  assert.deepEqual(await result.json(), { error: 'A construction job is already active' })
})

test('static routes never expose project files or uploads and carry local CSP', async t => {
  const f = await fixture(t)
  for (const filename of ['/package.json', '/.runtime/servers/1.21.11-25566.json', '/lib/webBuildManager.js']) assert.equal((await fetch(f.url + filename)).status, 404)
  const result = await fetch(f.url + '/api/config')
  assert.match(result.headers.get('Content-Security-Policy'), /default-src 'self'/)
  assert.equal(result.headers.get('Cache-Control'), 'no-store')
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff')
})
