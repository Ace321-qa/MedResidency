import type { ReactNode } from 'react';
import { StyleSheet, Text as RNText, type TextProps, type TextStyle } from 'react-native';

import { colors, typography, type TypographyVariant } from '../theme';

/**
 * Every piece of text in the app goes through this component.
 *
 * Why: it is the only way to guarantee the type scale is respected. Screens pick
 * a *variant* (`h1`, `body`, `caption`...) and an optional *tone*, never a raw
 * font size or colour, so headings stay distinguishable from body copy on every
 * screen.
 */

/** Semantic text colours. Use these, not hex values. */
export type TextTone =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'inverse'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'disabled';

const TONE_COLORS: Record<TextTone, string> = {
  primary: colors.textPrimary,
  secondary: colors.textSecondary,
  muted: colors.textMuted,
  inverse: colors.textInverse,
  brand: colors.primary,
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
  disabled: colors.disabledText,
};

export interface AppTextProps extends TextProps {
  variant?: TypographyVariant;
  tone?: TextTone;
  /** Convenience for `textAlign`. */
  align?: TextStyle['textAlign'];
  /** Renders the variant's label style but in normal case, for inline labels. */
  uppercase?: boolean;
  children?: ReactNode;
}

export function Text({
  variant = 'body',
  tone = 'primary',
  align,
  uppercase,
  style,
  children,
  ...rest
}: AppTextProps) {
  return (
    <RNText
      {...rest}
      style={[
        typography[variant],
        { color: TONE_COLORS[tone] },
        uppercase ? styles.uppercase : null,
        align ? { textAlign: align } : null,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

const styles = StyleSheet.create({
  uppercase: {
    textTransform: 'uppercase',
  },
});