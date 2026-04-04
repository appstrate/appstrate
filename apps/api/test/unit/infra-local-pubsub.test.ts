// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { LocalPubSub } from "../../src/infra/pubsub/local-pubsub.ts";

let pubsub: LocalPubSub;

afterEach(async () => {
  await pubsub?.shutdown();
});

describe("LocalPubSub", () => {
  it("delivers messages to subscribers", async () => {
    pubsub = new LocalPubSub();
    const received: string[] = [];

    await pubsub.subscribe("ch1", (msg) => received.push(msg));
    await pubsub.publish("ch1", "hello");
    await pubsub.publish("ch1", "world");

    expect(received).toEqual(["hello", "world"]);
  });

  it("does not deliver to unsubscribed channels", async () => {
    pubsub = new LocalPubSub();
    const received: string[] = [];

    await pubsub.subscribe("ch1", (msg) => received.push(msg));
    await pubsub.publish("other-channel", "should-not-appear");

    expect(received).toEqual([]);
  });

  it("unsubscribe stops delivery", async () => {
    pubsub = new LocalPubSub();
    const received: string[] = [];

    await pubsub.subscribe("ch1", (msg) => received.push(msg));
    await pubsub.publish("ch1", "before");
    await pubsub.unsubscribe("ch1");
    await pubsub.publish("ch1", "after");

    expect(received).toEqual(["before"]);
  });

  it("supports multiple channels independently", async () => {
    pubsub = new LocalPubSub();
    const ch1: string[] = [];
    const ch2: string[] = [];

    await pubsub.subscribe("ch1", (msg) => ch1.push(msg));
    await pubsub.subscribe("ch2", (msg) => ch2.push(msg));

    await pubsub.publish("ch1", "a");
    await pubsub.publish("ch2", "b");

    expect(ch1).toEqual(["a"]);
    expect(ch2).toEqual(["b"]);
  });

  it("shutdown removes all listeners", async () => {
    pubsub = new LocalPubSub();
    const received: string[] = [];

    await pubsub.subscribe("ch1", (msg) => received.push(msg));
    await pubsub.shutdown();
    await pubsub.publish("ch1", "post-shutdown");

    expect(received).toEqual([]);
  });
});
