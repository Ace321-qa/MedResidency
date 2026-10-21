import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FileText, Inbox, Send } from 'lucide-react-native';

import {
  AppHeader,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LetterPreviewSheet,
  LetterTemplateEditorSheet,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
  StatusBadge,
  Text,
} from '../../../../components';
import { useApiResource, useSession } from '../../../../hooks';
import { fetchDispatchedLetters } from '../../../../services/letters';
import { fetchLetterTemplates } from '../../../../services/lettersTemplates';
import { colors, radius, spacing } from '../../../../theme';
import { formatDate } from '../../../../utils/format';
import {
  hasUnresolvedFields,
  letterDestinationName,
  letterStatusTone,
} from '../../../../utils/letterStatus';
import type { LetterTemplate, ReleaseLetter } from '../../../../types/api';

/**
 * Release Letters — a three-tab hub, not a card on the programme's home screen.
 *
 * Three jobs a coordinator does with letters live side by side:
 *
 * - **Inbox (Received)** — notices *other* programmes dispatched that concern
 *   this one: a partner's rotation acceptance notice for a resident rotating
 *   into our departments, or a letter about one of our own residents issued
 *   elsewhere. Each row says which programme it came from, so a Family Medicine
 *   notice for a visiting PGY-5 reads as exactly that.
 * - **Sent Items** — every letter merged from this programme's own templates,
 *   the dispatch log, plus the generator's entry point.
 * - **Letter Templates** — the mail-merge templates both boxes' letters are
 *   authored from.
 *
 * The boxes are disjoint by construction (the server excludes our own
 * dispatches from our inbox), so nothing can appear twice. Tapping a letter in
 * either box opens it exactly as the recipient received it.
 */

type LettersTab = 'inbox' | 'sent' | 'templates';

