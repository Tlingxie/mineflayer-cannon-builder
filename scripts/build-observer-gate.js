#!/usr/bin/env node
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const ROOT = path.resolve(__dirname, '..')
const TARGET_SHA256 = 'de9538d2497c8f4174805f3fcedb8ade3060446aa203f351b820ea5bd04adbf4'
const ASM_SHA256 = '3c6fac2424db3d4a853b669f4e3d1d9c3c552235e19a319673f887083c2303a1'
const hash = async filename => crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex')

async function buildObserverGate ({ outputDirectory = path.join(ROOT, '.runtime/observer-gate') } = {}) {
  const targetJar = path.join(ROOT, '.runtime/server/versions/1.21.4/server-1.21.4.jar')
  const libraryDirectory = path.join(ROOT, '.runtime/server/libraries')
  const asmJar = path.join(libraryDirectory, 'org/ow2/asm/asm/9.6/asm-9.6.jar')
  if (await hash(targetJar) !== TARGET_SHA256) throw new Error('Official inner server-1.21.4.jar hash mismatch')
  if (await hash(asmJar) !== ASM_SHA256) throw new Error('Bundled ASM 9.6 hash mismatch')
  outputDirectory = path.resolve(outputDirectory)
  await fs.mkdir(outputDirectory, { recursive: true })
  const lockPath = path.join(outputDirectory, '.build-lock')
  const lock = await fs.open(lockPath, 'wx', 0o600)
  const temporary = await fs.mkdtemp(path.join(outputDirectory, 'build-'))
  try {
    const bridgeClasses = path.join(temporary, 'bridge')
    const agentClasses = path.join(temporary, 'agent')
    const asmClasses = path.join(temporary, 'asm')
    const testClasses = path.join(temporary, 'test-classes')
    const publication = path.join(temporary, 'release')
    for (const directory of [bridgeClasses, agentClasses, asmClasses, testClasses, publication]) await fs.mkdir(directory, { recursive: true })
    const source = path.join(ROOT, 'server-tools/observer-gate/src/observergate')
    await run('javac', ['--release', '21', '-d', bridgeClasses, path.join(source, 'bridge/GateBridge.java'), path.join(source, 'bridge/VanillaUpdates.java')])
    const allowlist = path.join(ROOT, 'server-tools/observer-gate/allowlist.txt')
    if (await hash(allowlist) !== 'cfab00df298d498acbe8779ca01655ed4427f8edc234693c04c3c9d4c4162f96') throw new Error('Pinned source update allowlist hash mismatch')
    await fs.copyFile(allowlist, path.join(bridgeClasses, 'observer-gate-allowlist.txt'))
    await run('javac', ['--release', '21', '-cp', asmJar, '-d', agentClasses, path.join(source, 'ObserverTransformer.java'), path.join(source, 'ObserverGateAgent.java')])
    await fs.writeFile(path.join(agentClasses, 'observer-gate-target.properties'), `targetJarUri=${pathToFileURL(targetJar).href}\n`)
    await run('jar', ['--extract', '--file', asmJar], { cwd: asmClasses })
    await fs.rm(path.join(asmClasses, 'META-INF'), { recursive: true, force: true })
    await fs.rm(path.join(asmClasses, 'module-info.class'), { force: true })
    const manifest = path.join(temporary, 'MANIFEST.MF')
    await fs.writeFile(manifest, 'Manifest-Version: 1.0\nPremain-Class: observergate.ObserverGateAgent\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n\n')
    const agentJar = path.join(publication, 'observer-gate-agent.jar')
    const bridgeJar = path.join(publication, 'observer-gate-bridge.jar')
    const testJar = path.join(publication, 'observer-gate-tests.jar')
    const jarDate = '--date=2024-01-01T00:00:00Z'
    await run('jar', ['--create', '--file', bridgeJar, jarDate, '-C', bridgeClasses, '.'])
    await run('jar', ['--create', '--file', agentJar, jarDate, '--manifest', manifest, '-C', agentClasses, '.', '-C', asmClasses, '.'])
    const testSource = path.join(ROOT, 'server-tools/observer-gate/test')
    await run('javac', ['--release', '21', '-cp', [agentJar, bridgeJar].join(path.delimiter), '-d', testClasses, path.join(testSource, 'GateBehaviorTest.java'), path.join(testSource, 'GateClassLoaderTest.java'), path.join(testSource, 'VanillaUpdatesTest.java')])
    await run('jar', ['--create', '--file', testJar, jarDate, '-C', testClasses, '.'])
    const sha256 = { agent: await hash(agentJar), bridge: await hash(bridgeJar), tests: await hash(testJar) }
    const releaseHash = crypto.createHash('sha256').update(`${sha256.agent}\n${sha256.bridge}\n${sha256.tests}\n`).digest('hex')
    const releaseDirectory = path.join(outputDirectory, 'releases', releaseHash)
    await fs.mkdir(path.dirname(releaseDirectory), { recursive: true })
    let published
    try { published = await fs.lstat(releaseDirectory) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (published) {
      if (!published.isDirectory() || published.isSymbolicLink()) throw new Error('Observer gate release is not an owned directory')
      for (const [kind, filename] of [['agent', agentJar], ['bridge', bridgeJar], ['tests', testJar]]) {
        const existing = path.join(releaseDirectory, path.basename(filename))
        if (!(await fs.lstat(existing)).isFile() || await hash(existing) !== sha256[kind]) throw new Error('Published observer gate release checksum mismatch')
      }
    } else await fs.rename(publication, releaseDirectory)
    return { agentJar: path.join(releaseDirectory, path.basename(agentJar)), bridgeJar: path.join(releaseDirectory, path.basename(bridgeJar)), sha256, targetJarSha256: TARGET_SHA256, targetJar, asmJar, libraryDirectory, testClasses: path.join(releaseDirectory, path.basename(testJar)) }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
    await lock.close()
    await fs.unlink(lockPath)
  }
}

if (require.main === module) buildObserverGate().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { buildObserverGate }
