import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, ClipboardCheck, LogOut, Settings, Timer, TriangleAlert } from 'lucide-react-native';

import {
  AppHeader,
  Avatar,
  Button,
  Card,
  DetailRow,
  Divider,
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
import { useApiResource, useSession } from '../../../hooks';
import { fetchAttendance } from '../../../services/attendance';
import { fetchReleaseLetters } from '../../../services/letters';
import { fetchResident } from '../../../services/residents';
import { fetchResidentSchedule } from '../../../services/rotations';
import { spacing } from '../../../theme';
import { formatDate, formatDateRange, formatHours, humanizeToken } from '../../../utils/format';
import { summarizeMonth } from '../../../utils/insights';
import { unresolvedPlaceholders } from '../../../utils/letterPreview';
import { humanizeEnum, residentFullName } from '../../../utils/residents';
import type { ReleaseLetter } from '../../../types/api';

/**
 * Profile — who is signed in, their record, and their progress.
 *
 * The identification block comes from `GET /residents/:id` rather than from the
 * sign-in screen, so if the two ever disagree the profile shows the server's
 * version. Enrollment and release letters come from the same endpoint, which is
 * why they sit here instead of on separate screens: there is nothing else to
 * show for them today.
 */

const LETTER_TONE = {
  DRAFT: 'neutral',
  GENERATED: 'info',
  SENT: 'info',
  ACKNOWLEDGED: 'success',
} as const;

/**
 * Whether a stored letter still carries `{{TOKEN}}` markers.
 *
 * The list endpoint does not return `unresolved_placeholders`, so the body is
 * checked for them here. A letter with one is not ready to be signed, and that
 * has to be visible before the resident opens it — not after.
 */
function hasUnresolvedFields(letter: ReleaseLetter): boolean {
  return unresolvedPlaceholders(letter.generated_letter_body).length > 0;
}

export default function ProfileScreen() {
  const router = useRouter();
  const { session, signOut } = useSession();
  const residentId = session?.residentId ?? 0;

  const profile = useApiResource(() => fetchResident(residentId), [residentId]);
  const letters = useApiResource(() => fetchReleaseLetters(residentId), [residentId]);
  const attendance = useApiResource(() => fetchAttendance(residentId), [residentId]);
  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);

  const month = useMemo(
    () => summarizeMonth(attendance.data ?? [], schedule.data ?? []),
    [attendance.data, schedule.data],
  );

  // Memoised rather than `letters.data ?? []` inline: the preview lookup below
  // depends on it, and a fresh array each render would make that memo recompute on
  // every keystroke of nothing at all.
  const letterList = useMemo(() => letters.data ?? [], [letters.data]);

  const enrollment = useMemo(
    () => profile.data?.enrollments[0] ?? null,
    [profile.data],
  );

  /**
   * Which letter the preview sheet is showing, or `null` for none.
   *
   * Held here rather than in the sheet so the sheet unmounts its content when
   * closed, and so the rows below stay the single source of truth for which
   * letters exist — the sheet is a view onto a selection, not a second list.
   */
  const [previewLetterId, setPreviewLetterId] = useState<number | null>(null);
  const previewLetter = useMemo(
    () => letterList.find((letter) => letter.letter_id === previewLetterId) ?? null,
    [letterList, previewLetterId],
  );

  return (
    <Screen
      onRefresh={() => {
        profile.refresh();
        letters.refresh();
        attendance.refresh();
        schedule.refresh();
      }}
      refreshing={
        profile.isRefreshing ||
        letters.isRefreshing ||
        attendance.isRefreshing ||
        schedule.isRefreshing
      }
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Profile" subtitle={session?.residentName ?? undefined} />

      {profile.isLoading ? <SkeletonList rows={4} /> : null}

      {profile.error ? (
        <ErrorState
          title="Could not load your profile"
          message={profile.error.message}
          onRetry={profile.refresh}
        />
      ) : null}

      {profile.data ? (
        <Card>
          <View style={styles.identity}>
            <Avatar name={residentFullName(profile.data)} size={52} />
            <View style={styles.identityText}>
              <Text variant="h2">{residentFullName(profile.data)}</Text>
              <Text variant="bodySmall" tone="secondary">
                {enrollment?.specialty_name ?? 'Programme not assigned'}
                {enrollment?.program_code ? ` · ${enrollment.program_code}` : ''}
              </Text>
            </View>
          </View>

          <Divider />

          <DetailRow label="Date of birth" value={formatDate(profile.data.date_of_birth)} />
          <DetailRow label="Sex" value={humanizeEnum(profile.data.sex)} />
          <DetailRow label="Nationality" value={profile.data.nationality} />
          <DetailRow label="Citizenship" value={humanizeEnum(profile.data.citizenship_status)} />
          {profile.data.race_ethnicity ? (
            <DetailRow label="Race / ethnicity" value={humanizeEnum(profile.data.race_ethnicity)} />
          ) : null}
        </Card>
      ) : null}

      {enrollment ? (
        <>
          <SectionHeader title="Current enrollment" />
          <Card>
            <View style={styles.tagRow}>
              <StatusBadge
                label={humanizeEnum(enrollment.resident_status)}
                tone={enrollment.resident_status === 'ACTIVE_FULL_TIME' ? 'success' : 'neutral'}
              />
              <StatusBadge label={humanizeEnum(enrollment.position_type)} tone="info" />
            </View>
            <View style={styles.detailStack}>
              <DetailRow label="Year in programme" value={enrollment.year_in_program === null ? '—' : `PGY-${enrollment.year_in_program}`} />
              <DetailRow
                label="Programme period"
                value={
                  enrollment.start_date && enrollment.expected_completion_date
                    ? formatDateRange(enrollment.start_date, enrollment.expected_completion_date)
                    : 'Not recorded'
                }
              />
              <DetailRow label="Standard shift" value={enrollment.standard_shift_hours === null ? '—' : formatHours(enrollment.standard_shift_hours)} />
            </View>
          </Card>
        </>
      ) : null}

      <SectionHeader title="Shortcuts" />
      <Card padded={false}>
        <ListRow
          title="Notifications"
          subtitle="Requests, decisions and duty-hour alerts"
          leadingIcon={Bell}
          onPress={() => router.push('/resident/notifications')}
        />
        <ListRow
          title="Settings"
          subtitle="API address, connection test, sign out"
          leadingIcon={Settings}
          onPress={() => router.push('/resident/settings')}
          last
        />
      </Card>

      {letterList.length > 0 ? (
        <>
          <SectionHeader title="Dispatched release letters" trailing={`${letterList.length} on record`} />
          <Card padded={false}>
            {letterList.map((letter, index) => (
              <ListRow
                key={letter.letter_id}
                title={letter.clinic_name}
                subtitle={letter.site_name ?? undefined}
                meta={`${formatDateRange(letter.release_start_date, letter.release_end_date)} · to ${letter.recipient_dept_head}`}
                trailing={
                  <View style={styles.letterTrailing}>
                    {hasUnresolvedFields(letter) ? <StatusBadge label="Incomplete" tone="warning" /> : null}
                    <StatusBadge
                      label={humanizeToken(letter.sent_status)}
                      tone={LETTER_TONE[letter.sent_status] ?? 'neutral'}
                    />
                  </View>
                }
                onPress={() => setPreviewLetterId(letter.letter_id)}
                accessibilityHint="Shows the full letter"
                last={index === letterList.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      <LetterPreviewSheet letter={previewLetter} onClose={() => setPreviewLetterId(null)} />

      <SectionHeader title="Progress" trailing={month.monthLabel} />
      <Card>
        <View style={styles.progressStats}>
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
        <View style={styles.progressStats}>
          <StatTile value={String(month.shifts)} label="Shifts this month" />
          <StatTile
            value={String(month.breaches)}
            label="Breaches this month"
            icon={TriangleAlert}
            tone={month.breaches > 0 ? 'danger' : 'success'}
          />
        </View>
        <Text variant="caption" tone="muted">
          {month.monthLabel}: day {month.daysElapsed} of {month.daysInMonth}. Counts come from your
          attendance log and rotation assignments, not a sample.
        </Text>
      </Card>

      <Divider />

      <View style={styles.signOut}>
        <Text variant="caption" tone="muted">
          This build has no authentication, so signing out simply clears the local session.
        </Text>
        <Button
          label="Sign out"
          variant="outline"
          icon={LogOut}
          onPress={signOut}
          accessibilityHint="Returns to the sign-in screen"
        />
      </View>
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
  tagRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  detailStack: {
    gap: spacing.xs,
  },
  letterTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  progressStats: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  signOut: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});