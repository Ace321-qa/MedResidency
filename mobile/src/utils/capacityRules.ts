import type { OccupancyStatus } from '../types/api';

/**
 * The words that describe an overcapacity verdict — no colours, no React Native.
 *
 * Kept apart from `capacityStatus.ts`, which colours these, so this can be
 * compiled and checked by `scripts/verify-capacity.ts` under plain Node. The
 * tier table itself lives on the server (`src/utils/occupancy.js`) and is the
 * authority; what is here is only how a verdict is *described* once the server
 * has decided it.
 */

export interface CapacityLabel {
  /** Short label, e.g. "Over capacity". */
  label: string;
  /** One-line summary of what the tier means for the coordinator. */
  summary: string;
}

const LABELS: Record<OccupancyStatus, CapacityLabel> = {
  GREEN: {
    label: 'Within capacity',
    summary: 'Every week of this placement is inside the departmental seat limit.',
  },
  AMBER: {
    label: 'Over capacity',
    summary: 'One week is over the limit — a logged rationale is required.',
  },
  REVIEW: {
    label: 'Sustained overcapacity',
    summary: 'Over the limit for two weeks — this needs review before it becomes routine.',
  },
  RED: {
    label: 'Significant overcapacity',
    summary: 'Well over the limit — an explicit programme-lead override is required.',
  },
  BLOCKED: {
    label: 'Locked limit',
    summary: 'This department has locked its seat limit; the placement cannot be made.',
  },
};

/** The label and summary for a status, defaulting to the within-capacity case. */
export function capacityLabel(status: OccupancyStatus | null | undefined): CapacityLabel {
  if (!status) return LABELS.GREEN;
  return LABELS[status] ?? LABELS.GREEN;
}

/**
 * The label for a rotation in the assignment picker.
 *
 * When the live occupancy for the block is known the label carries it —
 * `Internal Medicine Inpatient Wards (3/3 - FULL)` — so a coordinator can see a
 * department is full *before* tapping it, rather than after. Without an
 * occupancy figure only the declared limit can honestly be shown, because a
 * blank `0/3` would claim a rotation is empty when it may be full.
 */
export function capacityOptionLabel(
  rotationName: string,
  capacity: number | null | undefined,
  occupied?: number | null,
): string {
  if (capacity === null || capacity === undefined || capacity <= 0) {
    return `${rotationName} — No seat limit`;
  }
  if (occupied === null || occupied === undefined) {
    return `${rotationName} (limit ${capacity})`;
  }
  const full = occupied >= capacity;
  return `${rotationName} (${occupied}/${capacity}${full ? ' - FULL' : ''})`;
}

/** True when a rotation is at or past its limit, so a chip can be tinted. */
export function isAtCapacity(
  capacity: number | null | undefined,
  occupied: number | null | undefined,
): boolean {
  if (capacity === null || capacity === undefined || capacity <= 0) return false;
  return (occupied ?? 0) >= capacity;
}
