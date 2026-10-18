import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Banner } from './Banner';
import { Button } from './Button';
import { ChoiceGroup } from './ChoiceGroup';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { TextField } from './Form';
import { spacing } from '../theme';
import { createProgram, updateProgram } from '../services/programs';
import { useInAppNotifications } from '../services/inAppNotifications';
import type { Program } from '../types/api';

/**
 * Create or rename a residency programme.
 *
 * Opened from the coordinator area of the sign-in screen: "+ Add programme"
 * passes `program = null`, and the pencil on a card passes the row to edit. The
 * form is seeded once from `program`, so the host must re-key this component for
 * every open (`key={openSeq}`) — the same contract `LetterTemplateEditorSheet`
 * documents, and the reason the seed stays out of a render-phase effect.
 *
 * Renaming is safe by construction: programmes are referenced by id everywhere
 * in the schema, so changing a name or code never orphans a roster, a rotation or
 * a letter. The enrolled count on the card is derived from the roster, not stored
 * here, so this screen cannot make it stale.
 */

interface FormState {
  code: string;
  name: string;
  active: string;
}

interface FieldErrors {
  code?: string;
  name?: string;
}

export interface ProgramEditorSheetProps {
  visible: boolean;
  /** The programme being edited, or `null` to create a new one. */
  program: Program | null;
  onClose: () => void;
  /** Called after a successful create or update so the host can refetch. */
  onSaved: (program: Program, created: boolean) => void;
}

export function ProgramEditorSheet({ visible, program, onClose, onSaved }: ProgramEditorSheetProps) {
  const { notify } = useInAppNotifications();
  const editing = program !== null;

  const [form, setForm] = useState<FormState>(() => ({
    code: program?.program_code ?? '',
    name: program?.program_name ?? '',
    active: program && program.is_active === 0 ? '0' : '1',
  }));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    if (busy) return;
    onClose();
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (form.name.trim() === '') errors.name = 'A programme name is required.';
    if (form.code.trim() === '') errors.code = 'A programme code is required.';
    return errors;
  }

  async function save() {
    const errors = validate();
    setFieldErrors(errors);
    setSaveError(null);
    if (Object.keys(errors).length > 0) return;

    const payload = {
      program_name: form.name.trim(),
      program_code: form.code.trim().toUpperCase(),
      is_active: form.active === '1' ? 1 : 0,
    };

    setBusy(true);
    try {
      const saved = editing
        ? await updateProgram(program.id, payload)
        : await createProgram(payload);
      notify({
        title: editing ? 'Programme updated' : 'Programme created',
        message: saved.program_name,
        tone: 'success',
      });
      onSaved(saved, !editing);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The programme could not be saved.';
      setSaveError(message);
      notify({ title: 'Could not save', message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={editing ? 'Edit programme' : 'Add a residency programme'}
      subtitle={
        editing
          ? 'Rename it, correct its code, or take it off the sign-in picker.'
          : 'Register a programme so it appears on the sign-in picker, even before anyone is enrolled.'
      }
      footer={
        <View style={styles.footer}>
          <Button
            label={editing ? 'Save changes' : 'Create programme'}
            loading={busy}
            onPress={save}
          />
          <Button label="Cancel" variant="ghost" disabled={busy} onPress={close} />
        </View>
      }
    >
      <View style={styles.form}>
        {saveError ? <Banner tone="danger" title="Could not save" message={saveError} /> : null}

        <TextField
          label="Programme name"
          required
          value={form.name}
          onChangeText={(value) => setForm((current) => ({ ...current, name: value }))}
          placeholder="Family Medicine"
          error={fieldErrors.name}
          hint="Shown on the sign-in picker and in the coordinator area."
        />

        <TextField
          label="Programme code"
          required
          value={form.code}
          onChangeText={(value) => setForm((current) => ({ ...current, code: value }))}
          placeholder="FM-DEMO-002"
          autoCapitalize="characters"
          error={fieldErrors.code}
          hint="Unique across the platform. Stored upper-case."
        />

        <ChoiceGroup
          label="Availability"
          columns={2}
          value={form.active}
          onChange={(value) => setForm((current) => ({ ...current, active: value }))}
          options={[
            { value: '1', label: 'Active' },
            { value: '0', label: 'Hidden' },
          ]}
        />
        <Text variant="caption" tone="muted">
          Hidden programmes keep their roster and history but are not offered when signing in as a
          coordinator.
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: spacing.md,
  },
  footer: {
    gap: spacing.sm,
  },
});
