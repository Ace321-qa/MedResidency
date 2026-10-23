# MedResidency — AGENTS.md

This file is guidance for AI coding agents working on the MedResidency codebase. It defines the role, the system architecture, the active bug fix, and the verification gates every change must pass.

---

## ROLE & SYSTEM ARCHITECTURE DIRECTIVE

Act as **Lead Full-Stack Application Architect, Database Architect, and Senior Express/React Native Specialist** for MedResidency.

Primary files under your stewardship:

- `src/utils/occupancy.js` — pure weekly occupancy engine (the authority for capacity tiers)
- `src/services/rotationCapacityService.js` — service layer: loads rotation limits, fetches existing assignments, calls the engine, enforces exceptions
- `src/controllers/rotationController.js` — `checkCapacity` endpoint (reads `rotation_block_id` server-side, never trusts client dates)
- `mobile/src/app/program/master/grid.tsx` — Master Rotation Grid screen: assignment modal, capacity preview, seat tags, overcapacity banner
- `mobile/src/services/rotations.ts` — `checkAssignmentCapacity` API client
- `mobile/src/utils/capacityRules.ts` / `capacityStatus.ts` — client-side capacity labels and tones (presentation only; the server decides the tier)

### Core architectural rule

**The server is the single authority for occupancy.** `utils/occupancy.js` is a pure function: same inputs, same verdict. The server uses it to decide whether a write may proceed; the mobile app calls the same endpoint to render the same banner *before* the write is attempted. Two implementations would eventually disagree, and the one the user sees would be the one that is wrong. The client must never re-derive a capacity tier — it renders the verdict it is handed.

---

## CRITICAL BUG FIX — MASTER ROTATION GRID CAPACITY VALIDATION

### The bug

In the Master Rotation Grid capacity validation engine, the occupancy evaluator incorrectly sums/accumulates resident assignment counts across consecutive blocks (e.g., combining Block 5 and Block 6 assignments). When assigning a resident in Block 6 (`2026-11-15` to `2026-12-12`), the system evaluates total residents from both Block 5 AND Block 6 (reporting 5 residents / overcapacity) instead of scoping calculations strictly to Block 6's specific weekly date range.

### Root cause

The backend already supports block-scoped occupancy:
- `evaluateOccupancy` accepts a `block_window` parameter and filters both proposal weeks and existing assignments to the block's date range
- `loadConcurrentAssignments` applies `start_date <= block.end_date AND end_date >= block.start_date`
- The `checkCapacity` controller reads `rotation_block_id` from the request body, loads the block server-side by id, and passes the block window to `checkPlacement`
- The **write path** (`handleAssign` in grid.tsx) already sends `rotation_block_id`

The **preview path** does not. `checkAssignmentCapacity` is called in `grid.tsx` without `rotation_block_id`, and the service type in `rotations.ts` does not accept it. Without the block id, the server cannot load the block window, block-scoping is disabled, and prior-block assignments leak into the current block's occupancy count.

---

## 1. BACKEND OCCUPANCY ENGINE SCOPING FIX

**Files:** `src/utils/occupancy.js`, `src/services/rotationCapacityService.js`

The backend already implements block scoping. Your job when touching these files is to **preserve and not regress** the following contracts:

### 1.1 Date-scoped block isolation

When evaluating weekly occupancy for a target rotation assignment in a specific Block (e.g., Block 6: `2026-11-15` to `2026-12-12`):

- The date query MUST strictly constrain active assignment records to dates overlapping the target Block's date window:
  `assignment.start_date <= block.end_date AND assignment.end_date >= block.start_date`
- DO NOT include active assignments from prior blocks (e.g., Block 5: `2026-10-18` to `2026-11-14`) whose date bounds ended before the target block started.
- The block window is always read server-side by `rotation_block_id` (in `rotationController.checkCapacity`); a client-supplied window is never trusted for scoping.

### 1.2 Weekly deduplication logic

For each week $W$ within the target Block window:

- Count the **DISTINCT** resident IDs (`resident_id`) physically assigned to that rotation during week $W$.
- Duplicate database rows or multi-segment assignments for a single resident in the same week count as **1 resident**, not multiple (engine uses a `Set` of `r:<resident_id>` per week).
- Peak weekly occupancy = `MAX(count(DISTINCT resident_id))` across the weeks of the target Block.

### 1.3 What must not change

- `evaluateOccupancy` must remain a pure function over plain data.
- When `block_window` is omitted or unreadable, the engine falls back to the proposal's own window (backward-compatible behavior) — callers must always supply a real block when one is known.
- The tier table (GREEN/AMBER/REVIEW/RED/BLOCKED) and the `classifyOccupancy` thresholds stay as defined in `occupancy.js`.

### 1.4 Date-scoped block isolation (cross-program isolation)

**File:** `src/services/rotationService.js` — `getCohortGrid` correlated subquery for `rotation_block_occupancy`

The `rotation_block_occupancy` figure that the grid cell tag, modal chip, and picker label all read must count **all residents whose assignment dates overlap the viewed block's date window**, including visiting residents from other programmes. This is the correct cross-programme behaviour: an FM resident visiting IM-WARDS during IM's Block 5 counts in IM's grid, because they are physically present in IM's department during those dates.

