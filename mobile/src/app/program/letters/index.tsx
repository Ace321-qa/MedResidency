import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FilePlus2, FileText, Trash2 } from 'lucide-react-native';

import { goBack } from '../../../navigation/back';
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
  SectionHeader,
  Sheet,
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import {
  createLetterTemplate,
  deleteLetterTemplate,
  fetchLetterTemplates,
  updateLetterTemplate,
} from '../../../services/lettersTemplates';
import { useInAppNotifications } from '../../../services/inAppNotifications';
import { colors, radius, spacing } from '../../../theme';
import type { LetterTemplate } from '../../../types/api';

/**
 * Release letters — the coordinator's template library.
 *
 * A release letter is written once and merged dozens of times, so the template
 * is the artefact that matters: this screen is where it is read, written and
 * retired. Everything a template can contain is a `{{PLACEHOLDER}}` the server
 * fills when a letter is generated, which is why the placeholder chips sit
 * between the body field and the keyboard — a coordinator who has to remember
 * `{{RELEASE_START_DATE}}` will spell it wrong, and a wrong token survives the
 * merge as literal text in a letter addressed to a department head.
 *
 * Insertion is at the caret, not at the end of the document: the whole point of
 * a chip row is to put the token where the sentence is being written.
 */

const PLACEHOLDER_TOKENS: { token: string; label: string }[] = [
  { token: 'RESIDENT_NAME', label: 'Resident name' },
  { token: 'PGY_LEVEL', label: 'PGY level' },
  { token: 'HOSPITAL_DEPT', label: 'Hospital dept' },
  { token: 'CLINIC_NAME', label: 'Clinic' },
  { token: 'SITE_NAME', label: 'Site' },
  { token: 'RELEASE_DAY', label: 'Release day' },
  { token: 'START_TIME', label: 'Start time' },
  { token: 'END_TIME', label: 'End time' },
  { token: 'DEPT_HEAD_NAME', label: 'Dept head' },
  { token: 'SUPERVISOR_NAME', label: 'Supervisor' },
  { token: 'PROGRAM_NAME', label: 'Programme' },
  { token: 'SPECIALTY_NAME', label: 'Specialty' },
  { token: 'INSTITUTION_NAME', label: 'Institution' },
  { token: 'RELEASE_START_DATE', label: 'Release start' },
  { token: 'RELEASE_END_DATE', label: 'Release end' },
];

interface FormState {
  code: string;
  name: string;
  subject: string;
  body: string;
  active: string;
}

interface FieldErrors {
  code?: string;
  name?: string;
  subject?: string;
  body?: string;
}

const EMPTY_FORM: FormState = { code: '', name: '', subject: '', body: '', active: '1' };

