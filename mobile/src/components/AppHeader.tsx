import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';

import { colors, dimensions, spacing } from '../theme';
import { Text } from './Text';

/**
 * Screen header: an optional back affordance, a title and an optional subtitle
 * plus a right-hand slot for one action.
 *
 * Deliberately not a coloured bar. A flat header on the app background keeps
 * the page calm and lets the content below carry the visual weight.
 */
interface AppHeaderProps {
  title: string;
  subtitle?: string;
  /** Shows a back chevron that calls `onBack`. Omit for root tabs. */
  onBack?: () => void;
  /** Right-hand action, e.g. a single icon button. */
  action?: React.ReactNode;
}

export function AppHeader({ title, subtitle, onBack, action }: AppHeaderProps) {
  return (
    <View style={styles.container}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          hitSlop={8}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ChevronLeft color={colors.textPrimary} size={24} />
        </Pressable>
      ) : null}

      <View style={styles.textGroup}>
        <Text variant="h1" numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodySmall" tone="secondary" numberOfLines={2} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  backButton: {
    width: dimensions.touchTarget,
    height: dimensions.touchTarget,
    marginLeft: -spacing.sm,
    marginTop: -spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textGroup: {
    flex: 1,
  },
  subtitle: {
    marginTop: spacing.xxs,
  },
  action: {
    marginTop: -spacing.xs,
  },
});