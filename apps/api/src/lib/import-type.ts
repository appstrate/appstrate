// SPDX-License-Identifier: Apache-2.0

/**
 * The package type an import is made FOR. Every import door (`/import`,
 * `/import-github`, `/import-bundle`) accepts any type by default; a caller
 * importing from one type's page names it with `?type=`, and the archive is
 * refused before anything is written when its (root) package is another type.
 */

import type { Context } from "hono";
import { packageTypeEnum, type PackageType } from "@appstrate/core/validation";
import { ApiError, invalidRequest } from "./errors.ts";

/** Read the optional `?type=` of an import route. */
export function readExpectedImportType(c: Context): PackageType | undefined {
  const raw = c.req.query("type");
  if (raw === undefined) return undefined;
  const parsed = packageTypeEnum.safeParse(raw);
  if (!parsed.success) throw invalidRequest(`Unknown package type '${raw}'`, "type");
  return parsed.data;
}

/** Refuse an archive whose package is not the type the caller imports for. */
export function assertImportedType(actual: unknown, expected: PackageType | undefined): void {
  if (expected === undefined || actual === expected) return;
  throw new ApiError({
    status: 400,
    code: "unexpected_package_type",
    title: "Unexpected Package Type",
    detail: `This archive holds a package of type '${String(actual)}', not '${expected}'`,
    param: "type",
    extensions: { actual_type: actual, expected_type: expected },
  });
}
