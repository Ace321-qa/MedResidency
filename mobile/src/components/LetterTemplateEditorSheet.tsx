import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';

import { Banner } from './Banner';
import { Button } from './Button';
import { ChoiceGroup } from './ChoiceGroup';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { TextField } from './Form';
import { colors, radius, spacing } from '../theme';
import {
  createLetterTemplate,
  deleteLetterTemplate,
  updateLetterTemplate,
} from '../services/lettersTemplates';
import { useInAppNotifications } from '../services/inAppNotifications';
import type { LetterTemplate } from '../types/api';

/**
 * The release-letter template editor, opened from the Letters tab.
 *
 * A release letter is written once and merged dozens of times, so the template
 * is the artefact that matters: this sheet is where it is read, written and
 * retired. Everything a template can contain is a `{{PLACEHOLDER}}` the server
 * fills when a letter is generated, which is why the placeholder chips sit
 * between the body field and the keyboard — a coordinator who has to remember
 * `{{SUPERVISING_FACULTY}}` will spell it wrong, and a wrong token survives the
 * merge as literal text in a letter addressed to a department head.
 *
 * Insertion is at the caret, not at the end of the document: the whole point of
 * a chip row is to put the token where the sentence is being written.
 *
 * The sheet owns no list. It reports success through `onSaved` so the screen that
 * hosts it can refetch, and closes itself through `onClose`; that keeps the
 * create/edit/delete flow reusable from anywhere a template can be opened.
 *
 * **The host must re-key this component for every open** (e.g. `key={openSeq}`),
 * so each session starts from a fresh form seeded off the handed-in `template`.
 * That is deliberate: seeding from props in an effect is disallowed by React's
 * lint rules, and re-keying is the sanctioned way to reset state when the target
 * changes.
 */

const PLACEHOLDER_TOKENS: string[] = [
  'TODAYS_DATE',
  'COORDINATOR_NAME',
  'DISPATCHING_COORDINATOR_TITLE',
  'PROGRAM_DIRECTOR_NAME',
  'SUPERVISING_FACULTY',
  'RESIDENT_NAME',
  'PGY_LEVEL',
  'CORPORATE_ID',
  'RESIDENT_EMAIL',
  'RESIDENT_MOBILE',
  'HOSPITAL_DEPT',
  'DEPT_HEAD_NAME',
  'CLINIC_NAME',
  'SITE_NAME',
  'RELEASE_DAY',
  'START_TIME',
  'END_TIME',
  'SUPERVISOR_NAME',
  'ROTATION_NAME',
  'HOME_PROGRAM_NAME',
  'HOME_PROGRAM_CODE',
  'HOME_INSTITUTION_NAME',
  'HOST_PROGRAM_NAME',
  'RECEIVING_PROGRAM_NAME',
  'HOST_PROGRAM_CODE',
  'HOST_INSTITUTION_NAME',
  'PROGRAM_NAME',
  'SPECIALTY_NAME',
  'INSTITUTION_NAME',
  'RELEASE_START_DATE',
  'RELEASE_END_DATE',
];

/**
 * The tooltip a chip shows once it has been tapped — the difference between
 * "this token fills in a date" and "this token fills in *today*, the day the
 * letter is dispatched, which is not the release start date". The two date
 * tokens read almost identically by name, so the ones that are easy to confuse
 * are spelled out here rather than left to the placeholder's own wording.
 */
const PLACEHOLDER_HINTS: Record<string, string> = {
  TODAYS_DATE: 'Inserts the actual date the letter is generated/sent.',
  COORDINATOR_NAME: "Inserts the dispatching coordinator's name.",
  DISPATCHING_COORDINATOR_TITLE:
    'Inserts the sending coordinator\'s full title, e.g. "Family Medicine Residency Program Coordinator".',
  PROGRAM_DIRECTOR_NAME: "Inserts the dispatching program director's name.",
  SUPERVISING_FACULTY: 'Inserts the supervisor assigned at the destination hospital.',
  HOME_PROGRAM_NAME: "Inserts the resident's sponsoring (home) programme — the sender.",
  HOME_PROGRAM_CODE: 'Inserts the code of the resident\'s home programme.',
  HOME_INSTITUTION_NAME: "Inserts the institution hosting the resident's home programme.",
  HOST_PROGRAM_NAME: 'Inserts the programme that receives the resident for this rotation.',
  RECEIVING_PROGRAM_NAME: 'Alias of HOST_PROGRAM_NAME — the receiving programme.',
  HOST_PROGRAM_CODE: 'Inserts the code of the receiving programme.',
  HOST_INSTITUTION_NAME: 'Inserts the institution hosting the receiving programme.',
  HOSPITAL_DEPT: 'Inserts the receiving department for this rotation.',
  PROGRAM_NAME: 'Legacy alias of HOME_PROGRAM_NAME (the sponsoring programme).',
  INSTITUTION_NAME: 'Legacy alias of HOME_INSTITUTION_NAME.',
};

const FACULTY_TOKEN = 'SUPERVISING_FACULTY';

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

export interface LetterTemplateEditorSheetProps {
  visible: boolean;
  programId: number;
  /** The template being edited, or `null` to author a new one. */
  template: LetterTemplate | null;
  onClose: () => void;
  /** Called after a successful create, update or delete so the host can refetch. */
  onSaved: () => void;
}

