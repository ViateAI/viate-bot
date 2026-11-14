import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { describe, expect, it } from "vitest";
import type { MachineRecord, MachineStore } from "../db/machines.js";
import { userScope } from "../scope.js";
import { DockerDriver } from "./docker.js";

const spec = { cpu: 1, memMb: 1024, diskGb: 10 };

function machine(containerId: string | null): MachineRecord {
  return {
    id: "machine-1",
    userId: "user-1",
    state: "running",
    containerId,
    networkId: "vb-net-user-1",
    volumeName: "vb-home-user-1",
    imageVersion: "viate-bot/machine:dev",
    spec,
    tokenEnc: "enc",
  };
}

function memory(row: MachineRecord): MachineStore {
  const rows = [row];
  return {
    find(scope) {
      return rows.find((item) => item.userId === scope.userId);
    },
    findById(scope, id) {
      return rows.find((item) => item.userId === scope.userId && item.id === id);
    },
    insert(scope, created) {
      if (created.userId !== scope.userId) throw new Error("不能把机器写到别的用户名下");
      rows.push(created);
    },
    update(scope, patch) {
      const current = rows.find((item) => item.userId === scope.userId);
      if (!current) return false;
      if (patch.state !== undefined) current.state = patch.state;
      if (patch.containerId !== undefined) current.containerId = patch.containerId;
      if (patch.networkId !== undefined) current.networkId = patch.networkId;
      if (patch.volumeName !== undefined) current.volumeName = patch.volumeName;
      if (patch.imageVersion !== undefined) current.imageVersion = patch.imageVersion;
      if (patch.spec !== undefined) current.spec = patch.spec;
      if (patch.tokenEnc !== undefined) current.tokenEnc = patch.tokenEnc;
      return true;
    },
    updateById() {
      return false;
    },
    list() {
      return [];
    },
    findOwned() {
      return undefined;
    },
    updateOwned() {
      return false;
    },
  };
}

function missing(): Error {
  return Object.assign(new Error("not found"), { statusCode: 404 });
}

function fakeDocker(present: Set<string>, created: string[]): Docker {
  const docker = {
    getContainer(name: string) {
      return {
        inspect: async () => {
          if (!present.has(name)) throw missing();
          return { Id: name, State: { Running: true }, NetworkSettings: { Networks: {} } };
        },
        remove: async () => {
          if (!present.has(name)) throw missing();
          present.delete(name);
        },
        start: async () => {},
        stop: async () => {},
      };
    },
    getNetwork(name: string) {
      return { id: name, inspect: async () => ({ Id: name }) };
    },
    getVolume(name: string) {
      return {
        inspect: async () => ({
          Name: name,
          Driver: "local",
          Options: null,
          Mountpoint: "",
          Labels: {},
          Scope: "local" as const,
        }),
      };
    },
    createContainer: async () => {
      created.push("c-new");
      return { id: "c-new" };
    },
    createNetwork: async (options: { Name: string }) => ({ id: options.Name }),
    createVolume: async () => {},
  };
  return Object.assign(new Docker({ socketPath: "/var/run/docker.sock" }), docker);
}

describe("docker create recovery", () => {
  it("refuses to create while the named container still exists", async () => {
    const created: string[] = [];
    const driver = new DockerDriver({
      docker: fakeDocker(new Set(["vb-machine-user-1"]), created),
      image: "viate-bot/machine:dev",
      key: randomBytes(32),
    });
    const row = machine("old-container");
    await expect(driver.create(memory(row), userScope("user-1"), spec)).rejects.toThrow(/已经有一台机器/);
    expect(created).toEqual([]);
    expect(row.containerId).toBe("old-container");
  });

  it("recreates when the database still points at a missing container", async () => {
    const created: string[] = [];
    const driver = new DockerDriver({
      docker: fakeDocker(new Set(), created),
      image: "viate-bot/machine:dev",
      key: randomBytes(32),
    });
    const row = machine("old-container");
    const createdRecord = await driver.create(memory(row), userScope("user-1"), spec);
    expect(created).toEqual(["c-new"]);
    expect(row.containerId).toBe("c-new");
    expect(row.id).toBe("machine-1");
    expect(createdRecord.containerId).toBe("c-new");
    expect(row.state).toBe("running");
  });
});
