import { useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { FileText, Inbox, Mail, Send, TriangleAlert } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListRow,
  Screen,
  SectionHeader,
  SegmentedControl,
  SelectField,
  Sheet,
  SheetSelectField,
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
  type SelectOption,
} from '../../../../components';
import { useApiResource, useSession } from '../../../../hooks';
import { fetchReleaseLetters } from '../../../../services/letters';
import { ApiError } from '../../../../services/client';
import {
  createResidentMessage,
  deleteResidentMessage,
  fetchResidentMessages,
  updateResidentMessage,
} from '../../../../services/messages';
import { fetchPrograms } from '../../../../services/programs';
import { fetchResidentSchedule } from '../../../../services/rotations';
import { spacing } from '../../../../theme';
import { formatDate } from '../../../../utils/format';
import type {
  ReleaseLetter,
  ResidentMessage,
  ResidentMessageCategory,
} from '../../../../types/api';

/**
 * Letters & Messages — the resident's mailbox, one tab away from "Today".
 *
 * Three boxes, because a resident writes to the programme office in three
 * different states:
 *
 *  - **Inbox** — what has arrived: the programme office's replies, and the
 *    release letters issued about this resident's rotations.
 *  - **Drafts** — issues half-written. A resident thinking about a rotation
 *    overlap on a night shift does not finish the sentence; the draft is where
 *    the thought survives until the next shift.
 *  - **Sent Items** — what has been raised. These are the programme's record of
 *    the issue, so they cannot be deleted from the resident's side.
 *
 * The compose sheet is the point of the screen. A resident with a problem on a
 * ward has to be able to write it down and send it in one pass, so the form
 * asks for four things and nothing else: who it is for, what it is about,
 * what kind of issue it is, and what actually happened.
 *
 * The recipient list is not typed by hand — it is built from the resident's own
 * home programme and the hospital departments they are placed on, because a
 * message addressed to "the programme office" but belonging to a ward is a
 * message a coordinator cannot route.
 */

type LettersTab = 'inbox' | 'drafts' | 'sent';

/** The categories the programme office sorts raised issues by. */
const CATEGORY_OPTIONS: SelectOption<ResidentMessageCategory>[] = [
  { value: 'ROTATION_ISSUE', label: 'Rotation Issue' },
  { value: 'SCHEDULE_CONFLICT', label: 'Schedule Conflict' },
  { value: 'DUTY_HOURS_INQUIRY', label: 'Duty Hours Inquiry' },
  { value: 'GENERAL', label: 'General Request' },
];

const CATEGORY_LABELS: Record<ResidentMessageCategory, string> = {
  ROTATION_ISSUE: 'Rotation Issue',
  SCHEDULE_CONFLICT: 'Schedule Conflict',
  DUTY_HOURS_INQUIRY: 'Duty Hours Inquiry',
  GENERAL: 'General Request',
};

interface ComposeState {
  /** The home programme or receiving department the issue is raised against. */
  recipient: string;
  subject: string;
  category: ResidentMessageCategory;
  body: string;
}

const EMPTY_COMPOSE: ComposeState = {
  recipient: '',
  subject: '',
  category: 'ROTATION_ISSUE',
  body: '',
};

