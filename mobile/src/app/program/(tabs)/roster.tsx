import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, Modal, TextInput, TouchableOpacity, Alert } from 'react-native';

import {
  AppHeader,
  ExternalRosterTab,
  FacultyRosterTab,
  ResidentRosterTab,
  Screen,
  Text,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchExternalResidents, fetchResidentList } from '../../../services/residents';
import { fetchFacultySupervisors } from '../../../services/longitudinal';
import { colors, radius, spacing } from '../../../theme';
import { apiClient } from '../../../services/client';

type RosterTab = 'residents' | 'visiting' | 'faculty';

export default function RosterScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const [activeTab, setActiveTab] = useState<RosterTab>('residents');
  const [showAddVisitor, setShowAddVisitor] = useState(false);
  const [newVisitor, setNewVisitor] = useState({
    corporate_id: '',
    first_name: '',
    last_name: '',
    mobile: '',
    email: '',
    home_program_name: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null); // eslint-disable-line no-unused-vars 
  const residents = useApiResource(
    () => fetchResidentList({ programId, limit: 100 }),
    [programId],
  );
  const visiting = useApiResource(
    () => fetchExternalResidents(programId),
    [programId],
  );
  const faculty = useApiResource(
    () => fetchFacultySupervisors(programId, { includeInactive: true }),
    [programId],
  );

  const programme = useMemo(() => {
    const first = (residents.data ?? []).find((row) => row.program_code);
    if (!first) return null;
    return { name: first.specialty_name, code: first.program_code };
  }, [residents.data]);

  const headerSubtitle = programme?.code
    ? `Enrolled into ${programme.name ?? 'Programme'} Program (Code: ${programme.code})`
    : (session?.programLabel ?? 'Residents enrolled in this programme');

  const tabs = useMemo(
    () => [
      {
        value: 'residents' as const,
        label: 'Resident Roster',
        count: residents.data?.length ?? 0,
        countLabel: 'residents',
      },
      {
        value: 'visiting' as const,
        label: 'Visiting',
        count: visiting.data?.length ?? 0,
        countLabel: 'external',
      },
      {
        value: 'faculty' as const,
        label: 'Faculty Preceptors',
        count: (faculty.data ?? []).filter((row) => row.is_active === 1).length,
        countLabel: 'active',
      },
      {
        value: 'add-visitor' as const,
        label: '+ Register Visiting',
        count: showAddVisitor ? 'open' : '0',
        countLabel: 'button',
      },
    ],
    [residents.data, visiting.data, faculty.data, showAddVisitor],
  );

  /* eslint-disable no-unused-vars */
  async function handleSaveVisitingResident() {
    const { corporate_id, first_name, last_name, mobile, email, home_program_name } = newVisitor;

    if (!corporate_id || corporate_id.trim() === '') {
      setSaveError('Corporate/Guest ID is required');
      return;
    }

    setSaveError(null);
    setSaving(true);

    try {
      const response = await apiClient.post('/residents/visiting', {
        corporate_id: corporate_id.trim(),
        first_name: first_name?.trim() || undefined,
        last_name: last_name?.trim() || undefined,
        mobile: mobile?.trim() || undefined,
        email: email?.trim() || undefined,
        home_program_name: home_program_name?.trim() || undefined,
        program_id: programId,
      });

      if (response.data.success) {
        visiting.refresh();
        setShowAddVisitor(false);
        setNewVisitor({
          corporate_id: '',
          first_name: '',
          last_name: '',
          mobile: '',
          email: '',
          home_program_name: '',
        });
        Alert.alert('Success', 'Visiting resident registered successfully');
      } else {
        setSaveError(response.data.error || 'Failed to register visiting resident');
        Alert.alert('Error', response.data.error || 'Failed to register visiting resident');
      }
    } catch (error: any) {
      setSaveError(error.detail || 'Failed to register visiting resident');
      Alert.alert('Error', error.detail || 'Failed to register visiting resident');
    } finally {
      setSaving(false);
    }
  }
  /* eslint-enable no-unused-vars */

  return (
    <Screen
      onRefresh={() => {
        residents.refresh();
        visiting.refresh();
        faculty.refresh();
      }}
      refreshing={residents.isRefreshing || visiting.isRefreshing || faculty.isRefreshing}
      bottomGutter={spacing.xxl}
    >
      <AppHeader title="Roster" subtitle={headerSubtitle} />

      <View accessibilityRole="radiogroup" accessibilityLabel="Roster section" style={styles.toggle}>
        {tabs.map((tab) => {
          const active = activeTab === tab.value;
          if (tab.value === 'add-visitor') {
            return (
              <Pressable
                key={tab.value}
                onPress={() => setShowAddVisitor(true)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${tab.label}, ${tab.count} ${tab.countLabel}`}
                style={({ pressed }) => [
                  styles.toggleOption,
                  active ? styles.toggleOptionActive : null,
                  pressed && !active ? styles.toggleOptionPressed : null,
                ]}
              >
                <Text variant="button" align="center" tone={active ? 'brand' : 'secondary'}>
                  {tab.label}
                </Text>
                <Text variant="caption" align="center" tone="muted">
                  {`${tab.count} ${tab.countLabel}`}
                </Text>
              </Pressable>
            );
          }
          return (
            <Pressable
              key={tab.value}
              onPress={() => setActiveTab(tab.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${tab.label}, ${tab.count} ${tab.countLabel}`}
              style={({ pressed }) => [
                styles.toggleOption,
                active ? styles.toggleOptionActive : null,
                pressed && !active ? styles.toggleOptionPressed : null,
              ]}
            >
              <Text variant="button" align="center" tone={active ? 'brand' : 'secondary'}>
                {tab.label}
              </Text>
              <Text variant="caption" align="center" tone="muted">
                {`${tab.count} ${tab.countLabel}`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {activeTab === 'residents' ? (
        <ResidentRosterTab resource={residents} programId={programId} />
      ) : activeTab === 'visiting' ? (
        <>
          {showAddVisitor ? (
            <View style={styles.modalContainer}>
              <Modal visible={showAddVisitor} onRequestClose={() => setShowAddVisitor(false)}>
                <View style={styles.modalView}>
                  <Text style={styles.modalTitle}>Register Visiting Resident</Text>
                  <TouchableOpacity style={styles.modalClose} onPress={() => setShowAddVisitor(false)}>
                    <Text style={styles.modalCloseText}>X</Text>
                  </TouchableOpacity>
                  
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Corporate / Guest ID *</Text>
                    <TextInput
                      style={styles.formInput}
                      placeholder="e.g., VISIT-2026-01"
                      value={newVisitor.corporate_id}
                      onChangeText={(text) => setNewVisitor({ ...newVisitor, corporate_id: text })}
                      autoCapitalize="characters"
                    />
                  </View>
                  
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>First Name</Text>
                    <TextInput
                      style={styles.formInput}
                      placeholder="e.g., Dr. Sarah"
                      value={newVisitor.first_name}
                      onChangeText={(text) => setNewVisitor({ ...newVisitor, first_name: text })}
                    />
                  </View>
                  
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Last Name</Text>
                    <TextInput
                      style={styles.formInput}
                      placeholder="e.g., Jenkins"
                      value={newVisitor.last_name}
                      onChangeText={(text) => setNewVisitor({ ...newVisitor, last_name: text })}
                    />
                  </View>
                  
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Mobile Number</Text>
                    <TextInput
                      style={styles.formInput}
                      placeholder="e.g., +1-555-123-4567"
                      keyboardType="phone-pad"
                      value={newVisitor.mobile}
                      onChangeText={(text) => setNewVisitor({ ...newVisitor, mobile: text })}
                    />
                  </View>
                  
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Email Address</Text>
                    <TextInput
                      style={styles.formInput}
                      placeholder="e.g., sarah.jenkins@hospital.org"
                      keyboardType="email-address"
                      value={newVisitor.email}
                      onChangeText={(text) => setNewVisitor({ ...newVisitor, email: text })}
                    />
                  </View>
                  
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Sponsoring Home Program / Institution</Text>
                    <TextInput
                      style={styles.formInput}
                      placeholder="e.g., St. Mary's Hospital Family Medicine"
                      value={newVisitor.home_program_name}
                      onChangeText={(text) => setNewVisitor({ ...newVisitor, home_program_name: text })}
                    />
                  </View>
                  
                  <View style={styles.actionButtons}>
                    <TouchableOpacity style={styles.cancelButton} onPress={() => setShowAddVisitor(false)}>
                      <Text style={styles.cancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.saveButton} onPress={handleSaveVisitingResident}>
                      <Text style={styles.saveText}>Save Visiting Resident</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </Modal>
            </View>
          ) : null}
          
          <ExternalRosterTab resource={visiting} />
        </>
      ) : activeTab === 'faculty' ? (
        <FacultyRosterTab resource={faculty} programId={programId} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  toggle: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xxs,
    padding: spacing.xxs,
    marginBottom: spacing.md,
  },
  toggleOption: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  toggleOptionActive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  toggleOptionPressed: {
    backgroundColor: colors.surface,
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalView: {
    width: '80%',
    maxWidth: 400,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: spacing.lg,
    textAlign: 'center',
  },
  modalClose: {
    position: 'absolute',
    top: 10,
    right: 15,
  },
  modalCloseText: {
    color: colors.primary,
    fontWeight: 'bold',
  },
  formGroup: {
    width: '100%',
    marginBottom: spacing.md,
  },
  formLabel: {
    fontSize: 14,
    marginBottom: spacing.xs,
    color: colors.textPrimary,
  },
  formInput: {
    width: '100%',
    height: 50,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    fontSize: 16,
    backgroundColor: colors.background,
    color: colors.textPrimary,
  },
  actionButtons: {
    flexDirection: 'row',
    width: '100%',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
  },
  cancelButton: {
    width: '45%',
    backgroundColor: colors.surfaceMuted,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  saveButton: {
    width: '45%',
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  cancelText: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  saveText: {
    color: colors.onPrimary,
    fontWeight: '600',
  },
});
