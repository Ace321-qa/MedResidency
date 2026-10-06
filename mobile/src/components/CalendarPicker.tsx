import { useMemo, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react-native';

import { colors, dimensions, radius, spacing } from '../theme';
import { Text } from './Text';
import {
  calendarDateToLocalDate,
  describeWindow,
  endDateForDuration,
  localDateToCalendarDate,
  nextWeekday,
  parseCalendarDate,
  resolveBlockWindow,
} from '../utils/dateCalc';
import { todayCalendarDate } from '../utils/format';

/**
 * CalendarPicker — the pop-up month grid behind every `DateField`.
 *
 * Typing `2026-07-05` into a text box is how a block ends up on the wrong day, so
 * the calendar is the primary way a date is chosen and the keyboard is the
 * fallback. Both are always available: `DateField` keeps the text input and this
 * dialog sits beside it.
 *
 * Why hand-rolled rather than `@react-native-community/datetimepicker`? That
 * module opens a *platform* dialog whose appearance, OK/Cancel wording and
 * behaviour differ between iOS and Android and cannot carry an institutional
 * "ends on a Saturday" hint. A month grid is identical everywhere, renders the
 * block window underneath the chosen date, and is fully testable.
 *
 * Props:
 *  - `minDate` / `maxDate` grey out days outside the range.
 *  - `weekStartDay` snaps "jump to the next block start" to the programme's
 *    boundary day, which is how a coordinator moves between blocks quickly.
 *  - `durationWeeks` turns the footer into the block it would create: pick a
 *    Sunday with four weeks selected and the dialog says "Ends Sat 01 Aug 2026"
 *    before anything is saved.
 */

interface CalendarPickerProps {
  visible: boolean;
  /** Currently selected `YYYY-MM-DD`, or '' when the field is empty. */
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
  title?: string;
  minDate?: string;
  maxDate?: string;
  /** Programme week start, e.g. 'SUNDAY', for the "next block start" shortcut. */
  weekStartDay?: string | null;
  /** When set, the footer previews the window a block of this length would get. */
  durationWeeks?: number | null;
  accessibilityLabel?: string;
}

/** Monday-first column order. `getDay()` is Sunday-first, so offset by one. */
const WEEKDAY_HEADINGS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Indexed by `getDay()`, i.e. Sunday-first, for screen-reader labels. */
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTH_HEADINGS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function monthTitle(date: Date): string {
  return `${MONTH_HEADINGS[date.getMonth()]} ${date.getFullYear()}`;
}

function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1, 12, 0, 0, 0);
}

