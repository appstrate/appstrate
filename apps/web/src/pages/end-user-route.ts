// SPDX-License-Identifier: Apache-2.0

interface LocationParts {
  pathname: string;
  search: string;
  hash: string;
}

function href(location: LocationParts, params: URLSearchParams): string {
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}

/** Preserve the rest of the page URL while opening one addressable user panel. */
export function endUserHref(location: LocationParts, id: string, edit = false): string {
  const params = new URLSearchParams(location.search);
  params.set("user", id);
  if (edit) params.set("edit", "1");
  else params.delete("edit");
  return href(location, params);
}

/** Closing replaces the panel URL with the same page URL, minus its two keys. */
export function endUsersHref(location: LocationParts): string {
  const params = new URLSearchParams(location.search);
  params.delete("user");
  params.delete("edit");
  return href(location, params);
}
