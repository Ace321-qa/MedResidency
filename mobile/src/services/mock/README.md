# Mock data — temporary

Everything in this folder is **fake**. None of it comes from the MedResidency
backend, because the backend has no endpoint for it yet.

## Why this folder exists

Assessments, notifications and progress tracking are core parts of a residency
app, and it is useful to see and review those interfaces now rather than after
the API is written. Rather than scatter placeholder objects through the screens
(which is how fake data ends up shipped by accident), every fabricated value lives
here, in one folder, with one obvious way in and one obvious way out.

## The rules this folder follows

1. **No fake endpoints.** Nothing here performs HTTP. There is no `/api/v1/mock`
   and no interception of real requests.
2. **No production import.** `src/services/mock/index.ts` is the only module that
   re-exports from here, and only the screens listed below may import it.
3. **Named for what is fake.** Every export says it is sample data.

## Who uses it

| Module | Used by | Will be replaced by |
| --- | --- | --- |
| `assessments.ts` | Resident → Assessments | `GET /assessments` |
| `notifications.ts` | Resident → Notifications, dashboard alerts | `GET /notifications` |
| `progress.ts` | Resident → Profile progress summary | `GET /progress` |
| `programReports.ts` | Coordinator → Reports tab | `GET /reports` |

## How to remove it

1. Delete this folder.
2. In each screen, delete the `useMockResource`/`MOCK_*` import and replace the
   value with the real service call from `src/services/`.
3. Delete `src/services/mock/index.ts`.

`npx tsc --noEmit` will point at every remaining reference, so nothing can be left
behind silently.