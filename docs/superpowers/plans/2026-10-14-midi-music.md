# MIDI Redstone Music Implementation Plan

**Goal:** Import a MIDI file in the local construction console, generate a downloadable physical note-block redstone track, and build it through the existing strict layer scheduler.

**Design:** Parse Standard MIDI files locally, preserve tempo changes and simultaneous note onsets, quantize to 100 ms redstone ticks, and compile a passive repeater delay line with isolated note branches. Instruments come from actual support materials. A button starts playback. The console uses its existing origin, worker count, preview and build flow.

**Constraints:** Minecraft Java 1.21.11; real bot movement and placement; active placement strictly bottom-up; no automatic server tick changes. Unsupported inputs or oversized tracks fail explicitly. Note sustains, velocity and pitch bends cannot be reproduced by ordinary note blocks and are described in the conversion summary. Out-of-range pitches fold by octaves, with counts shown.

## Interfaces

- `lib/midiMusic.js`: `compileMidi(buffer, { version, title })` returns `{ schematic: Buffer, music }`. The music summary contains `noteCount`, `sourceNoteCount`, `durationSeconds`, `quantumSeconds`, `maxTimingErrorMs`, `octaveAdjustedNotes`, `deduplicatedNotes`, `instruments`, `start`, `warnings`.
- The generated Sponge schematic uses ordinary blocks with exact note/instrument states; `sourceMin` is `{ x: 0, y: 0, z: 0 }` so the existing origin selector works.
- `WebBuildManager.upload()` accepts `.mid/.midi`, stores the generated `.schem`, inspects it through the existing subprocess, and returns the usual blueprint plus `music`, `downloadUrl`, and `sourceFilename`.
- `GET /api/blueprints/<id>/download` serves only the registered generated schematic.
- Final music validation checks every note block's pitch, instrument and clear space above, using live world reads.

## Tasks

- [x] Write failing parser/compiler tests for tempo changes, running status, chords, note range, malformed input and limits; implement the MIDI parser and deterministic schematic compiler.
- [x] Write failing manager/server tests for MIDI import and safe download; implement upload conversion and the existing-page music summary/download UI.
- [x] Write failing note-block validation tests; implement and connect final live note/instrument/headroom validation.
- [x] Verify the physical redstone layout and playback in an isolated 1.21.11 server using real bots, without modifying the user's target server.
- [ ] Run relevant and full tests, review changes, verify the webpage upload flow and save visual evidence.
- [ ] Document the supported conversion behavior and publish sanitized source to the existing public repository.

## Circuit Contract

Each module occupies four X blocks and contributes one to four redstone ticks. The clock line is at Y=3; an eastward signal uses repeaters whose block-state `facing` is `west`. A repeater feeds a solid block, then two dust blocks, then the next repeater. Branch dust at Y=3 strongly powers its solid support at Y=2; note blocks sit beside that support at Y=2 and have instrument material at Y=1, supported by stone at Y=0 so sand cannot fall. Their upper Y=3 cells remain air. Branches are isolated across modules. The initial floor button is at Y=4. Tests must prove actual note events and relative timing, rather than only block counts.
