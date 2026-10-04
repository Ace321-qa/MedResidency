import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, ClipboardList, LogOut, Settings } from 'lucide-react-native';

import {
  AppHeader,
  Avatar,
  Button,
  Card,
  DetailRow,
  Divider,
  ErrorState,
  ListRow,
  ProgressBar,
  Screen,
  SectionHeader,
  SkeletonList,
  StatusBadge,
  Text,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchReleaseLetters } from '../../../services/letters';
import { fetchResident } from '../../../services/residents';
import { fetchMockTrainingProgress } from '../../../services/mock';
import { spacing } from '../../../theme';
import { formatDate, formatDateRange, formatHours, humanizeToken } from '../../../utils/format';
import { humanizeEnum, residentFullName } from '../../../utils/residents';

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

export default function ProfileScreen() {
  const router = useRouter();
  const { session, signOut } = useSession();
  const residentId = session?.residentId ?? 0;

  const profile = useApiResource(() => fetchResident(residentId), [residentId]);
  const letters = useApiResource(() => fetchReleaseLetters(residentId), [residentId]);
  const progress = useApiResource(fetchMockTrainingProgress);

  const letterList = letters.data ?? [];

  const enrollment = useMemo(
    () => profile.data?.enrollments[0] ?? null,
    [profile.data],
  );

  return (
    <Screen
      onRefresh={() => {
        profile.refresh();
        letters.refresh();
      }}
      refreshing={profile.isRefreshing || letters.isRefreshing}
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
          title="Assessments"
          subtitle="Sample data — the API has no assessments endpoint"
          leadingIcon={ClipboardList}
          onPress={() => router.push('/resident/assessments')}
        />
        <ListRow
          title="Notifications"
          subtitle="Sample data — the API has no notifications endpoint"
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
          <SectionHeader title="Release letters" />
          <Card padded={false}>
            {letterList.map((letter, index) => (
              <ListRow
                key={letter.letter_id}
                title={letter.clinic_name}
                subtitle={letter.site_name ?? undefined}
                meta={`${formatDateRange(letter.release_start_date, letter.release_end_date)} · to ${letter.recipient_dept_head}`}
                trailing={
                  <StatusBadge
                    label={humanizeToken(letter.sent_status)}
                    tone={LETTER_TONE[letter.sent_status] ?? 'neutral'}
                  />
                }
                last={index === letterList.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      <SectionHeader title="Progress" trailing="Sample data" />
      <Card>
        {progress.data ? (
          <>
            <Text variant="bodySmall" tone="secondary">
              {formatHours(progress.data.annualHours)} of {formatHours(progress.data.annualCap)} annual duty hours
            </Text>
            <View style={styles.barGap}>
              <ProgressBar
                value={Math.round((progress.data.annualHours / progress.data.annualCap) * 100)}
                label="Annual duty hours against the programme cap"
              />
            </View>
            {progress.data.milestones.map((milestone) => (
              <View key={milestone.id} style={styles.milestone}>
                <View style={styles.milestoneHead}>
                  <Text variant="bodySmall">{milestone.label}</Text>
                  <Text variant="caption" tone="muted">
                    {milestone.percent}%
                  </Text>
                </View>
                <ProgressBar
                  value={milestone.percent}
                  tone={milestone.state === 'achieved' ? 'success' : 'info'}
                  label={`${milestone.label}: ${milestone.percent}%`}
                />
              </View>
            ))}
          </>
        ) : (
          <Text variant="bodySmall" tone="muted">
            Loading…
          </Text>
        )}
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
  barGap: {
    marginVertical: spacing.sm,
  },
  milestone: {
    marginTop: spacing.sm,
    gap: spacing.xxs,
  },
  milestoneHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  signOut: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});