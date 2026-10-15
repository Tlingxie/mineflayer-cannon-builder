const test = require('node:test')
const assert = require('node:assert/strict')
const { bannerPatterns, bannerItemComponents, bannerDifferences } = require('../lib/physicalBanners')

test('legacy banner layers retain ordered patterns and dye colors', () => {
  const task = { name: 'black_wall_banner', blockEntity: { Patterns: [{ Pattern: 'bo', Color: 0 }, { Pattern: 'ms', Color: 0 }] } }
  assert.deepEqual(bannerPatterns(task), [{ pattern: 'minecraft:border', color: 'white' }, { pattern: 'minecraft:stripe_middle', color: 'white' }])
  assert.deepEqual(bannerDifferences(task, { patterns: bannerPatterns(task) }), [])
  assert.deepEqual(bannerDifferences(task, { patterns: [] }), ['patterns'])
  const component = bannerItemComponents(task)[0]
  assert.equal(component.type, 'banner_patterns')
  assert.equal(component.data.layers[0].pattern.data.assetId, 'minecraft:border')
  assert.equal(component.data.layers[1].colorId, 0)
  assert.throws(() => bannerPatterns({ ...task, blockEntity: { Patterns: [{ Pattern: 'unknown', Color: 0 }] } }), /Unsupported/)
  assert.throws(() => bannerPatterns({ ...task, blockEntity: { Patterns: [{ Pattern: 'bo', Color: 16 }] } }), /color/)
})
