import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ClipboardList, Pencil, Plus, Trash2 } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  ImportTools,
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
  department: string;
  abbreviation: string;
}

interface FieldErrors {
  fullName?: string;
  department?: string;
  abbreviation?: string;
}

const EMPTY_FORM: FormState = { fullName: '', department: '', abbreviation: '' };

const MAX_NAME_LENGTH = 255;
const MAX_ABBREVIATION_LENGTH = 50;

export default function RotationsCatalogueScreen() {
  const { session } = useSession();
  const { notify } = useInAppNotifications();
  const programId = session?.programId ?? 0;

  const catalogue = useApiResource(() => fetchRotationCatalogue(programId), [programId]);

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

  /** Departments already in use, offered as a hint under the department field. */
  const departments = useMemo(
    () => [...new Set(entries.map((entry) => entry.department))].sort((a, b) => a.localeCompare(b)),
    [entries],
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
      department: entry.department,
      abbreviation: entry.abbreviation,
    });
    setFieldErrors({});
    setSaveError(null);
    setSheetOpen(true);
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

    if (!abbreviation) errors.abbreviation = 'An abbreviation is required.';
    else if (abbreviation.length > MAX_ABBREVIATION_LENGTH) {
      errors.abbreviation = `Keep the abbreviation to ${MAX_ABBREVIATION_LENGTH} characters or fewer.`;
    } else {
      const clash = entries.find(
        (entry) => entry.abbreviation.toUpperCase() === abbreviation && entry.id !== editingId,
      );
      if (clash) errors.abbreviation = `Already used by “${clash.full_name}”.`;
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
      abbreviation: form.abbreviation.trim().toUpperCase(),
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
        hint="Three columns: full rotation name, hospital department, abbreviation. Existing abbreviations are updated, not duplicated."
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

          <TextField
            label="Hospital Department"
            required
            value={form.department}
            onChangeText={(value) => setForm((current) => ({ ...current, department: value }))}
            placeholder="Department of Surgery"
            autoCapitalize="words"
            error={fieldErrors.department}
            hint={
              editingId === null && departments.length > 0
                ? `In use: ${departments.slice(0, 4).join(', ')}${departments.length > 4 ? '…' : ''}`
                : undefined
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
