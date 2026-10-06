const fs = require('node:fs/promises')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { readPlan } = require('../lib/strictSchematic')
const { auditWorld } = require('../lib/worldAudit')

async function main (args = process.argv.slice(2)) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--world', '--schematic', '--origin', '--version', '--max-y', '--output'].includes(flag) || !value || options[flag]) throw new Error('Expected --world, --schematic, --origin x,y,z, optional --version, --max-y, --output')
    options[flag] = value
  }
  if (!options['--world'] || !options['--schematic'] || !options['--origin']) throw new Error('--world, --schematic and --origin are required; use a flushed backup world')
  const origin = options['--origin'].split(',').map(Number)
  if (origin.length !== 3 || !origin.every(Number.isSafeInteger)) throw new Error('Invalid origin')
  const maxLayer = options['--max-y'] === undefined ? Infinity : Number(options['--max-y'])
  const plan = await readPlan(options['--schematic'], options['--version'] || '1.21.4', new Vec3(...origin))
  const report = await auditWorld({ plan, regionDirectory: path.join(options['--world'], 'region'), maxLayer })
  if (options['--output']) await fs.writeFile(path.resolve(options['--output']), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ verified: report.verified, completeBlueprint: report.completeBlueprint, checkedBlocks: report.checkedBlocks, checkedAir: report.checkedAir, activeMismatches: report.activeMismatches.length, derivedPending: report.derivedPending.length, occupiedAir: report.occupiedAir.length, runtimeStateDifferences: report.runtimeStateDifferences.length, chunksRead: report.chunksRead, output: options['--output'] && path.resolve(options['--output']) }))
  if (!report.verified) process.exitCode = 1
  return report
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { main }
