// SPDX-License-Identifier: Apache-2.0

/** POSIX single-quote quoting: the only escape is closing, backslash-quoting, reopening. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** `value` as one shell word, quoted unless bash and zsh read it as is (zsh expands `=word`). */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9._@+:,/-]+$/.test(value) ? value : shellQuote(value);
}
