import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { AlertTriangle, Link2, Unlink } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { SheetSelectField } from './Form';
import { useApiResource } from '../hooks';
import {
  createProgramConnection,
  deleteProgramConnection,
  fetchConnectionTypes,
  fetchProgramConnections,
  fetchPrograms,
} from '../services/programs';
import type { Program, ProgramConnection, ProgramConnectionType } from '../types/api';

/**
 * ProgramConnectionsSheet — "Connect to Other Programme".
 *
 * A coordinator opens this from a programme card to declare which other
 * programmes in the city their residents may rotate into. The sheet is scoped to
 * one programme (the card it was opened from) and answers two questions: who are
 * we connected to, and who else could we connect to.
 *
 * ## Why the direction is not asked for
 *
 * A partnership is symmetric in meaning — if Internal Medicine takes Family
 * Medicine's residents, the two are connected — so the form does not offer a
 * direction to choose. The server stores the pair in a canonical order, which
 * means calling this from either card produces one connection rather than two
 * mirrored ones that would double-count a programme's partner list.
 */

interface ProgramConnectionsSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The programme whose card opened the sheet. */
  program: Program | null;
  onChanged?: () => void;
}

/** Human wording for a connection type, so the enum never reaches the screen. */
export const CONNECTION_TYPE_LABELS: Record<ProgramConnectionType, string> = {
  HOSPITAL_ROTATION: 'Hospital rotation',
  CLINIC_EXCHANGE: 'Clinic exchange',
  ACADEMIC_PARTNERSHIP: 'Academic partnership',
};

