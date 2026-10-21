import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { AlertTriangle, FileText, Mail, Users } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import { Button } from './Button';
import { CheckboxField } from './CheckboxField';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { useApiResource } from '../hooks';
import { previewRotationNotices } from '../services/rotations';
import type { RotationNoticeDispatchResult, RotationNoticePlan } from '../types/api';
import {
  describeBlockNumbers,
  describeDepartmentRows,
  describeDispatchOutcome,
  describeSendReadiness,
  plannedLetterCount,
  uniqueResidentCount,
} from '../utils/noticeDispatch';

/**
 * NoticeDispatchSheet — the "Send Notice Letter" confirmation.
 *
 * Three things happen in this order, because a coordinator about to write to
 * departments outside their own programme needs all three before agreeing:
 * how many residents are affected, which receiving departments are involved,
 * and what the letter actually says.
 *
 * The counts come from the server's own planner (`previewRotationNotices`),
 * which is the same code the send runs. A summary computed on the client would
 * be a second opinion that could disagree with what is about to be sent.
 */

interface NoticeDispatchSheetProps {
  visible: boolean;
  onClose: () => void;
  programId: number;
  /** The block or window the dispatch covers. */
  scope: { blockId?: number; startDate?: string; endDate?: string; academicYear?: string };
  /** Shown in the subtitle so the coordinator knows which view they are sending from. */
  scopeLabel: string;
  onPreviewTemplate?: () => void;
  onManageContacts?: () => void;
  onConfirm: (options: { sendToCoordinators: boolean; notifyResidents: boolean }) => Promise<RotationNoticeDispatchResult>;
}