export default function ReleaseLettersScreen() {
  const router = useRouter();
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const [activeTab, setActiveTab] = useState<LettersTab>('inbox');

  const templates = useApiResource(() => fetchLetterTemplates(programId), [programId]);
  // Two boxes over the same endpoint: `sent` is what this programme dispatched,
  // `received` is what arrived from partner programmes.
  const sentLetters = useApiResource(
    () => fetchDispatchedLetters(programId || undefined, 'sent'),
    [programId],
  );
  const inboxLetters = useApiResource(
    () => fetchDispatchedLetters(programId || undefined, 'received'),
    [programId],
  );

  const templateList = templates.data ?? [];
  const sentList = useMemo(() => sentLetters.data ?? [], [sentLetters.data]);
  const inboxList = useMemo(() => inboxLetters.data ?? [], [inboxLetters.data]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<LetterTemplate | null>(null);
  // Bumped on every open so the editor remounts with a fresh, correctly seeded
  // form; see LetterTemplateEditorSheet for why it is keyed rather than reset.
  const [editorSession, setEditorSession] = useState(0);
  const [previewLetter, setPreviewLetter] = useState<ReleaseLetter | null>(null);

  const tabs = useMemo(
    () => [
      { value: 'inbox' as const, label: 'Inbox', count: inboxList.length, countLabel: 'received' },
      { value: 'sent' as const, label: 'Sent', count: sentList.length, countLabel: 'sent' },
      {
        value: 'templates' as const,
        label: 'Templates',
        count: templateList.length,
        countLabel: 'on record',
      },
    ],
    [inboxList.length, sentList.length, templateList.length],
  );

  function openCreate() {
    setEditingTemplate(null);
    setEditorSession((session) => session + 1);
    setEditorOpen(true);
  }

  function openEdit(template: LetterTemplate) {
    setEditingTemplate(template);
    setEditorSession((session) => session + 1);
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
  }

  function goGenerate() {
    router.push('/program/letters/generate');
  }

  function refreshAll() {
    templates.refresh();
    sentLetters.refresh();
    inboxLetters.refresh();
  }

  /**
   * The shared letter row, used by both boxes. An inbox row leads with the
   * dispatching programme — the question a receiving coordinator opens the tab
   * with is "who sent this" — while a sent row keeps the "To …" recipient line.
   */
  function renderLetterRow(letter: ReleaseLetter, box: 'inbox' | 'sent', last: boolean) {
    const from = letter.dispatching_program_name ?? 'Partner programme';
    const subtitle =
      box === 'inbox'
        ? `From ${from}${letter.hospital_department_name ? ` · ${letter.hospital_department_name}` : ''}`
        : `To ${letter.recipient_dept_head}${
            letter.hospital_department_name ? ` · ${letter.hospital_department_name}` : ''
          }`;
    return (
      <ListRow
        key={letter.letter_id}
        title={letter.resident_name}
        subtitle={subtitle}
        meta={[
          letterDestinationName(letter),
          formatDate(letter.created_at),
          letter.year_in_program ? `PGY-${letter.year_in_program}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        trailing={
          <View style={styles.trailing}>
            {hasUnresolvedFields(letter) ? (
              <StatusBadge label="Incomplete" tone="warning" />
            ) : null}
            <StatusBadge label={letter.sent_status} tone={letterStatusTone(letter.sent_status)} />
          </View>
        }
        onPress={() => setPreviewLetter(letter)}
        accessibilityHint="Shows the full letter"
        last={last}
      />
    );
  }

  return (
    <Screen
      onRefresh={refreshAll}
      refreshing={templates.isRefreshing || sentLetters.isRefreshing || inboxLetters.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader
        title="Release Letters & Rotation Acceptances"
        subtitle="Read notices from partner programmes, dispatch release letters to hospital department heads, and author the templates behind both."
      />

      <View accessibilityRole="radiogroup" accessibilityLabel="Letters section" style={styles.toggle}>
        {tabs.map((tab) => {
          const active = activeTab === tab.value;
          return (
            <Pressable
              key={tab.value}
              onPress={() => setActiveTab(tab.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${tab.label}, ${tab.count} ${tab.countLabel}`}
              style={({ pressed }) => [
                styles.toggleOption,
                active ? styles.toggleOptionActive : null,
                pressed && !active ? styles.toggleOptionPressed : null,
              ]}
            >
              <Text variant="button" align="center" tone={active ? 'brand' : 'secondary'}>
                {tab.label}
              </Text>
              <Text variant="caption" align="center" tone="muted">
                {`${tab.count} ${tab.countLabel}`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* --- Inbox (Received) — partner programmes' notices about us -------- */}
      {activeTab === 'inbox' ? (
        <>
          <SectionHeader title="Notices from other programmes" trailing={`${inboxList.length} received`} />

          {inboxLetters.isLoading ? <SkeletonList rows={3} /> : null}

          {inboxLetters.error ? (
            <ErrorState
              title="Could not load the inbox"
              message={inboxLetters.error.message}
              onRetry={inboxLetters.refresh}
            />
          ) : null}

          {inboxLetters.status === 'ready' ? (
            inboxList.length === 0 ? (
              <Card>
                <EmptyState
                  icon={Inbox}
                  title="Inbox is empty"
                  message="Rotation acceptance notices dispatched by partner programmes — for residents rotating into your departments, or about your residents placed elsewhere — arrive here."
              />
            </Card>
            ) : (
              <Card padded={false}>
                {inboxList.map((letter, index) => renderLetterRow(letter, 'inbox', index === inboxList.length - 1))}
              </Card>
            )
          ) : null}

          <Text variant="caption" tone="muted">
            A notice appears here when another programme dispatches it for a rotation or resident
            connected to this programme.
          </Text>
        </>
      ) : null}

      {/* --- Sent Items — our dispatch log + the generator's entry point --- */}
      {activeTab === 'sent' ? (
        <>
          <View style={styles.cta}>
            <Button
              label="Generate & send official release letter"
              icon={Send}
              onPress={goGenerate}
              accessibilityHint="Opens the generator and dispatch window"
            />
          </View>

          <SectionHeader title="Dispatched letters log" trailing={`${sentList.length} sent`} />

          {sentLetters.isLoading ? <SkeletonList rows={5} /> : null}

          {sentLetters.error ? (
            <ErrorState
              title="Could not load dispatched letters"
              message={sentLetters.error.message}
              onRetry={sentLetters.refresh}
            />
          ) : null}

          {sentLetters.status === 'ready' ? (
            sentList.length === 0 ? (
              <Card>
                <EmptyState
                  icon={Send}
                  title="No letters dispatched yet"
                  message="Generate a release letter and it will appear here, addressed to the receiving department head."
                  actionLabel="Generate a letter"
                  onActionPress={goGenerate}
                />
              </Card>
            ) : (
              <Card padded={false}>
                {sentList.map((letter, index) => renderLetterRow(letter, 'sent', index === sentList.length - 1))}
              </Card>
            )
          ) : null}

          <Text variant="caption" tone="muted">
            Same letters the resident sees on their profile — one record, two views.
          </Text>
        </>
      ) : null}

      {/* --- Letter Templates — the mail-merge source both boxes draw from -- */}
      {activeTab === 'templates' ? (
        <>
          <SectionHeader
            title="Letter templates"
            trailing={`${templateList.length} on record`}
            actionLabel="+ Create template"
            onActionPress={openCreate}
          />

          {templates.isLoading ? <SkeletonList rows={3} /> : null}

          {templates.error ? (
            <ErrorState
              title="Could not load templates"
              message={templates.error.message}
              onRetry={templates.refresh}
            />
          ) : null}

          {templates.status === 'ready' ? (
            templateList.length === 0 ? (
              <Card>
                <EmptyState
                  icon={FileText}
                  title="No templates yet"
                  message="Create the first template and every release letter the programme generates will use it."
                  actionLabel="Create a template"
                  onActionPress={openCreate}
                />
              </Card>
            ) : (
              <Card padded={false}>
                {templateList.map((template, index) => (
                  <ListRow
                    key={template.id}
                    title={template.template_name}
                    subtitle={template.letter_subject}
                    meta={`Code ${template.template_code} · ${template.letter_body.length} characters`}
                    trailing={
                      <StatusBadge
                        label={template.is_active === 1 ? 'Active' : 'Inactive'}
                        tone={template.is_active === 1 ? 'success' : 'neutral'}
                      />
                    }
                    onPress={() => openEdit(template)}
                    accessibilityHint="Opens the template for editing"
                    last={index === templateList.length - 1}
                  />
                ))}
              </Card>
            )
          ) : null}
        </>
      ) : null}

      <LetterTemplateEditorSheet
        key={editorSession}
        visible={editorOpen}
        programId={programId}
        template={editingTemplate}
        onClose={closeEditor}
        onSaved={templates.refresh}
      />

      <LetterPreviewSheet letter={previewLetter} onClose={() => setPreviewLetter(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  toggle: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xxs,
    padding: spacing.xxs,
    marginBottom: spacing.md,
  },
  toggleOption: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  toggleOptionActive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  toggleOptionPressed: {
    backgroundColor: colors.surface,
  },
  cta: {
    marginBottom: spacing.sm,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
