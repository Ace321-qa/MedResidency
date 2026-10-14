import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
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
  createFacultySupervisor,
  deleteFacultySupervisor,
  updateFacultySupervisor,
} from '../services/longitudinal';
import { uploadFacultySupervisors } from '../services/excelTemplates';
import { useInAppNotifications } from '../services/inAppNotifications';
import { spacing } from '../theme';
import { ROSTER_FILTER_ALL } from '../utils/residents';
import type { FacultySupervisor } from '../types/api';

/**
 * The Faculty Preceptors half of the Roster Management Hub.
 *
 * The same supervisor records that the CCC matrix offers in its "Manage Faculty
 * Preceptors" sheet, promoted to a first-class roster: the CCC sheet is a
 * side-effect of building a clinic grid, whereas a coordinator maintaining the
 * programme's teaching faculty wants a searchable list of its own.
 *
 * Deactivation is a soft delete (`is_active = 0`): the person disappears from
 * the active rosters and dropdowns but every historical supervision record still
 * points at a real name. That is why the confirmation says "remove … from
 * active preceptors" rather than "delete".
 */

/**
 * Faculty are always shown and stored with exactly one `Dr. ` prefix, matching
 * the server's own normalisation. Stripping first means a display name that
 * already carries the title is not turned into `Dr. Dr. Areen`.
 */
function facultyDisplayName(faculty: FacultySupervisor): string {
  const base = String(faculty.display_name ?? `${faculty.first_name} ${faculty.last_name}`)
    .trim()
    .replace(/^Dr\.?\s+/i, '')
    .trim();
  return base ? `Dr. ${base}` : `${faculty.first_name} ${faculty.last_name}`.trim();
}

interface FacultyForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  specialty: string;
  clinicalTitle: string;
  facultyAppointment: string;
  administrativeRole: string;
}

interface FacultyFormErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  clinicalTitle?: string;
  facultyAppointment?: string;
}

const EMPTY_FACULTY_FORM: FacultyForm = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  specialty: '',
  clinicalTitle: '',
  facultyAppointment: '',
  administrativeRole: '',
};

