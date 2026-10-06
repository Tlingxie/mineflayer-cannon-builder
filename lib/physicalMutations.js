function cancelled () {
  return Object.assign(new Error('Physical mutation cancelled'), { name: 'AbortError' })
}

class PhysicalMutationCoordinator {
  constructor () {
    this.readers = 0
    this.writer = false
    this.queue = []
    this.halted = null
    this.confirmed = new Map()
  }

  acquire (exclusive, signal) {
    if (this.halted) return Promise.reject(this.halted)
    if (signal?.aborted) return Promise.reject(cancelled())
    return new Promise((resolve, reject) => {
      const entry = { exclusive, resolve, reject, signal }
      entry.cancel = () => {
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(cancelled())
        this.drain()
      }
      signal?.addEventListener('abort', entry.cancel, { once: true })
      this.queue.push(entry)
      this.drain()
    })
  }

  drain () {
    if (this.halted || this.writer) return
    while (this.queue.length) {
      const entry = this.queue[0]
      if (entry.exclusive && this.readers) return
      this.queue.shift()
      entry.signal?.removeEventListener('abort', entry.cancel)
      if (entry.exclusive) this.writer = true
      else this.readers++
      let released = false
      entry.resolve(() => {
        if (released) return
        released = true
        if (entry.exclusive) this.writer = false
        else this.readers--
        this.drain()
      })
      if (entry.exclusive) return
    }
  }

  halt (error) {
    this.halted ||= error
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener('abort', entry.cancel)
      entry.reject(this.halted)
    }
  }
}

module.exports = { PhysicalMutationCoordinator }
