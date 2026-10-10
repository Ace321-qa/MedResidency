import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Pencil, Trash2, UserPlus, Users } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  ImportTools,
  ListRow,
  Screen,
  SearchInput,
  SectionHeader,
  SelectField,
  Sheet,
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import {
  deleteResident,
  fetchResident,
  fetchResidentList,
  updateResident,
} from '../../../services/residents';
import { uploadRoster } from '../../../services/excelTemplates';
import { useInAppNotifications } from '../../../services/inAppNotifications';
import { spacing } from '../../../theme';
import { humanizeToken } from '../../../utils/format';
import {
  filterResidents,
  identifierValue,
  residentFullName,
  residentSubtitle,
} from '../../../utils/residents';
import { RESIDENT_STATUSES, type ResidentListItem } from '../../../types/api';

/**
 * Roster — every resident in the signed-in programme.
 *
 * Search covers name, programme code, specialty and PGY level, because a
 * coordinator looking for "the PGY-2" is as likely to type that as a name.
 *
 * The import path is deliberately two independent buttons rather than one
 * ambiguous "Import": downloading the template must work even when the API is
 * down, and a failed upload has to say *which row* broke instead of a generic
 * error alert.
 *
 * Each card carries its own Edit and Remove actions. Editing fetches the full
 * profile (the list row is only a projection) and writes it back through one
 * `PUT`; removing asks first, because dropping a resident from the roster is
 * not an action to discover by mis-tapping.
 */

interface EditForm {
  firstName: string;
  lastName: string;
  corporateId: string;
  pgyLevel: string;
  email: string;
  mobile: string;
  status: string;
}

interface EditErrors {
  firstName?: string;
  lastName?: string;
  pgyLevel?: string;
  email?: string;
}

const EMPTY_FORM: EditForm = {
  firstName: '',
  lastName: '',
  corporateId: '',
  pgyLevel: '',
  email: '',
  mobile: '',
  status: 'ACTIVE_FULL_TIME',
};

const STATUS_OPTIONS = RESIDENT_STATUSES.map((status) => ({
  value: status,
  label: humanizeToken(status),
}));

