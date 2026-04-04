// SPDX-License-Identifier: Apache-2.0

/**
 * Abstract Pub/Sub interface.
 * Implementations: Redis (multi-instance) and local EventEmitter (single-instance).
 */

export interface PubSub {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  shutdown(): Promise<void>;
}
