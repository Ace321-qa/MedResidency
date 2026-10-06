import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CalendarDays, Clock, TriangleAlert, UserRound } from 'lucide-react-native';

import {
  AppHeader,
  Avatar,
  Banner,
  Card,
  DetailRow,
  Divider,
  EmptyState,
  ErrorState,
  LetterPreviewSheet,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
  StatTile,
  StatusBadge,
  Text,
} from '../../../components';
import { useApiResource } from '../../../hooks';
import { goBack } from '../../../navigation/back';
import { fetchAttendance } from '../../../services/attendance';
import { fetchLeaves } from '../../../services/leaves';
import { fetchReleaseLetters } from '../../../services/letters';
import { fetchResident } from '../../../services/residents';
import { fetchResidentSchedule } from '../../../services/rotations';
import { spacing } from '../../../theme';
import { formatDate, formatDateRange, formatHours, humanizeToken } from '../../../utils/format';
import { summarizeDutyHours, summarizeSchedule } from '../../../utils/insights';
import { humanizeEnum, residentFullName } from '../../../utils/residents';
import type { ReleaseLetter } from '../../../types/api';

/**
 * A single resident's record, as seen by a coordinator.
 *
 * This is the screen where a coordinator answers "how is this person doing?",
 * so it aggregates four endpoints onto one page: identity, current rotation,
 * duty-hour position, leave history and release letters. Each is loaded through
 * its own resource so one slow endpoint does not blank the other three.
 */
