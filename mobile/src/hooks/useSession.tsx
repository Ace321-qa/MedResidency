import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import { DEFAULT_PROGRAM_ID, FALLBACK_RESIDENT_ID } from '../config/env';

/**
 * Who is using the app right now.
 *
 * The backend has no authentication endpoint and no users table, so nothing is
 * verified here yet. What this context *does* do is real and useful: it decides
 * which resident the app is scoped to and which set of tabs is shown, replacing
 * the `CURRENT_RESIDENT_ID = 1` constant that used to be hardcoded into every
 * screen.
 *
 * When real authentication arrives, `signIn` is the only function that changes:
 * it takes a resident and a role from the login response instead of from the
 * picker. Nothing else in the app needs to know the difference.
 */

export type AppRole = 'resident' | 'coordinator';

export interface Session {
  role: AppRole;
  /** The resident being viewed. Always set for a resident session. */
  residentId: number;
  residentName: string;
  /** Program whose roster the coordinator area shows. */
  programId: number;
}

interface SessionContextValue {
  session: Session | null;
  /** True once someone has chosen who they are in this app session. */
  isSignedIn: boolean;
  signInAsResident: (resident: { id: number; fullName: string; programId: number }) => void;
  signInAsCoordinator: (programId: number, programLabel: string) => void;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Program used when a coordinator signs in without picking one explicitly. */
const DEFAULT_PROGRAM = { id: DEFAULT_PROGRAM_ID, label: 'Family Medicine Residency Program' };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  const signInAsResident = useCallback((resident: { id: number; fullName: string; programId: number }) => {
    setSession({
      role: 'resident',
      residentId: resident.id,
      residentName: resident.fullName,
      programId: resident.programId,
    });
  }, []);

  const signInAsCoordinator = useCallback((programId: number, programLabel: string) => {
    setSession({
      role: 'coordinator',
      // A coordinator is not a resident; screens that need a resident id guard
      // on `session.role === 'resident'` before reading this.
      residentId: FALLBACK_RESIDENT_ID,
      residentName: programLabel,
      programId,
    });
  }, []);

  const signOut = useCallback(() => setSession(null), []);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      isSignedIn: session !== null,
      signInAsResident,
      signInAsCoordinator,
      signOut,
    }),
    [session, signInAsResident, signInAsCoordinator, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside <SessionProvider>, which is set up in the root layout.');
  }
  return value;
}

/**
 * The resident id for screens that only make sense for a resident.
 * Throws rather than silently returning a wrong id, which would show one
 * resident another resident's attendance record.
 */
export function useResidentId(): number {
  const { session } = useSession();
  if (!session) {
    throw new Error('useResidentId was called outside a signed-in session.');
  }
  return session.residentId;
}

export { DEFAULT_PROGRAM };