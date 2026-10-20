import { Pressable, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { Text } from './Text';

/**
 * CheckboxField — a single yes/no control.
 *
 * Distinct from `ChoiceGroup`, which is a *radio* group asking the user to pick
 * one of several answers. This asks one question with two states, so it
 * announces `checkbox` / `checked` and shows a tick, which is what a screen
 * reader user expects from a setting rather than from a choice.
 *
 * The whole row is the target, not just the 20×20 box: a checkbox you have to
 * aim at is a checkbox people miss.
 */

interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  error,
  disabled = false,
}: CheckboxFieldProps) {
  return (
    <View style={styles.field}>
      <Pressable
        onPress={() => onChange(!checked)}
        disabled={disabled}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled }}
        accessibilityLabel={label}
        style={({ pressed }) => [
          styles.row,
          checked && styles.rowChecked,
          disabled && styles.rowDisabled,
          pressed && !disabled && styles.rowPressed,
        ]}
      >
        <View style={[styles.box, checked && styles.boxSelected]}>
          {checked ? <Check color={colors.onPrimary} size={14} strokeWidth={3} /> : null}
        </View>
        <Text variant="body" tone={disabled ? 'muted' : 'primary'} style={styles.label}>
          {label}
        </Text>
      </Pressable>

      {hint && !error ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}

      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowChecked: {
    borderColor: colors.primary,
    borderWidth: 2,
    backgroundColor: colors.primarySoft,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowPressed: {
    opacity: 0.75,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  label: {
    flex: 1,
  },
});
