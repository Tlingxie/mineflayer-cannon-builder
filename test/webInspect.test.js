const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const nbt = require('prismarine-nbt')
const { inspect } = require('../scripts/web-inspect')

async function schematic (t, entities = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'web-inspect-natural-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'natural.litematic')
  const vector = (x, y, z) => nbt.comp({ x: nbt.int(x), y: nbt.int(y), z: nbt.int(z) })
  const palette = [
    { Name: nbt.string('minecraft:soul_sand') },
    { Name: nbt.string('minecraft:netherrack') },
    { Name: nbt.string('minecraft:bubble_column'), Properties: nbt.comp({ drag: nbt.string('false') }) },
    { Name: nbt.string('minecraft:fire'), Properties: nbt.comp({ age: nbt.string('15') }) }
  ]
  const data = nbt.comp({
    Metadata: nbt.comp({ Name: nbt.string('Natural targets') }),
    Regions: nbt.comp({
      main: nbt.comp({
        Position: vector(0, 0, 0),
        Size: vector(2, 2, 1),
        BlockStatePalette: nbt.list(nbt.comp(palette)),
        BlockStates: nbt.longArray([[0, 228]]),
        TileEntities: nbt.list(nbt.comp([])),
        Entities: nbt.list(nbt.comp(entities.map(name => ({ id: nbt.string(`minecraft:${name}`), Pos: nbt.list(nbt.double([0.5, 1, 0.5])) }))))
      })
    })
  })
  await fs.writeFile(filename, zlib.gzipSync(nbt.writeUncompressed(data)))
  return filename
}

test('web inspection accepts real bubble and fire blueprint data with honest natural-generation requirements', async t => {
  const overview = await inspect(await schematic(t), '1.21.11')
  assert.equal(overview.blocks, 4)
  assert.equal(overview.activeBlocks, 4)
  assert.equal(overview.derivedBlocks, 1)
  assert.equal(overview.layers, 2)
  assert.equal(overview.requiresFrozen, true)
  assert.ok(overview.warnings.some(warning => /气泡柱.*自然生成/.test(warning)))
})

test('after natural block checks, unsupported entities are all named without silently discarding them', async t => {
  const filename = await schematic(t, ['armor_stand', 'armor_stand', 'item_frame'])
  await assert.rejects(inspect(filename, '1.21.11'), error => {
    assert.match(error.message, /方块检查已通过/)
    assert.match(error.message, /盔甲架 \(armor_stand\) × 2/)
    assert.match(error.message, /item_frame × 1/)
    assert.match(error.message, /尚未开始施工/)
    return true
  })
})
