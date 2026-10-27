// SPDX-License-Identifier: Apache-2.0

/**
 * What, beyond its pathname and hash, decides which editor a URL mounts: the
 * query parameters naming a settings section or a file, read into one key. A
 * modal's parameter is left out, since opening one keeps the editor under it.
 */
export type EditorPlace = (search: URLSearchParams) => string;

/** Whether navigating from `from` to `to` unmounts the editor `place` locates. */
export function leavesEditor(from: URL, to: URL, place: EditorPlace): boolean {
  return (
    from.pathname !== to.pathname ||
    from.hash !== to.hash ||
    place(from.searchParams) !== place(to.searchParams)
  );
}
