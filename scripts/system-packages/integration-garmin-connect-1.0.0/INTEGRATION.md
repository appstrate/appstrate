Garmin Connect has no public API for individuals. This integration reads the API the Garmin
Connect mobile app uses, which is undocumented and may change: if a call returns something unlike
what is described here, report it, do not guess.

**Read only.** Use `GET` and nothing else. The token can also edit and delete the owner's activities
on the very paths below, and nothing here needs it. Paths outside the ones listed here are refused.

Every call goes to `https://connectapi.garmin.com` with `Accept: application/json` (except the file
downloads). The `Authorization` header is added for you; never set it. Times in responses come in
two forms: `…Local` (the activity's own time zone) and `…GMT` (UTC). Units, unless stated: distance
metres, duration seconds, speed metres per second, elevation metres.

#### Find activities

`GET /activitylist-service/activities/search/activities?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&start=0&limit=20`

Both dates are inclusive and read in the owner's local time. Without dates, the latest activities
come first. Page with `start` (offset) and `limit`. Each item has `activityId`, `activityName`,
`activityType.typeKey` (`running`, `hiking`, `walking`, `cycling`, …), `startTimeLocal`,
`startTimeGMT`, `timeZoneId`, `distance`, `duration`, `movingDuration`, `elapsedDuration`,
`elevationGain`, `elevationLoss`, `minElevation`, `maxElevation`, `averageHR`, `maxHR`, `calories`,
`steps`, `startLatitude`/`startLongitude`, `endLatitude`/`endLongitude`, `locationName`,
`hasPolyline`, `deviceId`.

#### Read one activity

- **Summary**: `GET /activity-service/activity/<activityId>`. The figures are under `summaryDTO`
  (adds `averageSpeed`, `maxSpeed`, `averageMovingSpeed`, `avgElevation`, `minHR`, `trainingEffect`,
  `anaerobicTrainingEffect`, `trainingEffectLabel`, `activityTrainingLoad`, cadence, power,
  respiration, `moderateIntensityMinutes`, `vigorousIntensityMinutes`, `waterEstimated`).
- **Laps**: `GET /activity-service/activity/<activityId>/splits` (`lapDTOs`).
- **Heart-rate zones**: `GET /activity-service/activity/<activityId>/hrTimeInZones` (seconds per zone).
- **Weather**: `GET /activity-service/activity/<activityId>/weather`, from the nearest weather station
  (`weatherStationDTO`, which may be far). `temp`, `apparentTemp` and `dewPoint` are in **°F**;
  `windSpeed` is probably mph (not stated by the API).

#### The dense track

`GET /activity-service/activity/<activityId>/details?maxChartSize=2000&maxPolylineSize=4000`

The response is large and is saved to a workspace file; read the file, do not request it again.
`metricDescriptors` maps each `metricsIndex` to a `key` and a `unit`; each row of
`activityDetailMetrics` is `{ "metrics": [...] }` in that index order, one row per sample (about one
per second, downsampled to `maxChartSize`). Keys seen: `directTimestamp` (epoch ms, UTC),
`directLatitude`, `directLongitude`, `directElevation`, `sumDistance`, `sumDuration`, `directSpeed`,
`directHeartRate`, `directRunCadence`, `directVerticalSpeed`, `directRespirationRate`, `directPower`,
and running dynamics. A value is `null` when the device did not record it. `geoPolylineDTO.polyline`
is the same track as points without altitude; use `directElevation` for altitude.

#### Files

Route both to a file with `responseMode.toFile` (for example `garmin/<activityId>.gpx`); never read
them inline.

- **GPX**: `GET /download-service/export/gpx/activity/<activityId>`. One `<trkpt>` per sample with
  `<ele>` and `<time>`, heart rate and cadence in `<extensions>`.
- **Original FIT**: `GET /download-service/files/activity/<activityId>`. A zip holding
  `<activityId>_ACTIVITY.fit`.

#### Profile

`GET /userprofile-service/socialProfile`: `displayName`, `fullName`, `userName`, `location`.

#### Errors

- `401`: the access token is renewed automatically and the call retried. A `401` that persists
  means the connection needs to be reconnected: say so, do not retry.
- `403`: Garmin may be refusing this client or network rather than the token. Report it.
- `429`: Garmin is throttling. Stop and report it; do not loop.
- `404` on an activity: it does not exist or is not the owner's.
- Any response may come back as a workspace-file pointer: read the file.
