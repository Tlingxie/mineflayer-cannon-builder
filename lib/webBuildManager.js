const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')

const exec = promisify(execFile)
const TARGET = Object.freeze({ host: '127.0.0.1', port: 25566, version: '1.21.11' })
const AXES = ['x', 'y', 'z']
const ACTIVE = new Set(['preparing', 'running', 'stopping'])
const errorWithStatus = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const coordinates = value => Object.fromEntries(AXES.map(axis => [axis, value[axis]]))

async function inspectFile (filename, { rootDir, signal }) {
  try {
    const { stdout } = await exec(process.execPath, ['--max-old-space-size=768', path.join(rootDir, 'scripts/web-inspect.js'), filename, TARGET.version], {
      cwd: rootDir, signal, timeout: 45000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', encoding: 'utf8'
    })
    return JSON.parse(stdout)
  } catch (error) {
    const detail = error.stderr?.trim().slice(-2000)
    throw errorWithStatus(detail || 'Blueprint inspection failed or exceeded its time/memory limit')
  }
}

async function checkServer () {
  const status = await require('minecraft-protocol').ping({ ...TARGET, closeTimeout: 4000, noPongTimeout: 1000 })
  if (status?.version?.name !== TARGET.version || status.version.protocol !== 774) throw new Error('Server is not Minecraft 1.21.11 (protocol 774)')
}

async function checkFrozen (profilePath, { signal }) {
  const snapshot = await require('./serverSnapshot').createExternalSnapshot(TARGET, { signal, profilePath })
  await snapshot.readTickState({ signal })
}

class WebBuildManager {
  constructor ({ rootDir = path.resolve(__dirname, '..'), runtimeDir, inspect = inspectFile, attach, spawn: spawnChild = spawn, checkServer: serverCheck = checkServer, checkFrozen: frozenCheck = checkFrozen, now = Date.now, stopTimeoutMs = 30000 } = {}) {
    this.rootDir = path.resolve(rootDir)
    this.runtimeDir = path.resolve(runtimeDir || path.join(this.rootDir, '.runtime/web'))
    this.buildsDir = path.join(this.rootDir, '.runtime/builds')
    this.profilePath = path.join(this.rootDir, '.runtime/servers/1.21.11-25566.json')
    this.inspect = inspect
    this.attach = attach || require('../scripts/server-attach').attachServer
    this.spawn = spawnChild
    this.checkServer = serverCheck
    this.checkFrozen = frozenCheck
    this.now = now
    this.stopTimeoutMs = stopTimeoutMs
    this.blueprints = new Map()
    this.job = null
    this.active = null
    this.server = { ...TARGET, status: 'unknown' }
    this.serverCheckedAt = -Infinity
    this.serverCheck = null
    this.inspection = null
    this.closed = false
  }

