Garmin LiveTrack has no public API. This integration reads the JSON API behind
the `livetrack.garmin.com` web page, which is undocumented and may change: if a
call returns something unlike what is described here, report it, do not guess.
Only sessions the owner shares with everyone are visible.

#### 1. Load the owner's page

`GET {{livetrack_url}}` (exactly that target, nothing after it). The page is
large, so the result is a pointer line
`[resource … → saved to workspace file resources/<file>.html …]`: read that
file, do not ask for the page again. This call also stores the `livetrack_csrf`
cookie, which later calls send automatically. Take two values from the file:

```sh
F=resources/<file>.html
grep -oE 'name="csrf-token" content="[^"]+"' "$F" | cut -d'"' -f4                       # CSRF token
grep -oE 'garminGuid[\\"]*:[\\"]*[0-9a-f-]{36}' "$F" | grep -oE '[0-9a-f-]{36}$' | head -1  # garminGuid
grep -oE 'isPasscodeRequired[\\"]*:true' "$F"                                            # passcode
```

- No `garminGuid`: the link is wrong or the owner shares nothing. Stop and say so.
- `isPasscodeRequired…:true`: the link needs a passcode, which this integration
  does not support. Stop and say so.

Every later call is a literal URL and sends the header
`Livetrack-Csrf-Token: <CSRF token>`. Without it Garmin answers `403`.

#### 2. List the sessions

`GET https://livetrack.garmin.com/api/v2/user/<garminGuid>/profile-sessions`
returns `activeSessions` and `completedSessions`. Each session has `sessionId`,
`sessionToken`, `sessionName`, `startDate` (UTC), `distance` (metres),
`duration` (ISO 8601, `PT20M45S`), `maxElevation` (m) and `sessionUrl` (a
viewer link you may give the user). The latest session is the first of
`activeSessions`, else the `completedSessions` entry with the most recent
`startDate`. Both lists empty: say no session is visible.

#### 3. Read a session's track

`GET https://livetrack.garmin.com/api/sessions/<sessionId>/track-points/common?token=<sessionToken>`
returns `trackPoints`, oldest first. Each point has `dateTime` (UTC, when the
device recorded it), `position.lat` / `position.lon`, `altitude` (m), `speed`
(m/s per Garmin's convention; multiply by 3.6 for km/h) and, on the first and
last points only, `eventTypes` (`BEGIN`, `END`).

The last point is the last known position. Report:

- the time in UTC and in the user's local time, and its age (now − `dateTime`);
- latitude and longitude, altitude, speed when non-zero;
- a map link: `https://www.openstreetmap.org/?mlat=<lat>&mlon=<lon>#map=16/<lat>/<lon>`.

Call the position live only when it comes from an active session and its
`dateTime` is a few minutes old at most. Otherwise say "last known position"
with its age, and say the session ended when its last point carries `END`.

#### Errors

- `403`: the CSRF cookie or token is stale. Redo step 1 once (new token, new
  cookie) and retry the call. A second `403`: stop and report it.
- Any response may come back as a workspace-file pointer like the page: read
  the file.
