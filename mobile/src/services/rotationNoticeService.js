import { request } from './client';

/**
 * Auto-ingest visiting resident profiles from coordinator's Inbox letters.
 *
 * When a Rotation Release / Placement Letter is received in the Coordinator's
 * Inbox (/program/letters), this service parses the resident identity attributes
 * from the letter payload and automatically upserts a new visiting resident
 * profile so they instantly appear under the Visiting roster tab.
 *
 * Letter payload expected fields (from ReleaseLetter type):
 * - resident_name
 * - corporate_id (from merge values or identifiers)
 * - resident_email
 * - resident_mobile
 * - home_program_name (the dispatching programme name)
 *
 * The service checks if a resident with the given corporate_id already exists
 * in the visiting residents list. If missing, it creates a new visiting resident
 * profile (resident_type = 'VISITING') so they instantly appear under the
 * Visiting roster tab.
 */

/**
 * Check if a visiting resident with the given corporate_id already exists
 * in the program's visiting resident list.
 */
async function visitingResidentExists(programId, corporateId) {
  try {
    const visitors = await request({
      method: 'GET',
      url: `/residents/external?program_id=${programId}`
    }, {
      method: 'GET',
    });

    const existing = visitors.data?.find(
      (v) => v.corporate_id === corporateId
    );

    return !!existing;
  } catch {
    // If we can't check, assume it doesn't exist (create will handle it)
    return false;
  }
}

/**
 * Create a new visiting resident profile via the API.
 */
async function createVisitingResident(
  programId,
  corporateId,
  firstName,
  lastName,
  mobile,
  email,
  homeProgramName
) {
  try {
    const response = await request({
      method: 'POST',
      url: '/residents/visiting',
      data: {
        corporate_id: corporateId,
        first_name: firstName,
        last_name: lastName,
        mobile,
        email,
        home_program_name: homeProgramName,
        program_id: programId,
      },
    });

    if (response.success && response.data) {
      return { success: true, residentId: response.data.resident_id };
    }

    return { success: false, error: response.error || 'Unknown error' };
  } catch (error) {
    return { success: false, error: error.detail || error.message };
  }
}

/**
 * Auto-ingest visiting resident profiles from coordinator's Inbox letters.
 *
 * @param programId The receiving programme ID
 * @param letters Array of ReleaseLetter from the inbox
 * @returns Object with created, alreadyExists, and errors counts
 */
export async function autoIngestVisitingFromInbox(
  programId,
  letters,
) {
  const results = {
    created: 0,
    alreadyExists: 0,
    errors: [],
  };

  for (const letter of letters) {
    // Extract resident identity attributes from the letter payload
    const {
      resident_name,
      corporate_id,
      resident_email,
      resident_mobile,
      home_program_name,
    } = letter;

    // Skip if no corporate_id is provided - we need at least the mandatory field
    if (!corporate_id) {
      results.errors.push(
        'Letter ' + letter.letter_id + ': No corporate_id found in letter payload, skipping auto-ingest.'
      );
      continue;
    }

    // Check if a resident with this corporate_id already exists
    const exists = await visitingResidentExists(programId, corporate_id);

    if (exists) {
      results.alreadyExists += 1;
      continue;
    }

    // Create a new visiting resident profile
    const createResult = await createVisitingResident(
      programId,
      corporate_id,
      resident_name || '',
      '' ,
      resident_mobile || '',
      resident_email || '',
      home_program_name || '',
    );

    if (createResult.success && createResult.residentId) {
      results.created += 1;
    } else {
      results.errors.push(
        'Letter ' + letter.letter_id + ': Failed to create visiting resident - ' + (createResult.error || 'Unknown error')
      );
    }
  }

  return results;
}

/**
 * Fetch inbox letters and auto-ingest visiting residents.
 * Convenience function for use in coordinator screens.
 */
export async function fetchAndAutoIngestInbox(
  programId,
) {
  // Fetch received letters (inbox)
  const inboxResponse = await request({
    method: 'GET',
    url: '/letters',
    params: {
      program_id: programId,
      box: 'received',
    },
  });

  const letters = (inboxResponse.data || []);
  const ingestResults = await autoIngestVisitingFromInbox(programId, letters);

  return {
    letters: letters,
    ingestResults: ingestResults,
  };
}