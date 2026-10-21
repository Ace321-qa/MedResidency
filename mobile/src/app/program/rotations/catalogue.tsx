import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  CheckboxField,
  EmptyState,
  ErrorState,
  IconButton,
  ImportTools,
  ProgramPicker,
  Screen,
  SearchInput,
  SectionHeader,
  Sheet,
  SkeletonList,
  Text,
  TextField,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { goBack } from '../../../navigation/back';
import {
  createCatalogueRotation,
  deleteCatalogueRotation,
  fetchRotationCatalogue,
  updateCatalogueRotation,
} from '../../../services/rotationCatalogue';
import { fetchPrograms } from '../../../services/programs';
import { uploadCatalogue } from '../../../services/excelTemplates';
import { useInAppNotifications } from '../../../services/inAppNotifications';
import { colors, radius, spacing } from '../../../theme';
import { rotationPalette } from '../../../utils/rotationBadges';
import type { RotationCatalogueEntry } from '../../../types/api';

/**
 * Rotations Catalogue — where a programme defines the rotations it can assign.
 *
 * The catalogue is the vocabulary every other screen speaks: the master grid
 * resolves a cell against these abbreviations, the assignment form offers these
 * names, and a resident's schedule is a history of them. So this is the one
 * place they are created, renamed and retired — with the API's own guard rails
 * surfaced rather than hidden:
 *
 *  - a duplicate abbreviation is caught here (the field's error) *and* by the
 *    server (409), because "PHC" twice is two rotations nobody can tell apart;
 *  - a deletion that residents depend on comes back as the server's sentence —
 *    "2 resident assignments rely on it" — instead of a generic failure, since
 *    that sentence is the only thing that tells the coordinator what to do next.
 *
 * The bulk path is the same workbook on every screen: download the template,
 * fill three columns, upload, and read which row was rejected. Rows in the
 * table are the four columns of that workbook made tappable — the abbreviation
 * as a colour-coded badge (the same palette the master grid uses, so a colour
 * learned there means the same thing here), the name, the department, and the
 * two actions.
 */

interface FormState {
  fullName: string;
  /** Display label derived from the linked programme; refined by hand if needed. */
  department: string;
  /**
   * The registered programme account this rotation is hosted by.
   *
   * `null` means "not linked", which the form rejects — a rotation that is not
   * bound to an account is the free-text state this picker exists to remove.
   */
  targetProgramId: number | null;
  abbreviation: string;
  /** Kept as text: an empty field means "no limit", which is not the number 0. */
  maxCapacity: string;
  capacityLocked: boolean;
  coordinatorEmail: string;
}

interface FieldErrors {
  fullName?: string;
  department?: string;
  targetProgramId?: string;
  abbreviation?: string;
  maxCapacity?: string;
  coordinatorEmail?: string;
}

const EMPTY_FORM: FormState = {
  fullName: '',
  department: '',
  targetProgramId: null,
  abbreviation: '',
  maxCapacity: '',
  capacityLocked: false,
  coordinatorEmail: '',
};

/**
 * The department label a programme account implies.
 *
 * The account is named after its *specialty* — "Internal Medicine Residency
 * Program" — while the department it hosts is named after the place: "Internal
 * Medicine". The trailing words name the account type rather than any ward, so
 * they are stripped for the label while the account id stays on the record as
 * the real link.
 *
 * A name with no recognised suffix passes through untouched: a programme
 * registered as just "Pediatrics" should not have its only word deleted, and a
 * heuristic that always trims something would do exactly that.
 */
function departmentLabelFromProgram(programName: string): string {
  const trimmed = programName.trim();
  const stripped = trimmed.replace(/\s+(Residency|Fellowship)?\s*Program$/i, '').trim();
  return stripped || trimmed;
}

const MAX_NAME_LENGTH = 255;
const MAX_ABBREVIATION_LENGTH = 50;
/** Matches the API's own ceiling, so the form never accepts what the server won't. */
const MAX_CAPACITY = 999;

/**
 * Render a rotation's seat limit as a compact tag.
 *
 * `null`/`0` is "no limit" rather than "zero seats", and the two must read
 * differently: one means a rotation anyone may join, the other would mean nobody
 * can, and showing them the same way would be actively misleading.
 */
function formatCapacity(entry: RotationCatalogueEntry): string {
  if (entry.max_capacity === null || entry.max_capacity <= 0) return 'No seat limit';
  return `Max Capacity: ${entry.max_capacity} seat${entry.max_capacity === 1 ? '' : 's'}`;
}