export const FACULTY_STATUS_FILTERS: SelectOption<string>[] = [
  { value: ROSTER_FILTER_ALL, label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];

interface FacultyRosterTabProps {
  resource: Resource<FacultySupervisor[]>;
  programId: number;
}

export function FacultyRosterTab({ resource, programId }: FacultyRosterTabProps) {
  const { notify } = useInAppNotifications();

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(ROSTER_FILTER_ALL);

  // --- add / edit state ---------------------------------------------------
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FacultySupervisor | null>(null);
  const [form, setForm] = useState<FacultyForm>(EMPTY_FACULTY_FORM);
  const [formErrors, setFormErrors] = useState<FacultyFormErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- remove state -------------------------------------------------------
  const [removing, setRemoving] = useState<FacultySupervisor | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (resource.data ?? []).filter((faculty) => {
      if (statusFilter === 'ACTIVE' && faculty.is_active !== 1) return false;
      if (statusFilter === 'INACTIVE' && faculty.is_active === 1) return false;
      if (!needle) return true;

      const haystack = [faculty.first_name, faculty.last_name, faculty.email, faculty.specialty, faculty.clinical_title, faculty.faculty_appointment, faculty.administrative_role]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [resource.data, query, statusFilter]);

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FACULTY_FORM);
    setFormErrors({});
    setSaveError(null);
    setFormOpen(true);
  }

  function openEdit(faculty: FacultySupervisor) {
    setEditing(faculty);
    setForm({
      firstName: faculty.first_name ?? '',
      lastName: faculty.last_name ?? '',
      email: faculty.email ?? '',
      phone: faculty.phone ?? '',
      specialty: faculty.specialty ?? '',
      clinicalTitle: faculty.clinical_title ?? '',
      facultyAppointment: faculty.faculty_appointment ?? '',
      administrativeRole: faculty.administrative_role ?? '',
    });
    setFormErrors({});
    setSaveError(null);
    setFormOpen(true);
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
  }

  function validate(form: FacultyForm): FacultyFormErrors {
    const errors: FacultyFormErrors = {};
    if (!form.firstName.trim()) errors.firstName = 'A first name is required.';
    if (!form.lastName.trim()) errors.lastName = 'A last name is required.';

    const email = form.email.trim();
    if (email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Enter a valid email address.';
    }

    return errors;
  }

  async function save() {
    if (!programId) return;

    const errors = validate(form);
    setFormErrors(errors);
    setSaveError(null);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const payload = {
        program_id: programId,
        first_name: form.firstName.trim(),
        last_name: form.lastName.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        specialty: form.specialty.trim() || null,
        clinical_title: form.clinicalTitle.trim() || null,
        faculty_appointment: form.facultyAppointment.trim() || null,
        administrative_role: form.administrativeRole.trim() || null,
      };

      if (editing) {
        const updated = await updateFacultySupervisor(editing.id, payload);
        resource.setData((current) =>
          (current ?? []).map((row) => (row.id === updated.id ? updated : row)),
        );
        notify({ title: 'Faculty updated', message: facultyDisplayName(updated), tone: 'success' });
      } else {
        const created = await createFacultySupervisor({ ...payload, is_active: 1 });
        resource.setData((current) => [created, ...(current ?? [])]);
        notify({ title: 'Faculty added', message: facultyDisplayName(created), tone: 'success' });
      }

      setFormOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The faculty member could not be saved.';
      setSaveError(message);
      notify({ title: 'Save failed', message, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  function closeRemove() {
    if (removeBusy) return;
    setRemoving(null);
    setRemoveError(null);
  }

  async function confirmRemove() {
    if (!removing || !programId) return;
    setRemoveBusy(true);
    setRemoveError(null);

    try {
      await deleteFacultySupervisor(removing.id, programId);
      const removedId = removing.id;
      resource.setData((current) =>
        (current ?? []).map((row) => (row.id === removedId ? { ...row, is_active: 0 } : row)),
      );
      notify({
        title: 'Faculty removed',
        message: facultyDisplayName(removing),
        tone: 'warning',
      });
      setRemoving(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The faculty member could not be removed.';
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
          title="Could not load the faculty roster"
          message={resource.error.message}
          onRetry={resource.refresh}
        />
      ) : null}

      {resource.status === 'ready' ? (
        <>
          <View style={styles.search}>
            <SearchInput
              accessibilityLabel="Search faculty preceptors"
              value={query}
              onChangeText={setQuery}
              placeholder="Name, email or specialty"
            />
          </View>

          <SelectField
            label="Status"
            value={statusFilter}
            options={FACULTY_STATUS_FILTERS}
            onChange={setStatusFilter}
          />

          <ImportTools
            template="faculty"
            downloadLabel="Download Template (.xlsx)"
            uploadLabel="Upload Faculty List (.xlsx)"
            upload={(file) => uploadFacultySupervisors(file, programId)}
            onImported={() => resource.refresh()}
            autoDismissSuccessMs={6000}
            hint="Five columns: First Name, Last Name, Email, Phone, Specialty. First and Last Name are required; Specialty defaults to Family Medicine."
          />

          <SectionHeader title={`${visible.length} preceptor${visible.length === 1 ? '' : 's'}`} />

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={Users}
                title={query ? 'No match' : 'No faculty preceptors'}
                message={
                  query
                    ? `No preceptor in this programme matches “${query}”.`
                    : 'Add the first preceptor, or upload the faculty template with the names you already have.'
                }
                actionLabel={query ? undefined : 'Add a preceptor'}
                onActionPress={query ? undefined : openAdd}
              />
            </Card>
          ) : (
            <Card padded={false}>
{visible.map((faculty, index) => (
                <ListRow
                  key={faculty.id}
                  title={[
                    facultyDisplayName(faculty),
                    faculty.faculty_appointment ? `• ${faculty.faculty_appointment}` : '',
                    faculty.administrative_role && faculty.administrative_role !== 'None' ? `• ${faculty.administrative_role}` : '',
                  ].filter(Boolean).join(' ')}
                  subtitle={faculty.specialty || 'No specialty recorded'}
                  meta={faculty.email || faculty.phone || 'No contact details recorded'}
                  trailing={
                    <View style={styles.actions}>
                      <StatusBadge
                        label={faculty.is_active === 1 ? 'Active' : 'Inactive'}
                        tone={faculty.is_active === 1 ? 'success' : 'neutral'}
                      />
                      <IconButton
                        icon={Pencil}
                        tone="primary"
                        accessibilityLabel={`Edit ${facultyDisplayName(faculty)}`}
                        onPress={() => openEdit(faculty)}
                      />
                      {faculty.is_active === 1 ? (
                        <IconButton
                          icon={Trash2}
                          tone="danger"
                          accessibilityLabel={`Remove ${facultyDisplayName(faculty)} from active preceptors`}
                          onPress={() => setRemoving(faculty)}
                        />
                      ) : null}
                    </View>
                  }
                />
              ))}
            </Card>
          )}

          <Button
            label="Add a preceptor"
            icon={UserPlus}
            onPress={openAdd}
            style={styles.cta}
          />
        </>
      ) : null}

      {/* Add / edit — one form for both, because the fields are identical. */}
      <Sheet
        visible={formOpen}
        onClose={closeForm}
        title={editing ? 'Edit preceptor' : 'Add preceptor'}
        subtitle={editing ? facultyDisplayName(editing) : 'A supervising faculty member'}
        footer={
          <View style={styles.footer}>
            <Button
              label={editing ? 'Save preceptor' : 'Add preceptor'}
              icon={editing ? undefined : UserPlus}
              loading={saving}
              onPress={() => void save()}
            />
            <Button label="Cancel" variant="ghost" disabled={saving} onPress={closeForm} />
          </View>
        }
      >
        <View style={styles.form}>
          {saveError ? (
            <Banner tone="danger" title="Could not save" message={saveError} />
          ) : null}

          <TextField
            label="First Name"
            required
            value={form.firstName}
            onChangeText={(value) => setForm((current) => ({ ...current, firstName: value }))}
            autoCapitalize="words"
            error={formErrors.firstName}
          />

          <TextField
            label="Last Name"
            required
            value={form.lastName}
            onChangeText={(value) => setForm((current) => ({ ...current, lastName: value }))}
            autoCapitalize="words"
            error={formErrors.lastName}
          />

          <TextField
            label="Email"
            value={form.email}
            onChangeText={(value) => setForm((current) => ({ ...current, email: value }))}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder="name@example.com"
            error={formErrors.email}
          />

          <TextField
            label="Phone"
            value={form.phone}
            onChangeText={(value) => setForm((current) => ({ ...current, phone: value }))}
            keyboardType="phone-pad"
            placeholder="+974 …"
          />

          <TextField
            label="Specialty"
            value={form.specialty}
            onChangeText={(value) => setForm((current) => ({ ...current, specialty: value }))}
            autoCapitalize="words"
            placeholder="Family Medicine"
          />
        </View>
      </Sheet>

      {/* Remove — confirmation first, exact wording. */}
      <Sheet
        visible={removing !== null}
        onClose={closeRemove}
        title="Remove preceptor?"
        subtitle={removing ? facultyDisplayName(removing) : undefined}
        footer={
          <View style={styles.footer}>
            <Button
              label="Remove from preceptors"
              variant="danger"
              icon={Trash2}
              loading={removeBusy}
              onPress={() => void confirmRemove()}
            />
            <Button label="Keep preceptor" variant="ghost" disabled={removeBusy} onPress={closeRemove} />
          </View>
        }
      >
        {removeError ? (
          <Banner tone="danger" title="Cannot remove this preceptor" message={removeError} />
        ) : null}

        {removing ? (
          <Text variant="body" tone="primary">
            {`Are you sure you want to remove ${facultyDisplayName(removing)} from active preceptors?`}
          </Text>
        ) : null}

        <Text variant="bodySmall" tone="secondary" style={styles.removeHint}>
          They disappear from active lists and dropdowns, but every historical supervision record
          they hold is kept.
        </Text>
      </Sheet>
    </>
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
