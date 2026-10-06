/**
 * A single shared empty array.
 *
 * `data ?? []` in a component body allocates a fresh array on every render, so
 * any `useMemo` downstream of it recomputes on every render too — the memo is
 * silently doing nothing, and for a derived list over a roster that is a real
 * cost on a low-end phone rather than a lint nit. It is also the reason
 * `react-hooks/exhaustive-deps` warns: the dependency genuinely is unstable.
 *
 * Typed as `never[]`, which is assignable to any array type with a plain cast at
 * the call site, and frozen at runtime so an accidental push cannot corrupt every
 * other screen that reached for the same array.
 */
export const EMPTY_ARRAY: never[] = Object.freeze([]) as never[];
