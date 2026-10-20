import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Banner } from './Banner';
import { Button } from './Button';
import { ChoiceGroup } from './ChoiceGroup';
import { SelectField, TextField, TimeField } from './Form';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { useApiResource } from '../hooks';
import { cloneSpecializedClinic, fetchCycleSchedule } from '../services/longitudinal';
import { spacing } from '../theme';
import { CCC_WBC_SLOT_COUNT, formatShiftRange, weekdayName, WEEKDAY_SHORT, weekdayIndex } from '../utils/cccMatrix';
import type { CloneSpecializedClinicResult, PrimaryCareCycleSchedule } from '../types/api';

/**
 * Create Specialized Clinic — the template-cloning form.
 *
 * A specialized clinic is not registered from nothing: it is *cloned* from the
 * Continuity Care Clinics (CCC) grid, so it arrives with the same structure the
 * programme already runs — the CCC week's days, their shift hours and PGY
 * levels, and its numbered clinic columns with the slots those columns write to.
 * This sheet is where that copy is configured, and it shows the coordinator the
 * template it is about to copy rather than asking them to remember it.
 *
 * The template preview is read live (`fetchCycleSchedule`) on every open, so what
 * is shown is what will be cloned — if the CCC grid has grown a sixth day, the
 * sheet says so. Nothing here invents a schedule: the preview renders the
 * template's own values, and the overrides below are optional and explicit.
 *
 * Seeding is deliberately mount-time only, so the host must re-key this component
 * for every open (`key={openSeq}`) — the same contract `ProgramEditorSheet`
 * documents.
 *
 * What the clone does **not** copy: residents, supervising faculty and the backup
 * pool. A clone that carried the CCC rota across would put the same person in two
 * clinics at once, so the new grid starts unstaffed and ready to populate.
 */

/** The clinic scope of a grid: only the standard CCC grid is clonable today. */
const TEMPLATE_OPTIONS = [
  { value: 'CCC' as const, label: 'Continuity Care Clinics (CCC) Standard Template' },
];

const PGY_OPTIONS = [
  { value: 'inherit' as const, label: 'Inherit CCC (per-day)' },
  { value: 'PGY-1' as const, label: 'All days PGY-1' },
  { value: 'PGY-2' as const, label: 'All days PGY-2' },
  { value: 'PGY-3' as const, label: 'All days PGY-3' },
  { value: 'PGY-4' as const, label: 'All days PGY-4' },
];

type PgyChoice = (typeof PGY_OPTIONS)[number]['value'];
type ScopeChoice = 'all' | 'one';

interface CreateSpecializedClinicSheetProps {
  visible: boolean;
  programId: number;
  onClose: () => void;
  /** Called with the new clinic and the grid that was copied for it. */
  onCreated: (result: CloneSpecializedClinicResult) => void;
}

