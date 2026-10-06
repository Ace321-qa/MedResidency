import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CalendarClock, Plus, TriangleAlert } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
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
import { spacing } from '../../../theme';
import { formatDate, formatHours, formatTime, humanizeToken } from '../../../utils/format';
import { DUTY_WINDOW_DAYS, summarizeDutyHours } from '../../../utils/insights';
import { EMPTY_ARRAY } from '../../../utils/empty';
import type { AttendanceLog } from '../../../types/api';

/**
 * Duty hours — the attendance log.
 *
 * The screen deliberately does not display a weekly hour limit. The
 * `duty_hour_rules` table exists in the database, but the API exposes no
 * endpoint that returns the applicable rules, so any cap drawn here would be a
 * guess. What the app *can* show truthfully is what was logged, and whether the
 * server flagged it — so those are the facts on screen.
 */

export default function DutyHoursScreen() {
  const router = useRouter();
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const attendance = useApiResource(() => fetchAttendance(residentId), [residentId]);
  const logs = attendance.data ?? (EMPTY_ARRAY as AttendanceLog[]);
  const duty = useMemo(() => summarizeDutyHours(logs), [logs]);

  const breaches = useMemo(() => logs.filter((log) => log.is_flagged_for_breach === 1), [logs]);

  return (
    <Screen
      onRefresh={attendance.refresh}
      refreshing={attendance.isRefreshing}
      bottomInset={false}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Duty hours" subtitle={`Every shift you have logged`} />

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
              value={formatHours(duty.windowHours)}
              label={`Last ${DUTY_WINDOW_DAYS} days`}
              icon={CalendarClock}
              tone={duty.windowBreaches > 0 ? 'warning' : 'neutral'}
            />
            <StatTile value={String(duty.windowShifts)} label="Shifts" />
            <StatTile
              value={String(duty.totalBreaches)}
              label="Breaches"
              tone={duty.totalBreaches > 0 ? 'danger' : 'success'}
            />
          </View>

          {duty.averageShiftHours !== null ? (
            <Text variant="caption" tone="muted" style={styles.footnote}>
              Average logged shift: {duty.averageShiftHours} h
            </Text>
          ) : null}

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
  },
  footnote: {
    marginTop: spacing.xs,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: spacing.xxs,
  },
  cta: {
    marginTop: spacing.lg,
  },
});