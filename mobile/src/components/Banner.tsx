import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { X } from 'lucide-react-native';

import { colors, radius, spacing, toneColors, type Tone } from '../theme';
import { Text } from './Text';

/**
 * Banner — a prominent, full-width message about the state of the data.
 *
 * Used for duty-hour breaches, offline notices and failed submissions. Because
 * a banner can be the only thing standing between a resident and a compliance
 * problem, it always pairs a colour with an icon *and* a bold text label, and
 * its text starts with the label rather than burying it.
 *
 * `onDismiss` is for *resolvable* banners — a rejected import, for instance.
 * Breaches and offline notices are never dismissable: hiding a compliance
 * problem with an X would be worse than never showing it.
 */

type BannerIcon = LucideIcon;

interface BannerProps {
  tone: Tone;
  title: string;
  message?: string;
  icon?: BannerIcon;
  /** Optional action, e.g. "Retry". */
  action?: ReactNode;
  /** Shows a close control. Only pass it when the condition can genuinely clear. */
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function Banner({ tone, title, message, icon: Icon, action, onDismiss, style }: BannerProps) {
  const palette = toneColors[tone];

  return (
    <View
      style={[styles.container, { backgroundColor: palette.surface, borderColor: palette.border }, style]}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={message ? `${title}. ${message}` : title}
    >
      <View style={[styles.iconRail, { backgroundColor: palette.foreground }]}>
        {Icon ? <Icon color={colors.onPrimary} size={16} strokeWidth={2.4} /> : null}
      </View>

      <View style={styles.body}>
        <Text variant="h3" style={{ color: palette.foreground }}>
          {title}
        </Text>
        {message ? (
          <Text variant="bodySmall" style={[styles.message, { color: palette.foreground }]}>
            {message}
          </Text>
        ) : null}
        {action ? <View style={styles.action}>{action}</View> : null}
      </View>

      {onDismiss ? (
        <Pressable
          onPress={onDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Dismiss message"
          style={styles.close}
        >
          <X color={palette.foreground} size={16} strokeWidth={2.6} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  iconRail: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
  message: {
    opacity: 0.95,
  },
  action: {
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
  },
  close: {
    alignSelf: 'flex-start',
    padding: spacing.xxs,
  },
});