export function LetterTemplateEditorSheet({
  visible,
  programId,
  template,
  onClose,
  onSaved,
}: LetterTemplateEditorSheetProps) {
  const { notify } = useInAppNotifications();

  // The form is seeded once, from the template the host hands in, and the host
  // re-keys this component for every open (see the docstring). That keeps the
  // seed out of an effect — which React's lint rules rightly forbid — and means a
  // list refetch while the sheet is open cannot yank the text out from under the
  // coordinator.
  const [form, setForm] = useState<FormState>(() =>
    template
      ? {
          code: template.template_code,
          name: template.template_name,
          subject: template.letter_subject,
          body: template.letter_body,
          active: template.is_active === 1 ? '1' : '0',
        }
      : EMPTY_FORM,
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** The token whose tooltip is showing; set by tapping or long-pressing a chip. */
  const [hintToken, setHintToken] = useState<string | null>(null);

  /**
   * Caret position, kept in a ref: it is only read when a chip is tapped, and
   * tracking it in state would re-render the whole sheet on every arrow key.
   */
  const caretRef = useRef(
    template
      ? { start: template.letter_body.length, end: template.letter_body.length }
      : { start: 0, end: 0 },
  );
  /**
   * A caret position to apply *once*, after a token is inserted. Cleared on the
   * next selection event so the field returns to being uncontrolled and the
   * user's own caret movement is never fought.
   */
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(
    null,
  );

  const editing = template !== null;
  const includesFaculty = form.body.includes(`{{${FACULTY_TOKEN}}}`);

  function close() {
    if (busy) return;
    onClose();
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

  /**
   * The preceptor toggle is a convenience over the raw token: switching it on
   * appends a labelled line carrying `{{SUPERVISING_FACULTY}}`, switching it off
   * removes every line that references the token. A coordinator who prefers to
   * type the token by hand is not fought — the switch simply reflects whether
   * the body contains it.
   */
  function toggleFaculty(include: boolean) {
    setForm((current) => {
      const token = `{{${FACULTY_TOKEN}}}`;
      const present = current.body.includes(token);
      if (include && !present) {
        const trimmed = current.body.replace(/\s+$/, '');
        const separator = trimmed.length > 0 ? '\n\n' : '';
        return { ...current, body: `${trimmed}${separator}Supervising Faculty: ${token}` };
      }
      if (!include && present) {
        const cleaned = current.body
          .split('\n')
          .filter((line) => !line.includes(token))
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .replace(/\s+$/, '');
        return { ...current, body: cleaned };
      }
      return current;
    });
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
      if (template === null) {
        await createLetterTemplate(payload);
        notify({ title: 'Template created', message: payload.template_name, tone: 'success' });
      } else {
        await updateLetterTemplate(template.id, payload);
        notify({ title: 'Template updated', message: payload.template_name, tone: 'success' });
      }
      onSaved();
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The template could not be saved.';
      setSaveError(message);
      notify({ title: 'Save failed', message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (template === null) return;
    setBusy(true);
    setSaveError(null);

    try {
      await deleteLetterTemplate(template.id);
      notify({ title: 'Template deleted', message: template.template_name, tone: 'warning' });
      onSaved();
      setConfirmingDelete(false);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The template could not be deleted.';
      setSaveError(message);
      notify({ title: 'Delete failed', message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Sheet
        visible={visible}
        onClose={close}
        title={editing ? 'Edit template' : 'New release letter template'}
        subtitle={
          editing
            ? 'Changes apply to letters generated from now on; letters already sent keep their text.'
            : 'Written once, merged into every letter the programme sends.'
        }
        footer={
          <View style={styles.footer}>
            <Button label="Save template" loading={busy} onPress={save} />
            {editing ? (
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
            label="Subject line"
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
              {PLACEHOLDER_TOKENS.map((token) => (
                <Pressable
                  key={token}
                  onPress={() => {
                    insertToken(token);
                    setHintToken(token);
                  }}
                  onLongPress={() => setHintToken(token)}
                  accessibilityRole="button"
                  accessibilityLabel={`Insert {{${token}}} placeholder`}
                  accessibilityHint={PLACEHOLDER_HINTS[token]}
                  style={styles.chip}
                >
                  <Text variant="caption" style={styles.chipText}>
                    {`+ {{${token}}}`}
                  </Text>
                </Pressable>
              ))}
            </View>
            {hintToken && PLACEHOLDER_HINTS[hintToken] ? (
              <Text variant="caption" tone="muted" accessibilityRole="text">
                {`{{${hintToken}}}: ${PLACEHOLDER_HINTS[hintToken]}`}
              </Text>
            ) : (
              <Text variant="caption" tone="muted">
                Tap a placeholder to insert it at the cursor; long-press to read what it fills in.
              </Text>
            )}
          </View>

          <ChoiceGroup
            label="Supervising faculty (preceptor)"
            columns={2}
            value={includesFaculty ? '1' : '0'}
            onChange={(value) => toggleFaculty(value === '1')}
            options={[
              { value: '1', label: 'Include' },
              { value: '0', label: 'Exclude' },
            ]}
          />
          <Text variant="caption" tone="muted">
            Include appends a Supervising Faculty line carrying {'{{SUPERVISING_FACULTY}}'}. It fills
            from the preceptor entered when a letter is generated.
          </Text>

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
    </>
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
