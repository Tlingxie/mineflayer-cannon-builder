# Observer construction gate

This opt-in Java 21 agent consumes observer startup pulses during a controlled
construction settling phase. It changes observer simulation while `HOLD` is
active. It never places blocks, edits block NBT, rewrites a world save, or starts
a Minecraft server.

Build locally with the existing official Minecraft and ASM cache:

```bash
node scripts/build-observer-gate.js
node --test test/observerGate.test.js
```

`buildObserverGate()` returns `agentJar`, `bridgeJar`, `sha256.agent`,
`sha256.bridge`, and `targetJarSha256`. The target checksum refers to the **inner**
`versions/1.21.4/server-1.21.4.jar`:

```text
de9538d2497c8f4174805f3fcedb8ade3060446aa203f351b820ea5bd04adbf4
```

Builds are published atomically beneath `.runtime/observer-gate/releases/<hash>`.
The hash covers the complete agent, bootstrap bridge and isolated test JARs.
Identical builds reuse the existing files after verifying their checksums;
changed builds return new paths and never overwrite a running JVM's JARs.

The builder also verifies the existing ASM 9.6 checksum. It does not download
dependencies. The integration test explicitly skips when the Minecraft cache
is absent. With the cache present, it transforms the actual official bytecode,
executes its two methods against isolated test objects, and checks an isolated
JVM with `-Xverify:all`. No test starts `MinecraftServer` or opens a world.

Keep the two JARs together. Before launching an explicitly selected clone, create
an absolute `observer-gate.control` file containing exactly `HOLD\n` or `OFF\n`
(the final newline is optional). Add this single JVM argument before `-jar`:

```text
-javaagent:/absolute/path/observer-gate-agent.jar=/absolute/clone/observer-gate.control
```

Replace the control file by atomic rename when changing its mode. A bootstrap
daemon reads it every 100 ms; both hooks also read it before deciding. A missing,
oversized, malformed or symbolic-link control file selects `HOLD` and marks
`controlValid=false`. Invalid control at startup exits the JVM with code 70.
The bridge depends only on JDK classes because the official launcher gives the
Minecraft class loader a platform parent, which cannot see system-loader agent
classes.

The same directory receives:

- `observer-gate-status.json`: atomically replaced status with numeric `pid`,
  `session`, `activeMode`, `controlValid`, `hooksReady`, `tickHook`,
  `startSignalHook`, `suppressedTicks`, `suppressedSignals`, `observedTicks`,
  `observedSignals`, `fallingTicksPassed`, `unsavedMarks`, `sequence` and `updatedAt`.
- `observer-gate-events.jsonl`: append-only session-tagged startup, control and
  hook records. Suppressed events include coordinates, gametime when available,
  and the world class. Every audit event is flushed to disk before returning.

The transformer only changes official `ObserverBlock` (`dpb`):

| Method | Official descriptor | HOLD behavior |
| --- | --- | --- |
| `tick` | `a(Ldwy;Lard;Lji;Lazh;)V` | Return only when `powered=false`; preserve the original true-to-false branch. |
| `startSignal` | `a(Ldgm;Ldgy;Lji;)V` | Return before scheduling a new observer tick. |

`OFF` falls through to the unchanged original method bodies. Fluid ticks,
piston events, redstone block implementations and world data are not patched.
After consuming a false observer tick, the injected branch calls the existing
chunk's `markUnsaved()` (`ard.m(Lji;)Ldzd; dzd.i()V`). This marks only save
metadata so normal chunk saving persists the consumed tick queue; it does not
change blocks or directly edit NBT. Without this mark, an otherwise unchanged
chunk could keep old scheduled ticks on disk. `unsavedMarks` and
`consumed-tick-chunk-dirty` audit events count successful calls. OFF, original
falling-edge ticks and suppressed `startSignal` calls receive no extra mark.
The original class SHA256 and expected two-method instruction structure are
checked. The runtime class must originate from the pinned inner JAR. A failed
transformation exits the JVM with code 71, because merely throwing from a
transformer would let the JVM continue loading the original class. Control
watcher failure exits with code 73. Runtime audit failure prevents the observer
method body from running and propagates an error.

Only `premain` is supported; no dynamic attach or retransformation is enabled.
The launcher must observe the expected live PID, `hooksReady=true`, valid
control and the requested mode before advancing any ticks. Before selecting
`OFF`, independently verify that all intended chunks are loaded, no observer
ticks remain queued, all 923 source observers are false and no moving pistons
remain. Suppression counters alone do not prove those conditions. Then use the
existing guarded single-tick checks and full original-blueprint validation.
Dropped startup events are consumed, not replayed when the gate opens. Fresh
events after `OFF` use normal observer behavior.

## Explicit missing-update replay on the isolated clone

The optional file request channel is limited to the current JVM on
`127.0.0.1:25567`, its exact working directory and `world` storage path. It accepts
only the 69 source piston bases with their original type/facing and four source
waterlogged top cobblestone slabs. `allowlist.txt` is checksum pinned and bound
to source SHA256 `8c2d8bf4dc8059cb083a28368da2efa1be2bd2dd4999d8b8062d115c4c758632`.

After a fresh gate process has observed an actual overworld observer callback,
its status reports `worldReady=true`. Create a JSON array containing only the
targets found missing by the current audit, for example:

```json
[{"type":"WATER_TICK","x":90,"y":-52,"z":15}]
```

Then explicitly request callbacks without advancing the world:

```bash
node scripts/request-vanilla-updates.js --game-time 25500 --operations /absolute/updates.json
```

Piston entries use `type: "PISTON_NEIGHBOR"`. The programmatic API is
`requestVanillaUpdates(operations, { expectedGameTime, signal })`. The helper
holds the clone operation lock, binds its current PID and gate session, and
publishes `observer-gate-request.txt` by atomic rename. No RCON or tick command
is sent. A published request is never automatically retried after timeout or
cancellation.

The daemon only submits a task to the server executor. That main-thread task
prevalidates the whole batch, then rechecks each item immediately before its
callback: correct clone/world, valid HOLD, frozen, zero pending steps, not
running game elements or sprinting, default tick rate, unchanged gametime,
already loaded target chunk, and the exact existing block type/properties.
It calls vanilla `neighborChanged` for pistons or schedules the existing slab's
water fluid with its vanilla five-tick delay, then marks that chunk unsaved.
It never directly writes a block, block entity, or saved NBT.

Durable request intents remain in `observer-gate-requests/<uuid>.intent`;
per-item before/after and results are appended to the existing gate journal.
`observer-gate-request-<uuid>.json` reports `succeeded` only after the callbacks
complete. This does **not** mean a piston extended or water appeared: vanilla
may do nothing or schedule retraction, and block events are not persisted across
JVM restarts. Keep the current process frozen until separately advancing guarded
ticks and auditing the original blueprint. Duplicate, unknown pending or failed
requests require inspection; they do not authorize replay after restart.
