// SPDX-License-Identifier: Apache-2.0

/** Shell words for the commands the CLI prints for a human, or Claude, to run. */

/** POSIX single-quote quoting: the only escape is closing, backslash-quoting, reopening. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * `value` as one shell word: bare when no character in it is special to bash
 * or zsh anywhere in a word, {@link shellQuote}d otherwise. `=` and `%` stay
 * out of the bare set: zsh expands a leading `=word` to a command path.
 */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9._@+:,/-]+$/.test(value) ? value : shellQuote(value);
}
