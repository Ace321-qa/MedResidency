import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Bell,
  CalendarPlus,
  ClipboardCheck,
  FilePlus2,
  Hospital,
  Stethoscope,
  Timer,
  TriangleAlert,
} from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  ListRow,
  ProgressBar,
  Screen,
  SectionHeader,
  SkeletonList,
  StatTile,
  StatusBadge,
  Text,
  LiveClockCard,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchAttendance } from '../../../services/attendance';
import { fetchLeaves } from '../../../services/leaves';
import { fetchResidentLongitudinalAssignments } from '../../../services/longitudinal';
import { fetchResidentSchedule } from '../../../services/rotations';
import { spacing } from '../../../theme';
import { formatHours, formatDateRange, formatShortDate, toCalendarDate } from '../../../utils/format';
import {
  describeRotation,
  summarizeDutyHours,
  summarizeLeaves,
  summarizeMonth,
  summarizeSchedule,
} from '../../../utils/insights';
import type { LongitudinalAssignment } from '../../../types/api';

/**
 * Today — the resident's home screen.
 *
 * The order answers one question: *what am I doing right now?*
 *
 *  1. The live clock and calendar, so the answer is anchored in the moment.
 *  2. The hospital rotation (top card) and the clinic rotation (bottom card) —
 *     the two things a resident is actually "on" today.
 *  3. This month's numbers, because annual totals never move.
 *
 * Assessments are not here, and deliberately so: there is no assessment
 * endpoint, and a sample card that never changes is worse than no card.
 */

/** True when a longitudinal clinic assignment covers today. */
function coversToday(assignment: LongitudinalAssignment, today: string): boolean {
  if (assignment.is_active === 0) return false;
  const start = assignment.start_date ? toCalendarDate(new Date(assignment.start_date)) : null;
  const end = assignment.end_date ? toCalendarDate(new Date(assignment.end_date)) : null;
  if (start && today < start) return false;
  if (end && today > end) return false;
  return true;
}

/** `Wednesday ANC` style prefix: the clinic day the resident attends. */
function clinicDayLabel(assignment: LongitudinalAssignment): string {
  return assignment.day_of_week ? `${assignment.day_of_week}` : 'Clinic day not set';
}

