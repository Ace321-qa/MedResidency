/**
 * Corner radii. Kept small and consistent — heavily rounded shapes read as
 * consumer apps, not clinical software.
 */
export const radius = {
  /** Inputs, small chips. */
  sm: 6,
  /** Cards, list containers, buttons. */
  md: 10,
  /** Sheets and modals. */
  lg: 14,
  /** Avatars and badges. */
  pill: 999,
} as const;

export type RadiusToken = keyof typeof radius;