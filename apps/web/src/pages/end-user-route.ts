// SPDX-License-Identifier: Apache-2.0

interface LocationParts {
  pathname: string;
  search: string;
  hash: string;
}

export type EndUserEditReturn = "list" | "detail";

const EDIT_RETURN_KEY = "endUserEditReturn";

/** Remember whether Edit was entered from the table deed or the detail panel. */
export function withEndUserEditReturn(
  state: unknown,
  destination: EndUserEditReturn,
): Record<string, unknown> {
  const previous = state && typeof state === "object" ? state : {};
  return { ...previous, [EDIT_RETURN_KEY]: destination };
}

/** Direct and bookmarked edit URLs fall back to the list, never to a surprise detail. */
export function endUserEditReturn(state: unknown): EndUserEditReturn {
  if (
    state &&
    typeof state === "object" &&
    EDIT_RETURN_KEY in state &&
    state[EDIT_RETURN_KEY as keyof typeof state] === "detail"
  ) {
    return "detail";
  }
  return "list";
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
