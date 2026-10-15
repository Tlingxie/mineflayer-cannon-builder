# Physical decorations and generated blocks

The strict builder supports armor stands, item frames, glow item frames, and paintings. It keeps the original schematic entity indices, rejects unknown entity types, and validates supported equipment, item contents, poses, flags, facing, rotation, and painting variants before building.

Workers place decorations with held items after every selected block layer has passed verification and construction supports have been removed. Decoration placement does not add block placement tasks or bypass the global bottom-to-top block barrier. Creative worker inventory items carry supported saved entity data; placement uses the normal item interaction path.

Decorations require an authoritative read-only snapshot backend. Before placing an entity, the worker checks for an existing matching entity and reuses it when its saved properties match. A mismatching existing entity fails the operation instead of creating a duplicate. Final verification checks every selected target and requires unique entity UUIDs. Read-only rechecks perform no placement or entity interaction.

The build report includes decorations in `entitiesExpected`, `entitiesVerified`, and `entitiesPending`, with separate `decorationsExpected`, `decorationsVerified`, and `decorationVerification` details. Decoration events are separate from block placement attempts. Minecarts retain their rail-dependent assembly order and their existing inventory and enabled-state verification.

Banner items preserve supported pattern layers. Final banner verification checks all selected banners against server block entity data, including read-only rechecks. Unknown patterns fail inspection.

Beds are planned as paired blocks of the same color and facing on one layer. Only the foot is an active placement task; its head is a `generated-by-bed` verification target. A missing or incorrect head prevents the next layer from starting. Door upper halves and other natural results likewise remain explicit final verification obligations.

Unsupported item components or entity customizations fail validation. Construction never substitutes a weaker entity check when authoritative readback is unavailable or reports a mismatch.
