import { useRouter } from 'expo-router';
import { FileSignature, FileText, Send } from 'lucide-react-native';
import { View, StyleSheet } from 'react-native';

import { goBack } from '../../../navigation/back';
import {
  AppHeader,
  Button,
  Card,
  ListRow,
  Screen,
  SectionHeader,
} from '../../../components';
import { spacing } from '../../../theme';

/**
 * The Release Letters window: the two entry points the coordinator needs, plus
 * the one action that is not a list — dispatching a new letter.
 *
 * The program tab links straight to each card's screen, so this hub exists for
 * deep links and for a coordinator who arrived at /program/letters and expects
 * a menu rather than a list. Same two cards as the tab, no second source of
 * truth: both routes render the same destinations.
 */

export default function LettersHubScreen() {
  const router = useRouter();

  return (
    <Screen bottomGutter={spacing.xxl}>
      <AppHeader
        title="Release Letters"
        onBack={goBack}
        subtitle="Templates and letters addressed to hospital department heads"
      />

      <SectionHeader title="Release letters" />
      <Card padded={false}>
        <ListRow
          title="Letter Templates"
          subtitle="View, edit, and create the templates letters are merged from"
          leadingIcon={FileSignature}
          onPress={() => router.push('/program/letters/templates')}
          accessibilityHint="Opens the release letter template library"
        />
        <ListRow
          title="Dispatched Letters Log"
          subtitle="View generated letters sent to hospital department heads"
          leadingIcon={FileText}
          onPress={() => router.push('/program/letters/log')}
          accessibilityHint="Opens the log of dispatched release letters"
          last
        />
      </Card>

      <View style={styles.cta}>
        <Button
          label="Generate & send official release letter"
          icon={Send}
          onPress={() => router.push('/program/letters/generate')}
          accessibilityHint="Opens the generator and dispatch window"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cta: {
    marginTop: spacing.md,
  },
});