export default function LettersTemplatesScreen() {
  const { session } = useSession();
  const { notify } = useInAppNotifications();
  const programId = session?.programId ?? 0;

  const templates = useApiResource(fetchLetterTemplates, []);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /**
   * Caret position, kept in a ref: it is only read when a chip is tapped, and
   * tracking it in state would re-render the whole sheet on every arrow key.
   */
  const caretRef = useRef({ start: 0, end: 0 });
  /**
   * A caret position to apply *once*, after a token is inserted. Cleared on the
   * next selection event so the field returns to being uncontrolled and the
   * user's own caret movement is never fought.
   */
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(
    null,
  );

  const list = templates.data ?? [];

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setSaveError(null);
    caretRef.current = { start: 0, end: 0 };
    setPendingSelection(null);
    setSheetOpen(true);
  }

  function openEdit(template: LetterTemplate) {
    setEditingId(template.id);
    setForm({
      code: template.template_code,
      name: template.template_name,
      subject: template.letter_subject,
      body: template.letter_body,
      active: template.is_active === 1 ? '1' : '0',
    });
    setFieldErrors({});
    setSaveError(null);
    caretRef.current = { start: template.letter_body.length, end: template.letter_body.length };
    setPendingSelection(null);
    setSheetOpen(true);
  }

  function closeSheet() {
    if (busy) return;
    setSheetOpen(false);
    setConfirmingDelete(false);
  }

  /** Insert `{{TOKEN}}` at the caret — or append when nothing is selected. */
  function insertToken(token: string) {
    const insertion = `{{${token}}}`;
    const body = form.body;
    const start = Math.max(0, Math.min(caretRef.current.start, body.length));
    const end = Math.max(start, Math.min(caretRef.current.end, body.length));

    const next = `${body.slice(0, start)}${insertion}${body.slice(end)}`;
    const caret = start + insertion.length;

    setForm((current) => ({ ...current, body: next }));
    caretRef.current = { start: caret, end: caret };
    setPendingSelection({ start: caret, end: caret });
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (form.code.trim() === '') errors.code = 'A template code is required.';
    if (form.name.trim() === '') errors.name = 'A template name is required.';
    if (form.subject.trim() === '') errors.subject = 'A subject line is required.';
    if (form.body.trim() === '') errors.body = 'The letter body is required.';
    return errors;
  }

  async function save() {
    const errors = validate();
    setFieldErrors(errors);
    setSaveError(null);
    if (Object.keys(errors).length > 0) return;

    const payload = {
      template_code: form.code.trim(),
      template_name: form.name.trim(),
      letter_subject: form.subject.trim(),
      letter_body: form.body,
      is_active: form.active === '1' ? 1 : 0,
      program_id: programId,
    };

    setBusy(true);
    try {
      if (editingId === null) {
        await createLetterTemplate(payload);
        notify({ title: 'Template created', message: payload.template_name, tone: 'success' });
      } else {
        await updateLetterTemplate(editingId, payload);
        notify({ title: 'Template updated', message: payload.template_name, tone: 'success' });
      }
      setSheetOpen(false);
      templates.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The template could not be saved.';
      setSaveError(message);
      notify({ title: 'Save failed', message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (editingId === null) return;
    setBusy(true);
    setSaveError(null);

    try {
      await deleteLetterTemplate(editingId);
      notify({ title: 'Template deleted', message: form.name, tone: 'warning' });
      setSheetOpen(false);
      setConfirmingDelete(false);
      templates.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The template could not be deleted.';
      setSaveError(message);
      notify({ title: 'Delete failed', message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen onRefresh={templates.refresh} refreshing={templates.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader
        title="Release Letters"
        onBack={goBack}
        subtitle="Templates the programme merges into resident release letters"
        action={
          <Button
            label="New"
            variant="ghost"
            fullWidth={false}
            icon={FilePlus2}
            onPress={openCreate}
            accessibilityLabel="Create a release letter template"
          />
        }
      />

      {templates.isLoading ? <SkeletonList rows={4} /> : null}

      {templates.error ? (
        <ErrorState
          title="Could not load templates"
          message={templates.error.message}
          onRetry={templates.refresh}
        />
      ) : null}

      {templates.status === 'ready' ? (
        <>
          <SectionHeader title={`${list.length} template${list.length === 1 ? '' : 's'}`} />

          {list.length === 0 ? (
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
              {list.map((template, index) => (
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
                  last={index === list.length - 1}
                />
              ))}
            </Card>
          )}

          <Banner
            tone="info"
            title="How placeholders work"
            message="Tokens like {{RESIDENT_NAME}} are replaced by the server when a letter is generated. An unknown token is left in the letter as text, so stick to the chips above."
          />
        </>
      ) : null}

      <Sheet
        visible={sheetOpen}
        onClose={closeSheet}
        title={editingId === null ? 'New release letter template' : 'Edit template'}
        subtitle={
          editingId === null
            ? 'Written once, merged into every letter the programme sends.'
            : 'Changes apply to letters generated from now on; letters already sent keep their text.'
        }
        footer={
          <View style={styles.footer}>
            <Button label="Save template" loading={busy} onPress={save} />
            {editingId !== null ? (
              <Button
                label="Delete template"
                variant="danger"
                icon={Trash2}
                disabled={busy}
                onPress={() => setConfirmingDelete(true)}
              />
            ) : null}
          </View>
        }
      >
        <View style={styles.form}>
          {saveError ? <Banner tone="danger" title="Could not save" message={saveError} /> : null}

          <TextField
            label="Template code"
            required
            value={form.code}
            onChangeText={(value) => setForm((current) => ({ ...current, code: value }))}
            placeholder="STANDARD-RELEASE"
            autoCapitalize="characters"
            error={fieldErrors.code}
            hint="Short, stable identifier used when generating a letter."
          />

          <TextField
            label="Template name"
            required
            value={form.name}
            onChangeText={(value) => setForm((current) => ({ ...current, name: value }))}
            placeholder="Standard Department Release Request Letter"
            error={fieldErrors.name}
          />

          <TextField
            label="Subject"
            required
            value={form.subject}
            onChangeText={(value) => setForm((current) => ({ ...current, subject: value }))}
            placeholder="Official Release Request for Resident: {{RESIDENT_NAME}}"
            error={fieldErrors.subject}
          />

          <TextField
            label="Letter body"
            required
            multiline
            value={form.body}
            onChangeText={(value) => setForm((current) => ({ ...current, body: value }))}
            onSelectionChange={(event) => {
              caretRef.current = event.nativeEvent.selection;
              setPendingSelection(null);
            }}
            selection={pendingSelection ?? undefined}
            placeholder={'Dear {{DEPT_HEAD_NAME}},\n\n…'}
            error={fieldErrors.body}
            hint="Tap a placeholder to insert it at the cursor."
          />

          <View style={styles.chips}>
            <Text variant="label" tone="secondary" uppercase>
              Placeholders
            </Text>
            <View style={styles.chipWrap}>
              {PLACEHOLDER_TOKENS.map(({ token, label }) => (
                <Pressable
                  key={token}
                  onPress={() => insertToken(token)}
                  accessibilityRole="button"
                  accessibilityLabel={`Insert ${label} placeholder`}
                  style={styles.chip}
                >
                  <Text variant="caption" style={styles.chipText}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <ChoiceGroup
            label="Template status"
            columns={2}
            value={form.active}
            onChange={(value) => setForm((current) => ({ ...current, active: value }))}
            options={[
              { value: '1', label: 'Active' },
              { value: '0', label: 'Inactive' },
            ]}
          />
        </View>
      </Sheet>

      <Sheet
        visible={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete this template?"
        subtitle={form.name}
        footer={
          <View style={styles.footer}>
            <Button
              label="Delete permanently"
              variant="danger"
              loading={busy}
              onPress={() => void remove()}
            />
            <Button label="Keep it" variant="ghost" onPress={() => setConfirmingDelete(false)} />
          </View>
        }
      >
        <Text variant="bodySmall" tone="secondary">
          Letters already generated keep their stored text, but no new letter can use this template
          afterwards. If you only want to stop offering it, set the status to Inactive instead.
        </Text>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: spacing.md,
  },
  footer: {
    gap: spacing.sm,
  },
  chips: {
    gap: spacing.xs,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chipText: {
    color: colors.primary,
  },
});
