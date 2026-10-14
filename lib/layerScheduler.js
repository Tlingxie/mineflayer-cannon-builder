function positionKey (pos) {
  return `${pos.x},${pos.y},${pos.z}`
}

function abortError (reason) {
  const error = new Error(reason?.message || 'Layer scheduler aborted', { cause: reason })
  error.name = 'AbortError'
  return error
}

class LayerScheduler {
  constructor ({ tasks, workers, execute, verifyLayer, onEvent = () => {}, maxAttempts = 8, signal, taskOwner } = {}) {
    if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array')
    if (!Array.isArray(workers) || workers.length === 0) throw new TypeError('workers must be a nonempty array')
    if (typeof execute !== 'function' || typeof verifyLayer !== 'function' || typeof onEvent !== 'function') {
      throw new TypeError('execute, verifyLayer and onEvent must be functions')
    }
    if (taskOwner !== undefined && typeof taskOwner !== 'function') throw new TypeError('taskOwner must be a function')
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer')
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      throw new TypeError('signal must be an AbortSignal')
    }

    this.layers = new Map()
    this.records = new Map()
    const positions = new Set()
    for (const task of tasks) {
      if (!task || (typeof task.id !== 'string' && !Number.isSafeInteger(task.id))) {
        throw new TypeError('Every task must have a string or integer id')
      }
      if (!task.pos || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(task.pos[axis]))) {
        throw new TypeError(`Task ${task.id} coordinates must be safe integers`)
      }
      if (this.records.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`)
      const key = positionKey(task.pos)
      if (positions.has(key)) throw new Error(`Duplicate task position: ${key}`)
      positions.add(key)
      const record = { task, attempts: 0 }
      this.records.set(task.id, record)
      if (!this.layers.has(task.pos.y)) this.layers.set(task.pos.y, [])
      this.layers.get(task.pos.y).push(record)
    }

    const workerIds = new Set()
    for (const worker of workers) {
      if (!worker || (typeof worker.id !== 'string' && !Number.isSafeInteger(worker.id))) {
        throw new TypeError('Every worker must have a string or integer id')
      }
      if (workerIds.has(worker.id)) throw new Error(`Duplicate worker id: ${worker.id}`)
      workerIds.add(worker.id)
    }

    this.fixedOwners = taskOwner !== undefined
    if (this.fixedOwners) {
      for (const record of this.records.values()) {
        record.ownerId = taskOwner(record.task)
        if (!workerIds.has(record.ownerId)) throw new Error(`Task ${record.task.id} owner must identify an existing worker`)
      }
    }

    this.workers = workers.slice()
    this.execute = execute
    this.verifyLayer = verifyLayer
    this.onEvent = onEvent
    this.maxAttempts = maxAttempts
    this.signal = signal
    this.controller = new AbortController()
    this.failure = null
    this.started = false
    this.layer = null
    this.pending = new Set()
    this.dependencyStalls = 0
    this.summary = { total: tasks.length, completed: 0, attempts: 0, layersCompleted: 0 }
  }

  emit (type, details = {}) {
    this.onEvent({
      type,
      layer: this.layer,
      remaining: this.pending.size,
      ...this.summary,
      ...details
    })
  }

  stop (error) {
    if (this.failure) return
    this.failure = error
    this.controller.abort(error)
  }

  throwIfStopped () {
    if (this.failure) throw this.failure
  }

  attemptLimitError (record) {
    const error = new Error(`Task ${record.task.id} at layer ${this.layer} reached the attempt limit (${this.maxAttempts})`)
    error.code = 'LAYER_ATTEMPT_LIMIT'
    error.layer = this.layer
    error.taskId = record.task.id
    error.attempts = record.attempts
    return error
  }

  takeTask (queue, worker) {
    const pos = worker.position
    let index = 0
    if (pos && ['x', 'y', 'z'].every(axis => Number.isFinite(pos[axis]))) {
      let nearest = Infinity
      // Bound scoring cost even for schematics with very wide layers.
      for (let i = 0; i < Math.min(queue.length, 256); i++) {
        const target = queue[i].task.pos
        const distance = (pos.x - target.x) ** 2 + (pos.y - target.y) ** 2 + (pos.z - target.z) ** 2
        if (distance < nearest) {
          nearest = distance
          index = i
        }
      }
    }
    const record = queue[index]
    queue[index] = queue[queue.length - 1]
    queue.pop()
    return record
  }

  async runBatch (records) {
    const sharedQueue = this.fixedOwners ? null : records.slice()
    const queues = this.fixedOwners ? new Map(this.workers.map(worker => [worker.id, []])) : null
    if (queues) {
      for (const record of records) queues.get(record.ownerId).push(record)
    }
    const retries = []
    let completed = 0
    let dependencyDeferrals = 0
    const work = async worker => {
      const queue = queues ? queues.get(worker.id) : sharedQueue
      try {
        while (!this.failure && queue.length > 0) {
          const record = this.takeTask(queue, worker)
          if (record.attempts >= this.maxAttempts) throw this.attemptLimitError(record)
          record.attempts++
          this.summary.attempts++
          const details = { taskId: record.task.id, workerId: worker.id, attempt: record.attempts }
          this.emit('task-start', details)
          this.throwIfStopped()
          let result = false
          let executionError
          try {
            result = await this.execute(worker, record.task, { signal: this.controller.signal, layer: this.layer })
          } catch (error) {
            executionError = error
          }
          if (this.failure) return
          if (result === true) {
            completed++
            this.pending.delete(record)
            this.emit('task-complete', details)
          } else if (executionError?.code === 'LAYER_DEPENDENCY_PENDING') {
            record.attempts--
            dependencyDeferrals++
            retries.push(record)
            this.emit('task-deferred', { ...details, attempt: record.attempts, reason: 'dependency', error: executionError.message })
          } else {
            if (record.attempts >= this.maxAttempts) throw this.attemptLimitError(record)
            retries.push(record)
            this.emit('task-retry', { ...details, reason: 'execute', error: executionError?.message })
          }
        }
      } catch (error) {
        this.stop(error)
      }
    }

    // A layer or round can never advance while any worker still owns a task.
    await Promise.allSettled(this.workers.map(worker => work(worker)))
    this.throwIfStopped()
    if (retries.length && completed === 0 && dependencyDeferrals === retries.length) {
      // Other clients can receive the support's block update after its placer ACK.
      if (++this.dependencyStalls <= 6) {
        this.emit('dependency-wait', { retry: this.dependencyStalls, delayMs: 50 })
        this.throwIfStopped()
        await wait(50, undefined, { signal: this.controller.signal })
        this.throwIfStopped()
        return retries
      }
      const error = new Error(`Layer ${this.layer} has no available support dependency: all ${retries.length} pending tasks deferred without progress`)
      error.code = 'LAYER_DEPENDENCY_DEADLOCK'
      error.layer = this.layer
      error.taskIds = retries.map(record => record.task.id)
      throw error
    }
    this.dependencyStalls = 0
    return retries
  }

  verificationRetries (tasks) {
    if (!Array.isArray(tasks)) throw new TypeError('Layer verification must return an array of tasks')
    const retries = new Set()
    for (const task of tasks) {
      const record = task && this.records.get(task.id)
      if (!record || !task.pos || record.task.pos.y !== this.layer || positionKey(task.pos) !== positionKey(record.task.pos)) {
        throw new Error('Layer verification returned a task outside the current layer')
      }
      if (retries.has(record)) throw new Error('Layer verification returned a duplicate task')
      retries.add(record)
    }
    return [...retries]
  }

  async run () {
    if (this.started) throw new Error('LayerScheduler.run() can only be called once')
    this.started = true
    const onAbort = () => this.stop(abortError(this.signal.reason))
    if (this.signal) {
      this.signal.addEventListener('abort', onAbort, { once: true })
      if (this.signal.aborted) onAbort()
    }

    try {
      this.throwIfStopped()
      const layers = [...this.layers.keys()].sort((left, right) => left - right)
      for (const layer of layers) {
        this.throwIfStopped()
        this.layer = layer
        this.dependencyStalls = 0
        const records = this.layers.get(layer)
        this.pending = new Set(records)
        this.emit('layer-start', { layerTotal: records.length })
        let retries = records
        while (true) {
          this.throwIfStopped()
          while (retries.length > 0) retries = await this.runBatch(retries)
          this.emit('layer-verify')
          this.throwIfStopped()
          const needsRetry = await this.verifyLayer(layer, records.map(record => record.task))
          this.throwIfStopped()
          retries = this.verificationRetries(needsRetry)
          if (retries.length === 0) break
          this.pending = new Set(retries)
          for (const record of retries) {
            if (record.attempts >= this.maxAttempts) throw this.attemptLimitError(record)
            this.emit('task-retry', { taskId: record.task.id, attempt: record.attempts, reason: 'verification' })
          }
        }
        this.summary.completed += records.length
        this.summary.layersCompleted++
        this.emit('layer-complete', { layerTotal: records.length })
      }
      this.throwIfStopped()
      this.emit('complete')
      return { ...this.summary }
    } catch (error) {
      this.stop(error)
      this.emit(error.name === 'AbortError' ? 'aborted' : 'error', { error: error.message })
      throw error
    } finally {
      if (this.signal) this.signal.removeEventListener('abort', onAbort)
    }
  }
}

module.exports = { LayerScheduler }
const { setTimeout: wait } = require('node:timers/promises')