export function NoticeDispatchSheet({
  visible,
  onClose,
  programId,
  scope,
  scopeLabel,
  onPreviewTemplate,
  onManageContacts,
  onConfirm,
}: NoticeDispatchSheetProps) {
  const [sendToCoordinators, setSendToCoordinators] = useState(true);
  const [notifyResidents, setNotifyResidents] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RotationNoticeDispatchResult | null>(null);

  // The three option states are reset by *remounting* rather than in an effect:
  // the caller keys this sheet on the dispatch scope, so choosing another block
  // gives a fresh sheet with fresh defaults. Resetting in an effect would mean a
  // synchronous `setState` on every open — a cascading render — and would leave
  // a stale "sent" banner showing for the new scope in the frame before it ran.
  const plan = useApiResource<RotationNoticePlan>(
    () =>
      previewRotationNotices({
        program_id: programId,
        block_id: scope.blockId,
        start_date: scope.startDate,
        end_date: scope.endDate,
        academic_year: scope.academicYear,
      }),
    [programId, scope.blockId, scope.startDate, scope.endDate, scope.academicYear],
  );

  const readiness = useMemo(
    () => describeSendReadiness(plan.data, { sendToCoordinators, notifyResidents }),
    [plan.data, sendToCoordinators, notifyResidents],
  );

  const departmentRows = useMemo(() => describeDepartmentRows(plan.data?.departments), [plan.data]);
  const letters = plannedLetterCount(plan.data);
  const residents = uniqueResidentCount(plan.data);
  const noRecipient = departmentRows.filter((row) => row.warning);

  async function handleConfirm() {
    setError(null);
    setSending(true);
    try {
      const outcome = await onConfirm({ sendToCoordinators, notifyResidents });
      setResult(outcome);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'The notices could not be sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Send Notice Letter"
      subtitle={scopeLabel}
      footer={
        result ? (
          <Button label="Done" onPress={onClose} />
        ) : (
          <Button
            label={sending ? 'Sending…' : 'Confirm & send'}
            loading={sending}
            disabled={!readiness.ready}
            onPress={() => void handleConfirm()}
          />
        )
      }
    >
      <ScrollView contentContainerStyle={styles.body}>
        {result ? (
          <ResultSummary result={result} />
        ) : (
          <>
            <View style={styles.summaryCard}>
              <Text variant="label" uppercase tone="secondary">
                This dispatch covers
              </Text>
              <View style={styles.summaryRow}>
                <Stat icon={<FileText size={16} color={colors.primary} />} value={letters} label="letters" />
                <Stat icon={<Users size={16} color={colors.primary} />} value={residents} label="residents" />
                <Stat
                  icon={<Mail size={16} color={colors.primary} />}
                  value={departmentRows.length}
                  label="departments"
                />
              </View>
              <Text variant="caption" tone="muted">
                {plan.isLoading
                  ? 'Checking assignments…'
                  : `${describeBlockNumbers(plan.data?.block_ids)} in this view.`}
              </Text>
            </View>

            {plan.status === 'error' ? (
              <View style={[styles.banner, styles.warning]}>
                <Text variant="bodySmall" style={styles.warningText}>
                  The assignments could not be checked, so this dispatch cannot be summarised.
                </Text>
              </View>
            ) : null}

            {readiness.reason ? (
              <View style={[styles.banner, styles.warning]}>
                <View style={styles.warningHeader}>
                  <AlertTriangle size={16} color={colors.warning} />
                  <Text variant="label" uppercase style={styles.warningText}>
                    Not ready to send
                  </Text>
                </View>
                <Text variant="bodySmall" style={styles.warningText}>
                  {readiness.reason}
                </Text>
              </View>
            ) : null}

            {departmentRows.length > 0 ? (
              <View style={styles.section}>
                <Text variant="label" uppercase tone="secondary">
                  Receiving departments
                </Text>
                {departmentRows.map((row) => (
                  <View key={row.label} style={styles.departmentRow}>
                    <Text variant="body">{row.label}</Text>
                    <Text variant="caption" tone={row.warning ? 'danger' : 'muted'}>
                      {row.warning ? `${row.detail} · no coordinator address on file` : row.detail}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {noRecipient.length > 0 ? (
              <View style={[styles.banner, styles.warning]}>
                <Text variant="bodySmall" style={styles.warningText}>
                  💡 **Missing Coordinator Contact Emails** — {noRecipient.length} hospital department
                  {noRecipient.length === 1 ? '' : 's'} do not have a coordinator email on file. Letters will
                  still be generated and recorded in the Release Letters log, but email dispatches cannot be
                  delivered until contacts are added.
                </Text>
                {onPreviewTemplate ? (
                  <Button
                    label="[ ⚙️ Manage Department Contacts ]"
                    variant="outline"
                    onPress={onManageContacts ?? onPreviewTemplate}
                    accessibilityHint="Open the department contacts management area."
                  />
                ) : null}
              </View>
            ) : null}

            <View style={styles.section}>
              <Text variant="label" uppercase tone="secondary">
                What to send
              </Text>
              <CheckboxField
                label="Send official rotation acceptance letters to hospital department coordinators"
                checked={sendToCoordinators}
                onChange={setSendToCoordinators}
                hint="One letter per assignment, built from the notice template and logged in Release Letters."
              />
              <CheckboxField
                label="Send rotation assignment notifications to affected residents"
                checked={notifyResidents}
                onChange={setNotifyResidents}
                hint="An in-app notice naming the rotation, department and block."
              />
            </View>

            {onPreviewTemplate ? (
              <Button
                label="Preview letter template"
                variant="outline"
                icon={FileText}
                onPress={onPreviewTemplate}
                accessibilityHint="Open the notice template in Release Letters to edit its wording."
              />
            ) : null}

            {error ? (
              <View style={[styles.banner, styles.danger]}>
                <Text variant="bodySmall" tone="danger">
                  {error}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <View style={styles.stat}>
      {icon}
      <Text variant="metric">{value}</Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
}

function ResultSummary({ result }: { result: RotationNoticeDispatchResult }) {
  const skipped = result.skipped ?? [];
  return (
    <View style={styles.section}>
      <View style={[styles.banner, styles.success]}>
        <Text variant="label" uppercase style={styles.successText}>
          Notices dispatched
        </Text>
        <Text variant="bodySmall" style={styles.successText}>
          {describeDispatchOutcome(result)}
        </Text>
      </View>

      <View style={styles.departmentRow}>
        <Text variant="body">{result.letters_sent} letters stored</Text>
        <Text variant="caption" tone="muted">
          Template {result.template_code} · dispatch type {result.dispatch_type}
        </Text>
      </View>

      {result.letters_without_recipient > 0 ? (
        <View style={[styles.banner, styles.warning]}>
          <Text variant="bodySmall" style={styles.warningText}>
            {result.letters_without_recipient} of those letters had no coordinator address on file, so
            they were logged but not delivered.
          </Text>
        </View>
      ) : null}

      {skipped.length > 0 ? (
        <View style={styles.section}>
          <Text variant="label" uppercase tone="secondary">
            Left out of this run
          </Text>
          {skipped.map((skip) => (
            <View key={`${skip.rotation_assignment_id}`} style={styles.departmentRow}>
              <Text variant="bodySmall">{skip.resident_name}</Text>
              <Text variant="caption" tone="muted">
                {skip.reason}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  summaryCard: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  stat: {
    alignItems: 'center',
    gap: 2,
    flex: 1,
  },
  section: {
    gap: spacing.sm,
  },
  departmentRow: {
    gap: 2,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  banner: {
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  warning: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
  },
  warningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  warningText: {
    color: colors.warning,
  },
  danger: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
  },
  success: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
  },
  successText: {
    color: colors.success,
  },
});
