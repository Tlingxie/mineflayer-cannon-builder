const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { resolveState } = require('../lib/strictSchematic')

function fixture () {
  const pos = new Vec3(4, 65, 6)
  const wanted = resolveState('note_block', { note: 12, instrument: 'flute', powered: false }, '1.21.11')
  const task = { id: '4,65,6', name: 'note_block', state: wanted.stateId, pos }
  const world = new Map([[task.id, wanted], ['4,66,6', resolveState('air', {}, '1.21.11')]])
  return { task, world, readBlock: pos => world.get(`${pos.x},${pos.y},${pos.z}`) }
}

test('note-block music verification checks pitch and material-derived instrument while allowing runtime power', () => {
  const { verifyNoteBlockMusic } = require('../lib/noteBlockMusic')
  const f = fixture()
  f.world.set(f.task.id, resolveState('note_block', { note: 12, instrument: 'flute', powered: true }, '1.21.11'))
  assert.deepEqual(verifyNoteBlockMusic([f.task], f.readBlock, '1.21.11'), { verified: true, notes: 1, instruments: { flute: 1 } })
  f.world.set(f.task.id, resolveState('note_block', { note: 12, instrument: 'harp' }, '1.21.11'))
  assert.throws(() => verifyNoteBlockMusic([f.task], f.readBlock, '1.21.11'), /instrument.*4,65,6/)
  f.world.set(f.task.id, resolveState('note_block', { note: 13, instrument: 'flute' }, '1.21.11'))
  assert.throws(() => verifyNoteBlockMusic([f.task], f.readBlock, '1.21.11'), /note.*4,65,6/)
})

test('music verification rejects obstructed or unloaded space above a note block', () => {
  const { verifyNoteBlockMusic } = require('../lib/noteBlockMusic')
  const f = fixture()
  for (const name of ['stone', 'water', 'glass']) {
    f.world.set('4,66,6', resolveState(name, {}, '1.21.11'))
    assert.throws(() => verifyNoteBlockMusic([f.task], f.readBlock, '1.21.11'), /above.*4,65,6/)
  }
  f.world.delete('4,66,6')
  assert.throws(() => verifyNoteBlockMusic([f.task], f.readBlock, '1.21.11'), /above.*4,65,6/)
})

test('unbuilt note blocks cannot pass music verification and unrelated blocks are ignored', () => {
  const { verifyNoteBlockMusic } = require('../lib/noteBlockMusic')
  const f = fixture()
  f.world.delete(f.task.id)
  assert.throws(() => verifyNoteBlockMusic([f.task], f.readBlock, '1.21.11'), /Missing.*4,65,6/)
  assert.deepEqual(verifyNoteBlockMusic([{ name: 'stone' }], () => assert.fail('No unrelated reads'), '1.21.11'), { verified: true, notes: 0, instruments: {} })
})
