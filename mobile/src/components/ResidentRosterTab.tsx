import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Pencil, Trash2, UserPlus, Users } from 'lucide-react-native';

import { Banner } from './Banner';
import { Button, IconButton } from './Button';
import { Card, SectionHeader } from './Card';
import { SearchInput, SelectField, TextField, type SelectOption } from './Form';
import { ImportTools } from './ImportTools';
import { ListRow } from './ListRow';
import { Sheet } from './Sheet';
import { EmptyState, ErrorState, SkeletonList } from './StateView';
import { StatusBadge } from './StatusBadge';
import { Text } from './Text';
import type { Resource } from '../hooks';
import {
  fetchResident,
  removeResidentEnrollment,
  updateResident,
} from '../services/residents';
import { uploadRoster } from '../services/excelTemplates';
import { useInAppNotifications } from '../services/inAppNotifications';
import { spacing, type Tone } from '../theme';
import { humanizeToken } from '../utils/format';
import {
  ROSTER_FILTER_ALL,
  filterResidentRoster,
  identifierValue,
  residentFullName,
  residentStatusGroup,
  residentStatusLabel,
  residentSubtitle,
} from '../utils/residents';
import { RESIDENT_STATUSES, type ResidentListItem } from '../types/api';

/**
 * The Resident Roster half of the Roster Management Hub.
 *
 * It owns one job: show every resident enrolled in the programme, let a
 * coordinator search and filter them, edit a row, or unenroll someone. The
 * list is fetched by the hub and handed down as a `Resource`, so the tab badge
 * and this list never disagree about how many people are on the roster.
 *
 * Removal is an *unenrollment*, not a delete: `DELETE /residents/:id/enrollment`
 * takes the person off this programme's roster while leaving their attendance,
 * rotations and letters intact. That is why the sheet is worded as "remove …
 * from the program roster" rather than "delete".
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

const STATUS_SELECT_OPTIONS = RESIDENT_STATUSES.map((status) => ({
  value: status,
  label: humanizeToken(status),
}));

export const RESIDENT_PGY_FILTERS: SelectOption<string>[] = [
  { value: ROSTER_FILTER_ALL, label: 'All' },
  { value: '1', label: 'PGY-1' },
  { value: '2', label: 'PGY-2' },
  { value: '3', label: 'PGY-3' },
  { value: '4', label: 'PGY-4' },
];

export const RESIDENT_STATUS_FILTERS: SelectOption<string>[] = [
  { value: ROSTER_FILTER_ALL, label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'OFF_CYCLE', label: 'Off-Cycle' },
  { value: 'ON_LEAVE', label: 'On Leave' },
];

/** The badge colour that matches an enrolment status. */
function statusTone(status: string): Tone {
  switch (residentStatusGroup(status)) {
    case 'ACTIVE':
      return 'success';
    case 'ON_LEAVE':
      return 'warning';
    case 'OFF_CYCLE':
      return 'info';
    default:
      return 'neutral';
  }
}

interface ResidentRosterTabProps {
  resource: Resource<ResidentListItem[]>;
  programId: number;
}

export function ResidentRosterTab({ resource, programId }: ResidentRosterTabProps) {
  const router = useRouter();
  const { notify } = useInAppNotifications();

  const [query, setQuery] = useState('');
  const [pgyFilter, setPgyFilter] = useState<string>(ROSTER_FILTER_ALL);
  const [statusFilter, setStatusFilter] = useState<string>(ROSTER_FILTER_ALL);

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
    () =>
      filterResidentRoster(resource.data ?? [], query, {
        pgyLevel: pgyFilter,
        statusGroup: statusFilter,
      }),
    [resource.data, query, pgyFilter, statusFilter],
  );

  /**
   * Load the full profile behind a list row and prefill the form.
   *
   * The list projection now carries the corporate id, email and mobile, so the
   * form is usable immediately; `GET /residents/:id` still wins because it is
   * the authority on which enrollment the PGY level belongs to.
   */
  async function openEdit(resident: ResidentListItem) {
    setEditing(resident);
    setEditErrors({});
    setEditSaveError(null);
    setEditLoading(true);
    setEditForm({
      firstName: resident.first_name,
      lastName: resident.last_name,
      corporateId: resident.corporate_id ?? '',
      pgyLevel: resident.pgy_level === null ? '' : String(resident.pgy_level),
      email: resident.email ?? '',
      mobile: resident.mobile ?? '',
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
      resource.refresh();
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
      await removeResidentEnrollment(removing.resident_id, programId || undefined);
      const removedId = removing.resident_id;
      // Drop the card in place so the tab badge updates immediately, without a
      // full reload of the list.
      resource.setData((current) => (current ?? []).filter((row) => row.resident_id !== removedId));
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
    <>
      {resource.isLoading ? <SkeletonList rows={6} /> : null}

      {resource.error ? (
        <ErrorState
          title="Could not load the roster"
          message={resource.error.message}
          onRetry={resource.refresh}
        />
      ) : null}

      {resource.status === 'ready' ? (
        <>
          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search residents"
              value={query}
              onChangeText={setQuery}
              placeholder="Name, corporate ID, email or PGY"
            />
          </View>

          <View style={styles.filters}>
            <SelectField
              label="PGY Level"
              value={pgyFilter}
              options={RESIDENT_PGY_FILTERS}
              onChange={setPgyFilter}
            />
            <SelectField
              label="Enrollment Status"
              value={statusFilter}
              options={RESIDENT_STATUS_FILTERS}
              onChange={setStatusFilter}
            />
          </View>

          <ImportTools
            template="roster"
            downloadLabel="Download Template (.xlsx)"
            uploadLabel="Upload Resident Roster (.xlsx)"
            upload={(file) => uploadRoster(file, programId)}
            onImported={() => resource.refresh()}
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
                  meta={
                    resident.corporate_id
                      ? `Corporate ID: ${resident.corporate_id}`
                      : 'Corporate ID not recorded'
                  }
                  trailing={
                    <View style={styles.actions}>
                      <StatusBadge
                        label={residentStatusLabel(resident.resident_status)}
                        tone={statusTone(resident.resident_status)}
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
                        accessibilityLabel={`Remove ${residentFullName(resident)} from the program roster`}
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
            <Button
              label="Save changes"
              loading={editBusy}
              disabled={editLoading}
              onPress={() => void saveEdit()}
            />
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
            options={STATUS_SELECT_OPTIONS}
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
            <Button
              label="Keep resident"
              variant="ghost"
              disabled={removeBusy}
              onPress={closeRemove}
            />
          </View>
        }
      >
        {removeError ? (
          <Banner tone="danger" title="Cannot remove this resident" message={removeError} />
        ) : null}

        {removing ? (
          <Text variant="body" tone="primary">
            {`Are you sure you want to remove ${residentFullName(removing)} from the program roster?`}
          </Text>
        ) : null}

        <Text variant="bodySmall" tone="secondary" style={styles.removeHint}>
          This removes the resident’s programme enrollment. Their attendance, rotation and letter
          history is kept intact.
        </Text>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  search: {
    marginBottom: spacing.md,
  },
  filters: {
    marginBottom: spacing.xs,
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