- The `COUNT(DISTINCT occ_rra.resident_id)` subquery MUST use date-overlap against the viewed block's window:
  ```sql
  AND occ_rra.start_date <= rb.end_date
  AND occ_rra.end_date >= rb.start_date
  ```
- `DISTINCT` resident IDs must be used so duplicate rows count as one person.
- Do NOT add `program_id` or `rotation_block_id` filters to this subquery — those would exclude visiting residents from other programmes who are physically present during the block's dates.
- `DISTINCT` resident IDs must still be used so duplicate rows count as one person.
- The **capacity pool is `rotation_id`** (= `rotations.max_capacity`), matching the
  write path `loadConcurrentAssignments` (`WHERE rotation_id = ? AND start_date <= ?
  AND end_date >= ?`). The read subquery and the write path MUST agree.
- **There is no shared department/service capacity pool in the schema** (capacity is
  per-`rotation_id`: `max_capacity` / `capacity_locked`). Do NOT group by
  `department_name` / `rotation_name`; that would invent a pool the write path does
  not enforce. (Schema limitation — reported, not worked around.)
- `academic_year` is **never** a filter in this subquery — date overlap is the sole
  criterion. Academic-year spelling (`2026-2027` vs `2026/2027`) is data hygiene only.

---

## 2. FRONTEND SEAT COUNTER & CALLOUT SYNCHRONIZATION

**File:** `mobile/src/app/program/master/grid.tsx` (primary)
**Supporting:** `mobile/src/services/rotations.ts`, `mobile/src/utils/capacityRules.ts`

### 2.1 Send `rotation_block_id` on the capacity preview

The `checkAssignmentCapacity` call in the `useEffect` (grid.tsx, around line 602) must include `rotation_block_id` taken from `targetWindow.blockId`:

```ts
checkAssignmentCapacity({
  rotation_id: assignRotationId,
  program_id: programId ?? undefined,
  resident_id: selected?.residentId ?? undefined,
  rotation_block_id: targetWindow.blockId,   // <-- required; was missing
  start_date: targetWindow.start,
  end_date: targetWindow.end,
})
```

`targetWindow` already resolves `blockId` from `blocksByNumber` (stored block dates win over grid arithmetic). Do not substitute `selected.blockId` directly — use `targetWindow.blockId`, which is the resolved, stored-date-backed block id.

### 2.2 Accept `rotation_block_id` in the service client

In `mobile/src/services/rotations.ts`, extend the `checkAssignmentCapacity` payload type:

```ts
export async function checkAssignmentCapacity(payload: {
  rotation_id: number;
  start_date: string;
  end_date: string;
  program_id?: number;
  resident_id?: number;
  exclude_assignment_id?: number;
  rotation_block_id?: number;   // <-- add
}): Promise<CapacityVerdict> { ... }
```

Forward it in the request body unchanged.

### 2.3 Grid cell & modal badge parity

Ensure the following all derive from the **exact same date-scoped occupancy formula** (the server verdict, rendered by the client — never re-derived locally):

1. The dropdown chip label, e.g. `Internal Medicine Inpatient Wards (1/3)` — built by `capacityOptionLabel` using `live?.occupied` from `occupancyByRotation` (which reads `rotation_block_occupancy` from grid data, keyed by block).
2. The inline cell counter tag, e.g. `3/3 - Full` — built by `capacityNotation` using `row.rotation_block_occupancy`.
3. The overcapacity warning banner (`CapacityBanner`) — driven by `activeVerdict` from the server.

If Block 6 has 1 active resident assigned against a capacity limit of 3:

- Display `1/3` seats used.
- Render Green / Allowed status.
- DO NOT trigger the Red overcapacity banner unless the **distinct resident count within Block 6's dates** actually exceeds 3.

No Block 5 totals may leak into Block 6.

---

## 3. VERIFICATION & QUALITY CHECKS

Every change must pass all of the following before the task is considered done.

### 3.1 Static type checking & syntax

| Command | Expected |
|---|---|
| `node --check src/server.js` | Exit clean, code 0 |
| `cd mobile && npx tsc --noEmit` | Exit clean, code 0 |
| `cd mobile && npx expo lint` | Exit clean, code 0 |

### 3.2 Functional test verification

1. Assign 3 residents to Internal Medicine in Block 5 (Block 5 total = 3/3).
2. Assign 1 resident to Internal Medicine in Block 6 (Block 6 total = 1/3).
3. Open the Assign Modal for another resident in Block 6.
4. CONFIRM:
   - The seat counter reads `1/3` (or `2/3` with the proposal).
   - Status shows Green / Available.
   - No Block 5 totals leak into Block 6 (no Red overcapacity banner).

### 3.3 Regression checklist

When editing `occupancy.js`, `rotationCapacityService.js`, `rotationController.js`, `grid.tsx`, `rotations.ts`, or `capacityRules.ts`:

- [ ] Block-scoping contract preserved: `start_date <= block.end_date AND end_date >= block.start_date`
- [ ] Weekly dedupe via `Set` of resident IDs retained (no row-counting)
- [ ] Frontend sends `rotation_block_id` on `checkAssignmentCapacity`
- [ ] Frontend never re-derives a capacity tier; renders the server verdict
- [ ] `targetWindow.blockId` (resolved from stored block dates) is used, not a client-computed fallback
- [ ] All three verification commands exit 0
- [ ] Functional test (3 residents Block 5 + 1 resident Block 6 → Block 6 reads 1/3 Green) passes

