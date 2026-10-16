import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { colors, dimensions, radius, spacing } from '../theme';
import { Text } from './Text';

/**
 * Buttons.
 *
 * One component, four visual weights, because a screen should never invent a
 * fifth:
 *  - `primary`   the single most important action on a screen.
 *  - `secondary` a filled but quieter action (navy, used for tab-level CTAs).
 *  - `outline`   an equally valid alternative to primary.
 *  - `ghost`     low-emphasis, text-only.
 *  - `danger`    destructive or compliance-critical actions.
 *
 * Full width by default because most mobile actions are one-per-row. Loading
 * and disabled states are handled inside the component so no screen can forget.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: LucideIcon;
  iconPosition?: 'leading' | 'trailing';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  /** Announced by screen readers when the label alone is not enough. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon: Icon,
  iconPosition = 'leading',
  disabled = false,
  loading = false,
  fullWidth = true,
  accessibilityLabel,
  accessibilityHint,
  style,
}: ButtonProps) {
  const isInert = disabled || loading;
  const palette = BUTTON_VARIANTS[variant];
  const iconColor = isInert ? colors.disabledText : palette.foreground;

  return (
    <Pressable
      onPress={onPress}
      disabled={isInert}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isInert, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        fullWidth ? styles.fullWidth : null,
        { backgroundColor: isInert ? palette.inertBackground : palette.background },
        palette.borderColor ? { borderWidth: 1, borderColor: palette.borderColor } : null,
        pressed && !isInert ? { backgroundColor: palette.pressedBackground } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={iconColor} />
      ) : (
        <>
          {Icon && iconPosition === 'leading' ? <Icon color={iconColor} size={18} /> : null}
          <Text variant="button" style={{ color: isInert ? colors.disabledText : palette.foreground }}>
            {label}
          </Text>
          {Icon && iconPosition === 'trailing' ? <Icon color={iconColor} size={18} /> : null}
        </>
      )}
    </Pressable>
  );
}

interface IconButtonProps {
  icon: LucideIcon;
  onPress: () => void;
  /** Required: an icon alone tells a screen reader nothing. */
  accessibilityLabel: string;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Unread count shown as a dot badge; hidden when 0 or undefined. */
  badgeCount?: number;
}

/** A square, borderless icon button sized to the 44pt touch target. */
export function IconButton({
  icon: Icon,
  onPress,
  accessibilityLabel,
  tone = 'default',
  disabled = false,
  style,
  badgeCount,
}: IconButtonProps) {
  const color =
    tone === 'primary' ? colors.primary : tone === 'danger' ? colors.danger : colors.textPrimary;

  const showBadge = typeof badgeCount === 'number' && badgeCount > 0;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={
        showBadge ? `${accessibilityLabel}, ${badgeCount} unread` : accessibilityLabel
      }
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && !disabled ? { backgroundColor: colors.surfaceMuted } : null,
        disabled ? styles.inert : null,
        style,
      ]}
    >
      <Icon color={disabled ? colors.disabledText : color} size={20} />
      {showBadge ? (
        <View style={styles.badge} accessibilityElementsHidden importantForAccessibility="no">
          <Text variant="label" style={styles.badgeText}>
            {badgeCount > 9 ? '9+' : String(badgeCount)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

interface ButtonPalette {
  background: string;
  pressedBackground: string;
  inertBackground: string;
  foreground: string;
  borderColor?: string;
}

const BUTTON_VARIANTS: Record<ButtonVariant, ButtonPalette> = {
  primary: {
    background: colors.primary,
    pressedBackground: colors.primaryPressed,
    inertBackground: colors.disabled,
    foreground: colors.onPrimary,
  },
  secondary: {
    background: colors.secondary,
    pressedBackground: colors.primaryDark,
    inertBackground: colors.disabled,
    foreground: colors.onSecondary,
  },
  outline: {
    background: 'transparent',
    pressedBackground: colors.primarySoft,
    inertBackground: 'transparent',
    foreground: colors.primary,
    borderColor: colors.primaryBorder,
  },
  ghost: {
    background: 'transparent',
    pressedBackground: colors.surfaceMuted,
    inertBackground: 'transparent',
    foreground: colors.primary,
  },
  danger: {
    background: colors.danger,
    pressedBackground: colors.danger,
    inertBackground: colors.disabled,
    foreground: colors.onPrimary,
  },
};

const styles = StyleSheet.create({
  base: {
    minHeight: dimensions.controlHeight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  iconButton: {
    width: dimensions.touchTarget,
    height: dimensions.touchTarget,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: colors.onPrimary,
    fontSize: 10,
    lineHeight: 12,
  },
  inert: {
    opacity: 0.6,
  },
});