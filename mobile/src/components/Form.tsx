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
import { CalendarDays, Check, ChevronDown } from 'lucide-react-native';

import { colors, dimensions, radius, spacing } from '../theme';
import { Button } from './Button';
import { CalendarPicker } from './CalendarPicker';
// Imported from the modules directly rather than from `./index`: the barrel
// re-exports this file, and routing its own dependencies through it would make
// the barrel load itself.
import { Sheet } from './Sheet';
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

/**
 * SheetSelectField — a select whose options open in a searchable bottom sheet.
 *
 * The same argument `SelectField` makes for a leave type applies in reverse
 * here. Chips are the right answer while every option can be on screen at once;
 * they are the wrong answer for a roster. On `New Rotation Assignment` the
 * resident list is a whole programme's worth of names, so "pick one" became
 * "scroll four screens and hope the name is where you left it" — and every chip
 * rendered is one more thing standing between the coordinator and the field
 * below it.
 *
 * So this keeps `SelectField`'s contract — label, hint, error, required — and
 * replaces the presentation: a button showing the current choice opens `Sheet`,
 * which lists one row per option behind a search box. The row that is already
 * chosen is ticked, so reopening is how you *change* a pick rather than how you
 * discover what you picked.
 *
 * The search box only appears once there are more options than fit comfortably
 * on a phone (`SEARCH_THRESHOLD`); a two-option group with a search field reads
 * as a control that is broken.
 */
const SEARCH_THRESHOLD = 6;

interface SheetSelectFieldProps<T extends string> {
  label: string;
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  /** Shown on the button while nothing is selected. */
  placeholder?: string;
  /** Force the search box on or off; otherwise it appears above the threshold. */
  searchable?: boolean;
}

