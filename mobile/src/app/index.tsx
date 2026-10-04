import { Redirect } from 'expo-router';

import { useSession } from '../hooks';

/**
 * The app's entry point.
 *
 * Expo Router needs a root screen, and this one decides where the user belongs:
 * nobody signed in goes to the sign-in screen, a resident goes to their own
 * dashboard, and a coordinator goes to the programme area. Because a session
 * lives in memory only, a cold start always lands here and re-asks who is
 * using the app.
 */
export default function Index() {
  const { session } = useSession();

  if (!session) {
    return <Redirect href="/sign-in" />;
  }

  return <Redirect href={session.role === 'resident' ? '/resident' : '/program'} />;
}