import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ChevronDown, ChevronUp, Library } from 'lucide-react-native';
import { router } from 'expo-router';

import {
  AppHeader,
  Banner,
  Button,
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
import { fetchRotationBlocks, fetchRotations, generateAcademicBlocks } from '../../../services/rotations';
import { colors, spacing, type Tone } from '../../../theme';
import { blockTitle } from '../../../utils/blockLabels';
import { formatDateRange, formatWeeks, humanizeToken, todayCalendarDate } from '../../../utils/format';
import {
  blockPhase,
  blockStartDay,
  partitionBlocksByDate,
  type BlockPhase,
} from '../../../utils/rotationBlocks';
import type { RotationBlock } from '../../../types/api';

/**
 * Rotations — the programme's rotation catalogue and its academic blocks.
 *
 * Two related things, split by a choice group rather than two screens, because
 * they are always read together when assigning somebody: "what rotations exist?"
 * and "which blocks do they fit into?".
 *
 * The Blocks list is organised around *today*. An academic year can hold
 * thirteen blocks, most of which are irrelevant to a coordinator mid-year, so
 * the running block leads and everything else is one tap away: past blocks are
 * hidden behind a toggle (finished work is rarely what you came for), and the
 * remaining future blocks are collapsible so the year does not dominate the
 * screen. A gap between blocks — an off-cycle transition — promotes the next
 * block to "Upcoming" instead of leaving the screen without an anchor.
 *
 * The screen links out to the tools built for writing: the Master Rotation Grid,
 * the Continuity of Care Clinics (CCC) matrix, and the Rotations Catalogue. Rotation
 * *definitions* are read here and managed in `../rotations/catalogue` — creating,
 * renaming and bulk importing them needs a table of its own, which is why this
 * list opens that screen instead of growing inline edit controls.
 */

type View2 = 'BLOCKS' | 'ROTATIONS';

/** The badge shown on a block row for each phase. Colour is never the only cue. */
const PHASE_BADGE: Record<BlockPhase, { label: string; tone: Tone }> = {
  PAST: { label: 'Past', tone: 'neutral' },
  CURRENT: { label: 'Current', tone: 'success' },
  FUTURE: { label: 'Future', tone: 'info' },
  UNKNOWN: { label: 'No dates', tone: 'warning' },
};

export default function ProgramRotationsScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const [view, setView] = useState<View2>('BLOCKS');
  const [query, setQuery] = useState('');
  // Past blocks are hidden by default; the rest of the year starts collapsed so
  // the running block is the only thing competing for attention.
  const [showPast, setShowPast] = useState(false);
  const [showFuture, setShowFuture] = useState(false);

  const blocks = useApiResource(() => fetchRotationBlocks(programId), [programId]);
  const rotations = useApiResource(() => fetchRotations(programId), [programId]);

  const [calendarNotice, setCalendarNotice] = useState<string | null>(null);
  const completedCalendar = useRef(false);
  const refreshBlocks = blocks.refresh;

  /**
   * Complete the academic year to its thirteen blocks.
   *
   * The Master Rotation Grid has always drawn thirteen columns, but the block
   * table only held what had been typed in by hand (production stopped at Block
   * 7), so Blocks 8-13 could not be assigned at all. The API fills only the
   * missing numbers and never edits an existing block, so this is safe to run on
   * every open; the ref keeps it to one request per visit, and a complete year
   * writes nothing.
   */
  useEffect(() => {
    if (completedCalendar.current || programId <= 0 || blocks.status !== 'ready') return;
    completedCalendar.current = true;
    generateAcademicBlocks(programId)
      .then((result) => {
        if (result.created.length === 0) return;
        const first = result.created[0].block_number;
        const last = result.created[result.created.length - 1].block_number;
        setCalendarNotice(
          `Added ${result.created.length} block${
            result.created.length === 1 ? '' : 's'
          } (Block ${first}–${last}) to complete ${result.academic_year}.`,
        );
        refreshBlocks();
      })
      .catch(() => {
        // The screen still lists the blocks on record; failing to complete the
        // calendar must not stop a coordinator from reading it.
      });
  }, [blocks.status, programId, refreshBlocks]);

  const needle = query.trim().toLowerCase();
  const today = todayCalendarDate();
  const searching = needle.length > 0;

  const matchedBlocks = useMemo(
    () =>
      (blocks.data ?? [])
        .filter((block) => (needle ? blockTitle(block).toLowerCase().includes(needle) : true))
        .sort((a, b) => (blockStartDay(a) ?? '').localeCompare(blockStartDay(b) ?? '')),
    [blocks.data, needle],
  );

  const { past, current, future } = useMemo(
    () => partitionBlocksByDate(matchedBlocks, today),
    [matchedBlocks, today],
  );

  // The one block the screen always shows: the running block if there is one,
  // otherwise the next block to start so an off-cycle gap still has an anchor.
  const highlighted = current ?? future[0] ?? null;
  const highlightedIsCurrent = current !== null;
  // With no running block the anchor already is the first future block, so the
  // collapsible remainder starts after it.
  const remainingFuture = current ? future : future.slice(1);

  const visibleRotations = useMemo(
    () =>
      (rotations.data ?? []).filter((rotation) =>
        needle ? `${rotation.rotation_name} ${rotation.department_name ?? ''}`.toLowerCase().includes(needle) : true,
      ),
    [rotations.data, needle],
  );

  function openBlock(block: RotationBlock) {
    router.push(`/program/block/${block.block_id}` as any);
  }

  function renderBlockRow(block: RotationBlock, index: number, list: RotationBlock[]) {
    const phase = blockPhase(block, today);
    const badge = PHASE_BADGE[phase];
    return (
      <ListRow
        key={block.block_id}
        title={blockTitle(block)}
        subtitle={
          block.week_start_day
            ? `Week starts ${humanizeToken(block.week_start_day)}`
            : 'No first day of week recorded'
        }
        meta={formatDateRange(block.start_date, block.end_date)}
        trailing={<StatusBadge label={badge.label} tone={badge.tone} />}
        last={index === list.length - 1}
        muted={phase === 'PAST'}
        onPress={() => openBlock(block)}
      />
    );
  }

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
          placeholder={view === 'BLOCKS' ? 'Block number or year' : 'Rotation or department'}
        />
      </View>

      {view === 'BLOCKS' && calendarNotice ? (
        <Banner
          tone="info"
          title="Academic calendar completed"
          message={calendarNotice}
          onDismiss={() => setCalendarNotice(null)}
          style={styles.calendarNotice}
        />
      ) : null}

      {view === 'BLOCKS' ? (
        <>
          {blocks.isLoading ? <SkeletonList rows={4} /> : null}
          {blocks.error ? (
            <ErrorState title="Could not load blocks" message={blocks.error.message} onRetry={blocks.refresh} />
          ) : null}

          {blocks.status === 'ready' && matchedBlocks.length === 0 ? (
            <Card>
              <EmptyState
                icon={Library}
                title={searching ? 'No matching blocks' : 'No blocks'}
                message={
                  searching
                    ? `Nothing matches “${query.trim()}”. Try a different block number or year.`
                    : 'No academic blocks are recorded for this programme.'
                }
              />
            </Card>
          ) : null}

          {/* While searching, every phase is shown in one flat list so a past or
              future block is never hidden behind a collapsed section. */}
          {searching && matchedBlocks.length > 0 ? (
            <>
              <SectionHeader
                title="Search results"
                trailing={`${matchedBlocks.length} block${matchedBlocks.length === 1 ? '' : 's'}`}
              />
              <Card padded={false}>
                {matchedBlocks.map((block, index) => renderBlockRow(block, index, matchedBlocks))}
              </Card>
            </>
          ) : null}

          {!searching && matchedBlocks.length > 0 ? (
            <>
              {past.length > 0 ? (
                <>
                  <Button
                    label={
                      showPast ? 'Hide Past Rotations' : `Show Past Rotations (${past.length})`
                    }
                    variant="ghost"
                    icon={showPast ? ChevronUp : ChevronDown}
                    iconPosition="trailing"
                    onPress={() => setShowPast((value) => !value)}
                    accessibilityLabel={
                      showPast
                        ? `Hide ${past.length} past rotation blocks`
                        : `Show ${past.length} past rotation blocks`
                    }
                    accessibilityHint="Toggles blocks that have already finished"
                    style={styles.toggle}
                  />
                  {showPast ? (
                    <>
                      <SectionHeader
                        title="Past rotations"
                        trailing={`${past.length} block${past.length === 1 ? '' : 's'}`}
                      />
                      <Card padded={false}>
                        {past.map((block, index) => renderBlockRow(block, index, past))}
                      </Card>
                    </>
                  ) : null}
                </>
              ) : null}

              {highlighted ? (
                <>
                  <SectionHeader title={highlightedIsCurrent ? 'Running now' : 'Next up'} />
                  <Card
                    padded={false}
                    style={highlightedIsCurrent ? styles.currentCard : styles.upcomingCard}
                  >
                    <ListRow
                      title={blockTitle(highlighted)}
                      titleAccessory={
                        <StatusBadge
                          label={highlightedIsCurrent ? 'Current' : 'Upcoming'}
                          tone={highlightedIsCurrent ? 'success' : 'warning'}
                        />
                      }
                      subtitle={
                        highlighted.week_start_day
                          ? `Week starts ${humanizeToken(highlighted.week_start_day)}`
                          : 'No first day of week recorded'
                      }
                      meta={formatDateRange(highlighted.start_date, highlighted.end_date)}
                      onPress={() => openBlock(highlighted)}
                    />
                  </Card>
                </>
              ) : null}

              {remainingFuture.length > 0 ? (
                <>
                  <Button
                    label={
                      showFuture
                        ? 'Hide Future Blocks'
                        : `Show Future Blocks (${remainingFuture.length})`
                    }
                    variant="ghost"
                    icon={showFuture ? ChevronUp : ChevronDown}
                    iconPosition="trailing"
                    onPress={() => setShowFuture((value) => !value)}
                    accessibilityLabel={
                      showFuture
                        ? `Hide ${remainingFuture.length} future rotation blocks`
                        : `Show ${remainingFuture.length} future rotation blocks`
                    }
                    accessibilityHint="Toggles the remaining blocks through the end of the academic year"
                    style={styles.toggle}
                  />
                  {showFuture ? (
                    <>
                      <SectionHeader
                        title="Future blocks"
                        trailing={`${remainingFuture.length} block${
                          remainingFuture.length === 1 ? '' : 's'
                        }`}
                      />
                      <Card padded={false}>
                        {remainingFuture.map((block, index) =>
                          renderBlockRow(block, index, remainingFuture),
                        )}
                      </Card>
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}

          {/* Shown even when the list is empty or filtered away: the rotation
              tools stay reachable whichever blocks happen to be on record. */}
          {blocks.status === 'ready' && needle === '' ? (
            <>
              <Text variant="label" tone="secondary" uppercase style={styles.toolsLabel}>
                Tools
              </Text>
              <Button
                label="Master Rotation Grid"
                variant="outline"
                onPress={() => router.push('/program/master/grid' as any)}
                style={styles.addButton}
              />
              <Button
                label="Continuity Care Clinics"
                variant="outline"
                onPress={() => router.push('/program/longitudinal/matrix' as any)}
                style={styles.addButton}
              />
              <Button
                label="Rotations Catalogue"
                variant="outline"
                icon={Library}
                onPress={() => router.push('/program/rotations/catalogue')}
                style={styles.addButton}
              />
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
                actionLabel="Manage the catalogue"
                onActionPress={() => router.push('/program/rotations/catalogue')}
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
                  onPress={() => router.push('/program/rotations/catalogue')}
                  accessibilityHint="Opens the catalogue, where rotations are added, edited and imported"
                  last={index === visibleRotations.length - 1}
                  muted={rotation.is_active !== 1}
                />
              ))}
            </Card>
          ) : null}

          {rotations.status === 'ready' && (rotations.data?.length ?? 0) > 0 ? (
            <Button
              label="Rotations Catalogue"
              variant="secondary"
              icon={Library}
              onPress={() => router.push('/program/rotations/catalogue')}
              style={styles.addButton}
            />
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
  calendarNotice: {
    marginBottom: spacing.md,
  },
  addButton: {
    marginTop: spacing.md,
  },
  toolsLabel: {
    marginTop: spacing.lg,
  },
  toggle: {
    marginTop: spacing.sm,
  },
  /** The running block: green so it reads as "live" at a glance. */
  currentCard: {
    borderColor: colors.success,
    backgroundColor: colors.successSurface,
  },
  /** The next block when today sits between blocks. */
  upcomingCard: {
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primarySoft,
  },
});
