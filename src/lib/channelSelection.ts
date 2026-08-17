/**
 * Lead-Yield Waste Fix — Channel Selection (UI side).
 *
 * Audit finding (MAST bottleneck audit, §2 Lead-Yield Funnel): the
 * discovery form (src/routes/dashboard.leads.tsx) previously initialized
 * `channels` to `["email", "phone"]` — i.e. every session silently opened
 * with the most expensive AND-combination pre-selected (see
 * channelFilter.ts's own docstring: requesting Email+Phone requires BOTH,
 * not either). In production this combination alone accounted for 1,104 of
 * 1,710 discovered candidates (64.6%) being pruned before ever reaching
 * enrichment (engine/execution_driver.py's `candidate_early_channel_pruned`).
 * A user who never touched the channel selector got the highest-waste
 * configuration by default, with no indication that was happening.
 *
 * This is a UI/default-selection fix only. It does NOT change:
 *   - channel semantics (AND stays AND — see channelFilter.ts /
 *     engine/execution_driver.py's required_channels handling, both
 *     untouched by this file)
 *   - which combinations are supported (every combination —
 *     ["email"], ["phone"], ["email","phone"], ["website","instagram"],
 *     etc. — remains exactly as selectable and exactly as enforced)
 *   - the request payload shape sent to the engine
 *
 * What it changes: the form's *default* is now an empty selection
 * (see dashboard.leads.tsx's `useState<ChannelId[]>(DEFAULT_CHANNELS)`)
 * so `canGenerate`'s existing `channels.length > 0` gate (unchanged)
 * naturally requires the user to make an explicit, conscious choice
 * before launching a session, instead of silently inheriting the most
 * expensive AND-combination.
 *
 * These helpers are extracted as plain, framework-free functions —
 * mirroring this repo's existing convention (see
 * src/lib/channelFilter.ts and its test src/lib/__tests__/channelFilter.test.ts)
 * — specifically so the "selected channels reach the engine request
 * unchanged" contract can be unit-tested without a React test harness
 * (this repo has none set up; see src/lib/__tests__ for the plain
 * node:test convention every existing "frontend" test here follows).
 */

/**
 * The form's initial channel selection. Deliberately empty — see module
 * docstring. `canGenerate` in dashboard.leads.tsx already requires
 * `channels.length > 0`, so an empty default means the Generate button
 * simply stays disabled (with an explicit "select a channel" message —
 * see dashboard.leads.tsx's warning block) until the user picks at least
 * one channel themselves. No channel, or combination of channels, is ever
 * silently assumed.
 */
export const DEFAULT_CHANNELS: readonly string[] = [];

/**
 * Toggle one channel id in/out of a selection, preserving the order the
 * rest of the selection was already in and never introducing a duplicate.
 * Pure — no framework dependency, no side effects — so dashboard.leads.tsx's
 * `setChannels((c) => toggleChannelSelection(c, id))` is the only call site
 * that needs to exist, and this function itself is fully unit-testable.
 */
export function toggleChannelSelection<T extends string>(current: readonly T[], id: T): T[] {
  return current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id];
}

/**
 * The pass-through-unchanged contract for the engine request.
 *
 * This is intentionally an identity operation (returns a shallow copy of
 * exactly what was selected, same values, same order) — no dedup, no sort,
 * no OR-conversion, no filtering happens here or anywhere between this
 * function and the `channels` field in the `generate.mutateAsync({...})`
 * call in dashboard.leads.tsx. It exists as a *named, tested* unit so that
 * invariant is an explicit contract rather than an implicit assumption at
 * the call site — see the test file for the exact combinations this is
 * proven against (matches tests/test_dynamic_channel_pruning.py's list on
 * the Python side, and channelFilter.test.ts's list on the Node side).
 */
export function channelsForRequest<T extends string>(selected: readonly T[]): T[] {
  return [...selected];
}
