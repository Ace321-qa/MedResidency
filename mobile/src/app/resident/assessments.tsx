import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ClipboardList } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Card,
  ChoiceGroup,
  EmptyState,
  ErrorState,
  ListRow,
  Screen,
  SearchInput,
  SectionHeader,
  SkeletonList,
  StatusBadge,
  Text,
} from '../../components';
import { useApiResource } from '../../hooks';
import { goBack } from '../../navigation/back';
import {
  MOCK_ASSESSMENT_STATUS_LABEL,
  MOCK_ASSESSMENT_STATUS_TONE,
  fetchMockAssessments,
  type MockAssessmentStatus,
} from '../../services/mock';
import { spacing } from '../../theme';
import { formatShortDate } from '../../utils/format';

/**
 * Assessments — **entirely sample data**.
 *
 * The banner at the top is not decoration. There is no assessments table and no
 * assessments endpoint, so nothing on this screen reflects a real record. It
 * exists so the assessment interface can be reviewed now rather than after the
 * backend is written. Delete `src/services/mock/` once the endpoint exists; see
 * that folder's README.
 */

type Filter = 'OPEN' | 'ALL';

export default function AssessmentsScreen() {
  const assessments = useApiResource(fetchMockAssessments);
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (assessments.data ?? [])
      .filter((item) => (filter === 'ALL' ? true : item.status !== 'COMPLETED'))
      .filter((item) =>
        needle ? `${item.title} ${item.context} ${item.category}`.toLowerCase().includes(needle) : true,
      );
  }, [assessments.data, filter, query]);

  return (
    <Screen
      onRefresh={assessments.refresh}
      refreshing={assessments.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Assessments" onBack={goBack} />

      <Banner
        tone="warning"
        title="Sample data"
        message="The API has no assessments endpoint, so nothing on this screen is a real record."
      />

      {assessments.isLoading ? <SkeletonList rows={4} /> : null}

      {assessments.error ? (
        <ErrorState title="Could not load" message={assessments.error.message} onRetry={assessments.refresh} />
      ) : null}

      <ChoiceGroup
        label="Filter assessments"
        columns={2}
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        options={[
          { value: 'OPEN', label: 'Outstanding' },
          { value: 'ALL', label: 'All' },
        ]}
      />

      {assessments.status === 'ready' ? (
        <>
          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search assessments"
              value={query}
              onChangeText={setQuery}
              placeholder="Title, rotation or category"
            />
          </View>

          <SectionHeader title={`${visible.length} assessment${visible.length === 1 ? '' : 's'}`} />

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={ClipboardList}
                title="Nothing here"
                message={query ? 'No assessment matches that search.' : 'No outstanding assessments.'}
              />
            </Card>
          ) : (
            <Card padded={false}>
              {visible.map((item, index) => (
                <ListRow
                  key={item.id}
                  title={item.title}
                  subtitle={`${item.context} · ${item.category}`}
                  meta={`Due ${formatShortDate(item.dueDate)}${item.evaluator ? ` · ${item.evaluator}` : ''}`}
                  trailing={
                    <StatusBadge
                      label={MOCK_ASSESSMENT_STATUS_LABEL[item.status as MockAssessmentStatus]}
                      tone={MOCK_ASSESSMENT_STATUS_TONE[item.status as MockAssessmentStatus]}
                    />
                  }
                  last={index === visible.length - 1}
                />
              ))}
            </Card>
          )}

          {visible.some((item) => item.feedback) ? (
            <>
              <SectionHeader title="Feedback received" />
              <Card>
                {visible
                  .filter((item) => item.feedback)
                  .map((item) => (
                    <View key={item.id} style={styles.feedback}>
                      <Text variant="h3">{item.title}</Text>
                      <Text variant="bodySmall" tone="secondary">
                        {item.evaluator} · scored {item.score}
                      </Text>
                      <Text variant="bodySmall">{item.feedback}</Text>
                    </View>
                  ))}
              </Card>
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    marginTop: spacing.md,
  },
  feedback: {
    gap: spacing.xxs,
    marginBottom: spacing.md,
  },
});