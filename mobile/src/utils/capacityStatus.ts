import { colors } from '../theme';
import { capacityLabel } from './capacityRules';
import type { OccupancyStatus } from '../types/api';

/**
 * How an overcapacity verdict is coloured.
 *
 * The tier table itself lives on the server (`src/utils/occupancy.js`), which is
 * the authority: the client renders whatever verdict it is handed rather than
 * re-deriving one, so a change to the thresholds cannot leave the banner and the
 * enforcement disagreeing.
 *
 * What lives here is the *presentation* — the label, the summary, and the
 * colours. The words come from `capacityRules.ts` (pure, so it is directly
 * testable); only the palette is here, because a colour needs the theme.
 *
 * The five tiers are kept visually distinct on purpose: a single week over the
 * limit is an accident, two weeks is a pattern, and a locked limit is a refusal,
 * so collapsing them into one "warning" colour would hide the only distinction
 * that changes what the user does next.
 */

export interface CapacityTone {
  label: string;
  summary: string;
  foreground: string;
  surface: string;
  border: string;
}

const COLORS: Record<OccupancyStatus, { foreground: string; surface: string; border: string }> = {
  GREEN: { foreground: colors.success, surface: colors.successSurface, border: colors.success },
  AMBER: { foreground: colors.warning, surface: colors.warningSurface, border: colors.warning },
  REVIEW: { foreground: colors.warning, surface: colors.warningSurface, border: colors.warning },
  RED: { foreground: colors.danger, surface: colors.dangerSurface, border: colors.danger },
  BLOCKED: { foreground: colors.danger, surface: colors.dangerSurface, border: colors.danger },
};

/** The presentation for an occupancy status, defaulting to the within-capacity case. */
export function capacityTone(status: OccupancyStatus | null | undefined): CapacityTone {
  const key: OccupancyStatus = status ?? 'GREEN';
  const words = capacityLabel(key);
  const palette = COLORS[key] ?? COLORS.GREEN;
  return { ...words, ...palette };
}

export { capacityOptionLabel, isAtCapacity } from './capacityRules';