export default function RotationsCatalogueScreen() {
  const { session } = useSession();
  const { notify } = useInAppNotifications();
  const programId = session?.programId ?? 0;

  const catalogue = useApiResource(() => fetchRotationCatalogue(programId), [programId]);

  /** The picker's option list: every registered, still-active programme account. */
  const programs = useApiResource(() => fetchPrograms({ activeOnly: true }), []);
  const programOptions = useMemo(() => programs.data ?? [], [programs.data]);

  const [query, setQuery] = useState('');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<RotationCatalogueEntry | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** A stable reference, so the filters below are not rebuilt every render. */
  const entries = useMemo(() => catalogue.data ?? [], [catalogue.data]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle
        ? entries.filter((entry) =>
            `${entry.full_name} ${entry.department} ${entry.abbreviation}`.toLowerCase().includes(needle),
          )
        : entries,
    [entries, needle],
  );

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setSaveError(null);
    setSheetOpen(true);
  }

  function openEdit(entry: RotationCatalogueEntry) {
    setEditingId(entry.id);
    setForm({
      fullName: entry.full_name,
      // The stored label is kept verbatim rather than re-derived: a rotation
      // linked to Internal Medicine may still legitimately read "Internal
      // Medicine Inpatient Wards", and re-deriving on open would silently
      // rewrite it the moment the coordinator tapped Save for an unrelated
      // reason. The label only follows the picker when the pick itself changes.
      department: entry.department,
      targetProgramId: entry.target_program_id ?? null,
      abbreviation: entry.abbreviation,
      maxCapacity: entry.max_capacity === null ? '' : String(entry.max_capacity),
      capacityLocked: entry.capacity_locked === 1,
      coordinatorEmail: entry.coordinator_email ?? '',
    });
    setFieldErrors({});
    setSaveError(null);
    setSheetOpen(true);
  }

  /**
   * Pick (or clear) the programme that hosts this rotation.
   *
   * Choosing an account refills the department label from its name, because
   * the label's job is to read as a place and the account's job is to be an
   * identity — picking should leave both consistent without a second edit.
   * Clearing restores the empty label so a stale place name cannot survive
   * without an account behind it.
   */
  function pickProgram(targetProgramId: number | null) {
    setForm((current) => {
      if (targetProgramId === null) return { ...current, targetProgramId: null, department: '' };
      const chosen = programOptions.find((option) => option.id === targetProgramId);
      if (!chosen) return { ...current, targetProgramId };
      return {
        ...current,
        targetProgramId,
        department: departmentLabelFromProgram(chosen.program_name),
      };
    });
    setFieldErrors((current) => {
      if (!current.targetProgramId && !current.department) return current;
      const next = { ...current };
      delete next.targetProgramId;
      delete next.department;
      return next;
    });
  }

  function closeSheet() {
    if (busy) return;
    setSheetOpen(false);
    setConfirmingDelete(false);
    setDeleteError(null);
  }

  function askDelete(entry: RotationCatalogueEntry) {
    setPendingDelete(entry);
    setDeleteError(null);
    setConfirmingDelete(true);
  }

  /**
   * The same rules the API applies, checked before the request leaves.
   *
   * Re-implementing them here is deliberate: a form that only learns about a
   * blank abbreviation after a round trip makes the coordinator wait to be told
   * what they forgot to type, and the duplicate check names the rotation that
   * already owns the code — something the 409 from the server cannot do.
   */
  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const fullName = form.fullName.trim();
    const department = form.department.trim();
    const abbreviation = form.abbreviation.trim().toUpperCase();

    if (!fullName) errors.fullName = 'A full rotation name is required.';
    else if (fullName.length > MAX_NAME_LENGTH) {
      errors.fullName = `Keep the name to ${MAX_NAME_LENGTH} characters or fewer.`;
    }

    if (!department) errors.department = 'A hospital department is required.';
    else if (department.length > MAX_NAME_LENGTH) {
      errors.department = `Keep the department to ${MAX_NAME_LENGTH} characters or fewer.`;
    }

    // The link is the point of the field, so an unlinked rotation is refused
    // here rather than saved as another unattributable department string. The
    // label check above still runs independently: a pick always fills it, but
    // a cleared picker must not let an empty label through on its own.
    if (form.targetProgramId === null) {
      errors.targetProgramId = 'Select the programme that hosts this rotation.';
    }

    if (!abbreviation) errors.abbreviation = 'An abbreviation is required.';
    else if (abbreviation.length > MAX_ABBREVIATION_LENGTH) {
      errors.abbreviation = `Keep the abbreviation to ${MAX_ABBREVIATION_LENGTH} characters or fewer.`;
    } else {
      const clash = entries.find(
        (entry) => entry.abbreviation.toUpperCase() === abbreviation && entry.id !== editingId,
      );
      if (clash) errors.abbreviation = `Already used by “${clash.full_name}”.`;
    }

    // A blank seat limit is a valid answer — it means "no limit" — so only a
    // filled-in cell that holds something unusable is an error. A bare `0` is
    // accepted and read as no limit, exactly as the API reads it.
    const capacityText = form.maxCapacity.trim();
    if (capacityText !== '') {
      const parsed = Number(capacityText);
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors.maxCapacity = 'Enter a whole number of seats, or leave blank for no limit.';
      } else if (parsed > MAX_CAPACITY) {
        errors.maxCapacity = `Enter ${MAX_CAPACITY} or fewer.`;
      }
    }

    const email = form.coordinatorEmail.trim();
    if (email !== '') {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(email) || email.length > 255) {
        errors.coordinatorEmail = 'Coordinator Email must be a valid email address';
      }
    }

    return errors;
  }

  async function save() {
    const errors = validate();
    setFieldErrors(errors);
    setSaveError(null);
    if (Object.keys(errors).length > 0) return;

    const payload = {
      program_id: programId,
      full_name: form.fullName.trim(),
      department: form.department.trim(),
      // The identity behind the label: which registered account hosts this
      // rotation. Nothing downstream may read the label as a link — the notice
      // router and the visiting roster both resolve the programme from this id.
      target_program_id: form.targetProgramId,
      abbreviation: form.abbreviation.trim().toUpperCase(),
      max_capacity: form.maxCapacity.trim() === '' ? null : Number(form.maxCapacity.trim()),
      capacity_locked: form.capacityLocked,
      coordinator_email: form.coordinatorEmail.trim() === '' ? null : form.coordinatorEmail.trim(),
    };

    setBusy(true);
    try {
      if (editingId === null) {
        await createCatalogueRotation(payload);
        notify({ title: 'Rotation added', message: `${payload.full_name} · ${payload.abbreviation}`, tone: 'success' });
      } else {
        await updateCatalogueRotation(editingId, payload);
        notify({ title: 'Rotation updated', message: `${payload.full_name} · ${payload.abbreviation}`, tone: 'success' });
      }
      setSheetOpen(false);
      catalogue.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The rotation could not be saved.';
      setSaveError(message);
      notify({ title: 'Save failed', message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!pendingDelete) return;
    setBusy(true);
    setDeleteError(null);

    try {
      await deleteCatalogueRotation(pendingDelete.id);
      notify({ title: 'Rotation deleted', message: pendingDelete.full_name, tone: 'warning' });
      setConfirmingDelete(false);
      setPendingDelete(null);
      setSheetOpen(false);
      catalogue.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The rotation could not be deleted.';
      setDeleteError(message);
      notify({ title: 'Delete failed', message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      onRefresh={catalogue.refresh}
      refreshing={catalogue.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader
        title="Rotations Catalogue"
        subtitle="Manage hospital and clinic rotation definitions"
        onBack={goBack}
      />

      <View style={styles.search}>
        <SearchInput
          accessibilityLabel="Search the rotation catalogue"
          value={query}
          onChangeText={setQuery}
          placeholder="Name, department or abbreviation"
        />
      </View>

      <Button
        label="Add Rotation"
        icon={Plus}
        onPress={openCreate}
        accessibilityLabel="Add a rotation to the catalogue"
        accessibilityHint="Opens the form for a new rotation definition"
      />

      <ImportTools
        template="catalogue"
        uploadLabel="Upload Excel (.xlsx)"
        upload={(file) => uploadCatalogue(file, programId)}
        onImported={() => catalogue.refresh()}
        hint="Four columns: full rotation name, hospital department, abbreviation, and an optional Max Capacity / Seat Limit. Existing abbreviations are updated, not duplicated."
        style={styles.importTools}
      />

      {catalogue.isLoading ? <SkeletonList rows={5} /> : null}

      {catalogue.error ? (
        <ErrorState
          title="Could not load the catalogue"
          message={catalogue.error.message}
          onRetry={catalogue.refresh}
        />
      ) : null}

      {catalogue.status === 'ready' ? (
        <>
          <SectionHeader
            title={`${visible.length} rotation${visible.length === 1 ? '' : 's'}`}
          />

          {entries.length === 0 ? (
            <Card>
              <EmptyState
                icon={ClipboardList}
                title="No rotations yet"
                message="Define the hospital and clinic rotations this programme can assign, or upload the catalogue template with the rows you already have."
                actionLabel="Add the first rotation"
                onActionPress={openCreate}
              />
            </Card>
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={ClipboardList}
                title="No match"
                message={`No rotation in this catalogue matches “${query.trim()}”.`}
              />
            </Card>
          ) : (
            <Card padded={false}>
              <View style={[styles.row, styles.headerRow]}>
                <Text variant="label" uppercase tone="muted" style={styles.colBadge}>
                  Abbreviation
                </Text>
                <View style={styles.colName}>
                  <Text variant="label" uppercase tone="muted">
                    Full rotation name
                  </Text>
                  <Text variant="label" uppercase tone="muted">
                    Hospital department
                  </Text>
                </View>
                <Text variant="label" uppercase tone="muted" style={styles.colActions}>
                  Actions
                </Text>
              </View>

              {visible.map((entry, index) => {
                const palette = rotationPalette(entry.abbreviation, entry.id);
                const last = index === visible.length - 1;
                return (
                  <View key={entry.id} style={[styles.row, last ? styles.rowLast : null]}>
                    <View style={styles.colBadge}>
                      <View
                        style={[
                          styles.badge,
                          { backgroundColor: palette.surface, borderColor: palette.border },
                        ]}
                      >
                        <Text
                          variant="label"
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          minimumFontScale={0.75}
                          style={{ color: palette.foreground }}
                          accessibilityLabel={`Abbreviation ${entry.abbreviation}`}
                        >
                          {entry.abbreviation}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.colName}>
                      <Text variant="h3" numberOfLines={2}>
                        {entry.full_name}
                      </Text>
                      <Text variant="bodySmall" tone="secondary" numberOfLines={2}>
                        {entry.department}
                      </Text>
                      <View style={styles.capacityRow}>
                        <View
                          style={[
                            styles.capacityBadge,
                            entry.max_capacity && entry.max_capacity > 0
                              ? styles.capacityBadgeLimited
                              : styles.capacityBadgeUnlimited,
                          ]}
                        >
                          <Text variant="caption" tone="secondary">
                            {formatCapacity(entry)}
                          </Text>
                        </View>
                        {entry.capacity_locked === 1 ? (
                          <View style={[styles.capacityBadge, styles.capacityBadgeLocked]}>
                            <Text variant="caption" style={{ color: colors.danger }}>
                              Locked
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    </View>

                    <View style={styles.colActions}>
                      <IconButton
                        icon={Pencil}
                        tone="primary"
                        accessibilityLabel={`Edit ${entry.full_name}`}
                        onPress={() => openEdit(entry)}
                      />
                      <IconButton
                        icon={Trash2}
                        tone="danger"
                        accessibilityLabel={`Delete ${entry.full_name}`}
                        onPress={() => askDelete(entry)}
                      />
                    </View>
                  </View>
                );
              })}
            </Card>
          )}
        </>
      ) : null}

      {/* Add and edit share one sheet: the fields are identical, and a second
          form would only be a place for the two to drift apart. */}
      <Sheet
        visible={sheetOpen}
        onClose={closeSheet}
        title={editingId === null ? 'Add rotation' : 'Edit rotation'}
        subtitle={
          editingId === null
            ? 'A rotation the programme can assign to residents.'
            : 'Renaming updates every screen that shows this rotation.'
        }
        footer={
          <View style={styles.footer}>
            <Button label={editingId === null ? 'Save rotation' : 'Save changes'} loading={busy} onPress={save} />
            {editingId !== null ? (
              <Button
                label="Delete rotation"
                variant="danger"
                icon={Trash2}
                disabled={busy}
                onPress={() => {
                  const entry = entries.find((candidate) => candidate.id === editingId);
                  if (entry) askDelete(entry);
                }}
              />
            ) : null}
          </View>
        }
      >
        <View style={styles.form}>
          {saveError ? <Banner tone="danger" title="Could not save" message={saveError} /> : null}

          <TextField
            label="Full Rotation Name"
            required
            value={form.fullName}
            onChangeText={(value) => setForm((current) => ({ ...current, fullName: value }))}
            placeholder="General Surgery Inpatient"
            autoCapitalize="words"
            error={fieldErrors.fullName}
          />

          {/*
            The department is no longer typed — it is chosen. A free-text box
            let three spellings of one ward exist with no identity behind any
            of them, which is why a notice could not be routed to the department
            it concerned. The picker binds the rotation to a registered account
            (`target_program_id`) and derives the stored label from that
            account's name, so the display text and the link cannot drift apart.
          */}
          <ProgramPicker
            label="Hosted by Department / Programme"
            required
            value={form.targetProgramId}
            options={programOptions}
            onChange={pickProgram}
            loading={programs.isLoading}
            error={fieldErrors.targetProgramId ?? fieldErrors.department}
            accessibilityLabel="Select the registered programme that hosts this rotation"
            hint={
              form.targetProgramId !== null
                ? `Department label stored as “${form.department.trim()}”`
                : 'Choosing an account fills the department label it is stored under.'
            }
          />

          <TextField
            label="Abbreviation"
            required
            value={form.abbreviation}
            onChangeText={(value) => setForm((current) => ({ ...current, abbreviation: value }))}
            placeholder="SURG-INP"
            autoCapitalize="characters"
            error={fieldErrors.abbreviation}
            hint="The short code shown on the rota. One per programme."
          />

          <TextField
            label="Max Capacity / Seat Limit (Optional)"
            value={form.maxCapacity}
            onChangeText={(value) => setForm((current) => ({ ...current, maxCapacity: value }))}
            placeholder="Leave blank for no limit"
            keyboardType="number-pad"
            error={fieldErrors.maxCapacity}
            hint="Maximum approved concurrent residents physically present per week."
          />

          <TextField
            label="COORDINATOR CONTACT EMAIL"
            value={form.coordinatorEmail}
            onChangeText={(value) => {
              setForm((current) => ({ ...current, coordinatorEmail: value }));
              if (fieldErrors.coordinatorEmail) setFieldErrors((e) => ({ ...e, coordinatorEmail: undefined }));
            }}
            placeholder="e.g. coordinator.im@hospital.org"
            keyboardType="email-address"
            autoCapitalize="none"
            error={fieldErrors.coordinatorEmail}
            hint="Receiving department coordinator email address for rotation notice letters."
          />

          {/* Locking the limit is only meaningful once there is a limit to lock,
              so the toggle appears with the number rather than beside a blank
              field where it would read as a switch that does nothing. */}
          {form.maxCapacity.trim() !== '' && Number(form.maxCapacity) > 0 ? (
            <CheckboxField
              label="Lock this limit"
              checked={form.capacityLocked}
              onChange={(next) => setForm((current) => ({ ...current, capacityLocked: next }))}
              hint="A locked limit is a hard stop: no rationale can override it."
            />
          ) : null}
        </View>
      </Sheet>

      <Sheet
        visible={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete this rotation?"
        subtitle={pendingDelete ? `${pendingDelete.full_name} · ${pendingDelete.abbreviation}` : undefined}
        footer={
          <View style={styles.footer}>
            <Button
              label="Delete permanently"
              variant="danger"
              loading={busy}
              onPress={() => void remove()}
            />
            <Button
              label="Keep it"
              variant="ghost"
              disabled={busy}
              onPress={() => setConfirmingDelete(false)}
            />
          </View>
        }
      >
        {deleteError ? (
          <Banner tone="danger" title="Cannot delete this rotation" message={deleteError} />
        ) : null}

        <Text variant="bodySmall" tone="secondary">
          Residents who have already been scheduled onto this rotation keep their history, but the
          rotation is removed from the catalogue and can no longer be assigned. A rotation with
          resident assignments cannot be deleted — remove those assignments first.
        </Text>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    marginBottom: spacing.md,
  },
  importTools: {
    marginTop: spacing.md,
  },
  footer: {
    gap: spacing.sm,
  },
  form: {
    gap: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    minHeight: 64,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  headerRow: {
    minHeight: 0,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceMuted,
  },
  colBadge: {
    width: 96,
  },
  colName: {
    flex: 1,
    gap: spacing.xxs,
  },
  capacityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xxs,
  },
  capacityBadge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
  },
  capacityBadgeUnlimited: {
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  capacityBadgeLimited: {
    borderColor: colors.primaryBorder,
    backgroundColor: colors.infoSurface,
  },
  capacityBadgeLocked: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSurface,
  },
  colActions: {
    width: 88,
    textAlign: 'right',
  },
  badge: {
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    maxWidth: '100%',
  },
});
