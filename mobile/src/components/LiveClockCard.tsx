import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Clock3 } from 'lucide-react-native';

import { Card } from './Card';
import { Text } from './Text';
import { colors, radius, spacing } from '../theme';

/**
 * Live clock and calendar.
 *
 * A resident checking "what shift am I on?" reads the time first, so the clock
 * ticks once a second (`setInterval`, cleared on unmount) and the full date sits
 * underneath it rather than in the status bar, where it is four-point type on a
 * phone held at arm's length.
 *
 * `hour12: true` is explicit: an unspecified locale would render 24-hour time in
 * some regions, and "07:04:12" without a meridiem is ambiguous during a
 * night shift.
 */

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);
}

/** `Wednesday, October 7, 2026`. */
function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function LiveClockCard() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Card style={styles.card}>
      <View style={styles.iconWrap} accessible={false}>
        <Clock3 color={colors.onPrimary} size={20} strokeWidth={2.2} />
      </View>

      <View style={styles.text}>
        <Text variant="h1" style={styles.time} accessibilityRole="text">
          {formatTime(now)}
        </Text>
        <Text variant="body" tone="secondary" accessibilityRole="text">
          {formatDate(now)}
        </Text>
      </View>

      <View style={styles.tick} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    borderRadius: radius.md,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: spacing.xxs,
  },
  time: {
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  tick: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
  },
});
