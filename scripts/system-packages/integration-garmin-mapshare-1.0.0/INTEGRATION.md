Garmin Explore publishes the owner's inReach track as a KML feed (MapShare).
Read it with `api_call` GET on
`https://share.garmin.com/feed/share/{{mapshare_id}}` (keep the path
lowercase): `{{mapshare_id}}` is substituted from the connection.

#### 1. Call

- No query parameter: the most recent point only.
- History: `?d1=…&d2=…`, both in UTC, e.g. 17 October 2026, 06:00 to 18:00
  UTC: `?d1=2026-10-17T06:00z&d2=2026-10-17T18:00z` (`Z`, seconds or a
  date alone also work). "Today" means the user's local day, converted to
  UTC.
- Always pass `responseMode: { "toFile": "garmin/<name>.kml" }`: a point
  weighs about 2.3 KB of KML, so a history would flood the context. The
  result is `{ "kind": "file", "path", "size", "status" }`: read the KML from
  `path`.

#### 2. Read the answer

- `size: 0` (empty body): the map link name is wrong, MapShare is disabled,
  or no point has been shared on the map yet. Say so; never invent a
  position.
- Points are the `Placemark`s holding a `Point`. The last `Placemark` holds a
  `LineString` (the drawn track) and no point data: ignore it. A call without
  parameters therefore returns two `Placemark`s.
- A valid KML with no `Point` Placemark: no visible point in that range. Not
  an error.
- A point's fields are in `ExtendedData`, as
  `<Data name="…"><value>…</value></Data>`:
  - `Time UTC`: US format `M/D/YYYY h:mm:ss AM/PM`, in UTC. Use it, not
    `Time` (owner's zone, unlabelled).
  - `Latitude`, `Longitude`: decimal degrees.
  - `Elevation` (`… m from MSL`), `Velocity` (`… km/h`), `Course`
    (`… ° True`): strip the unit before using the number.
  - `Valid GPS Fix` (`True` / `False`), `In Emergency`, `Event`, `Text` (the
    message, if any).
- `401`: the MapShare password is missing or wrong. Do not retry: report that
  the Garmin MapShare connection must be fixed.

#### Reporting

- Give each point's time in the user's local time, and its age computed from
  `Time UTC` ("il y a 2 h").
- Never present a position as live. Points arrive at the interval set on the
  device (often 10 min; 2 min possible on Premium; billed per point on
  Essential), only while tracking is on: the latest point may be days or
  months old.
- Say when `Valid GPS Fix` is `False`: the position may be wrong.
- Give a map link:
  `https://www.openstreetmap.org/?mlat=<lat>&mlon=<lon>#map=15/<lat>/<lon>`.

#### Limits

- No on-demand locate, no messaging.
- Messages sent in SOS mode are absent from the feed: never use it to assess
  an emergency.
- Do not poll more than once every few minutes.
