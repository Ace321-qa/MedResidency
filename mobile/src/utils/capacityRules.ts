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
 * The picker shows the *declared limit* rather than a live occupancy. A live
 * count would have to be computed for whichever window the coordinator is about
 * to choose, and until that window is known any number shown would be invented —
 * `(0/3)` would claim the rotation is empty when it may be full. So the option
 * says what the rotation *allows* (`Internal Medicine (limit 3)`), and the
 * precise week-by-week count appears in the capacity banner once a window is
 * selected, which is the point at which the number is real.
 */
export function capacityOptionLabel(rotationName: string, capacity: number | null | undefined): string {
  if (capacity === null || capacity === undefined || capacity <= 0) {
    return `${rotationName} — No seat limit`;
  }
  return `${rotationName} (limit ${capacity})`;
}
