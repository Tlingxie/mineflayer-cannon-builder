#!/usr/bin/env node
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const { DEFAULT_BOTS, MAX_BOTS } = require('../lib/buildLimits')

const root = path.resolve(__dirname, '..')
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
])

function parseOptions (args) {
  if (!args.length) return { port: 3210 }
  if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1])) throw new Error('Usage: npm run web -- [--port 3210]')
  const port = Number(args[1])
  if (port < 1 || port > 65535) throw new Error('Web port must be between 1 and 65535')
  return { port }
}

function fail (statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function json (res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function body (req, limit) {
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    req.resume()
    throw fail(413, '请求文件或数据超过大小限制')
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAbort)
    }
    const onError = error => { cleanup(); reject(error) }
    const onAbort = () => onError(fail(400, '上传已中断'))
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    const onData = chunk => {
      size += chunk.length
      if (size > limit) {
        cleanup()
        req.resume()
        reject(fail(413, '请求文件或数据超过大小限制'))
      } else chunks.push(chunk)
    }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onAbort)
  })
}

function createWebServer ({ manager, rootDir = root, maxUploadBytes = MAX_UPLOAD_BYTES } = {}) {
  if (!manager) throw new Error('A build manager is required')
  const token = randomBytes(32).toString('hex')
  const defaults = { host: '127.0.0.1', port: 25566, version: '1.21.11', bots: DEFAULT_BOTS, origin: { x: 128, y: 0, z: 128 } }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try {
      const port = req.socket.localPort
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) throw fail(403, '只允许本机网页访问')
      const origin = `http://${req.headers.host}`
      if ((req.headers.origin !== undefined && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '拒绝跨站请求，请从本机页面操作')
      const url = new URL(req.url, origin)
      if (url.origin !== origin) throw fail(403, '无效的请求来源')
      if (req.method === 'POST') {
        const received = req.headers['x-csrf-token']
        if (typeof received !== 'string' || !/^[a-f0-9]{64}$/.test(received) || !timingSafeEqual(Buffer.from(received), Buffer.from(token))) throw fail(403, '页面凭据已失效，请刷新页面')
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { csrfToken: token, defaults, maxBots: MAX_BOTS, maxUploadBytes })
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await manager.snapshot())
      const download = /^\/api\/blueprints\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/download$/.exec(url.pathname)
      if (req.method === 'GET' && download) {
        const { buffer, filename } = await manager.getDownload(download[1])
        const fallback = filename.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'music.schem'
        const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length, 'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}` })
        return res.end(buffer)
      }
      if (req.method === 'POST' && url.pathname === '/api/blueprints') {
        if (req.headers['content-type'] !== 'application/octet-stream') throw fail(415, '请上传原始蓝图文件')
        const filename = url.searchParams.get('name')
        if (!filename || filename.length > 255) throw fail(400, '缺少有效的蓝图文件名')
        const contents = await body(req, maxUploadBytes)
        if (!contents.length) throw fail(400, '蓝图文件为空')
        return json(res, 201, await manager.upload(filename, contents))
      }
      const stop = /^\/api\/builds\/([a-zA-Z0-9_-]{1,100})\/stop$/.exec(url.pathname)
      if (req.method === 'POST' && (url.pathname === '/api/builds' || stop)) {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(415, '请求必须使用 JSON')
        let data
        try { data = JSON.parse((await body(req, 16 * 1024)).toString('utf8')) } catch (error) {
          if (error.statusCode) throw error
          throw fail(400, '请求不是有效的 JSON')
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail(400, '请求必须是 JSON 对象')
        return json(res, 202, stop ? await manager.stop(stop[1]) : await manager.start(data))
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && assets.has(url.pathname)) {
        const [filename, type] = assets.get(url.pathname)
        const content = await fs.readFile(path.join(rootDir, 'web', filename))
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length })
        return res.end(req.method === 'HEAD' ? undefined : content)
      }
      json(res, 404, { error: '找不到该页面或接口' })
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500, { error: error.message || '操作失败' })
    }
  })
  server.requestTimeout = 60000
  server.headersTimeout = 15000
  return server
}

async function main (args = process.argv.slice(2)) {
  const { port } = parseOptions(args)
  const { WebBuildManager } = require('../lib/webBuildManager')
  const manager = new WebBuildManager({ rootDir: root })
  const server = createWebServer({ manager })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  console.log(`Construction console: http://127.0.0.1:${port}`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    server.close()
    try { await manager.close() } catch (error) { console.error(error.message); process.exitCode = 1 }
    server.closeAllConnections()
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  return { server, manager }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })

module.exports = { createWebServer, parseOptions, main }
