import { StyleSheet, View } from 'react-native';
import { Database, LogOut, Server } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DetailRow,
  Screen,
  SectionHeader,
  Text,
} from '../../components';
import { useApiResource, useSession } from '../../hooks';
import { API_BASE_URL, DEFAULT_PROGRAM_ID } from '../../config/env';
import { goBack } from '../../navigation/back';
import { fetchHealth } from '../../services/health';
import { colors, spacing } from '../../theme';
import { formatDateTime } from '../../utils/format';

/**
 * Coordinator settings.
 *
 * Same three things as the resident's: which server, is the database reachable,
 * and how to leave. Settings that only make sense for one role stay out of the
 * other role's copy.
 */
export default function ProgramSettingsScreen() {
  const { session, signOut } = useSession();
  const health = useApiResource(fetchHealth);

  const reachable = health.status === 'ready';
  const dbConnected = reachable && health.data?.database.connected === true;

  return (
    <Screen onRefresh={health.refresh} refreshing={health.isRefreshing} bottomGutter={spacing.xxl}>
      <AppHeader title="Settings" onBack={goBack} />

      <SectionHeader title="Connection" />
      <Card>
        <View style={styles.statusRow}>
          <Server color={reachable ? colors.success : colors.danger} size={18} />
          <Text variant="h3">
            {reachable ? 'API reachable' : health.status === 'loading' ? 'Checking…' : 'API unreachable'}
          </Text>
        </View>

        <DetailRow label="API base URL" value={API_BASE_URL} />
        <DetailRow
          label="Database"
          value={
            health.status === 'ready'
              ? `${health.data?.database.database_name ?? 'unknown'} · ${dbConnected ? 'connected' : 'not connected'}`
              : health.status === 'loading'
                ? 'checking…'
                : 'unreachable'
          }
        />
        {health.data ? (
          <DetailRow label="Server time" value={formatDateTime(health.data.timestamp)} />
        ) : null}

        {health.error ? (
          <Banner
            tone="danger"
            title="Could not reach the API"
            message={`${health.error.message} — check EXPO_PUBLIC_API_URL, then reload the app.`}
          />
        ) : null}

        {dbConnected ? (
          <View style={styles.row}>
            <Database color={colors.success} size={14} />
            <Text variant="caption" tone="secondary">
              Server reported a healthy database connection
            </Text>
          </View>
        ) : null}
      </Card>

      <SectionHeader title="Session" />
      <Card>
        <DetailRow label="Role" value="Programme coordinator" />
        <DetailRow label="Programme id" value={String(session?.programId ?? '—')} />
        <DetailRow label="Scoped programme" value={session?.programLabel ?? '—'} />
      </Card>

      <Banner
        tone="info"
        title="No authentication yet"
        message="The coordinator role is chosen on the sign-in screen. When SSO or a real auth endpoint arrives, only the sign-in screen changes — every screen here reads the programme from the session."
      />

      <SectionHeader title="Defaults" />
      <Card>
        <DetailRow label="Fallback programme id" value={String(DEFAULT_PROGRAM_ID)} />
        <Text variant="caption" tone="muted" style={styles.note}>
          Override with EXPO_PUBLIC_API_URL and EXPO_PUBLIC_FALLBACK_PROGRAM_ID.
        </Text>
      </Card>

      <View style={styles.actions}>
        <Button label="Re-test connection" variant="outline" onPress={health.refresh} />
        <Button
          label="Sign out"
          variant="danger"
          icon={LogOut}
          onPress={signOut}
          accessibilityHint="Clears the local session and returns to the sign-in screen"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  note: {
    marginTop: spacing.sm,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
});