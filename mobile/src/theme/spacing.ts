/**
 * Spacing scale — a 4-point grid.
 *
 * Every margin, padding and gap in the app must come from here. If a layout
 * needs an odd number, the fix is a different token or a flex rule, never an
 * inline number.
 */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  giant: 48,
} as const;

export type SpacingToken = keyof typeof spacing;

/** Height of a list row that holds a title plus one line of metadata. */
export const ROW_MIN_HEIGHT = 64;