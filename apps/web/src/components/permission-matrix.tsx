// SPDX-License-Identifier: Apache-2.0

/**
 * A MATRIX of roles (columns) against rows of capabilities or permissions, in
 * groups. It keeps the raw table a matrix needs and scrolls, with the first
 * column pinned so a row stays readable wherever it scrolled to.
 *
 * The table takes the container's width and the first column what is left,
 * wrapping its labels; role columns are fixed. It only scrolls once the roles
 * outgrow the container. Sized to its content instead (`w-max`), the longest
 * label would refuse to wrap and push a role that fits out of view.
 */
import { Fragment, type ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { MATRIX_HEAD } from "../lib/matrix-head";

const LABEL_COLUMN = 224;
const ROLE_COLUMN = 96;

export function PermissionMatrix<Column extends string>({
  ariaLabel,
  firstHeader,
  columns,
  groups,
}: {
  ariaLabel: string;
  firstHeader: string;
  /** `dividerBefore` sets a column apart from the ones before it. */
  columns: { key: Column; label: string; dividerBefore?: boolean }[];
  /** A group with a `label` opens with a header row spanning the table. */
  groups: {
    label?: string;
    rows: { key: string; label: ReactNode; title?: string; cell: (column: Column) => ReactNode }[];
  }[];
}) {
  return (
    <div className="bg-card overflow-hidden rounded-lg border shadow-sm">
      <Table
        aria-label={ariaLabel}
        className="w-full"
        style={{ minWidth: LABEL_COLUMN + columns.length * ROLE_COLUMN }}
      >
        <TableHeader>
          <TableRow>
            <TableHead className={cn(MATRIX_HEAD, "bg-card sticky left-0 z-10")}>
              {firstHeader}
            </TableHead>
            {columns.map(({ key, label, dividerBefore }) => (
              <TableHead
                key={key}
                className={cn(
                  MATRIX_HEAD,
                  "w-24 text-center leading-tight whitespace-normal",
                  dividerBefore && "border-l",
                )}
              >
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map(({ label, rows }, index) => (
            <Fragment key={label ?? index}>
              {label && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columns.length + 1}
                    className="bg-muted/50 sticky left-0 py-1.5 text-xs font-semibold"
                  >
                    {label}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell
                    className="bg-card sticky left-0 z-10 text-sm whitespace-normal"
                    title={row.title}
                  >
                    {row.label}
                  </TableCell>
                  {columns.map(({ key, dividerBefore }) => (
                    <TableCell key={key} className={cn("text-center", dividerBefore && "border-l")}>
                      {row.cell(key)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