  async upload (filename, buffer) {
    if (this.closed) throw errorWithStatus('Web build manager is closed', 503)
    if (typeof filename !== 'string' || filename.length > 180 || /[\x00-\x1f\x7f/\\]/.test(filename) || filename !== path.basename(filename)) throw errorWithStatus('Invalid blueprint filename') // eslint-disable-line no-control-regex
    const extension = path.extname(filename).toLowerCase()
    if (!['.litematic', '.schem'].includes(extension)) throw errorWithStatus('Choose a .litematic or .schem blueprint')
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw errorWithStatus('Blueprint is empty')
    if (buffer.length > 32 * 1024 * 1024) throw errorWithStatus('Blueprint exceeds 32 MiB', 413)
    if (this.inspection) throw errorWithStatus('Another blueprint is being inspected', 409)
    const controller = new AbortController()
    this.inspection = controller
    const id = randomUUID()
    const directory = path.join(this.runtimeDir, 'uploads', id)
    const file = path.join(directory, `blueprint${extension}`)
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.writeFile(file, buffer, { mode: 0o600, flag: 'wx', signal: controller.signal })
      const metadata = await this.inspect(file, { rootDir: this.rootDir, signal: controller.signal })
      if (controller.signal.aborted) throw errorWithStatus('Blueprint inspection cancelled')
      const blueprint = { ...metadata, id, filename, name: metadata.name || filename }
      this.blueprints.set(id, { file, blueprint })
      return structuredClone(blueprint)
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true })
      if (!error.statusCode) error.statusCode = 400
      throw error
    } finally {
      if (this.inspection === controller) this.inspection = null
    }
  }

  async start (input) {
    if (this.closed) throw errorWithStatus('Web build manager is closed', 503)
    if (this.active) throw errorWithStatus('A build is already active; wait for it to finish stopping', 409)
    const entry = this.blueprints.get(input?.blueprintId)
    if (!entry) throw errorWithStatus('Upload a valid blueprint first')
    if (!Number.isInteger(input.bots) || input.bots < 1 || input.bots > 30) throw errorWithStatus('Bot count must be between 1 and 30')
    if (!['minimum', 'schematic'].includes(input.originMode)) throw errorWithStatus('Invalid origin mode')
    if (!input.origin || !AXES.every(axis => Number.isSafeInteger(input.origin[axis]))) throw errorWithStatus('Origin must contain integer x, y, z coordinates')
    const origin = coordinates(input.origin)
    const blueprint = entry.blueprint
    const minimum = coordinates(origin)
    if (input.originMode === 'schematic') {
      if (!blueprint.sourceMin || !AXES.every(axis => Number.isSafeInteger(blueprint.sourceMin[axis]))) throw errorWithStatus('Blueprint has no source origin; choose minimum corner')
      for (const axis of AXES) minimum[axis] += blueprint.sourceMin[axis]
    }
    const maximum = Object.fromEntries(AXES.map(axis => [axis, minimum[axis] + blueprint.dimensions[axis]]))
    if (minimum.y < -64 || maximum.y > 320) throw errorWithStatus('Build exceeds overworld height limits (-64 to 319)')
    if (['x', 'z'].some(axis => minimum[axis] < -29999984 || maximum[axis] > 29999984)) throw errorWithStatus('Build exceeds world coordinate limits')
    if (blueprint.requiresAlignment && !AXES.every(axis => (minimum[axis] - blueprint.sourceMin[axis]) % 16 === 0)) throw errorWithStatus('Mk6.1 schematic origin must be a multiple of 16 on every axis')
    const job = {
      id: randomUUID(),
      status: 'preparing',
      blueprint: { id: blueprint.id, filename: blueprint.filename, name: blueprint.name },
      origin,
      originMode: input.originMode,
      bots: input.bots,
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      endedAt: null,
      error: null,
      progress: { completed: 0, total: blueprint.activeBlocks, layer: null, completedLayers: 0, totalLayers: blueprint.layers, connectedBots: 0, activeBots: 0, elapsedSeconds: 0 },
      logs: []
    }
    const active = { job, entry, controller: new AbortController(), child: null, runDir: null, stopRequested: false, forced: false, lines: { stdout: '', stderr: '' }, lastError: '' }
    this.active = active
    this.job = job
    this._log(job, 'info', '正在检查本地服务器和施工条件…')
    active.finished = this._run(active).catch(error => this._finishFailure(active, error))
    return this._publicJob(job)
  }

  async _run (active) {
    const { job, entry, controller } = active
    const signal = controller.signal
    try {
      await this.attach({ ...TARGET, output: this.profilePath }, { signal })
      signal.throwIfAborted()
      this.server = { ...TARGET, status: 'online' }
      this.serverCheckedAt = this.now()
      if (entry.blueprint.requiresFrozen) {
        try { await this.checkFrozen(this.profilePath, { signal }) } catch (error) {
          signal.throwIfAborted()
          throw new Error(`此蓝图包含需要冻结验证的流体或封闭矿车，请先在服务器控制台执行 tick freeze，再开始施工。网页不会自动冻结服务器。(${error.message})`)
        }
        signal.throwIfAborted()
      }
      const originFlag = job.originMode === 'schematic' ? '--schematic-origin' : '--origin'
      const args = [path.join(this.rootDir, 'examples/strictBuilder.js'), '--schematic', entry.file, '--host', TARGET.host, '--port', String(TARGET.port), '--version', TARGET.version, '--server-profile', this.profilePath, '--prepare-workers', '--bots', String(job.bots), originFlag, AXES.map(axis => job.origin[axis]).join(','), '--prefix', `web${job.id.replaceAll('-', '').slice(0, 9)}`]
      const child = this.spawn(process.execPath, args, { cwd: this.rootDir, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      active.child = child
      job.startedAt = new Date(this.now()).toISOString()
      job.status = 'running'
      this._log(job, 'info', `施工已启动，正在连接 ${job.bots} 个 bot。每层验证后才进入上一层。`)
      await new Promise(resolve => {
        child.stdout.on('data', chunk => this._consume(active, 'stdout', chunk))
        child.stderr.on('data', chunk => this._consume(active, 'stderr', chunk))
        child.once('error', error => { active.spawnError = error; this._log(job, 'error', error.message) })
        child.once('close', (code, signal) => {
          active.exitCode = code
          active.exitSignal = signal
          resolve()
        })
      })
      clearTimeout(active.stopTimer)
      for (const stream of ['stdout', 'stderr']) if (active.lines[stream]) this._line(active, stream, active.lines[stream])
      const report = await this._readReport(active, 'report.json')
      if (report) this._applyReport(job, report)
      if (active.forced) {
        throw new Error('施工进程未能按时安全退出，已强制停止；请检查世界中的未完成结构后再继续。')
      } else if (active.stopRequested) {
        job.status = 'cancelled'
        this._log(job, 'info', '施工已停止，已放置的方块会保留。')
      } else if (active.exitCode === 0 && report?.status === 'verified') {
        job.status = 'completed'
        this._log(job, 'info', '全部层与最终结构验证通过，施工完成。')
      } else {
        throw new Error(report?.error || active.spawnError?.message || active.lastError || `Construction exited without a verified report (code ${active.exitCode}, signal ${active.exitSignal || 'none'})`)
      }
      this._end(active)
    } catch (error) {
      this._finishFailure(active, error)
    }
  }

  _finishFailure (active, error) {
    clearTimeout(active.stopTimer)
    const { job } = active
    if (active.stopRequested && !active.forced) {
      job.status = 'cancelled'
      this._log(job, 'info', '施工准备已取消。')
    } else {
      job.status = 'failed'
      job.error = String(error.message || error).slice(0, 4000)
      this._log(job, 'error', job.error)
    }
    this._end(active)
  }

  _end (active) {
    const { job } = active
    job.endedAt = new Date(this.now()).toISOString()
    job.progress.activeBots = 0
    if (!active.finalElapsed && job.startedAt) job.progress.elapsedSeconds = Math.max(0, (this.now() - Date.parse(job.startedAt)) / 1000)
    if (this.active === active) this.active = null
  }

  _consume (active, stream, chunk) {
    const lines = (active.lines[stream] + chunk.toString('utf8')).split(/\r?\n/)
    active.lines[stream] = lines.pop().slice(-16000)
    for (const line of lines) if (line.trim()) this._line(active, stream, line.slice(0, 4000))
  }

  _line (active, stream, line) {
    let value
    if (stream === 'stdout' && line.startsWith('{')) {
      try { value = JSON.parse(line) } catch {}
      if (typeof value?.runDir === 'string') {
        const runDir = path.resolve(value.runDir)
        if (path.dirname(runDir) === this.buildsDir && !active.runDir) active.runDir = runDir
        else if (runDir !== active.runDir) this._log(active.job, 'error', 'Ignored an unexpected construction report directory')
        return
      }
    }
    if (stream === 'stderr' && !/^\s+at\s/.test(line)) active.lastError = line.slice(0, 4000)
    this._log(active.job, stream === 'stderr' ? 'error' : 'info', line)
  }

  _log (job, level, message) {
    job.logs.push({ time: new Date(this.now()).toISOString(), level, message: message.slice(0, 4000) })
    if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200)
  }

  async _readReport (active, name) {
    if (!active.runDir) return null
    try {
      const filename = path.join(active.runDir, name)
      const stat = await fs.lstat(filename)
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || stat.isSymbolicLink()) return null
      const expectedDirectory = path.join(await fs.realpath(this.buildsDir), path.basename(active.runDir))
      if (await fs.realpath(active.runDir) !== expectedDirectory) return null
      return JSON.parse(await fs.readFile(filename, 'utf8'))
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) return null
      throw error
    }
  }

  _applyReport (job, report) {
    if (typeof report.status === 'string') job.progress.phase = report.status
    const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
    for (const [key, field] of [['completed', 'completed'], ['connectedBots', 'connectedBots'], ['activeBots', 'activeWorkers'], ['elapsedSeconds', 'elapsedSeconds']]) {
      if (nonnegative(report[field])) job.progress[key] = report[field]
    }
    if (Number.isInteger(report.currentLayer)) job.progress.layer = report.currentLayer
    if (Array.isArray(report.layers)) job.progress.completedLayers = report.layers.length
    if (nonnegative(report.elapsedSeconds) && this.active?.job === job) this.active.finalElapsed = true
  }

  async _refreshServer () {
    if (this.now() - this.serverCheckedAt < 10000) return
    if (!this.serverCheck) {
      this.serverCheck = Promise.resolve().then(() => this.checkServer()).then(() => {
        this.server = { ...TARGET, status: 'online' }
      }, error => {
        this.server = { ...TARGET, status: 'offline', error: String(error.message || error).slice(0, 1000) }
      }).finally(() => { this.serverCheckedAt = this.now(); this.serverCheck = null })
    }
    await this.serverCheck
  }

  async snapshot () {
    await this._refreshServer()
    const active = this.active
    if (active) {
      const report = await this._readReport(active, 'status.json')
      if (this.active === active) {
        if (report) this._applyReport(active.job, report)
        if (active.job.startedAt) active.job.progress.elapsedSeconds = Math.max(0, (this.now() - Date.parse(active.job.startedAt)) / 1000)
      }
    }
    return { server: { ...this.server }, job: this._publicJob(this.job) }
  }

  _publicJob (job) { return job ? structuredClone(job) : null }

  async stop (id) {
    if (!this.job || this.job.id !== id) throw errorWithStatus('Build not found', 404)
    const active = this.active
    if (!active || !ACTIVE.has(active.job.status)) return this._publicJob(this.job)
    if (!active.stopRequested) {
      active.stopRequested = true
      active.job.status = 'stopping'
      this._log(active.job, 'info', '正在停止施工并等待所有 bot 退出…')
      active.controller.abort(new Error('Build cancelled'))
      if (active.child) {
        active.child.kill('SIGINT')
        active.stopTimer = setTimeout(() => {
          if (this.active !== active) return
          active.forced = true
          this._log(active.job, 'error', '安全退出超时，正在结束施工进程。')
          active.child.kill('SIGKILL')
        }, this.stopTimeoutMs)
        active.stopTimer.unref?.()
      }
    }
    return this._publicJob(this.job)
  }

  async close () {
    this.closed = true
    this.inspection?.abort(new Error('Web server closing'))
    const active = this.active
    if (active) {
      await this.stop(active.job.id)
      await active.finished
    }
  }
}

module.exports = { WebBuildManager }
