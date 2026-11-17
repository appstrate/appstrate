Garmin LiveTrack has no public API. This integration reads the JSON API behind
the LiveTrack web page (`livetrack.garmin.com` or `live.garmin.com`), which is
undocumented and may change: if a call returns something unlike what is
described here, report it, do not guess. Only sessions the owner shares with
everyone are visible.

#### 1. Load the owner's page

Call `api_call` with target `{{livetrack_url}}` (exactly that, nothing after it)
and no `responseMode`: the page is large, so it is saved automatically to a
workspace file and the result is a pointer line
`[resource … → saved to workspace file resources/<file>.html …]`. Do not use
`responseMode.toFile`; read that file, do not ask for the page again. This call
also stores the `livetrack_csrf` cookie, which later calls in the same run send
automatically. Take three values from the file:

```sh
F=resources/<file>.html
grep -qE '(isPasscodeRequired|isAccessCodeRequired)[\\"]*:true' "$F" && echo protected || echo open
grep -oE 'name="csrf-token" content="[^"]+"' "$F" | cut -d'"' -f4                          # CSRF token
grep -oE 'garminGuid[\\"]*:[\\"]*[0-9a-f-]{36}' "$F" | grep -oE '[0-9a-f-]{36}$' | head -1  # garminGuid
```

- `protected`: the link needs a passcode or access code, which this integration
  does not support. Stop and say so.
- No `garminGuid`: the link is wrong or the owner shares nothing. Stop and say so.

Every later call is a literal URL and sends the header
`Livetrack-Csrf-Token: <CSRF token>`. Send the API calls to the same host as
the link (`<host>` below: `livetrack.garmin.com` or `live.garmin.com`), because
the cookie belongs to that host.

#### 2. List the sessions

`GET https://<host>/api/v2/user/<garminGuid>/profile-sessions`
returns `activeSessions` and `completedSessions`. Each session has `sessionId`,
`sessionToken`, `sessionName`, `startDate` (UTC), `distance` (metres),
`duration` (ISO 8601, `PT20M45S`), `maxElevation` (m) and `sessionUrl` (a
viewer link you may give the user). The latest session is the first of
`activeSessions` (assumed to be the latest), else the `completedSessions` entry
with the most recent `startDate`.

The response also has `activeMultiDayActivities` (multi-day inReach
activities), which this version does not cover. If it is non-empty, say there
is an ongoing multi-day activity and give its fields as returned. If it and
both session lists are empty, say no session is visible.

#### 3. Read a session's track

`GET https://<host>/api/sessions/<sessionId>/track-points/common?token=<sessionToken>`
returns `trackPoints`, oldest first. Each point has `dateTime` (UTC, when the
device recorded it), `position.lat` / `position.lon`, `altitude` (m), `speed`
(probably m/s; multiply by 3.6 for km/h, but nearly all samples seen were 0) and
`eventTypes`, seen as `BEGIN` on the first point and `END` on the last.

The last point is the last known position. Report:

- the time in UTC and in the user's local time, and its age (now − `dateTime`);
- latitude and longitude, altitude, speed when non-zero;
- a map link: `https://www.openstreetmap.org/?mlat=<lat>&mlon=<lon>#map=16/<lat>/<lon>`.

Call the position live only when it comes from an active session and its
`dateTime` is a few minutes old at most. Otherwise say "last known position"
with its age, and say the session ended when its last point carries `END`.

#### Errors

- `403` with an empty body: the CSRF cookie or token is missing or stale. Redo
  step 1 once (new token, new cookie) and retry the call. A second `403`: stop
  and report it.
- `403` with a JSON `errors` body (e.g. `PERSONAL_URL_NO_SUBSCRIPTION`, code
  6004): report its `type` and message. Do not retry.
- Any response may come back as a workspace-file pointer like the page: read
  the file.
