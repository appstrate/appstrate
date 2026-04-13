// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only spy factory. Centralises the `NODE_ENV === "test"` guard so
 * production code cannot accidentally register a spy that observes tenant
 * traffic (e.g. outgoing mails, resolver hits).
 *
 * Usage:
 *   const smtpSpy = createTestSpy<SpiedSmtpSend>("_setSmtpSpy");
 *   export const _setSmtpSpy = smtpSpy.setter;
 *   smtpSpy.emit({ source, to, from, subject });
 */

export interface TestSpy<E> {
  /** Install or remove the spy. Throws outside `NODE_ENV=test`. */
  setter(fn: ((event: E) => void) | null): void;
  /** Emit an event to the installed spy, if any. No-op in production. */
  emit(event: E): void;
}

export function createTestSpy<E>(name: string): TestSpy<E> {
  let spy: ((event: E) => void) | null = null;
  return {
    setter(fn) {
      if (process.env.NODE_ENV !== "test") {
        throw new Error(`${name} is test-only`);
      }
      spy = fn;
    },
    emit(event) {
      if (spy) spy(event);
    },
  };
}
