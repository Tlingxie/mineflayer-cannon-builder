# Physical decorations and generated blocks

The strict builder supports armor stands, item frames, glow item frames, and paintings. It keeps the original schematic entity indices, rejects unknown entity types, and validates supported equipment, item contents, poses, flags, facing, rotation, and painting variants before building.

Workers place decorations with held items after every selected block layer has passed verification and construction supports have been removed. Decoration placement does not add block placement tasks or bypass the global bottom-to-top block barrier. Creative worker inventory items carry supported saved entity data; placement uses the normal item interaction path.

Decorations require an authoritative read-only snapshot backend. Before placing an entity, the worker checks for an existing matching entity and reuses it when its saved properties match. A mismatching existing entity fails the operation instead of creating a duplicate. Final verification checks every selected target and requires unique entity UUIDs. Read-only rechecks perform no placement or entity interaction.

The build report includes decorations in `entitiesExpected`, `entitiesVerified`, and `entitiesPending`, with separate `decorationsExpected`, `decorationsVerified`, and `decorationVerification` details. Decoration events are separate from block placement attempts. Minecarts retain their rail-dependent assembly order and their existing inventory and enabled-state verification.

Banner items preserve supported pattern layers. Final banner verification checks all selected banners against server block entity data, including read-only rechecks. Unknown patterns fail inspection.

Beds are planned as paired blocks of the same color and facing on one layer. Only the foot is an active placement task; its head is a `generated-by-bed` verification target. A missing or incorrect head prevents the next layer from starting. Door upper halves and other natural results likewise remain explicit final verification obligations.

Standing signs and banners use the top face of their lower support. Wall variants use a matching wall face, and ceiling hanging signs retain their required upper support. Supplying an item state does not replace the normal attachment checks for hanging signs.

With item state components enabled, matching slab items can use the occupied side half of a slab on the same layer as a safe placement reference. Merge regions and top or bottom faces remain excluded. This lets the builder finish adjacent slabs without changing an already completed slab.

Potted plants use a second item interaction after the empty pot has been placed. The secondary interaction belongs to the pot's current layer, so it cannot bypass the audit that protects completed lower layers.

Pressure plate power is treated as a runtime property during placement matching. Exact state differences remain recorded in the final report, so a plate activated by an entity is visible without forcing an unnecessary replacement.

Support planning can explicitly enable `stateControlledAttachments` for ceiling levers and hanging lanterns when the executing workers support item state components. These targets may use temporary references on their current layer; the builder still verifies and cleans that layer before advancing. The option defaults to disabled and does not extend to ceiling hanging signs.

Unsupported item components or entity customizations fail validation. Construction never substitutes a weaker entity check when authoritative readback is unavailable or reports a mismatch.