export default function RosterScreen() {
  const router = useRouter();
  const { session } = useSession();
  const { notify } = useInAppNotifications();
  const programId = session?.programId ?? 0;
  const [query, setQuery] = useState('');

  const residents = useApiResource(() => fetchResidentList({ programId, limit: 100 }), [programId]);

  // --- edit state ---------------------------------------------------------
  const [editing, setEditing] = useState<ResidentListItem | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_FORM);
  const [editErrors, setEditErrors] = useState<EditErrors>({});
  const [editLoading, setEditLoading] = useState(false);
  const [editSaveError, setEditSaveError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  // --- remove state -------------------------------------------------------
  const [removing, setRemoving] = useState<ResidentListItem | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const visible = useMemo(
    () => filterResidents(residents.data ?? [], query),
    [residents.data, query],
  );

  // The header has to name the *programme*, and there is no GET /programs, so
  // it is derived from the roster itself — every row carries the code and name.
  const programme = useMemo(() => {
    const first = (residents.data ?? []).find((row) => row.program_code);
    if (!first) return null;
    return { name: first.specialty_name, code: first.program_code };
  }, [residents.data]);

  const headerSubtitle = programme?.code
    ? `Enrolled into ${programme.name ?? 'Programme'} Program (Code: ${programme.code})`
    : (session?.programLabel ?? 'Residents enrolled in this programme');

  const programmeName = programme?.name ?? 'Family Medicine';

  /**
   * Load the full profile behind a list row and prefill the form.
   *
   * The list endpoint returns only the columns a card draws; the corporate id,
   * email and mobile live on `resident_identifiers` and the PGY level on the
   * enrollment, so they are read from `GET /residents/:id`.
   */
  async function openEdit(resident: ResidentListItem) {
    setEditing(resident);
    setEditErrors({});
    setEditSaveError(null);
    setEditLoading(true);
    setEditForm({
      firstName: resident.first_name,
      lastName: resident.last_name,
      corporateId: '',
      pgyLevel: resident.pgy_level === null ? '' : String(resident.pgy_level),
      email: '',
      mobile: '',
      status: resident.resident_status || 'ACTIVE_FULL_TIME',
    });

    try {
      const full = await fetchResident(resident.resident_id);
      const enrollment = full.enrollments[0] ?? null;
      setEditForm({
        firstName: full.first_name,
        lastName: full.last_name,
        corporateId: identifierValue(full.identifiers, 'CORPORATE_ID'),
        pgyLevel:
          enrollment?.year_in_program === null || enrollment?.year_in_program === undefined
            ? ''
            : String(enrollment.year_in_program),
        email: identifierValue(full.identifiers, 'EMAIL'),
        mobile: identifierValue(full.identifiers, 'MOBILE'),
        status: enrollment?.resident_status ?? (resident.resident_status || 'ACTIVE_FULL_TIME'),
      });
    } catch (error) {
      // The list row still holds a usable name and status; say the rest could
      // not be loaded rather than blocking the edit entirely.
      setEditSaveError(
        error instanceof Error
          ? `Some details could not be loaded: ${error.message}`
          : 'Some details could not be loaded.',
      );
    } finally {
      setEditLoading(false);
    }
  }

  function closeEdit() {
    if (editBusy) return;
    setEditing(null);
  }

  function validateEdit(form: EditForm): EditErrors {
    const errors: EditErrors = {};
    if (!form.firstName.trim()) errors.firstName = 'A first name is required.';
    if (!form.lastName.trim()) errors.lastName = 'A last name is required.';

    const pgy = form.pgyLevel.trim();
    if (pgy !== '') {
      const value = Number(pgy);
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        errors.pgyLevel = 'PGY level must be a whole number between 1 and 10.';
      }
    }

    const email = form.email.trim();
    if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Enter a valid email address.';
    }

    return errors;
  }

  async function saveEdit() {
    if (!editing) return;

    const errors = validateEdit(editForm);
    setEditErrors(errors);
    setEditSaveError(null);
    if (Object.keys(errors).length > 0) return;

    setEditBusy(true);
    try {
      await updateResident(editing.resident_id, {
        first_name: editForm.firstName.trim(),
        last_name: editForm.lastName.trim(),
        corporate_id: editForm.corporateId.trim(),
        email: editForm.email.trim(),
        mobile: editForm.mobile.trim(),
        pgy_level: editForm.pgyLevel.trim() === '' ? undefined : Number(editForm.pgyLevel),
        resident_status: editForm.status,
        program_id: programId || undefined,
      });

      notify({
        title: 'Resident updated',
        message: `${editForm.firstName.trim()} ${editForm.lastName.trim()}`,
        tone: 'success',
      });
      setEditing(null);
      residents.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The resident could not be saved.';
      setEditSaveError(message);
      notify({ title: 'Save failed', message, tone: 'danger' });
    } finally {
      setEditBusy(false);
    }
  }

  function askRemove(resident: ResidentListItem) {
    setEditing(null);
    setRemoving(resident);
    setRemoveError(null);
  }

  function closeRemove() {
    if (removeBusy) return;
    setRemoving(null);
    setRemoveError(null);
  }

  async function confirmRemove() {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);

    try {
      await deleteResident(removing.resident_id);
      const removedId = removing.resident_id;
      // Drop the card in place so the count badge updates immediately, without
      // a full reload of the list.
      residents.setData((current) => (current ?? []).filter((row) => row.resident_id !== removedId));
      notify({
        title: 'Resident removed',
        message: residentFullName(removing),
        tone: 'warning',
      });
      setRemoving(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The resident could not be removed.';
      setRemoveError(message);
      notify({ title: 'Remove failed', message, tone: 'danger' });
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <Screen onRefresh={residents.refresh} refreshing={residents.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader title="Roster" subtitle={headerSubtitle} />

      {residents.isLoading ? <SkeletonList rows={6} /> : null}

      {residents.error ? (
        <ErrorState
          title="Could not load the roster"
          message={residents.error.message}
          onRetry={residents.refresh}
        />
      ) : null}

      {residents.status === 'ready' ? (
        <>
          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search residents"
              value={query}
              onChangeText={setQuery}
              placeholder="Name, programme or PGY level"
            />
          </View>

          <ImportTools
            template="roster"
            uploadLabel="Upload Excel Roster"
            upload={(file) => uploadRoster(file, programId)}
            onImported={() => residents.refresh()}
          />

          <SectionHeader title={`${visible.length} resident${visible.length === 1 ? '' : 's'}`} />

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={Users}
                title={query ? 'No match' : 'No residents enrolled'}
                message={
                  query
                    ? `No resident in this programme matches “${query}”.`
                    : 'Register the first resident, or upload the roster template with the rows you already have.'
                }
                actionLabel={query ? undefined : 'Register a resident'}
                onActionPress={query ? undefined : () => router.push('/program/onboarding')}
              />
            </Card>
          ) : (
            <Card padded={false}>
              {visible.map((resident, index) => (
                <ListRow
                  key={resident.resident_id}
                  title={residentFullName(resident)}
                  subtitle={residentSubtitle(resident)}
                  meta={humanizeToken(resident.resident_status)}
                  trailing={
                    <View style={styles.actions}>
                      <StatusBadge
                        label={resident.resident_status === 'ACTIVE_FULL_TIME' ? 'Active' : 'Other'}
                        tone={resident.resident_status === 'ACTIVE_FULL_TIME' ? 'success' : 'neutral'}
                      />
                      <IconButton
                        icon={Pencil}
                        tone="primary"
                        accessibilityLabel={`Edit ${residentFullName(resident)}`}
                        onPress={() => void openEdit(resident)}
                      />
                      <IconButton
                        icon={Trash2}
                        tone="danger"
                        accessibilityLabel={`Remove ${residentFullName(resident)} from the roster`}
                        onPress={() => askRemove(resident)}
                      />
                    </View>
                  }
                  onPress={() => router.push(`/program/resident/${resident.resident_id}`)}
                  last={index === visible.length - 1}
                />
              ))}
            </Card>
          )}

          <Button
            label="Register a resident"
            icon={UserPlus}
            onPress={() => router.push('/program/onboarding')}
            style={styles.cta}
          />
        </>
      ) : null}

      {/* Edit — prefilled from the full profile, written back in one PUT. */}
      <Sheet
        visible={editing !== null}
        onClose={closeEdit}
        title="Edit resident"
        subtitle={editing ? residentFullName(editing) : undefined}
        footer={
          <View style={styles.footer}>
            <Button label="Save changes" loading={editBusy} disabled={editLoading} onPress={() => void saveEdit()} />
            <Button label="Cancel" variant="ghost" disabled={editBusy} onPress={closeEdit} />
          </View>
        }
      >
        <View style={styles.form}>
          {editSaveError ? (
            <Banner tone="danger" title="Could not save" message={editSaveError} />
          ) : null}

          {editLoading ? (
            <Text variant="bodySmall" tone="secondary">
              Loading the resident’s current details…
            </Text>
          ) : null}

          <TextField
            label="First Name"
            required
            value={editForm.firstName}
            onChangeText={(value) => setEditForm((current) => ({ ...current, firstName: value }))}
            autoCapitalize="words"
            error={editErrors.firstName}
          />

          <TextField
            label="Last Name"
            required
            value={editForm.lastName}
            onChangeText={(value) => setEditForm((current) => ({ ...current, lastName: value }))}
            autoCapitalize="words"
            error={editErrors.lastName}
          />

          <TextField
            label="Corporate ID"
            value={editForm.corporateId}
            onChangeText={(value) => setEditForm((current) => ({ ...current, corporateId: value }))}
            autoCapitalize="characters"
            placeholder="CORP-00001"
          />

          <TextField
            label="PGY Level"
            value={editForm.pgyLevel}
            onChangeText={(value) => setEditForm((current) => ({ ...current, pgyLevel: value }))}
            keyboardType="number-pad"
            placeholder="1"
            hint="Post-graduate year, 1 to 10."
            error={editErrors.pgyLevel}
          />

          <TextField
            label="Email"
            value={editForm.email}
            onChangeText={(value) => setEditForm((current) => ({ ...current, email: value }))}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder="name@example.com"
            error={editErrors.email}
          />

          <TextField
            label="Mobile"
            value={editForm.mobile}
            onChangeText={(value) => setEditForm((current) => ({ ...current, mobile: value }))}
            keyboardType="phone-pad"
            placeholder="+974 …"
          />

          <SelectField
            label="Active Status"
            value={editForm.status}
            options={STATUS_OPTIONS}
            onChange={(value) => setEditForm((current) => ({ ...current, status: value }))}
          />
        </View>
      </Sheet>

      {/* Remove — confirmation first, exact wording. */}
      <Sheet
        visible={removing !== null}
        onClose={closeRemove}
        title="Remove resident?"
        subtitle={removing ? residentFullName(removing) : undefined}
        footer={
          <View style={styles.footer}>
            <Button
              label="Remove from roster"
              variant="danger"
              icon={Trash2}
              loading={removeBusy}
              onPress={() => void confirmRemove()}
            />
            <Button label="Keep resident" variant="ghost" disabled={removeBusy} onPress={closeRemove} />
          </View>
        }
      >
        {removeError ? (
          <Banner tone="danger" title="Cannot remove this resident" message={removeError} />
        ) : null}

        {removing ? (
          <Text variant="body" tone="primary">
            {`Are you sure you want to remove ${residentFullName(removing)} from the ${programmeName} Program roster?`}
          </Text>
        ) : null}

        <Text variant="bodySmall" tone="secondary" style={styles.removeHint}>
          A resident with attendance or rotation history cannot be deleted; the server will explain
          what is holding the record and it will stay on the roster.
        </Text>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    marginBottom: spacing.md,
  },
  cta: {
    marginTop: spacing.lg,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  footer: {
    gap: spacing.sm,
  },
  form: {
    gap: spacing.md,
  },
  removeHint: {
    marginTop: spacing.md,
  },
});
