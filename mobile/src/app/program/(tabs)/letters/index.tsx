import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FileText, Send } from 'lucide-react-native';

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
import { spacing } from '../../../../theme';
import { formatDate } from '../../../../utils/format';
import {
  hasUnresolvedFields,
  letterDestinationName,
  letterStatusTone,
} from '../../../../utils/letterStatus';
import type { LetterTemplate } from '../../../../types/api';

/**
 * Release Letters — a primary tab, not a card on the programme's home screen.
 *
 * The two jobs a coordinator does with letters live side by side: author the
 * mail-merge templates once, and read back the letters the programme has already
 * sent to hospital department heads. Templates sit above the log because the log
 * is the result of them, and because a coordinator who lands here usually wants
 * to check *what* a letter says (the template) before asking *who* got it (the
 * log).
 *
 * Editing a template opens a sheet rather than a new screen: a template is a
 * single document with a form, and pushing a screen for it would lose the letter
 * list underneath. Tapping a dispatched letter opens the finished letter exactly
 * as the resident or department head received it.
 */

export default function ReleaseLettersScreen() {
  const router = useRouter();
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const templates = useApiResource(() => fetchLetterTemplates(programId), [programId]);
  const letters = useApiResource(
    () => fetchDispatchedLetters(programId || undefined),
    [programId],
  );

  const templateList = templates.data ?? [];
  const letterList = useMemo(() => letters.data ?? [], [letters.data]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<LetterTemplate | null>(null);
  // Bumped on every open so the editor remounts with a fresh, correctly seeded
  // form; see LetterTemplateEditorSheet for why it is keyed rather than reset.
  const [editorSession, setEditorSession] = useState(0);
  const [previewLetterId, setPreviewLetterId] = useState<number | null>(null);

  const previewLetter = useMemo(
    () => letterList.find((letter) => letter.letter_id === previewLetterId) ?? null,
    [letterList, previewLetterId],
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

  return (
    <Screen
      onRefresh={() => {
        templates.refresh();
        letters.refresh();
      }}
      refreshing={templates.isRefreshing || letters.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader
        title="Release Letters & Rotation Acceptances"
        subtitle="Manage standardized templates, dispatch release letters to hospital department heads, and track sent letters."
      />

      <View style={styles.cta}>
        <Button
          label="Generate & send official release letter"
          icon={Send}
          onPress={goGenerate}
          accessibilityHint="Opens the generator and dispatch window"
        />
      </View>

      {/* Section 1 — the mail-merge templates letters are authored from. */}
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

      {/* Section 2 — every letter the programme has sent to the hospital. */}
      <SectionHeader
        title="Dispatched letters log"
        trailing={`${letterList.length} on record`}
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
        letterList.length === 0 ? (
          <Card>
            <EmptyState
              icon={FileText}
              title="No letters dispatched yet"
              message="Generate a release letter and it will appear here, addressed to the receiving department head."
              actionLabel="Generate a letter"
              onActionPress={goGenerate}
            />
          </Card>
        ) : (
          <Card padded={false}>
            {letterList.map((letter, index) => (
              <ListRow
                key={letter.letter_id}
                title={letter.resident_name}
                subtitle={`To ${letter.recipient_dept_head}${
                  letter.hospital_department_name ? ` · ${letter.hospital_department_name}` : ''
                }`}
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
                    <StatusBadge
                      label={letter.sent_status}
                      tone={letterStatusTone(letter.sent_status)}
                    />
                  </View>
                }
                onPress={() => setPreviewLetterId(letter.letter_id)}
                accessibilityHint="Shows the full letter"
                last={index === letterList.length - 1}
              />
            ))}
          </Card>
        )
      ) : null}

      <Text variant="caption" tone="muted">
        Same letters the resident sees on their profile — one record, two views.
      </Text>

      <LetterTemplateEditorSheet
        key={editorSession}
        visible={editorOpen}
        programId={programId}
        template={editingTemplate}
        onClose={closeEditor}
        onSaved={templates.refresh}
      />

      <LetterPreviewSheet letter={previewLetter} onClose={() => setPreviewLetterId(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  cta: {
    marginBottom: spacing.sm,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