export function CreateSpecializedClinicSheet({
  visible,
  programId,
  onClose,
  onCreated,
}: CreateSpecializedClinicSheetProps) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [template, setTemplate] = useState<'CCC'>('CCC');
  const [scope, setScope] = useState<ScopeChoice>('all');
  const [day, setDay] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [pgy, setPgy] = useState<PgyChoice>('inherit');

  const [fieldErrors, setFieldErrors] = useState<{ name?: string; hours?: string; day?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The grid that will be copied. Loaded only while the sheet is open, so a
   * closed sheet costs nothing.
   */
  const preview = useApiResource<PrimaryCareCycleSchedule | null>(
    () => (visible ? fetchCycleSchedule(programId) : Promise.resolve(null)),
    [programId, visible],
  );

  const templateDays = preview.data?.dailyHeaders ?? [];
  const dayOptions = templateDays.map((header) => ({
    value: header.day_of_week,
    label: weekdayName(header.day_of_week) ?? header.day_of_week,
  }));
  // The day a "one day a week" clone copies: the coordinator's pick, or the
  // template's first day. Derived rather than stored so the picker has a value
  // before anyone touches it.
  const effectiveDay = day || templateDays[0]?.day_of_week || '';

  const columnCount = preview.data?.columns?.length || CCC_WBC_SLOT_COUNT;
  const slotNumbers = new Set((preview.data?.slots ?? []).map((slot) => Number(slot.clinic_number)));
  const slotCount = slotNumbers.size > 0
    ? Math.max(CCC_WBC_SLOT_COUNT, ...slotNumbers)
    : CCC_WBC_SLOT_COUNT;
  const copiedDays = scope === 'one' && effectiveDay
    ? templateDays.filter((header) => header.day_of_week === effectiveDay)
    : templateDays;

  function close() {
    if (busy) return;
    onClose();
  }

  function validate() {
    const errors: { name?: string; hours?: string; day?: string } = {};
    if (name.trim() === '') errors.name = 'A clinic name is required.';
    // The two hours travel as one override, so half a range is not a value.
    if ((startTime && !endTime) || (!startTime && endTime)) {
      errors.hours = 'Enter both a start and an end time, or leave both blank to inherit the template.';
    }
    if (scope === 'one' && !effectiveDay) {
      errors.day = 'The CCC template has no day to copy yet.';
    }
    return errors;
  }

  async function create() {
    const errors = validate();
    setFieldErrors(errors);
    setSaveError(null);
    if (Object.keys(errors).length > 0) return;
    if (templateDays.length === 0) {
      setSaveError('The CCC template has no clinic days to copy yet. Open the Continuity Care Clinics matrix and add a day first.');
      return;
    }

    const payload = {
      program_id: programId,
      custom_name: name.trim(),
      source_template: template,
      ...(code.trim() ? { clinic_code: code.trim() } : {}),
      ...(scope === 'one' && effectiveDay ? { days: [effectiveDay] } : {}),
      ...(startTime && endTime ? { start_time: startTime, end_time: endTime } : {}),
      ...(pgy !== 'inherit' ? { pgy_level: pgy } : {}),
    };

    setBusy(true);
    try {
      const result = await cloneSpecializedClinic(payload);
      onCreated(result);
      onClose();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : 'The specialized clinic could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="New specialized clinic template"
      subtitle="Name a clinic and copy the Continuity Care Clinics grid into a matrix of its own."
      footer={
        <View style={styles.footer}>
          <Button
            label="Create specialized clinic"
            loading={busy}
            onPress={create}
            accessibilityHint="Creates the clinic and gives it its own copy of the CCC grid."
          />
          <Button label="Cancel" variant="ghost" disabled={busy} onPress={close} />
        </View>
      }
    >
      <View style={styles.form}>
        {saveError ? (
          <Banner tone="danger" title="Could not create the clinic" message={saveError} />
        ) : null}

        <TextField
          label="Clinic name"
          required
          value={name}
          onChangeText={setName}
          placeholder="Sports Medicine Clinic"
          error={fieldErrors.name}
          hint="The name coordinators and residents will see, e.g. Sports Medicine Clinic."
        />

        <TextField
          label="Clinic abbreviation / code"
          value={code}
          onChangeText={setCode}
          placeholder="SPORTS-CLINIC"
          autoCapitalize="characters"
          hint="Optional. Unique per programme; defaults to a code derived from the name."
        />

        <SelectField
          label="Template source"
          value={template}
          options={TEMPLATE_OPTIONS}
          onChange={(value) => setTemplate(value)}
          hint="The grid copied into the new clinic. The CCC standard template is the programme's own Continuity Care Clinics matrix."
        />

        <Text variant="label" tone="secondary" uppercase>
          Days & shift scope
        </Text>
        <Text variant="caption" tone="muted">
          Copied from the CCC template. A specialized clinic may meet on every CCC day or on one
          day a week; it can be adjusted afterwards like any other cycle.
        </Text>
        <ChoiceGroup
          label="Clinic days"
          columns={2}
          value={scope}
          onChange={(value) => setScope(value as ScopeChoice)}
          options={[
            { value: 'all', label: 'Every CCC day' },
            { value: 'one', label: 'One day a week' },
          ]}
        />
        {scope === 'one' ? (
          <SelectField
            label="Clinic day"
            value={effectiveDay || null}
            options={dayOptions}
            onChange={(value) => setDay(value)}
            error={fieldErrors.day}
            disabled={dayOptions.length === 0}
            hint="The weekday the new clinic runs."
          />
        ) : null}

        <View style={styles.hours}>
          <View style={styles.half}>
            <TimeField
              label="Shift start (optional)"
              value={startTime}
              onChangeText={setStartTime}
              placeholder="10:30"
            />
          </View>
          <View style={styles.half}>
            <TimeField
              label="Shift end (optional)"
              value={endTime}
              onChangeText={setEndTime}
              placeholder="14:00"
            />
          </View>
        </View>
        <Text variant="caption" tone="muted">
          Leave blank to inherit the template&apos;s per-day shift hours. Filling both overrides
          every copied day with one range.
        </Text>
        {fieldErrors.hours ? (
          <Text variant="caption" tone="danger">
            {fieldErrors.hours}
          </Text>
        ) : null}

        <SelectField
          label="Target PGY cohort"
          value={pgy}
          options={PGY_OPTIONS}
          onChange={(value) => setPgy(value)}
          hint="Inherited from the CCC template, or one level for every day of the new clinic."
        />

        <Text variant="label" tone="secondary" uppercase>
          What will be copied
        </Text>
        {preview.isLoading ? (
          <Text variant="caption" tone="muted">
            Reading the CCC template…
          </Text>
        ) : null}
        {preview.error ? (
          <Banner
            tone="warning"
            title="Could not read the CCC template"
            message={preview.error.message}
          />
        ) : null}
        {!preview.isLoading && !preview.error && templateDays.length === 0 ? (
          <Text variant="caption" tone="muted">
            The CCC template has no days yet, so there is nothing to copy. Add a day to the
            Continuity Care Clinics matrix first.
          </Text>
        ) : null}
        {copiedDays.map((header) => (
          <View key={header.id} style={styles.templateRow}>
            <Text variant="bodySmall" style={styles.dayCell}>
              {WEEKDAY_SHORT[weekdayIndex(header.day_of_week)] ?? header.day_of_week}
            </Text>
            <Text variant="bodySmall" tone="secondary" style={styles.shiftCell}>
              {formatShiftRange(header.shift_time) || 'Shift not set'}
            </Text>
            <Text variant="bodySmall" tone="secondary">
              {pgy === 'inherit' ? header.pgy_level || 'PGY not set' : pgy}
            </Text>
          </View>
        ))}
        {copiedDays.length > 0 ? (
          <Text variant="caption" tone="muted">
            {`Copying ${copiedDays.length} day${copiedDays.length === 1 ? '' : 's'}, ${columnCount} clinic column${columnCount === 1 ? '' : 's'} and ${slotCount} slot${slotCount === 1 ? '' : 's'} per day. Residents, supervising faculty and the backup pool are not copied — the new clinic starts unstaffed.`}
          </Text>
        ) : null}
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
  hours: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  half: {
    flex: 1,
  },
  templateRow: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
  },
  dayCell: {
    minWidth: 44,
  },
  shiftCell: {
    flex: 1,
  },
});
