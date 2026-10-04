import { StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { radius, spacing, toneColors, type Tone } from '../theme';
import { Text } from './Text';

/**
 * StatusBadge — a compact label for a status.
 *
 * The label text is always present, so the meaning survives for anyone who
 * cannot distinguish the colour (colour-blind users, a bright outdoor screen,
 * a monochrome print-out).
 */
interface StatusBadgeProps {
  label: string;
  tone?: Tone;
  /** Adds a leading tick, for "done" states. */
  checked?: boolean;
}

export function StatusBadge({ label, tone = 'neutral', checked = false }: StatusBadgeProps) {
  const palette = toneColors[tone];

  return (
    <View
      style={[styles.badge, { backgroundColor: palette.surface, borderColor: palette.border }]}
      accessible
      accessibilityLabel={`Status: ${label}`}
    >
      {checked ? <Check color={palette.foreground} size={12} strokeWidth={3} /> : null}
      <Text variant="label" style={{ color: palette.foreground }}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xxs,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
});