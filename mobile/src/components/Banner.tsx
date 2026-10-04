import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { colors, radius, spacing, toneColors, type Tone } from '../theme';
import { Text } from './Text';

/**
 * Banner — a prominent, full-width message about the state of the data.
 *
 * Used for duty-hour breaches, offline notices and failed submissions. Because
 * a banner can be the only thing standing between a resident and a compliance
 * problem, it always pairs a colour with an icon *and* a bold text label, and
 * its text starts with the label rather than burying it.
 */

type BannerIcon = LucideIcon;

interface BannerProps {
  tone: Tone;
  title: string;
  message?: string;
  icon?: BannerIcon;
  /** Optional action, e.g. "Retry". */
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Banner({ tone, title, message, icon: Icon, action, style }: BannerProps) {
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
});