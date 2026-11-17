import { randomBytes } from "node:crypto";
import Docker, { type ContainerCreateOptions } from "dockerode";
import { describe, expect, it } from "vitest";
import type { MachineRecord, MachineStore } from "../db/machines.js";
import { userScope } from "../scope.js";
import { DockerDriver } from "./docker.js";
import { bridgeName } from "./policy.js";

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
    listAdmin() {
      return [];
    },
    findAdmin() {
      return undefined;
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

function fakeDocker(present: Set<string>, created: string[], network: {
  Driver: string;
  Options: Record<string, string>;
  Containers: Record<string, unknown>;
} = {
  Driver: "bridge",
  Options: { "com.docker.network.bridge.name": bridgeName("user-1") },
  Containers: {},
}, removed: string[] = [], optionsSeen: ContainerCreateOptions[] = []): Docker {
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
      return {
        id: name,
        inspect: async () => ({ Id: name, ...network }),
        remove: async () => { removed.push(name); },
      };
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
    createContainer: async (options: ContainerCreateOptions) => {
      optionsSeen.push(options);
      created.push("c-new");
      return { id: "c-new" };
    },
    createNetwork: async (options: { Name: string }) => ({ id: `${options.Name}-new` }),
    createVolume: async () => {},
  };
  return Object.assign(new Docker({ socketPath: "/var/run/docker.sock" }), docker);
}

describe("docker create recovery", () => {
  it("uses configured DNS for both creation and rebuild", async () => {
    const seen: ContainerCreateOptions[] = [];
    const docker = fakeDocker(new Set(), [], undefined, [], seen);
    const driver = new DockerDriver({ docker, image: "viate-bot/machine:m31a", key: randomBytes(32), dns: ["223.5.5.5", "1.1.1.1"] });
    const store = memory(machine(null));
    await driver.create(store, userScope("user-1"), spec);
    await driver.rebuild(store, userScope("user-1"), spec);
    expect(seen.map((options) => options.HostConfig?.Dns)).toEqual([["223.5.5.5", "1.1.1.1"], ["223.5.5.5", "1.1.1.1"]]);
  });

  it("replaces an empty legacy network before creating the machine", async () => {
    const created: string[] = [];
    const removed: string[] = [];
    const driver = new DockerDriver({
      docker: fakeDocker(new Set(), created, { Driver: "bridge", Options: {}, Containers: {} }, removed),
      image: "viate-bot/machine:dev",
      key: randomBytes(32),
    });
    const row = machine(null);
    await driver.create(memory(row), userScope("user-1"), spec);
    expect(row.networkId).toBe("vb-net-user-1-new");
    expect(removed).toEqual(["vb-net-user-1"]);
  });

  it("refuses an occupied legacy network without removing it or creating a machine", async () => {
    const created: string[] = [];
    const removed: string[] = [];
    const driver = new DockerDriver({
      docker: fakeDocker(new Set(), created, {
        Driver: "bridge", Options: {}, Containers: { control: {} },
      }, removed),
      image: "viate-bot/machine:dev",
      key: randomBytes(32),
    });
    await expect(driver.create(memory(machine(null)), userScope("user-1"), spec))
      .rejects.toThrow(/vb-net-user-1.*防火墙.*容器/);
    expect(removed).toEqual([]);
    expect(created).toEqual([]);
  });

  it("refuses to start a machine on an occupied legacy network", async () => {
    const driver = new DockerDriver({
      docker: fakeDocker(new Set(["vb-machine-user-1"]), [], {
        Driver: "bridge", Options: {}, Containers: { machine: {} },
      }),
      image: "viate-bot/machine:dev",
      key: randomBytes(32),
    });
    await expect(driver.start("user-1")).rejects.toThrow(/防火墙/);
  });

  it("requires rebuild when a stopped legacy machine has no live network endpoints", async () => {
    const removed: string[] = [];
    const driver = new DockerDriver({
      docker: fakeDocker(new Set(["vb-machine-user-1"]), [], {
        Driver: "bridge", Options: {}, Containers: {},
      }, removed),
      image: "viate-bot/machine:dev",
      key: randomBytes(32),
    });
    await expect(driver.start("user-1")).rejects.toThrow(/重建机器/);
    expect(removed).toEqual([]);
  });

  it("stops a running legacy machine rather than reporting it healthy during reconciliation", async () => {
    const docker = fakeDocker(new Set(["vb-machine-user-1"]), [], {
      Driver: "bridge", Options: {}, Containers: { machine: {} },
    });
    let stopped = false;
    const container = docker.getContainer("vb-machine-user-1");
    container.stop = async () => { stopped = true; };
    docker.getContainer = () => container;
    const driver = new DockerDriver({ docker, image: "viate-bot/machine:dev", key: randomBytes(32) });
    await expect(driver.actualState("user-1")).rejects.toThrow(/防火墙/);
    expect(stopped).toBe(true);
  });

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
