export function getVersionRedirect(params: {
  type: string;
  packageId: string;
  versionParam: string | undefined;
  versionDetail: { version: string } | undefined;
  liveVersion: string | null | undefined;
}): { redirect: string } | { isHistoricalVersion: boolean } {
  const { type, packageId, versionParam, versionDetail, liveVersion } = params;
  const basePath = type === "flow" ? `/flows/${packageId}` : `/${type}s/${packageId}`;

  if (versionParam && !versionDetail) {
    return { redirect: basePath };
  }

  const isHistoricalVersion =
    !!versionParam && !!versionDetail && versionDetail.version !== liveVersion;
  return { isHistoricalVersion };
}
