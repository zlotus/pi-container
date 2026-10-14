import { describe, expect, it } from "vitest";

import {
  canonicalIpv4Cidr,
  ControlToWorkerMessageSchema,
  intervalCovered,
  intervalToCidrs,
  Ipv4CidrSchema,
  mergeIntervals,
  parseIpv4CidrList,
  WorkerToControlMessageSchema,
} from "./index.js";

const requestId = "0d17d4a0-c25a-43fd-a2eb-3d9ca7c5976c";

describe("IPv4 CIDR handling", () => {
  it("normalizes addresses and CIDRs strictly", () => {
    expect(canonicalIpv4Cidr("192.168.1.1")).toBe("192.168.1.1/32");
    expect(canonicalIpv4Cidr("10.0.0.0/8")).toBe("10.0.0.0/8");
    for (const invalid of [
      "10.0.0.1/8", // host bits
      "010.0.0.0/8",
      "10.0.0/8",
      "256.0.0.0/8",
      "10.0.0.0/33",
      "10.0.0.0/08",
      "fd00::/8",
      " 10.0.0.0/8",
    ]) {
      expect(canonicalIpv4Cidr(invalid), invalid).toBeNull();
    }
    expect(Ipv4CidrSchema.safeParse("192.168.1.1").success).toBe(false);
    expect(Ipv4CidrSchema.safeParse("192.168.1.1/32").success).toBe(true);
  });

  it("merges, splits and covers intervals", () => {
    const merged = mergeIntervals([
      { start: 10, end: 20 },
      { start: 21, end: 30 },
      { start: 5, end: 12 },
      { start: 40, end: 50 },
    ]);
    expect(merged).toEqual([{ start: 5, end: 30 }, { start: 40, end: 50 }]);
    expect(intervalToCidrs({ start: 0x0a000001, end: 0x0a000006 }).map((cidr) => cidr.prefix))
      .toEqual([32, 31, 31, 32]);
    expect(intervalCovered({ start: 6, end: 29 }, merged)).toBe(true);
    expect(intervalCovered({ start: 29, end: 41 }, merged)).toBe(false);
  });

  it("parses configuration lists", () => {
    expect(parseIpv4CidrList(" 10.0.0.5 , 192.168.0.0/16,,10.0.0.5/32")).toEqual({
      ok: true,
      cidrs: ["10.0.0.5/32", "192.168.0.0/16"],
    });
    expect(parseIpv4CidrList("10.0.0.5,example.internal")).toEqual({
      ok: false,
      invalid: "example.internal",
    });
  });
});

describe("egress protocol messages", () => {
  it("accepts a typed policy and rejects malformed entries", () => {
    const message = (payload: unknown) =>
      ControlToWorkerMessageSchema.safeParse({
        version: 6,
        type: "worker.egress.apply",
        requestId,
        payload,
      });
    expect(
      message({
        revision: 3,
        allow: [
          { network: "192.168.1.1/32", protocol: "tcp", portMin: 80, portMax: 80 },
          { network: "10.0.0.0/8" },
        ],
        denyExtra: ["100.64.0.0/10"],
        protected: ["10.0.0.5/32"],
      }).success,
    ).toBe(true);
    for (const allow of [
      { network: "10.0.0.1/8" },
      { network: "10.0.0.0/8", portMin: 80, portMax: 80 },
      { network: "10.0.0.0/8", protocol: "tcp", portMin: 80 },
      { network: "10.0.0.0/8", protocol: "icmp" },
      { network: "10.0.0.0/8", protocol: "tcp", portMin: 90, portMax: 80 },
      { network: "10.0.0.0/8", extra: true },
    ]) {
      expect(
        message({ revision: 1, allow: [allow], denyExtra: [], protected: [] }).success,
        JSON.stringify(allow),
      ).toBe(false);
    }
    expect(message({ revision: -1, allow: [], denyExtra: [], protected: [] }).success).toBe(false);
  });

  it("requires the egress state in heartbeats", () => {
    const heartbeat = (payload: Record<string, unknown>) =>
      WorkerToControlMessageSchema.safeParse({
        version: 6,
        type: "worker.heartbeat",
        requestId,
        payload: {
          host: { cpuUtilization: null, memoryTotalBytes: 8, memoryAvailableBytes: 4, load1: 0 },
          workerId: "worker-01",
          allocatedWorkspaces: 0,
          storage: { enforced: true, fsType: "xfs", totalBytes: 10, freeBytes: 5 },
        modelRelay: { enabled: false, port: null, listening: false },
          observedAt: "2026-10-05T08:00:00.000Z",
          ...payload,
        },
      }).success;
    expect(heartbeat({ egress: { enforced: false, revision: null } })).toBe(true);
    expect(heartbeat({})).toBe(false);
    expect(heartbeat({ egress: { enforced: "yes", revision: null } })).toBe(false);
  });
});
