import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FileText, Send } from 'lucide-react-native';

import { goBack } from '../../../navigation/back';
import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LetterPreviewSheet,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
  StatusBadge,
  Text,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchDispatchedLetters } from '../../../services/letters';
import { spacing } from '../../../theme';
import { formatDate } from '../../../utils/format';
import {
  hasUnresolvedFields,
  letterDestinationName,
  letterStatusTone,
} from '../../../utils/letterStatus';

/**
 * Dispatched letters log — every release letter the programme has merged and
 * sent, addressed to hospital department heads.
 *
 * This is the answer to "what have we actually told the hospital?", which no
 * other screen holds: the residents' roster shows who is enrolled, the clinic
 * matrix shows when they are released, and this shows the letters that went out
 * to make that release happen. Tapping a row opens the finished letter exactly
 * as the resident or department head received it.
 */

export default function DispatchedLettersLogScreen() {
  const router = useRouter();
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const letters = useApiResource(
    () => fetchDispatchedLetters(programId || undefined),
    [programId],
  );

  const list = useMemo(() => letters.data ?? [], [letters.data]);
  const [previewLetterId, setPreviewLetterId] = useState<number | null>(null);
  const previewLetter = useMemo(
    () => list.find((letter) => letter.letter_id === previewLetterId) ?? null,
    [list, previewLetterId],
  );

  return (
    <Screen
      onRefresh={letters.refresh}
      refreshing={letters.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader
        title="Dispatched Letters Log"
        onBack={goBack}
        subtitle="Generated letters sent to hospital department heads"
        action={
          <Button
            label="Generate"
            variant="ghost"
            fullWidth={false}
            icon={Send}
            onPress={() => router.push('/program/letters/generate')}
            accessibilityLabel="Generate and send a release letter"
          />
        }
      />

      {letters.isLoading ? <SkeletonList rows={5} /> : null}

      {letters.error ? (
        <ErrorState
          title="Could not load dispatched letters"
          message={letters.error.message}
          onRetry={letters.refresh}
        />
      ) : null}

      {letters.status === 'ready' ? (
        <>
          <SectionHeader
            title="Dispatched letters"
            trailing={`${list.length} on record`}
          />

          {list.length === 0 ? (
            <Card>
              <EmptyState
                icon={FileText}
                title="No letters dispatched yet"
                message="Generate a release letter and it will appear here, addressed to the receiving department head."
                actionLabel="Generate a letter"
                onActionPress={() => router.push('/program/letters/generate')}
              />
            </Card>
          ) : (
            <Card padded={false}>
              {list.map((letter, index) => (
                <ListRow
                  key={letter.letter_id}
                  title={letter.resident_name}
                  subtitle={
                    letter.hospital_department_name ?? 'Destination department not recorded'
                  }
                  meta={`${letterDestinationName(letter)} · To ${letter.recipient_dept_head} · Generated ${formatDate(letter.created_at)}`}
                  trailing={
                    <View style={styles.trailing}>
                      {hasUnresolvedFields(letter) ? (
                        <StatusBadge label="Incomplete" tone="warning" />
                      ) : null}
                      <StatusBadge
                        label={letter.sent_status}
                        tone={letterStatusTone(letter.sent_status)}
                      />
                    </View>
                  }
                  onPress={() => setPreviewLetterId(letter.letter_id)}
                  accessibilityHint="Shows the full letter"
                  last={index === list.length - 1}
                />
              ))}
            </Card>
          )}

          <Text variant="caption" tone="muted">
            Same letters the resident sees on their profile — one record, two views.
          </Text>
        </>
      ) : null}

      <LetterPreviewSheet letter={previewLetter} onClose={() => setPreviewLetterId(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
