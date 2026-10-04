import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { colors, radius, spacing, toneColors, type Tone } from '../theme';
import { Text } from './Text';

/**
 * StatTile — one number with a label, used in a row of two or three.
 *
 * Kept deliberately plain: a figure, a caption, and an optional icon. On a
 * clinical dashboard the numbers carry the meaning, so they are the only thing
 * that gets emphasis.
 */
interface StatTileProps {
  value: string;
  label: string;
  icon?: LucideIcon;
  tone?: Tone;
  /** Supporting line under the label. */
  caption?: string;
  style?: StyleProp<ViewStyle>;
}

export function StatTile({ value, label, icon: Icon, tone = 'neutral', caption, style }: StatTileProps) {
  const palette = toneColors[tone];

  return (
    <View
      style={[styles.tile, style]}
      accessible
      accessibilityLabel={`${label}: ${value}${caption ? `. ${caption}` : ''}`}
    >
      {Icon ? <Icon color={palette.foreground} size={16} /> : null}
      <Text
        variant="metric"
        numberOfLines={1}
        adjustsFontSizeToFit
        style={tone === 'neutral' ? styles.value : { color: palette.foreground }}
      >
        {value}
      </Text>
      <Text variant="caption" tone="secondary" numberOfLines={2}>
        {label}
      </Text>
      {caption ? (
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * ProgressBar — a determinate bar for a percentage that matters, e.g. hours
 * logged against a weekly cap.
 *
 * The percentage is also written next to the bar, so the value is never
 * communicated by bar length alone.
 */
export function ProgressBar({
  value,
  max = 100,
  tone = 'info',
  label,
}: {
  /** Current amount. */
  value: number;
  max?: number;
  tone?: Tone;
  label?: string;
}) {
  const palette = toneColors[tone];
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const percent = Math.round(ratio * 100);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: percent }}
      accessibilityLabel={label}
    >
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%`, backgroundColor: palette.foreground }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xxs,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  value: {
    color: colors.textPrimary,
  },
  track: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
  },
});