export function SheetSelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  error,
  required = false,
  disabled = false,
  placeholder = 'Choose one',
  searchable,
}: SheetSelectFieldProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = options.find((option) => option.value === value) ?? null;
  const showSearch = searchable ?? options.length > SEARCH_THRESHOLD;

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options;

  function handleOpen() {
    if (disabled) return;
    setQuery('');
    setOpen(true);
  }

  function choose(next: T) {
    onChange(next);
    setQuery('');
    setOpen(false);
  }

  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {(control) => (
        <>
          <Pressable
            onPress={handleOpen}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={control.label}
            accessibilityHint={
              selected ? `Currently ${selected.label}. Opens the list of ${options.length} options.` : `Opens the list of ${options.length} options.`
            }
            accessibilityState={{ disabled, expanded: open }}
            style={({ pressed }) => [
              styles.control,
              control.invalid ? styles.controlError : null,
              disabled ? styles.controlDisabled : null,
              pressed && !disabled ? styles.controlFocused : null,
            ]}
          >
            <Text
              variant="body"
              tone={selected ? 'primary' : 'muted'}
              numberOfLines={1}
              style={styles.sheetValue}
            >
              {selected ? selected.label : placeholder}
            </Text>
            <ChevronDown color={disabled ? colors.disabledText : colors.textMuted} size={18} />
          </Pressable>

          <Sheet
            visible={open}
            onClose={() => setOpen(false)}
            title={`Choose ${label.toLowerCase()}`}
            subtitle={
              showSearch && needle
                ? `${visible.length} of ${options.length} match${visible.length === 1 ? '' : 'es'}`
                : `${options.length} option${options.length === 1 ? '' : 's'}`
            }
            footer={
              <Button
                label="Close"
                variant="outline"
                onPress={() => setOpen(false)}
                accessibilityHint="Closes the list without changing the selection"
              />
            }
          >
            {showSearch ? (
              <SearchInput
                value={query}
                onChangeText={setQuery}
                placeholder={`Search ${label.toLowerCase()}`}
                accessibilityLabel={`Search ${label.toLowerCase()}`}
              />
            ) : null}

            <View style={styles.sheetList} accessibilityRole="radiogroup" accessibilityLabel={control.label}>
              {visible.map((option) => {
                const isSelected = option.value === value;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => choose(option.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={option.label}
                    style={({ pressed }) => [
                      styles.sheetOption,
                      isSelected ? styles.sheetOptionSelected : null,
                      pressed && !isSelected ? styles.sheetOptionPressed : null,
                    ]}
                  >
                    <Text variant="bodySmall" style={isSelected ? styles.sheetOptionTextSelected : undefined} numberOfLines={2}>
                      {option.label}
                    </Text>
                    {isSelected ? <Check color={colors.primary} size={18} strokeWidth={3} /> : null}
                  </Pressable>
                );
              })}

              {visible.length === 0 ? (
                <Text variant="bodySmall" tone="muted" align="center" style={styles.sheetEmpty}>
                  {needle ? `No option matches “${query.trim()}”.` : 'There is nothing to choose from yet.'}
                </Text>
              ) : null}
            </View>
          </Sheet>
        </>
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
 * DateField — a calendar pop-up plus a `YYYY-MM-DD` text input.
 *
 * Two ways in, deliberately:
 *
 *  - The calendar button opens `CalendarPicker`, which is how most dates get
 *    chosen. Typing `2026-07-05` is exactly how a block ends up on the wrong
 *    weekday, so the visual path is the primary one.
 *  - The text input stays editable for a resident fixing a typo at 02:00, which
 *    the original comment here treated as a reason to ship *only* a text box.
 *    Native date *entry* is inconsistent across Android versions; a calendar
 *    grid plus a free-text field is not.
 *
 * The API accepts only `YYYY-MM-DD` and that is what the MySQL DATE columns
 * store, so both paths produce that shape — the picker cannot emit anything else.
 *
 * `weekStartDay` and `durationWeeks` are optional and only make the dialog
 * smarter: together they preview the block window ("4 weeks · Sun 05 Jul - Sat
 * 01 Aug 2026") and add a "Next block start" shortcut.
 */
export interface DateFieldProps extends Omit<TextFieldProps, 'keyboardType' | 'autoCapitalize'> {
  /** Earliest selectable day, `YYYY-MM-DD`. */
  minDate?: string;
  /** Latest selectable day, `YYYY-MM-DD`. */
  maxDate?: string;
  /** Programme week start ('SUNDAY' / 'MONDAY') for the block-start shortcut. */
  weekStartDay?: string | null;
  /** Previews the window this date would create, e.g. 4 for a four-week block. */
  durationWeeks?: number | null;
}

export function DateField({
  minDate,
  maxDate,
  weekStartDay,
  durationWeeks = null,
  ...textFieldProps
}: DateFieldProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const { label, value, onChangeText } = textFieldProps;

  return (
    <>
      <TextField
        {...textFieldProps}
        autoCapitalize="none"
        keyboardType="numbers-and-punctuation"
        trailing={
          <Pressable
            onPress={() => setCalendarOpen(true)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Open the calendar to choose ${label.toLowerCase()}`}
            style={styles.calendarButton}
          >
            <CalendarDays color={colors.primary} size={20} />
          </Pressable>
        }
      />

      <CalendarPicker
        visible={calendarOpen}
        value={value}
        onSelect={onChangeText}
        onClose={() => setCalendarOpen(false)}
        title={`Choose ${label.toLowerCase()}`}
        minDate={minDate}
        maxDate={maxDate}
        weekStartDay={weekStartDay}
        durationWeeks={durationWeeks}
        accessibilityLabel={label}
      />
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  calendarButton: {
    width: dimensions.touchTarget,
    height: dimensions.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
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
  sheetValue: {
    flex: 1,
    paddingRight: spacing.sm,
  },
  sheetList: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: dimensions.touchTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  sheetOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  sheetOptionPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  sheetOptionTextSelected: {
    fontWeight: '600',
  },
  sheetEmpty: {
    paddingVertical: spacing.lg,
  },
});