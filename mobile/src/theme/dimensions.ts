import { Platform } from 'react-native';

/**
 * Layout constants that are not spacing.
 */
export const dimensions = {
  /** Left/right padding for every screen. */
  screenPadding: 16,
  /**
   * Content is centred and capped at this width so the app stays readable on
   * tablets and foldables instead of stretching text across the display.
   */
  maxContentWidth: 640,
  /** Minimum tappable size, per the iOS and Android accessibility guidance. */
  touchTarget: 44,
  /** Minimum height of a pressable row or button. */
  controlHeight: 48,
  /** Height of the text input used in forms. */
  inputHeight: 48,
  /** Height of a small icon-only button. */
  iconButtonSize: 40,
  /** Border thickness used by inputs, cards and dividers. */
  hairline: 1,
  /** How wide a stat tile grid becomes before it splits into two columns. */
  twoColumnBreakpoint: 360,
} as const;

/**
 * Extra bottom padding for scroll content so the last row is never trapped
 * under the tab bar.
 */
export const scrollBottomInset = Platform.select({
  ios: 32,
  android: 24,
  default: 24,
});