export function ProgramConnectionsSheet({
  visible,
  onClose,
  program,
  onChanged,
}: ProgramConnectionsSheetProps) {
  const programs = useApiResource(() => fetchPrograms(), []);
  const types = useApiResource(() => fetchConnectionTypes(), []);
  const [targetProgramId, setTargetProgramId] = useState<string | null>(null);
  const [connectionType, setConnectionType] = useState<ProgramConnectionType>('HOSPITAL_ROTATION');
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  /**
   * Reloading the connections when `tick` moves keeps the create and the remove
   * paths to one refresh: both bump the counter rather than each maintaining its
   * own copy of the list.
   */
  const connections = useApiResource<ProgramConnection[]>(
    async () => {
      if (!program) return [];
      return fetchProgramConnections(program.id);
    },
    [program?.id, tick],
  );

  const active = useMemo(
    () => (connections.data ?? []).filter((connection) => connection.is_active === 1),
    [connections.data],
  );

  /** Partners already connected, so the picker offers only new ones. */
  const connectedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const connection of active) {
      ids.add(Number(connection.source_program_id));
      ids.add(Number(connection.target_program_id));
    }
    return ids;
  }, [active]);

  const options = useMemo(() => {
    const rows = programs.data ?? [];
    return rows
      .filter((row) => row.id !== program?.id && row.is_active === 1 && !connectedIds.has(row.id))
      .map((row) => ({
        value: String(row.id),
        label: `${row.program_name}${row.specialty_name ? ` — ${row.specialty_name}` : ''}`,
      }));
  }, [programs.data, program?.id, connectedIds]);

  const typeOptions = useMemo(() => {
    const served = types.data ?? [];
    const list = served.length > 0 ? served : (Object.keys(CONNECTION_TYPE_LABELS) as ProgramConnectionType[]);
    return list.map((value) => ({ value, label: CONNECTION_TYPE_LABELS[value] ?? value }));
  }, [types.data]);

  async function handleConnect() {
    if (!program || !targetProgramId) return;
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const created = await createProgramConnection({
        source_program_id: program.id,
        target_program_id: Number(targetProgramId),
        connection_type: connectionType,
      });
      setNotice(`Connected to ${created.target_program_name || created.source_program_name}.`);
      setTargetProgramId(null);
      setTick((value) => value + 1);
      programs.refresh();
      onChanged?.();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'The connection could not be created.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect(connectionId: number) {
    setError(null);
    setNotice(null);
    setRemovingId(connectionId);
    try {
      await deleteProgramConnection(connectionId);
      setNotice('Connection withdrawn.');
      setTick((value) => value + 1);
      programs.refresh();
      onChanged?.();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'The connection could not be withdrawn.');
    } finally {
      setRemovingId(null);
    }
  }

  /** The other programme on a connection, from this programme's point of view. */
  function partnerOf(connection: ProgramConnection) {
    if (!program) return connection.target_program_name;
    return Number(connection.source_program_id) === program.id
      ? connection.target_program_name
      : connection.source_program_name;
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Connect to other programme"
      subtitle={program ? program.program_name : undefined}
      footer={<Button label="Done" onPress={onClose} />}
    >
      <ScrollView contentContainerStyle={styles.body}>
        <Text variant="bodySmall" tone="secondary">
          A connection lets this programme&apos;s residents rotate into another programme&apos;s
          departments, and tells that programme&apos;s coordinator when one of your residents is
          posted to them.
        </Text>

        {active.length > 0 ? (
          <View style={styles.section}>
            <Text variant="label" uppercase tone="secondary">
              Connected programmes
            </Text>
            {active.map((connection) => (
              <View key={connection.id} style={styles.row}>
                <View style={styles.rowText}>
                  <View style={styles.rowTitle}>
                    <Link2 size={14} color={colors.primary} />
                    <Text variant="body">{partnerOf(connection)}</Text>
                  </View>
                  <Text variant="caption" tone="muted">
                    {CONNECTION_TYPE_LABELS[connection.connection_type] ?? connection.connection_type}
                  </Text>
                </View>
                <Button
                  label="Withdraw"
                  variant="ghost"
                  fullWidth={false}
                  icon={Unlink}
                  loading={removingId === connection.id}
                  disabled={removingId !== null}
                  onPress={() => void handleDisconnect(connection.id)}
                  accessibilityLabel={`Withdraw the connection with ${partnerOf(connection)}`}
                />
              </View>
            ))}
          </View>
        ) : connections.status === 'ready' ? (
          <View style={styles.banner}>
            <Text variant="bodySmall" tone="muted">
              This programme is not connected to any other yet.
            </Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text variant="label" uppercase tone="secondary">
            Add a connection
          </Text>

          {options.length === 0 && programs.status === 'ready' ? (
            <View style={styles.banner}>
              <View style={styles.rowTitle}>
                <AlertTriangle size={14} color={colors.warning} />
                <Text variant="bodySmall" style={styles.warningText}>
                  {connectedIds.size > 0
                    ? 'Every other active programme is already connected.'
                    : 'There is no other active programme to connect to yet. Register one first.'}
                </Text>
              </View>
            </View>
          ) : (
            <>
              <SheetSelectField
                label="Programme"
                value={targetProgramId}
                options={options}
                onChange={setTargetProgramId}
                placeholder="Choose a programme"
                hint="Only programmes not already connected are listed."
              />
              <SheetSelectField
                label="Partnership type"
                value={connectionType}
                options={typeOptions}
                onChange={(value) => setConnectionType(value as ProgramConnectionType)}
              />
              <Button
                label="Connect"
                icon={Link2}
                loading={saving}
                disabled={!targetProgramId || saving}
                onPress={() => void handleConnect()}
              />
            </>
          )}
        </View>

        {notice ? (
          <View style={[styles.banner, styles.successBanner]}>
            <Text variant="bodySmall" style={styles.successText}>
              {notice}
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={[styles.banner, styles.dangerBanner]}>
            <Text variant="bodySmall" style={styles.dangerText}>
              {error}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  section: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: {
    gap: 2,
    flexShrink: 1,
  },
  rowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  banner: {
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  successBanner: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
  },
  successText: {
    color: colors.success,
  },
  dangerBanner: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
  },
  dangerText: {
    color: colors.danger,
  },
  warningText: {
    color: colors.warning,
  },
});
