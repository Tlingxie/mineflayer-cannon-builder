const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { resolveState } = require('../lib/strictSchematic')

let musicTrackFromPlan, createMusicFollower
try { ({ musicTrackFromPlan, createMusicFollower } = require('../lib/musicFollower')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

function fixture (delays = [4, 1, 3]) {
  assert.equal(typeof musicTrackFromPlan, 'function', 'Music follower must be implemented')
  const min = new Vec3(0, 64, 3456)
  const task = (name, pos, properties) => ({ name, pos, state: resolveState(name, properties, '1.21.11').stateId })
  const tasks = [task('stone_button', min.offset(1, 4, 14), { face: 'floor', facing: 'west' })]
  delays.forEach((delay, index) => tasks.push(task('repeater', min.offset(2 + index * 4, 3, 14), { delay, facing: 'west' })))
  const plan = { music: true, version: '1.21.11', min, max: min.offset(2 + delays.length * 4, 5, 29), tasks }
  const track = musicTrackFromPlan(plan)
  const bot = new EventEmitter()
  bot.entity = { position: track.home.clone(), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0 }
  bot.blockAt = () => ({ name: 'air', shapes: [] })
  let time = 0
  const events = []
  const follower = createMusicFollower(bot, track, { now: () => time, onEvent: event => events.push(event) })
  const block = (name, position, powered) => ({ name, position, getProperties: () => ({ powered }) })
  const press = () => bot.emit('blockUpdate', block('stone_button', track.button, false), block('stone_button', track.button, true))
  const power = index => bot.emit('blockUpdate', block('repeater', track.modules[index].pos, false), block('repeater', track.modules[index].pos, true))
  return { plan, track, bot, follower, events, block, press, power, advance: ms => { time += ms; follower.step() } }
}

test('track is recovered from actual schematic repeaters and preserves leading silent delays', () => {
  const { plan, track } = fixture()
  assert.deepEqual(track.button, new Vec3(1, 68, 3470))
  assert.deepEqual(track.modules.map(module => module.delay), [4, 1, 3])
  assert.equal(track.modules.length, 3)
  assert.ok(track.home.y > 69)
  assert.throws(() => musicTrackFromPlan({ ...plan, music: false }), /music/i)
  assert.throws(() => musicTrackFromPlan({ ...plan, tasks: plan.tasks.slice(0, -1) }), /module|repeater/i)
})

test('only the exact start button rising edge starts playback; silence does not block progress', () => {
  const { bot, track, follower, block, press, power } = fixture()
  power(0)
  assert.equal(follower.status.phase, 'idle')
  bot.emit('blockUpdate', block('stone_button', track.button.offset(1, 0, 0), false), block('stone_button', track.button.offset(1, 0, 0), true))
  assert.equal(follower.status.phase, 'idle')
  press()
  assert.equal(follower.status.phase, 'playing')
  power(0)
  assert.equal(follower.status.moduleIndex, 0)
  assert.equal(follower.status.notesHeard, 0)
  press()
  assert.equal(follower.status.runs, 1)
})

test('real main-line power advances monotonically while unrelated, falling and cached states are ignored', () => {
  const { bot, follower, block, track, press, power } = fixture()
  press()
  power(1)
  power(0)
  assert.equal(follower.status.moduleIndex, 1)
  const pos = track.modules[2].pos
  bot.emit('blockUpdate', null, block('repeater', pos, true))
  bot.emit('blockUpdate', block('repeater', pos, true), block('repeater', pos, false))
  bot.emit('blockUpdate', block('repeater', pos.offset(0, 0, 1), false), block('repeater', pos.offset(0, 0, 1), true))
  assert.equal(follower.status.moduleIndex, 1)
})

test('flight catches the fastest modules with bounded steps, stops after one unconfirmed module and never crosses missing chunks', () => {
  const { bot, track, follower, press, power, advance } = fixture([1, 1, 1])
  press()
  power(0)
  let previous = bot.entity.position.clone()
  for (let tick = 0; tick < 10; tick++) {
    advance(50)
    assert.ok(bot.entity.position.distanceTo(previous) <= 2.401)
    previous = bot.entity.position.clone()
  }
  assert.ok(bot.entity.position.x <= track.modules[1].pos.x + 0.501)
  const stoppedAt = bot.entity.position.clone()
  advance(5000)
  assert.deepEqual(bot.entity.position, stoppedAt)
  power(1)
  bot.blockAt = () => null
  advance(50)
  assert.deepEqual(bot.entity.position, stoppedAt)
  assert.equal(follower.status.moduleIndex, 1)
})

test('last actual module finishes playback then returns physically and rearms at the button', () => {
  const { bot, track, follower, press, power, advance, events } = fixture([1, 1])
  press()
  power(0)
  advance(100)
  power(1)
  for (let tick = 0; tick < 100; tick++) advance(50)
  assert.equal(follower.status.phase, 'idle')
  assert.ok(bot.entity.position.distanceTo(track.home) < 0.01)
  assert.equal(events.filter(event => event.type === 'music-follow-finished').length, 1)
  press()
  assert.equal(follower.status.runs, 2)
  assert.equal(follower.status.moduleIndex, -1)
})

test('a broken main-line module stops the camera and stop removes its listeners', () => {
  const { bot, track, follower, press, block, advance } = fixture()
  press()
  const before = bot.entity.position.clone()
  bot.emit('blockUpdate', block('repeater', track.modules[0].pos, false), { name: 'air', position: track.modules[0].pos })
  advance(50)
  assert.equal(follower.status.phase, 'fault')
  assert.deepEqual(bot.entity.position, before)
  follower.stop()
  assert.equal(bot.listenerCount('blockUpdate'), 0)
  assert.equal(bot.listenerCount('noteHeard'), 0)
})
