// SPDX-License-Identifier: Apache-2.0

import { getRedisConnection, getRedisSubscriber } from "../../lib/redis.ts";
import { logger } from "../../lib/logger.ts";
import type { PubSub } from "./interface.ts";

export class RedisPubSub implements PubSub {
  private handlers = new Map<string, (message: string) => void>();
  private listening = false;

  async publish(channel: string, message: string): Promise<void> {
    await getRedisConnection().publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.handlers.set(channel, handler);
    const subscriber = getRedisSubscriber();

    if (!this.listening) {
      subscriber.on("message", (ch, msg) => {
        const h = this.handlers.get(ch);
        if (h) h(msg);
      });
      this.listening = true;
    }

    await new Promise<void>((resolve, reject) => {
      subscriber.subscribe(channel, (err) => {
        if (err) {
          logger.error("Failed to subscribe to channel", { channel, error: err.message });
          reject(err);
        } else {
          logger.info("Subscribed to channel", { channel });
          resolve();
        }
      });
    });
  }

  async unsubscribe(channel: string): Promise<void> {
    this.handlers.delete(channel);
    try {
      await getRedisSubscriber().unsubscribe(channel);
      logger.info("Unsubscribed from channel", { channel });
    } catch (err) {
      logger.warn("Error unsubscribing from channel", {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async shutdown(): Promise<void> {
    const channels = [...this.handlers.keys()];
    for (const channel of channels) {
      await this.unsubscribe(channel);
    }
  }
}
