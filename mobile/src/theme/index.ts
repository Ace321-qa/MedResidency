/**
 * The MedResidency design system.
 *
 * Screens and components import from `@/theme` only. Nothing else in the app
 * should contain a raw hex value, an arbitrary font size or a magic number for
 * padding — that is what keeps the interface consistent when it grows.
 */
import { colors, toneColors, type Tone } from './colors';
import { dimensions, scrollBottomInset } from './dimensions';
import { radius } from './radius';
import { shadow } from './shadow';
import { spacing } from './spacing';
import { typography, type TypographyVariant } from './typography';

export {
  colors,
  toneColors,
  dimensions,
  radius,
  shadow,
  spacing,
  typography,
  scrollBottomInset,
};
export type { Tone, TypographyVariant };

export const theme = {
  colors,
  spacing,
  radius,
  shadow,
  typography,
  dimensions,
} as const;