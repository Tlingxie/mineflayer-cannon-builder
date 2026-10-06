const fs = require('node:fs/promises')
const path = require('node:path')

async function withServerOperation (operation, { directory = path.resolve(__dirname, '../.runtime/server') } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const filename = path.join(directory, '.operation-lock')
  const file = await fs.open(filename, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n')
    await file.sync()
    return await operation()
  } finally {
    await file.close()
    await fs.unlink(filename)
  }
}

module.exports = { withServerOperation }
