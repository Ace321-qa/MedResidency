import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Library } from 'lucide-react-native';

import {
  AppHeader,
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
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchRotationBlocks, fetchRotations } from '../../../services/rotations';
import { spacing } from '../../../theme';
import { formatDateRange, formatWeeks, humanizeToken, todayCalendarDate } from '../../../utils/format';

/**
 * Rotations — the programme's rotation catalogue and its academic blocks.
 *
 * Two related things, split by a choice group rather than two screens, because
 * they are always read together when assigning somebody: "what rotations exist?"
 * and "which blocks do they fit into?".
 *
 * Both are read-only. Creating rotations and blocks belongs to the academic
 * office and there is no POST endpoint for them, so this screen does not offer
 * a button that could not work.
 */

type View2 = 'BLOCKS' | 'ROTATIONS';

export default function ProgramRotationsScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const [view, setView] = useState<View2>('BLOCKS');
  const [query, setQuery] = useState('');

  const blocks = useApiResource(() => fetchRotationBlocks(programId), [programId]);
  const rotations = useApiResource(() => fetchRotations(programId), [programId]);

  const needle = query.trim().toLowerCase();
  const today = todayCalendarDate();

  const visibleBlocks = useMemo(
    () =>
      (blocks.data ?? [])
        .filter((block) =>
          needle ? `${block.block_name} ${block.academic_year}`.toLowerCase().includes(needle) : true,
        )
        .sort((a, b) => a.start_date.localeCompare(b.start_date)),
    [blocks.data, needle],
  );

  const visibleRotations = useMemo(
    () =>
      (rotations.data ?? []).filter((rotation) =>
        needle ? `${rotation.rotation_name} ${rotation.department_name ?? ''}`.toLowerCase().includes(needle) : true,
      ),
    [rotations.data, needle],
  );

  return (
    <Screen
      onRefresh={() => {
        blocks.refresh();
        rotations.refresh();
      }}
      refreshing={blocks.isRefreshing || rotations.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Rotations" subtitle="Blocks and the rotation catalogue" />

      <ChoiceGroup
        label="Show"
        columns={2}
        value={view}
        onChange={(value) => setView(value as View2)}
        options={[
          { value: 'BLOCKS', label: `Blocks (${blocks.data?.length ?? 0})` },
          { value: 'ROTATIONS', label: `Catalogue (${rotations.data?.length ?? 0})` },
        ]}
      />

      <View style={styles.search}>
        <SearchInput
          accessibilityLabel={view === 'BLOCKS' ? 'Search blocks' : 'Search rotations'}
          value={query}
          onChangeText={setQuery}
          placeholder={view === 'BLOCKS' ? 'Block name or year' : 'Rotation or department'}
        />
      </View>

      {view === 'BLOCKS' ? (
        <>
          {blocks.isLoading ? <SkeletonList rows={4} /> : null}
          {blocks.error ? (
            <ErrorState title="Could not load blocks" message={blocks.error.message} onRetry={blocks.refresh} />
          ) : null}

          {blocks.status === 'ready' && visibleBlocks.length === 0 ? (
            <Card>
              <EmptyState
                icon={Library}
                title="No blocks"
                message="No academic blocks are recorded for this programme."
              />
            </Card>
          ) : null}

          {visibleBlocks.length > 0 ? (
            <>
              <SectionHeader title={`${visibleBlocks.length} block${visibleBlocks.length === 1 ? '' : 's'}`} />
              <Card padded={false}>
                {visibleBlocks.map((block, index) => {
                  const isCurrent = block.start_date <= today && block.end_date >= today;
                  const isPast = block.end_date < today;
                  return (
                    <ListRow
                      key={block.block_id}
                      title={`${block.block_name} · ${block.academic_year}`}
                      subtitle={`Starts ${humanizeToken(block.week_start_day ?? 'monday')}`}
                      meta={formatDateRange(block.start_date, block.end_date)}
                      trailing={
                        <StatusBadge
                          label={isCurrent ? 'Current' : isPast ? 'Past' : 'Future'}
                          tone={isCurrent ? 'success' : isPast ? 'neutral' : 'info'}
                        />
                      }
                      last={index === visibleBlocks.length - 1}
                      muted={isPast}
                    />
                  );
                })}
              </Card>
              <Text variant="caption" tone="muted" style={styles.footnote}>
                Blocks are created by the academic office. This app has no endpoint to add or edit them.
              </Text>
            </>
          ) : null}
        </>
      ) : (
        <>
          {rotations.isLoading ? <SkeletonList rows={4} /> : null}
          {rotations.error ? (
            <ErrorState
              title="Could not load the catalogue"
              message={rotations.error.message}
              onRetry={rotations.refresh}
            />
          ) : null}

          {rotations.status === 'ready' && visibleRotations.length === 0 ? (
            <Card>
              <EmptyState
                icon={Library}
                title="No rotations"
                message="No rotation definitions are recorded for this programme."
              />
            </Card>
          ) : null}

          {visibleRotations.length > 0 ? (
            <Card padded={false}>
              {visibleRotations.map((rotation, index) => (
                <ListRow
                  key={rotation.rotation_id}
                  title={rotation.rotation_name}
                  subtitle={rotation.department_name ?? 'Department not assigned'}
                  meta={`${rotation.rotation_code} · default ${formatWeeks(rotation.default_duration_weeks)}`}
                  trailing={
                    <StatusBadge
                      label={rotation.is_active === 1 ? 'Available' : 'Inactive'}
                      tone={rotation.is_active === 1 ? 'success' : 'neutral'}
                    />
                  }
                  last={index === visibleRotations.length - 1}
                  muted={rotation.is_active !== 1}
                />
              ))}
            </Card>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    marginVertical: spacing.md,
  },
  footnote: {
    marginTop: spacing.sm,
  },
});