export default function ResidentRecordScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const residentId = Number(id);

  const profile = useApiResource(() => fetchResident(residentId), [residentId]);
  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);
  const attendance = useApiResource(() => fetchAttendance(residentId), [residentId]);
  const leaves = useApiResource(() => fetchLeaves(residentId), [residentId]);
  const letters = useApiResource(() => fetchReleaseLetters(residentId), [residentId]);

  const rotations = useMemo(() => summarizeSchedule(schedule.data ?? []), [schedule.data]);
  const duty = useMemo(() => summarizeDutyHours(attendance.data ?? []), [attendance.data]);
  const letterList = letters.data ?? [];
  const enrollment = profile.data?.enrollments[0] ?? null;

  // The letter rows used to be inert: a `Sent` badge you could not open, so a
  // coordinator could see a letter existed but never read it. The preview is the
  // same sheet the resident's profile opens, not a separate document view.
  const [previewLetter, setPreviewLetter] = useState<ReleaseLetter | null>(null);

  if (!Number.isFinite(residentId)) {
    return (
      <Screen>
        <AppHeader title="Resident" onBack={goBack} />
        <ErrorState
          title="Unknown resident"
          message="That link did not include a valid resident id."
          onRetry={goBack}
        />
      </Screen>
    );
  }

  const breaches = (attendance.data ?? []).filter((log) => log.is_flagged_for_breach === 1);

  return (
    <Screen
      onRefresh={() => {
        profile.refresh();
        schedule.refresh();
        attendance.refresh();
        leaves.refresh();
        letters.refresh();
      }}
      refreshing={profile.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader
        title={profile.data ? residentFullName(profile.data) : 'Resident'}
        subtitle={enrollment ? `${enrollment.specialty_name} · ${enrollment.program_code}` : undefined}
        onBack={goBack}
      />

      {profile.isLoading ? <SkeletonList rows={5} /> : null}

      {profile.error ? (
        <ErrorState
          title="Could not load this resident"
          message={profile.error.message}
          onRetry={profile.refresh}
        />
      ) : null}

      {profile.data ? (
        <>
          <Card>
            <View style={styles.identity}>
              <Avatar name={residentFullName(profile.data)} size={52} />
              <View style={styles.identityText}>
                <Text variant="h3">Resident #{profile.data.id}</Text>
                <Text variant="caption" tone="secondary">
                  {enrollment
                    ? `${humanizeEnum(enrollment.resident_status)} · ${humanizeEnum(enrollment.position_type)}`
                    : 'No program enrollment'}
                </Text>
              </View>
            </View>
            <Divider />
            <DetailRow label="Date of birth" value={formatDate(profile.data.date_of_birth)} />
            <DetailRow label="Sex" value={humanizeEnum(profile.data.sex)} />
            <DetailRow label="Nationality" value={profile.data.nationality} />
            <DetailRow label="Citizenship" value={humanizeEnum(profile.data.citizenship_status)} />
            {profile.data.identifiers.length > 0 ? (
              <DetailRow
                label="Primary identifier"
                value={`${humanizeToken(profile.data.identifiers[0].identifier_type)} · ${profile.data.identifiers[0].identifier_value}`}
              />
            ) : null}
          </Card>

          <SectionHeader title="Duty hours" />
          <View style={styles.statRow}>
            <StatTile value={formatHours(duty.windowHours)} label="Last 7 days" icon={Clock} />
            <StatTile value={String(duty.windowShifts)} label="Shifts" />
            <StatTile
              value={String(duty.totalBreaches)}
              label="Breaches"
              tone={duty.totalBreaches > 0 ? 'danger' : 'success'}
            />
          </View>

          {breaches.length > 0 ? (
            <>
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

          <SectionHeader title="Rotation" />
          {schedule.isLoading ? (
            <SkeletonList rows={2} />
          ) : rotations.current ? (
            <Card>
              <Text variant="h3">{rotations.current.rotation_name}</Text>
              <Text variant="bodySmall" tone="secondary">
                {formatDateRange(rotations.current.start_date, rotations.current.end_date)} ·{' '}
                {rotations.current.department_name ?? 'Department not assigned'}
              </Text>
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon={CalendarDays}
                title="Not on a rotation"
                message={
                  rotations.next
                    ? `Next: ${rotations.next.rotation_name}, ${formatDateRange(rotations.next.start_date, rotations.next.end_date)}.`
                    : 'No active or upcoming rotation assignment.'
                }
              />
            </Card>
          )}

          <SectionHeader title={`Leave history (${leaves.data?.length ?? 0})`} />
          {leaves.data && leaves.data.length > 0 ? (
            <Card padded={false}>
              {leaves.data.map((request, index) => (
                <ListRow
                  key={request.request_id}
                  title={humanizeToken(request.leave_type)}
                  subtitle={`${formatDateRange(request.start_date, request.end_date)} · ${request.total_days} day${request.total_days === 1 ? '' : 's'}`}
                  meta={request.rejection_reason ?? request.reason ?? undefined}
                  trailing={
                    <StatusBadge
                      label={humanizeToken(request.status)}
                      tone={
                        request.status === 'APPROVED'
                          ? 'success'
                          : request.status === 'REJECTED'
                            ? 'danger'
                            : request.status === 'CANCELLED'
                              ? 'neutral'
                              : 'warning'
                      }
                    />
                  }
                  last={index === leaves.data!.length - 1}
                  muted={request.status === 'CANCELLED'}
                />
              ))}
            </Card>
          ) : (
            <Card>
              <EmptyState icon={UserRound} title="No leave on record" message="This resident has not requested any leave." />
            </Card>
          )}

          {letterList.length > 0 ? (
            <>
              <SectionHeader title="Release letters" />
              <Card padded={false}>
                {letterList.map((letter, index) => (
                  <ListRow
                    key={letter.letter_id}
                    title={letter.clinic_name}
                    subtitle={letter.site_name ?? undefined}
                    meta={`${formatDateRange(letter.release_start_date, letter.release_end_date)} · to ${letter.recipient_dept_head}`}
                    trailing={<StatusBadge label={humanizeToken(letter.sent_status)} tone="info" />}
                    onPress={() => setPreviewLetter(letter)}
                    last={index === letterList.length - 1}
                  />
                ))}
              </Card>
            </>
          ) : null}
        </>
      ) : null}

      <LetterPreviewSheet letter={previewLetter} onClose={() => setPreviewLetter(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  identityText: {
    flex: 1,
    gap: 2,
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
});