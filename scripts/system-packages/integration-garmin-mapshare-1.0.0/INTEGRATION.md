Garmin Explore publishes the owner's inReach track as a KML feed (MapShare).
Read it with `api_call` GET on
`https://explore.garmin.com/feed/share/{{mapshare_id}}` (lowercase path):
`{{mapshare_id}}` is substituted from the connection.

#### 1. Pick the range

- No query parameter: the most recent point only.
- History: `?d1=YYYY-MM-DDTHH:MMz&d2=YYYY-MM-DDTHH:MMz`, in UTC, lowercase `z`,
  no seconds. Example, the 17 October 2026 from 06:00 to 18:00 UTC:
  `?d1=2026-10-17T06:00z&d2=2026-10-17T18:00z`.
- Keep ranges short (a day or two): a large answer is spilled to a workspace
  file.

#### 2. Read the answer

- `200` with KML: one `Placemark` per point. Its fields are in `ExtendedData`,
  as `<Data name="…"><value>…</value></Data>`:
  - `Time UTC`: US format `M/D/YYYY h:mm:ss AM/PM`, in UTC.
  - `Latitude`, `Longitude`: decimal degrees.
  - `Elevation` (`… m from MSL`), `Velocity` (`… km/h`), `Course`
    (`… ° True`): strip the unit before using the number.
  - `Valid GPS Fix` (`True` / `False`), `In Emergency`, `Event` (tracking,
    message…), `Text` (the message, if any), `Map Display Name`,
    `Device Type`.
- `200` with an EMPTY body: the map link name is wrong, MapShare is disabled,
  or nothing in the range is visible under the owner's MapShare settings. Say
  so; never invent a position.
- `401`: the MapShare password is missing or wrong. Do not retry and do not
  loop: stop and report that the Garmin MapShare connection must be fixed.

#### Reporting

- Always give the point's UTC time and its age ("il y a 2 h") with the
  position.
- Say when `Valid GPS Fix` is `False`: the position may be wrong.
- A position is only as fresh as the last tracking point. Tracking must be on
  in the device, and points come every 10 min (Standard plan) or 2 min
  (Premium). Never present it as live.
- Give a map link:
  `https://www.openstreetmap.org/?mlat=<lat>&mlon=<lon>#map=15/<lat>/<lon>`.

#### Limits

- This integration cannot locate the device on demand or send it a message.
- Messages sent in SOS mode are absent from the feed: never use it to assess
  an emergency.
- Do not poll more than once every few minutes.