export default function TodayScreen() {
  const router = useRouter();
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const attendance = useApiResource(() => fetchAttendance(residentId), [residentId]);
  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);
  const leaves = useApiResource(() => fetchLeaves(residentId), [residentId]);
  const clinics = useApiResource(() => fetchResidentLongitudinalAssignments(residentId), [residentId]);

  const duty = useMemo(() => summarizeDutyHours(attendance.data ?? []), [attendance.data]);
  const rotations = useMemo(() => summarizeSchedule(schedule.data ?? []), [schedule.data]);
  const leaveSummary = useMemo(() => summarizeLeaves(leaves.data ?? []), [leaves.data]);
  const month = useMemo(
    () => summarizeMonth(attendance.data ?? [], schedule.data ?? []),
    [attendance.data, schedule.data],
  );

  const today = toCalendarDate(new Date());
  const currentClinic = useMemo(
    () => (clinics.data ?? []).find((assignment) => coversToday(assignment, today)) ?? null,
    [clinics.data, today],
  );

  // The most serious unacknowledged breach, if there is one.
  const latestBreach = (attendance.data ?? []).find((log) => log.is_flagged_for_breach === 1);

  const isFirstLoad =
    attendance.isLoading || schedule.isLoading || leaves.isLoading || clinics.isLoading;
  const firstError = attendance.error ?? schedule.error ?? leaves.error ?? clinics.error;

  const monthProgressPercent = Math.round((month.daysElapsed / Math.max(month.daysInMonth, 1)) * 100);

  return (
    <Screen
      onRefresh={() => {
        attendance.refresh();
        schedule.refresh();
        leaves.refresh();
        clinics.refresh();
      }}
      refreshing={
        attendance.isRefreshing || schedule.isRefreshing || leaves.isRefreshing || clinics.isRefreshing
      }
      bottomGutter={spacing.xxl}
    >
      <AppHeader
        title={`Hello, ${session?.residentName.split(' ')[0] ?? 'Resident'}`}
        subtitle="Here is where you stand today"
        action={
          <IconButton
            icon={Bell}
            accessibilityLabel="Notifications"
            onPress={() => router.push('/resident/notifications')}
          />
        }
      />

      <LiveClockCard />

      {latestBreach ? (
        <Banner
          tone="danger"
          icon={TriangleAlert}
          title="Duty-hour breach on record"
          message={`${latestBreach.violation_details ?? 'A recorded shift exceeded your programme duty-hour rule.'} Logged for ${formatShortDate(latestBreach.shift_date)} at ${formatHours(latestBreach.total_hours)}. Raise this with your programme director.`}
          action={
            <Button
              label="Review duty hours"
              variant="danger"
              fullWidth={false}
              onPress={() => router.push('/resident/duty-hours')}
            />
          }
        />
      ) : null}

      {isFirstLoad ? <SkeletonList rows={4} /> : null}

      {firstError ? (
        <ErrorState
          title="Could not load your dashboard"
          message={firstError.message}
          onRetry={() => {
            attendance.refresh();
            schedule.refresh();
            leaves.refresh();
            clinics.refresh();
          }}
        />
      ) : null}

      {!isFirstLoad && !firstError ? (
        <>
          <SectionHeader title="Current rotations" />

          {/* Card 1 — hospital. */}
          <Card>
            <View style={styles.cardHead}>
              <View style={styles.cardIcon} accessibilityElementsHidden importantForAccessibility="no">
                <Hospital color="#FFFFFF" size={18} strokeWidth={2.2} />
              </View>
              <View style={styles.cardHeadText}>
                <Text variant="label" tone="secondary" uppercase>
                  Hospital rotation
                </Text>
                {rotations.current ? (
                  <Text variant="h3">
                    {rotations.current.block_name}: {rotations.current.rotation_name}
                  </Text>
                ) : (
                  <Text variant="h3">
                    {rotations.next ? `Next: ${rotations.next.rotation_name}` : 'No hospital rotation today'}
                  </Text>
                )}
              </View>
            </View>

            {rotations.current ? (
              <>
                <Text variant="bodySmall" tone="secondary">
                  {describeRotation(rotations.current)}
                </Text>
                <View style={styles.tagRow}>
                  <StatusBadge
                    label={
                      rotations.current.assignment_type === 'FULL_BLOCK' ? 'Full block' : 'Partial block'
                    }
                    tone="info"
                  />
                  <StatusBadge label={rotations.current.block_name} tone="neutral" />
                </View>
              </>
            ) : rotations.next ? (
              <Text variant="bodySmall" tone="secondary" style={styles.gapTop}>
                {formatDateRange(rotations.next.start_date, rotations.next.end_date)} ·{' '}
                {rotations.next.block_name}
              </Text>
            ) : (
              <EmptyState
                icon={CalendarPlus}
                title="No rotation scheduled"
                message="You have no active or upcoming rotation assignments. If that is unexpected, ask your programme coordinator to publish a schedule."
              />
            )}
          </Card>

          {/* Card 2 — clinic, always under the hospital card. */}
          <Card>
            <View style={styles.cardHead}>
              <View style={styles.cardIcon} accessibilityElementsHidden importantForAccessibility="no">
                <Stethoscope color="#FFFFFF" size={18} strokeWidth={2.2} />
              </View>
              <View style={styles.cardHeadText}>
                <Text variant="label" tone="secondary" uppercase>
                  Clinic rotation
                </Text>
                {currentClinic ? (
                  <Text variant="h3">
                    {clinicDayLabel(currentClinic)} · {currentClinic.clinic_name}
                  </Text>
                ) : (
                  <Text variant="h3">No clinic session today</Text>
                )}
              </View>
            </View>

            {currentClinic ? (
              <>
                <Text variant="bodySmall" tone="secondary">
                  {currentClinic.start_time && currentClinic.end_time
                    ? `${currentClinic.start_time} – ${currentClinic.end_time}`
                    : 'Time not recorded'}
                  {currentClinic.site_name ? ` · ${currentClinic.site_name}` : ''}
                  {currentClinic.supervisor_name ? ` · with ${currentClinic.supervisor_name}` : ''}
                </Text>
                <View style={styles.tagRow}>
                  <StatusBadge label={currentClinic.clinic_code} tone="success" />
                  {currentClinic.pgy_level ? (
                    <StatusBadge label={`PGY-${currentClinic.pgy_level}`} tone="neutral" />
                  ) : null}
                </View>
              </>
            ) : (
              <Text variant="bodySmall" tone="secondary" style={styles.gapTop}>
                {clinics.data && clinics.data.length > 0
                  ? `No clinic session falls on ${formatShortDate(today)}. Your next assigned clinic is listed under Rotations.`
                  : 'No longitudinal clinic has been assigned to you yet.'}
              </Text>
            )}
          </Card>

          <SectionHeader title="This month" trailing={month.monthLabel} />

          <View style={styles.statRow}>
            <StatTile
              value={formatHours(month.hoursLogged)}
              label="Hours logged this month"
              icon={Timer}
              tone={month.breaches > 0 ? 'warning' : 'neutral'}
            />
            <StatTile
              value={String(month.rotationsCompleted)}
              label="Rotations completed this month"
              icon={ClipboardCheck}
              tone={month.rotationsCompleted > 0 ? 'success' : 'neutral'}
            />
          </View>

          <View style={styles.statRow}>
            <StatTile value={String(month.shifts)} label="Shifts this month" icon={ClipboardCheck} />
            <StatTile
              value={String(month.breaches)}
              label="Duty-hour breaches this month"
              icon={TriangleAlert}
              tone={month.breaches > 0 ? 'danger' : 'success'}
            />
            <StatTile
              value={String(leaveSummary.pendingCount)}
              label="Requests pending"
              tone={leaveSummary.pendingCount > 0 ? 'warning' : 'success'}
            />
          </View>

          <Card>
            <Text variant="h3">{month.monthLabel}</Text>
            <Text variant="caption" tone="muted" style={styles.progressCaption}>
              {month.daysElapsed} of {month.daysInMonth} days elapsed · {formatHours(month.hoursLogged)}{' '}
              logged across {month.shifts} shift{month.shifts === 1 ? '' : 's'}
            </Text>
            <View style={styles.progressWrap}>
              <ProgressBar
                value={monthProgressPercent}
                label={`${month.monthLabel}: day ${month.daysElapsed} of ${month.daysInMonth}`}
              />
            </View>
            <Text variant="caption" tone="muted">
              Rolling 7-day total: {formatHours(duty.windowHours)} across {duty.windowShifts} shift
              {duty.windowShifts === 1 ? '' : 's'}.
            </Text>
          </Card>

          <SectionHeader title="Quick actions" />
          <View style={styles.actionStack}>
            <Button
              label="Log a shift"
              icon={Timer}
              onPress={() => router.push('/resident/log-shift')}
              accessibilityHint="Record attendance and hours for a shift you worked"
            />
            <Button
              label="Request leave"
              variant="outline"
              icon={FilePlus2}
              onPress={() => router.push('/resident/request-leave')}
            />
          </View>

          {leaveSummary.pendingCount > 0 ? (
            <>
              <SectionHeader title="Awaiting a decision" />
              <Card padded={false}>
                {leaveSummary.nextPending ? (
                  <ListRow
                    title={leaveSummary.nextPending.reason ?? 'Leave request'}
                    subtitle={`${formatShortDate(leaveSummary.nextPending.start_date)} – ${formatShortDate(leaveSummary.nextPending.end_date)} · ${leaveSummary.nextPending.total_days} day${leaveSummary.nextPending.total_days === 1 ? '' : 's'}`}
                    trailing={<StatusBadge label="Pending" tone="warning" />}
                    onPress={() => router.push('/resident/requests')}
                    last
                  />
                ) : null}
              </Card>
            </>
          ) : null}
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
  actionStack: {
    gap: spacing.sm,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  gapTop: {
    marginTop: spacing.xs,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  cardHeadText: {
    flex: 1,
    gap: spacing.xxs,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0E4573',
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressCaption: {
    marginTop: spacing.xxs,
  },
  progressWrap: {
    marginVertical: spacing.sm,
  },
});
