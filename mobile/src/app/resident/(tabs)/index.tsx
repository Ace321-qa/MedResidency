import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, CalendarPlus, ClipboardCheck, FilePlus2, Timer, TriangleAlert } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  Divider,
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
import { fetchResidentSchedule } from '../../../services/rotations';
import {
  MOCK_ASSESSMENT_STATUS_LABEL,
  MOCK_ASSESSMENT_STATUS_TONE,
  fetchMockAssessments,
  fetchMockTrainingProgress,
} from '../../../services/mock';
import { spacing } from '../../../theme';
import { formatHours, formatDateRange, formatShortDate } from '../../../utils/format';
import { describeRotation, summarizeDutyHours, summarizeLeaves, summarizeSchedule } from '../../../utils/insights';

/**
 * Today — the resident's home screen.
 *
 * One question drives the order of this screen: *is anything wrong right now?*
 * So a duty-hour breach sits at the top in red, before any of the pleasant
 * content. Then the current rotation, then the numbers, then the things to do.
 *
 * Everything on this screen is derived from real endpoints — attendance,
 * assignments, leave requests — with one clearly-labelled mock panel at the
 * bottom for training progress, which the API cannot yet provide.
 */
export default function TodayScreen() {
  const router = useRouter();
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;

  const attendance = useApiResource(() => fetchAttendance(residentId), [residentId]);
  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);
  const leaves = useApiResource(() => fetchLeaves(residentId), [residentId]);
  const assessments = useApiResource(fetchMockAssessments);
  const progress = useApiResource(fetchMockTrainingProgress);

  const duty = useMemo(() => summarizeDutyHours(attendance.data ?? []), [attendance.data]);
  const rotations = useMemo(() => summarizeSchedule(schedule.data ?? []), [schedule.data]);
  const leaveSummary = useMemo(() => summarizeLeaves(leaves.data ?? []), [leaves.data]);

  const openAssessments = (assessments.data ?? [])
    .filter((item) => item.status !== 'COMPLETED')
    .slice(0, 3);

  // The most serious unacknowledged breach, if there is one.
  const latestBreach = (attendance.data ?? []).find((log) => log.is_flagged_for_breach === 1);

  const isFirstLoad =
    attendance.isLoading || schedule.isLoading || leaves.isLoading;
  const firstError = attendance.error ?? schedule.error ?? leaves.error;

  return (
    <Screen
      onRefresh={() => {
        attendance.refresh();
        schedule.refresh();
        leaves.refresh();
        assessments.refresh();
      }}
      refreshing={attendance.isRefreshing || schedule.isRefreshing || leaves.isRefreshing}
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
          }}
        />
      ) : null}

      {!isFirstLoad && !firstError ? (
        <>
          <SectionHeader title="Current rotation" />
          {rotations.current ? (
            <Card>
              <Text variant="h2">{rotations.current.rotation_name}</Text>
              <Text variant="bodySmall" tone="secondary">
                {describeRotation(rotations.current)}
              </Text>
              <View style={styles.tagRow}>
                <StatusBadge label={rotations.current.assignment_type === 'FULL_BLOCK' ? 'Full block' : 'Partial block'} tone="info" />
                <StatusBadge label={`${rotations.current.block_name}`} tone="neutral" />
              </View>
            </Card>
          ) : rotations.next ? (
            <Card>
              <Text variant="bodySmall" tone="secondary">
                You are not on a rotation today.
              </Text>
              <Text variant="h3" style={styles.gapTop}>
                Next: {rotations.next.rotation_name}
              </Text>
              <Text variant="bodySmall" tone="secondary">
                {formatDateRange(rotations.next.start_date, rotations.next.end_date)}
              </Text>
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon={CalendarPlus}
                title="No rotation scheduled"
                message="You have no active or upcoming rotation assignments. If that is unexpected, ask your programme coordinator to publish a schedule."
              />
            </Card>
          )}

          <SectionHeader title="This month" />
          <View style={styles.statRow}>
            <StatTile
              value={formatHours(duty.windowHours)}
              label="Hours logged"
              icon={Timer}
              tone={duty.windowBreaches > 0 ? 'warning' : 'neutral'}
            />
            <StatTile value={String(duty.windowShifts)} label="Shifts" icon={ClipboardCheck} />
            <StatTile
              value={String(duty.totalBreaches)}
              label="Breaches ever"
              icon={TriangleAlert}
              tone={duty.totalBreaches > 0 ? 'danger' : 'success'}
            />
          </View>

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

          <SectionHeader
            title="Training progress"
            trailing="Sample data"
          />
          <Card>
            {progress.data ? (
              <>
                <View style={styles.progressHead}>
                  <Text variant="h3">
                    {formatHours(progress.data.annualHours)} of {formatHours(progress.data.annualCap)}
                  </Text>
                  <Text variant="caption" tone="muted">
                    annual duty-hour cap
                  </Text>
                </View>
                <ProgressBar
                  value={Math.round((progress.data.annualHours / progress.data.annualCap) * 100)}
                  label={`${progress.data.weeksElapsed} weeks elapsed, averaging ${progress.data.averageWeeklyHours} hours per week`}
                />
                <Text variant="caption" tone="muted" style={styles.progressCaption}>
                  {progress.data.weeksElapsed} weeks elapsed · {progress.data.averageWeeklyHours} h/week average
                </Text>
              </>
            ) : (
              <Text variant="bodySmall" tone="muted">
                Loading…
              </Text>
            )}
          </Card>


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
  actionStack: {
    gap: spacing.sm,
  },
  tagRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  gapTop: {
    marginTop: spacing.xs,
  },
  progressHead: {
    marginBottom: spacing.sm,
  },
  progressCaption: {
    marginTop: spacing.xs,
  },
});