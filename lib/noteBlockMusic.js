const AIR = new Set(['air', 'cave_air', 'void_air'])

function verifyNoteBlockMusic (tasks, readBlock, version) {
  const Block = require('prismarine-block')(version)
  const instruments = {}
  let notes = 0
  for (const task of tasks) {
    if (task.name !== 'note_block') continue
    const actual = readBlock(task.pos)
    if (actual?.name !== 'note_block') throw new Error(`Missing note block at ${task.id}`)
    const wanted = Block.fromStateId(task.state, 0).getProperties()
    const observed = actual.getProperties()
    for (const property of ['note', 'instrument']) {
      if (String(wanted[property]) !== String(observed[property])) throw new Error(`Music ${property} mismatch at ${task.id}: expected ${wanted[property]}, got ${observed[property]}`)
    }
    if (!AIR.has(readBlock(task.pos.offset(0, 1, 0))?.name)) throw new Error(`Music requires clear air above note block at ${task.id}`)
    instruments[observed.instrument] = (instruments[observed.instrument] || 0) + 1
    notes++
  }
  return { verified: true, notes, instruments }
}

module.exports = { verifyNoteBlockMusic }
