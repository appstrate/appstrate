// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import type { PubSub } from "./interface.ts";

/**
 * In-memory Pub/Sub using EventEmitter.
 * Sufficient for single-instance deployments — messages stay within the process.
 */
export class LocalPubSub implements PubSub {
  private emitter = new EventEmitter();

  async publish(channel: string, message: string): Promise<void> {
    this.emitter.emit(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.emitter.on(channel, handler);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.emitter.removeAllListeners(channel);
  }

  async shutdown(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}
