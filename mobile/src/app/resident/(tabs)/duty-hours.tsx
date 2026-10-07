import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CalendarClock, ChevronLeft, ChevronRight, Plus, TriangleAlert } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ImportTools,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
  StatTile,
  StatusBadge,
  Text,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchAttendance } from '../../../services/attendance';
import { uploadTimesheet } from '../../../services/excelTemplates';
import { colors, radius, spacing } from '../../../theme';
import { formatDate, formatHours, formatTime, humanizeToken } from '../../../utils/format';
import { calendarDaysForMonth, summarizeMonth } from '../../../utils/insights';
import { EMPTY_ARRAY } from '../../../utils/empty';
import type { AttendanceLog } from '../../../types/api';

/**
 * Duty hours — the attendance log, read as a month.
 *
 * The calendar is the point of this screen. A resident planning next week needs
 * to see *shape* — "three 24-hour shifts in the last fortnight" — and a reverse
 * chronological list makes that countable only by hand. Each day cell carries
 * its hours; a cell that broke the continuous-duty limit turns red, so the
 * pattern is visible before any row is read.
 *
 * The screen deliberately does not display a weekly hour limit. The
 * `duty_hour_rules` table exists in the database, but the API exposes no
 * endpoint that returns the applicable rules, so any cap drawn here would be a
 * guess. What the app *can* show truthfully is what was logged, and whether the
 * server flagged it — so those are the facts on screen.
 *
 * The month can be moved with the chevrons; the timesheet buttons below let a
 * whole month be filled from a file instead of typed in one shift at a time.
 */

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function DutyHoursScreen() {
  const router = useRouter();
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const attendance = useApiResource(() => fetchAttendance(residentId), [residentId]);
  const logs = attendance.data ?? (EMPTY_ARRAY as AttendanceLog[]);

  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });

  const month = useMemo(
    () => summarizeMonth(logs, [], new Date(cursor.year, cursor.month, 1)),
    [logs, cursor],
  );
  const dayMap = useMemo(
    () => calendarDaysForMonth(logs, cursor.year, cursor.month),
    [logs, cursor],
  );

  const breaches = useMemo(
    () => logs.filter((log) => log.is_flagged_for_breach === 1),
    [logs],
  );

  /** Days of the month, laid out Sunday-first with blanks before the 1st. */
  const calendarCells = useMemo(() => {
    const firstWeekday = new Date(cursor.year, cursor.month, 1).getDay();
    const blanks = Array.from({ length: firstWeekday }, (_, index) => ({ kind: 'blank' as const, key: `b${index}` }));
    const days = Array.from({ length: month.daysInMonth }, (_, index) => {
      const day = index + 1;
      return { kind: 'day' as const, key: `d${day}`, day };
    });
    return [...blanks, ...days];
  }, [cursor, month.daysInMonth]);

  function moveMonth(delta: number) {
    setCursor((current) => {
      const next = new Date(current.year, current.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  return (
    <Screen
      onRefresh={attendance.refresh}
      refreshing={attendance.isRefreshing}
      bottomInset={false}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Duty hours" subtitle="Every shift you have logged" />

      {attendance.isLoading ? <SkeletonList rows={5} /> : null}

      {attendance.error ? (
        <ErrorState
          title="Could not load your shifts"
          message={attendance.error.message}
          onRetry={attendance.refresh}
        />
      ) : null}

      {attendance.status === 'ready' ? (
        <>
          <View style={styles.statRow}>
            <StatTile
              value={formatHours(month.hoursLogged)}
              label="Hours this month"
              icon={CalendarClock}
              tone={month.breaches > 0 ? 'warning' : 'neutral'}
            />
            <StatTile value={String(month.shifts)} label="Shifts this month" />
            <StatTile
              value={String(month.breaches)}
              label="Breaches this month"
              tone={month.breaches > 0 ? 'danger' : 'success'}
            />
          </View>

          <SectionHeader title="Month" trailing={month.monthLabel} />

          <Card>
            <View style={styles.monthBar}>
              <Pressable
                onPress={() => moveMonth(-1)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                style={styles.monthButton}
              >
                <ChevronLeft color={colors.primary} size={22} strokeWidth={2.4} />
              </Pressable>

              <View style={styles.monthTitle}>
                <Text variant="h3">{month.monthLabel}</Text>
                <Text variant="caption" tone="muted">
                  {formatHours(month.hoursLogged)} logged across {month.shifts} shift
                  {month.shifts === 1 ? '' : 's'}
                </Text>
              </View>

              <Pressable
                onPress={() => moveMonth(1)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Next month"
                style={styles.monthButton}
              >
                <ChevronRight color={colors.primary} size={22} strokeWidth={2.4} />
              </Pressable>
            </View>

            <View style={styles.weekRow}>
              {WEEKDAY_LABELS.map((label, index) => (
                <View key={`wd-${index}`} style={styles.weekday}>
                  <Text variant="caption" tone="muted">
                    {label}
                  </Text>
                </View>
              ))}
            </View>

            <View style={styles.grid}>
              {calendarCells.map((cell) => {
                if (cell.kind === 'blank') {
                  return <View key={cell.key} style={styles.cell} />;
                }

                const entry = dayMap.get(cell.day);
                const isToday =
                  cell.day === now.getDate() &&
                  cursor.month === now.getMonth() &&
                  cursor.year === now.getFullYear();

                return (
                  <View
                    key={cell.key}
                    style={[
                      styles.cell,
                      entry?.breach ? styles.cellBreach : null,
                      entry && !entry.breach ? styles.cellLogged : null,
                      isToday ? styles.cellToday : null,
                    ]}
                    accessible
                    accessibilityLabel={`${month.monthLabel} ${cell.day}${
                      entry ? `, ${formatHours(entry.hours)} logged${entry.breach ? ', breach' : ''}` : ', no hours logged'
                    }`}
                  >
                    <Text
                      variant="caption"
                      tone={entry?.breach ? 'danger' : isToday ? 'brand' : 'secondary'}
                      style={styles.cellDay}
                    >
                      {cell.day}
                    </Text>
                    {entry ? (
                      <Text
                        variant="caption"
                        tone={entry.breach ? 'danger' : 'secondary'}
                        style={styles.cellHours}
                        numberOfLines={1}
                      >
                        {entry.hours > 0 ? `${entry.hours}h` : '—'}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>

            <View style={styles.legend}>
              <View style={[styles.legendDot, { backgroundColor: colors.dangerSurface, borderColor: colors.danger }]} />
              <Text variant="caption" tone="muted">
                Red = a shift past the 24-hour continuous limit
              </Text>
            </View>
          </Card>

          <SectionHeader title="Timesheet" trailing="Excel" />

          <ImportTools
            template="timesheet"
            uploadLabel="Import Monthly Timesheet"
            upload={(file) => uploadTimesheet(file, residentId)}
            onImported={() => attendance.refresh()}
          />

          {breaches.length > 0 ? (
            <>
              <SectionHeader title="Flagged by the server" />
              {breaches.map((log) => (
                <Banner
                  key={log.log_id}
                  tone="danger"
                  icon={TriangleAlert}
                  title={`${formatDate(log.shift_date)} — ${formatHours(log.total_hours)}`}
                  message={log.violation_details ?? 'A recorded shift exceeded a programme duty-hour rule.'}
                />
              ))}
            </>
          ) : null}

          <SectionHeader title={`All shifts (${logs.length})`} />

          {logs.length === 0 ? (
            <Card>
              <EmptyState
                icon={CalendarClock}
                title="Nothing logged yet"
                message="Once you log a shift it appears here with its hours and any rule it breached."
              />
            </Card>
          ) : (
            <Card padded={false}>
              {logs.map((log, index) => (
                <ListRow
                  key={log.log_id}
                  title={`${humanizeToken(log.attendance_status)} · ${formatDate(log.shift_date)}`}
                  subtitle={
                    log.clock_in && log.clock_out
                      ? `${formatTime(log.clock_in)} – ${formatTime(log.clock_out)}`
                      : 'No clock-in and clock-out recorded'
                  }
                  meta={log.violation_rule ? `${log.violation_rule} · ${log.violation_severity ?? 'flagged'}` : undefined}
                  trailing={
                    <View style={styles.trailing}>
                      <Text variant="bodySmall" tone={log.is_flagged_for_breach === 1 ? 'danger' : 'primary'}>
                        {formatHours(log.total_hours)}
                      </Text>
                      {log.is_flagged_for_breach === 1 ? (
                        <StatusBadge label="Breach" tone="danger" />
                      ) : null}
                    </View>
                  }
                  last={index === logs.length - 1}
                  muted={log.is_flagged_for_breach === 0 && log.attendance_status !== 'PRESENT'}
                />
              ))}
            </Card>
          )}

          <Button
            label="Log a shift"
            icon={Plus}
            onPress={() => router.push('/resident/log-shift')}
            style={styles.cta}
          />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  monthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  monthButton: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  monthTitle: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xxs,
  },
  weekRow: {
    flexDirection: 'row',
    marginBottom: spacing.xs,
  },
  weekday: {
    flex: 1,
    alignItems: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginHorizontal: -0.5,
    marginVertical: -0.5,
  },
  cellLogged: {
    backgroundColor: colors.primarySoft,
  },
  cellBreach: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
  },
  cellToday: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  cellDay: {
    fontVariant: ['tabular-nums'],
  },
  cellHours: {
    fontVariant: ['tabular-nums'],
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: 3,
    borderWidth: 1,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: spacing.xxs,
  },
  cta: {
    marginTop: spacing.lg,
  },
});
