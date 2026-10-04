import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Check } from 'lucide-react-native';

import { colors, dimensions, radius, spacing } from '../theme';
import { Text } from './Text';

/**
 * Form controls.
 *
 * Three rules every form in this app follows:
 *  1. The label sits above the control, never as a placeholder — placeholders
 *     disappear as soon as you type, which is useless on a clinical form.
 *  2. The label is also the control's accessibility label, so a screen reader
 *     announces the same words a sighted user sees.
 *  3. Errors are written out in words under the control, never signalled by a
 *     red border alone.
 */

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: (control: { label: string; invalid: boolean }) => React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

function FieldShell({ label, hint, error, required, children, style }: FieldShellProps) {
  return (
    <View style={[styles.field, style]}>
      <Text variant="label" tone="secondary" uppercase>
        {label}
        {required ? <Text variant="label" tone="danger">{' *'}</Text> : null}
      </Text>

      {children({ label: required ? `${label}, required` : label, invalid: Boolean(error) })}

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

interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  multiline?: boolean;
  editable?: boolean;
  /** Right-hand affordance, e.g. a clear button. */
  trailing?: React.ReactNode;
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  error,
  required,
  keyboardType,
  autoCapitalize = 'sentences',
  multiline = false,
  editable = true,
  trailing,
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {(control) => (
        <View
          style={[
            styles.control,
            multiline ? styles.controlMultiline : null,
            focused ? styles.controlFocused : null,
            control.invalid ? styles.controlError : null,
            !editable ? styles.controlDisabled : null,
          ]}
        >
          <TextInput
            style={[styles.input, multiline ? styles.inputMultiline : null]}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            keyboardType={keyboardType}
            autoCapitalize={autoCapitalize}
            autoCorrect={false}
            multiline={multiline}
            editable={editable}
            accessibilityLabel={control.label}
            accessibilityHint={hint}
            accessibilityState={{ disabled: !editable }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            underlineColorAndroid="transparent"
          />
          {trailing}
        </View>
      )}
    </FieldShell>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectFieldProps<T extends string> {
  label: string;
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
}

/**
 * SelectField renders as a wrapping group of selectable chips.
 *
 * Why not a dropdown? Every enum this app submits to MySQL has a small, fixed
 * set of values (leave types, attendance statuses). Showing them all means a
 * resident can never send a value the database will reject, and on a phone it
 * is faster than opening a picker. The group wraps, so the same control works
 * on a 5-inch Android phone and on a tablet.
 */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  error,
  required,
  disabled = false,
}: SelectFieldProps<T>) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {(control) => (
        <View style={styles.chipGroup} accessibilityRole="radiogroup" accessibilityLabel={control.label}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <Pressable
                key={option.value}
                onPress={() => onChange(option.value)}
                disabled={disabled}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled }}
                accessibilityLabel={option.label}
                style={({ pressed }) => [
                  styles.chip,
                  selected ? styles.chipSelected : null,
                  pressed && !disabled && !selected ? styles.chipPressed : null,
                  disabled ? styles.chipDisabled : null,
                ]}
              >
                {selected ? <Check color={colors.onPrimary} size={14} strokeWidth={3} /> : null}
                <Text variant="bodySmall" style={selected ? styles.chipTextSelected : styles.chipText}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </FieldShell>
  );
}

/** SearchInput — the rounded search box used by the roster and review lists. */
export function SearchInput({
  value,
  onChangeText,
  placeholder = 'Search',
  accessibilityLabel,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
}) {
  return (
    <View style={styles.search}>
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={accessibilityLabel ?? placeholder}
        returnKeyType="search"
        clearButtonMode="while-editing"
        underlineColorAndroid="transparent"
      />
    </View>
  );
}

/**
 * DateField — a text input constrained to `YYYY-MM-DD`.
 *
 * The API accepts only that format and it is what the MySQL DATE columns store,
 * so we ask for it directly instead of shipping a native picker that would need
 * converting anyway. Native date *entry* is also inconsistent across Android
 * versions, which matters when a resident logs a shift at 02:00.
 */
export function DateField(props: Omit<TextFieldProps, 'keyboardType' | 'autoCapitalize'>) {
  return <TextField {...props} autoCapitalize="none" keyboardType="numbers-and-punctuation" />;
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  control: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: dimensions.inputHeight,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  controlMultiline: {
    minHeight: dimensions.inputHeight * 2,
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
  },
  controlFocused: {
    borderColor: colors.primary,
    // A visible focus ring matters for anyone navigating with assistive tech.
    shadowColor: colors.primary,
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 2,
  },
  controlError: {
    borderColor: colors.danger,
  },
  controlDisabled: {
    backgroundColor: colors.surfaceMuted,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: colors.textPrimary,
    paddingVertical: spacing.sm,
  },
  inputMultiline: {
    textAlignVertical: 'top',
    minHeight: dimensions.inputHeight,
  },
  chipGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipPressed: {
    backgroundColor: colors.primarySoft,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipText: {
    color: colors.textSecondary,
  },
  chipTextSelected: {
    color: colors.onPrimary,
    fontWeight: '600',
  },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minHeight: dimensions.inputHeight - 4,
  },
  searchInput: {
    fontSize: 15,
    color: colors.textPrimary,
    paddingVertical: spacing.sm,
  },
});