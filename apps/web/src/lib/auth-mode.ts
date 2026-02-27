const AUTH_MODE_I18N: Record<string, string> = {
  oauth2: "providers.authMode.oauth2",
  oauth1: "providers.authMode.oauth1",
  api_key: "providers.authMode.apiKey",
  basic: "providers.authMode.basic",
  custom: "providers.authMode.custom",
  proxy: "providers.authMode.proxy",
};

/** Return the i18n key for a given authMode (settings namespace). */
export function authModeI18nKey(authMode: string): string {
  return AUTH_MODE_I18N[authMode] ?? authMode;
}