export default function ResidentLettersScreen() {
  const { session } = useSession();
  const residentId = session?.residentId ?? 0;
  const programId = session?.programId ?? 0;

  const [tab, setTab] = useState<LettersTab>('inbox');
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(EMPTY_COMPOSE);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openMessage, setOpenMessage] = useState<ResidentMessage | null>(null);

  // The three boxes, the letters issued about this resident, and the two lists
  // the recipient picker is built from.
  const messages = useApiResource(() => fetchResidentMessages(residentId), [residentId]);
  const letters = useApiResource(() => fetchReleaseLetters(residentId), [residentId]);
  const programs = useApiResource(() => fetchPrograms(), []);
  const schedule = useApiResource(() => fetchResidentSchedule(residentId), [residentId]);

  const inbox = messages.data?.inbox ?? [];
  const drafts = messages.data?.drafts ?? [];
  const sent = messages.data?.sent ?? [];
  const releaseLetters = letters.data ?? [];

  /**
   * Who a resident can write to.
   *
   * The home programme comes first because most issues are about the
   * programme itself; the hospital departments follow, one per rotation the
   * resident is currently placed on. A resident who has never been placed has
   * no department to write to, which is correct — there is no ward to complain
   * about yet.
   */
  const recipientOptions = useMemo<SelectOption<string>[]>(() => {
    const options: SelectOption<string>[] = [];

    const homeProgram = programs.data?.find((program) => program.id === programId);
    if (homeProgram) {
      options.push({
        value: homeProgram.program_name,
        label: `${homeProgram.program_name} (home programme)`,
      });
    }

    const departments = new Set<string>();
    for (const assignment of schedule.data ?? []) {
      if (assignment.department_name) departments.add(assignment.department_name);
    }
    for (const department of Array.from(departments).sort()) {
      options.push({ value: department, label: department });
    }

    return options;
  }, [programs.data, schedule.data, programId]);

  /**
   * The name of the resident's own programme.
   *
   * It is the fallback recipient: a message with no department chosen still
   * belongs to the programme, and the programme office's queue reads far better
   * when every row names an addressee than when half of them are blank.
   */
  const homeProgramName = useMemo(
    () => programs.data?.find((program) => program.id === programId)?.program_name ?? '',
    [programs.data, programId],
  );

  function refreshAll() {
    messages.refresh();
    letters.refresh();
  }

  function openCompose() {
    setCompose(EMPTY_COMPOSE);
    setSaveError(null);
    setComposeOpen(true);
  }

  function closeCompose() {
    setComposeOpen(false);
    setSaveError(null);
  }

  /**
   * Save the draft or send it.
   *
   * The two are the same write with a different folder, so they share one
   * handler — which is why a resident who starts a draft, closes the app and
   * comes back can send exactly the text they wrote.
   */
  async function handleSubmit(folder: 'DRAFT' | 'SENT') {
    const subject = compose.subject.trim();
    const body = compose.body.trim();

    if (!subject) {
      setSaveError('A subject is required.');
      return;
    }
    if (!body) {
      setSaveError('A message body is required.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await createResidentMessage({
        resident_id: residentId,
        program_id: programId,
        recipient_department: compose.recipient || homeProgramName || null,
        subject,
        body,
        category: compose.category,
        folder,
      });

      setComposeOpen(false);
      setCompose(EMPTY_COMPOSE);
      messages.refresh();

      Alert.alert(
        folder === 'SENT' ? 'Sent to the programme office' : 'Saved as a draft',
        folder === 'SENT'
          ? 'The programme office has been notified.'
          : 'You can finish and send it from the Drafts tab.',
      );
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setSaveError(apiError?.detail ?? 'Your message could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  /** Send a draft that was written earlier. */
  async function handleSendDraft(message: ResidentMessage) {
    try {
      await updateResidentMessage(message.id, {
        resident_id: residentId,
        folder: 'SENT',
      });
      setOpenMessage(null);
      messages.refresh();
      Alert.alert('Sent to the programme office', 'The programme office has been notified.');
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      Alert.alert('Could not send the draft', apiError?.detail ?? 'Please try again.');
    }
  }

  /** Throw away a draft. Sent messages are the programme's record and stay. */
  async function handleDeleteDraft(message: ResidentMessage) {
    try {
      await deleteResidentMessage(message.id, residentId);
      setOpenMessage(null);
      messages.refresh();
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      Alert.alert('Could not delete the draft', apiError?.detail ?? 'Please try again.');
    }
  }

  /**
   * Open a message.
   *
   * An inbox message is marked read as it is opened, so the unread badge on
   * the row disappears the moment the resident has actually read it.
   */
  function handleOpenMessage(message: ResidentMessage) {
    setOpenMessage(message);
    if (message.folder === 'INBOX' && !message.is_read) {
      void updateResidentMessage(message.id, { resident_id: residentId, is_read: true })
        .then(() => messages.refresh())
        .catch(() => {
          // A read receipt that fails is not worth interrupting the resident
          // over: the message is open in front of them either way.
        });
    }
  }

  /** One row in the mailbox. */
  function renderMessageRow(message: ResidentMessage, last: boolean) {
    const isDraft = message.folder === 'DRAFT';
    return (
      <ListRow
        key={message.id}
        title={message.subject}
        subtitle={
          message.folder === 'INBOX'
            ? `From the programme office${message.recipient_department ? ` · ${message.recipient_department}` : ''}`
            : `To ${message.recipient_department ?? 'Programme office'}`
        }
        meta={[
          CATEGORY_LABELS[message.category] ?? message.category,
          formatDate(message.updated_at ?? message.created_at),
        ]
          .filter(Boolean)
          .join(' · ')}
        trailing={
          <View style={styles.trailing}>
            {message.folder === 'INBOX' && !message.is_read ? (
              <StatusBadge label="Unread" tone="info" />
            ) : null}
            <StatusBadge
              label={isDraft ? 'Draft' : 'Sent'}
              tone={isDraft ? 'warning' : 'neutral'}
            />
          </View>
        }
        onPress={() => handleOpenMessage(message)}
        accessibilityHint="Opens the message"
        last={last}
      />
    );
  }

  /** One release letter issued about this resident's rotations. */
  function renderLetterRow(letter: ReleaseLetter, last: boolean) {
    return (
      <ListRow
        key={letter.letter_id}
        title={letter.letter_subject || letter.template_name}
        subtitle={`From ${letter.program_name ?? 'Programme office'} · ${letter.hospital_department_name ?? letter.rotation_name ?? 'Rotation'}`}
        meta={[formatDate(letter.created_at), letter.sent_status].filter(Boolean).join(' · ')}
        trailing={<StatusBadge label={letter.sent_status} tone="neutral" />}
        last={last}
      />
    );
  }

  const currentList = tab === 'inbox' ? inbox : tab === 'drafts' ? drafts : sent;

  return (
    <Screen
      onRefresh={refreshAll}
      refreshing={messages.isRefreshing || letters.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader
        title="Letters & Messages"
        subtitle="Raise an issue with the programme office, keep your drafts, and read the letters issued about your rotations."
      />

      <View style={styles.cta}>
        <Button
          label="+ Raise Issue / Contact Programme"
          icon={Send}
          onPress={openCompose}
          accessibilityHint="Opens the form for writing a message to the programme office"
        />
      </View>

      <SegmentedControl
        label="Mailbox"
        value={tab}
        onChange={(value) => setTab(value as LettersTab)}
        options={[
          { value: 'inbox', label: 'Inbox' },
          { value: 'drafts', label: 'Drafts' },
          { value: 'sent', label: 'Sent Items' },
        ]}
        hint={
          tab === 'inbox'
            ? `${inbox.length} message${inbox.length === 1 ? '' : 's'} · ${releaseLetters.length} letter${releaseLetters.length === 1 ? '' : 's'}`
            : tab === 'drafts'
              ? `${drafts.length} draft${drafts.length === 1 ? '' : 's'}`
              : `${sent.length} sent`
        }
      />

      {messages.error ? (
        <ErrorState
          title="Could not load your messages"
          message={messages.error.message}
          onRetry={messages.refresh}
        />
      ) : null}

      {messages.isLoading ? <SkeletonList rows={3} /> : null}

      {messages.status === 'ready' ? (
        <>
          {tab === 'inbox' ? (
            <>
              <SectionHeader
                title="From the programme office"
                trailing={`${inbox.length} received`}
              />
              {inbox.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={Inbox}
                    title="No messages from the programme office"
                    message="Replies to the issues you raise arrive here, alongside the release letters issued about your rotations."
                  />
                </Card>
              ) : (
                <Card padded={false}>
                  {inbox.map((message, index) =>
                    renderMessageRow(message, index === inbox.length - 1),
                  )}
                </Card>
              )}

              <SectionHeader
                title="Release letters"
                trailing={`${releaseLetters.length} on record`}
              />
              {letters.isLoading ? <SkeletonList rows={2} /> : null}
              {letters.error ? (
                <ErrorState
                  title="Could not load release letters"
                  message={letters.error.message}
                  onRetry={letters.refresh}
                />
              ) : null}
              {letters.status === 'ready' ? (
                releaseLetters.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon={FileText}
                      title="No release letters yet"
                      message="A release letter is generated when your programme confirms a rotation with a hospital department."
                    />
                  </Card>
                ) : (
                  <Card padded={false}>
                    {releaseLetters.map((letter, index) =>
                      renderLetterRow(letter, index === releaseLetters.length - 1),
                    )}
                  </Card>
                )
              ) : null}
            </>
          ) : null}

          {tab === 'drafts' ? (
            <>
              <SectionHeader title="Unsent drafts" trailing={`${drafts.length} saved`} />
              {drafts.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={Mail}
                    title="No drafts yet"
                    message="Write an issue and choose Save as Draft to keep it here until you are ready to send it."
                    actionLabel="Compose a message"
                    onActionPress={openCompose}
                  />
                </Card>
              ) : (
                <Card padded={false}>
                  {drafts.map((message, index) =>
                    renderMessageRow(message, index === drafts.length - 1),
                  )}
                </Card>
              )}
            </>
          ) : null}

          {tab === 'sent' ? (
            <>
              <SectionHeader title="Issues you have raised" trailing={`${sent.length} sent`} />
              {sent.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={Send}
                    title="Nothing sent yet"
                    message="A message sent to the programme office is kept here as the record of what you raised."
                    actionLabel="Raise an issue"
                    onActionPress={openCompose}
                  />
                </Card>
              ) : (
                <Card padded={false}>
                  {sent.map((message, index) =>
                    renderMessageRow(message, index === sent.length - 1),
                  )}
                </Card>
              )}
            </>
          ) : null}
        </>
      ) : null}

      {currentList.length > 0 && tab !== 'inbox' ? (
        <Text variant="caption" tone="muted">
          {tab === 'drafts'
            ? 'A draft is only visible to you until you send it to the programme office.'
            : 'The programme office reads these as the issues raised against it.'}
        </Text>
      ) : null}

      {/* --- Compose: raise an issue / contact the programme office ---------- */}
      <Sheet
        visible={composeOpen}
        onClose={closeCompose}
        title="Raise Issue / Contact Programme"
        subtitle="The programme office is notified when you send. A draft is only visible to you."
        footer={
          <View style={styles.footerRow}>
            <Button
              label="Save as Draft"
              variant="outline"
              onPress={() => void handleSubmit('DRAFT')}
              disabled={saving}
              style={styles.footerButton}
              accessibilityHint="Keeps the message for later without notifying the programme office"
            />
            <Button
              label="Send to Programme Office"
              onPress={() => void handleSubmit('SENT')}
              loading={saving}
              style={styles.footerButton}
              accessibilityHint="Delivers the message and notifies the programme office"
            />
          </View>
        }
      >
        {saveError ? (
          <Banner
            tone="danger"
            title="Could not save the message"
            message={saveError}
            icon={TriangleAlert}
            style={styles.banner}
          />
        ) : null}

        <SheetSelectField
          label="Recipient Programme / Department"
          value={compose.recipient || null}
          options={recipientOptions}
          onChange={(value) => setCompose((current) => ({ ...current, recipient: value }))}
          placeholder="Choose a programme or department"
          hint="Your home programme and the hospital departments you are placed on."
        />

        <TextField
          label="Subject Line"
          required
          value={compose.subject}
          onChangeText={(value) => setCompose((current) => ({ ...current, subject: value }))}
          placeholder="e.g. Rotation Overlap Issue — Block 6"
          hint="One line a coordinator can triage on."
        />

        <SelectField<ResidentMessageCategory>
          label="Category"
          value={compose.category}
          options={CATEGORY_OPTIONS}
          onChange={(value) => setCompose((current) => ({ ...current, category: value }))}
        />

        <TextField
          label="Message Body"
          required
          multiline
          value={compose.body}
          onChangeText={(value) => setCompose((current) => ({ ...current, body: value }))}
          placeholder="Describe the issue arising from your clinical rotations…"
          hint="What happened, on which rotation, and what you need the programme office to do."
        />
      </Sheet>

      {/* --- Reading a message ---------------------------------------------- */}
      <Sheet
        visible={openMessage !== null}
        onClose={() => setOpenMessage(null)}
        title={openMessage?.subject ?? ''}
        subtitle={
          openMessage
            ? `${CATEGORY_LABELS[openMessage.category] ?? openMessage.category} · ${formatDate(openMessage.updated_at ?? openMessage.created_at)}`
            : undefined
        }
        footer={
          openMessage?.folder === 'DRAFT' ? (
            <View style={styles.footerRow}>
              <Button
                label="Delete Draft"
                variant="outline"
                onPress={() => void handleDeleteDraft(openMessage)}
                style={styles.footerButton}
                accessibilityHint="Removes this unsent draft"
              />
              <Button
                label="Send to Programme Office"
                onPress={() => void handleSendDraft(openMessage)}
                style={styles.footerButton}
                accessibilityHint="Delivers this draft and notifies the programme office"
              />
            </View>
          ) : (
            <Button
              label="Close"
              variant="outline"
              onPress={() => setOpenMessage(null)}
              accessibilityHint="Closes the message"
            />
          )
        }
      >
        {openMessage ? (
          <View style={styles.detail}>
            <Text variant="label" tone="secondary" uppercase>
              {openMessage.folder === 'INBOX' ? 'From the programme office' : 'To'}
            </Text>
            <Text variant="body">
              {openMessage.folder === 'INBOX'
                ? openMessage.recipient_department ?? 'Programme office'
                : openMessage.recipient_department ?? 'Programme office'}
            </Text>

            <Text variant="body" style={styles.detailBody}>
              {openMessage.body}
            </Text>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cta: {
    marginBottom: spacing.lg,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  banner: {
    marginBottom: spacing.lg,
  },
  footerRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  footerButton: {
    flex: 1,
  },
  detail: {
    gap: spacing.xs,
  },
  detailBody: {
    marginTop: spacing.md,
    lineHeight: 22,
  },
});