export function CalendarPicker({
  visible,
  value,
  onSelect,
  onClose,
  title = 'Choose a date',
  minDate,
  maxDate,
  weekStartDay,
  durationWeeks = null,
  accessibilityLabel,
}: CalendarPickerProps) {
  const selected = calendarDateToLocalDate(value);

  // Opening on the selected month is what makes the dialog feel like it knows
  // where you are; an empty field opens on today.
  const [month, setMonth] = useState<Date>(() => selected ?? calendarDateToLocalDate(todayCalendarDate()) ?? new Date());

  // A field that was empty when the dialog opened must still land on today's
  // month, and reopening after a pick must not keep the old month.
  const [lastSeen, setLastSeen] = useState(value);
  if (visible && lastSeen !== value) {
    const next = calendarDateToLocalDate(value) ?? month;
    setLastSeen(value);
    setMonth(next);
  }

  /** Six weeks of cells, so every month is the same height and never reflows. */
  const weeks = useMemo(() => {
    const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1, 12);
    const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
    const cells: (Date | null)[] = Array.from({ length: leadingBlanks }, () => null);

    for (let day = 1; day <= 31; day += 1) {
      const candidate = new Date(month.getFullYear(), month.getMonth(), day, 12);
      if (candidate.getMonth() !== month.getMonth()) break;
      cells.push(candidate);
    }

    while (cells.length % 7 !== 0) cells.push(null);
    return Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
  }, [month]);

  const today = todayCalendarDate();
  const selectedKey = localDateToCalendarDate(selected ?? new Date(0));
  const minKey = minDate && parseCalendarDate(minDate) ? minDate.slice(0, 10) : null;
  const maxKey = maxDate && parseCalendarDate(maxDate) ? maxDate.slice(0, 10) : null;

  /**
   * The window this pick would produce, e.g. "4 weeks · Sun 05 Jul - Sat 01 Aug 2026".
   *
   * Shown in the footer so the Saturday/Sunday rule is visible at the moment of
   * choosing, not discovered after saving.
   *
   * When the chosen date is *not* the programme's week-start day the window is
   * wrong by construction — a four-week block from a Wednesday does not end on a
   * Saturday — and saying so here is the whole reason the dialog carries
   * `weekStartDay` at all. Without it a coordinator picks a Wednesday, dismisses
   * the dialog, and only then meets the rejection on the field behind it.
   */
  const windowPreview = useMemo(() => {
    if (!durationWeeks || !selected) return null;
    const startDate = localDateToCalendarDate(selected);
    const endDate = endDateForDuration(startDate, durationWeeks);
    if (!endDate) return null;

    const label = `${durationWeeks} week${durationWeeks === 1 ? '' : 's'} · ${describeWindow(startDate, endDate)}`;
    const boundary = weekStartDay ? resolveBlockWindow({
      start_date: startDate,
      duration_weeks: durationWeeks,
      week_start_day: weekStartDay,
    }).errors : [];

    return { label, boundary };
  }, [durationWeeks, selected, weekStartDay]);

  const blockStartShortcut = useMemo(() => {
    if (!weekStartDay) return null;
    const base = value && parseCalendarDate(value) ? value : todayCalendarDate();
    const next = nextWeekday(base, weekStartDay);
    return next && next !== base ? { label: 'Next block start', value: next } : null;
  }, [weekStartDay, value]);

  function choose(date: Date) {
    onSelect(localDateToCalendarDate(date));
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close the calendar"
        />

        <View style={styles.dialog} accessibilityViewIsModal accessibilityLabel={accessibilityLabel ?? title}>
          <View style={styles.header}>
            <Text variant="h2">{title}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close the calendar"
              style={styles.closeButton}
            >
              <Text variant="body" tone="secondary">
                ✕
              </Text>
            </Pressable>
          </View>

          <View style={styles.monthBar}>
            <Pressable
              onPress={() => setMonth((current) => shiftMonth(current, -1))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              style={styles.monthButton}
            >
              <ChevronLeft color={colors.textPrimary} size={20} />
            </Pressable>
            <Text variant="h3" style={styles.monthTitle}>
              {monthTitle(month)}
            </Text>
            <Pressable
              onPress={() => setMonth((current) => shiftMonth(current, 1))}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Next month"
              style={styles.monthButton}
            >
              <ChevronRight color={colors.textPrimary} size={20} />
            </Pressable>
          </View>

          <View style={styles.weekdayRow}>
            {WEEKDAY_HEADINGS.map((heading) => (
              <Text key={heading} variant="label" tone="secondary" align="center" style={styles.weekdayCell}>
                {heading}
              </Text>
            ))}
          </View>

          <View style={styles.grid}>
            {weeks.map((week, weekIndex) => (
              <View key={weekIndex} style={styles.week}>
                {week.map((date, dayIndex) => {
                  if (!date) {
                    return <View key={dayIndex} style={styles.dayCell} />;
                  }

                  const key = localDateToCalendarDate(date);
                  const isSelected = key === selectedKey;
                  const isToday = key === today;
                  const disabled = (minKey !== null && key < minKey) || (maxKey !== null && key > maxKey);

                  return (
                    <Pressable
                      key={dayIndex}
                      onPress={() => choose(date)}
                      disabled={disabled}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected, disabled }}
                      accessibilityLabel={`${DAY_LABELS[date.getDay()] ?? ''} ${date.getDate()} ${MONTH_HEADINGS[date.getMonth()]} ${date.getFullYear()}`}
                      style={({ pressed }) => [
                        styles.dayCell,
                        isSelected ? styles.daySelected : null,
                        pressed && !disabled && !isSelected ? styles.dayPressed : null,
                        disabled ? styles.dayDisabled : null,
                      ]}
                    >
                      <Text
                        variant="bodySmall"
                        align="center"
                        tone={isSelected ? 'inverse' : disabled ? 'disabled' : 'primary'}
                      >
                        {date.getDate()}
                      </Text>
                      {isToday && !isSelected ? <View style={styles.todayDot} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>

          <View style={styles.footer}>
{windowPreview ? (
              <View style={styles.preview}>
                <Text
                  variant="caption"
                  tone={windowPreview.boundary.length > 0 ? 'warning' : 'secondary'}
                  align="center"
                >
                  {windowPreview.label}
                </Text>
                {windowPreview.boundary.map((message) => (
                  <Text key={message} variant="caption" tone="warning" align="center">
                    {message}
                  </Text>
                ))}
              </View>
            ) : null}

            <View style={styles.shortcuts}>
              <Pressable
                onPress={() => choose(calendarDateToLocalDate(today) ?? new Date())}
                accessibilityRole="button"
                accessibilityLabel="Choose today"
                style={styles.shortcut}
              >
                <CalendarDays color={colors.primary} size={16} />
                <Text variant="bodySmall" tone="brand" style={styles.shortcutText}>
                  Today
                </Text>
              </Pressable>

              {blockStartShortcut ? (
                <Pressable
                  onPress={() => {
                    const date = calendarDateToLocalDate(blockStartShortcut.value);
                    if (date) choose(date);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={blockStartShortcut.label}
                  style={styles.shortcut}
                >
                  <Text variant="bodySmall" tone="brand" style={styles.shortcutText}>
                    {blockStartShortcut.label}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  closeButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  monthButton: {
    width: dimensions.touchTarget,
    height: dimensions.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthTitle: {
    textAlign: 'center',
  },
  weekdayRow: {
    flexDirection: 'row',
  },
  weekdayCell: {
    flex: 1,
    paddingVertical: spacing.xs,
  },
  grid: {
    gap: 2,
  },
  week: {
    flexDirection: 'row',
  },
  dayCell: {
    flex: 1,
    aspectRatio: Platform.OS === 'ios' ? 1 : 1.15,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  daySelected: {
    backgroundColor: colors.primary,
  },
  dayPressed: {
    backgroundColor: colors.primarySoft,
  },
  dayDisabled: {
    opacity: 0.35,
  },
  todayDot: {
    position: 'absolute',
    bottom: 6,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  footer: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  preview: {
    gap: spacing.xxs,
  },
  shortcuts: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  shortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primarySoft,
  },
  shortcutText: {
    fontWeight: '600',
  },
});