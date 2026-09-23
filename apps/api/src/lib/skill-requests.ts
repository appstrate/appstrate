// SPDX-License-Identifier: Apache-2.0

// Import-free, so the OpenAPI paths can read it without loading the database client.

/** Cap on `GET /api/me/context?skills=`; above the chat's pin ceiling, it bounds one query. */
export const MAX_REQUESTED_SKILLS = 30;
