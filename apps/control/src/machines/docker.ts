import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import type { Container, Network } from "dockerode";
import { encrypt } from "../crypto.js";
import type { MachineRecord, MachineStore } from "../db/machines.js";
import type { UserScope } from "../scope.js";
import {
  assertMachinePolicy,
  assertNetworkPolicy,
  assertVolumePolicy,
  buildCreateOptions,
  buildNetworkOptions,
  containerName,
  networkName,
  volumeName,
  MachinePolicyError,
  type MachineCreateInput,
  type MachineSpec,
} from "./policy.js";

export interface DockerDriverOptions {
  docker?: Docker;
  image: string;
  key: Buffer;
  now?: () => Date;
}

export class DockerDriver {
  readonly docker: Docker;
  private readonly image: string;
  private readonly key: Buffer;

  constructor(options: DockerDriverOptions) {
    this.docker = options.docker ?? new Docker({ socketPath: "/var/run/docker.sock" });
    this.image = options.image;
    this.key = options.key;
  }

  async create(store: MachineStore, scope: UserScope, spec: MachineSpec): Promise<MachineRecord> {
    return this.insertMachine(store, scope, spec, this.image);
  }

  private async insertMachine(store: MachineStore, scope: UserScope, spec: MachineSpec, image: string): Promise<MachineRecord> {
    const userId = scope.userId;
    const existing = store.find(scope);
    // 数据库里留下的 containerId 可能指向已经消失的容器。容器还在才拒绝，消失了就原地重建。
    if (existing && existing.state !== "deleted" && (await this.actualState(userId)) !== "missing") {
      throw new Error(`用户 ${userId} 已经有一台机器`);
    }
    const machineId = existing?.id ?? randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const network = await this.ensureNetwork(userId);
    await this.ensureVolume(userId);
    const input: MachineCreateInput = {
      userId,
      machineId,
      image,
      token,
      spec,
    };
    const options = buildCreateOptions(input);
    assertMachinePolicy(userId, options);
    await this.removeContainerIfPresent(containerName(userId));
    const container = await this.docker.createContainer(options);
    const record: MachineRecord = {
      id: machineId,
      userId,
      state: existing?.state === "running" ? "running" : "stopped",
      containerId: container.id,
      networkId: network.id,
      volumeName: volumeName(userId),
      imageVersion: image,
      spec,
      tokenEnc: encrypt(this.key, token),
    };
    if (existing) store.update(scope, record);
    else store.insert(scope, record);
    return record;
  }

  async start(userId: string): Promise<void> {
    await this.ensureNetwork(userId, false);
    await this.container(userId).start();
  }

  async stop(userId: string, timeoutSec = 10): Promise<void> {
    const container = this.container(userId);
    try {
      await container.stop({ t: timeoutSec });
    } catch (error) {
      const stopped =
        statusCode(error) === 304 || (error instanceof Error && /is not running/i.test(error.message));
      if (!stopped) throw error;
    }
  }

  async rebuild(store: MachineStore, scope: UserScope, spec: MachineSpec, image = this.image): Promise<MachineRecord> {
    const current = this.requireRecord(store, scope);
    await this.removeContainerIfPresent(containerName(scope.userId));
    store.update(scope, { containerId: null, state: current.state === "running" ? "running" : "stopped" });
    const created = await this.insertMachine(store, scope, spec, image);
    if (current.state === "running") await this.start(scope.userId);
    return store.find(scope) ?? created;
  }

  async delete(store: MachineStore, scope: UserScope): Promise<void> {
    await this.removeContainerIfPresent(containerName(scope.userId));
    const network = this.docker.getNetwork(networkName(scope.userId));
    try {
      await network.remove();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    store.update(scope, { state: "deleted", containerId: null, networkId: null });
  }

  async inspect(userId: string): Promise<Docker.ContainerInspectInfo | null> {
    try {
      return await this.container(userId).inspect();
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async stats(userId: string): Promise<Docker.ContainerStats> {
    return this.container(userId).stats({ stream: false });
  }

  async actualState(userId: string): Promise<"missing" | "stopped" | "running"> {
    const info = await this.inspect(userId);
    if (!info) return "missing";
    if (info.State.Running) {
      try {
        await this.ensureNetwork(userId, false);
      } catch (error) {
        if (error instanceof MachinePolicyError) await this.stop(userId, 0);
        throw error;
      }
    }
    return info.State.Running ? "running" : "stopped";
  }

  private container(userId: string): Container {
    return this.docker.getContainer(containerName(userId));
  }

  private requireRecord(store: MachineStore, scope: UserScope): MachineRecord {
    const record = store.find(scope);
    if (!record || record.state === "deleted") throw new Error(`用户 ${scope.userId} 没有机器`);
    return record;
  }

  private async ensureNetwork(userId: string, replaceUnsafe = true): Promise<Network> {
    const name = networkName(userId);
    const existing = this.docker.getNetwork(name);
    try {
      const info = await existing.inspect();
      try {
        // inspect 的 IPAM 是 Docker 自动分配结果，不是调用者传入的自定义配置。
        assertNetworkPolicy(userId, {
          Name: name,
          Driver: info.Driver,
          Options: info.Options,
          Internal: info.Internal,
          EnableIPv6: info.EnableIPv6,
        });
        return existing;
      } catch (error) {
        if (!(error instanceof MachinePolicyError)) throw error;
        // 停机容器虽没有活动端点，仍保存 NetworkID；只能在重建容器后更换网络。
        if (!replaceUnsafe) {
          throw new MachinePolicyError(`网络 ${name} 不符合防火墙策略；已有容器仍可能引用旧网络 ID，请重建机器`);
        }
        if (Object.keys(info.Containers ?? {}).length !== 0) {
          throw new MachinePolicyError(`网络 ${name} 不符合防火墙策略，仍有容器连接；请先停止并断开容器，再重建网络`);
        }
        // Docker 在 remove 时也会拒绝新增端点；不强制断开任何现存容器。
        await existing.remove();
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!replaceUnsafe) throw new MachinePolicyError(`网络 ${name} 不存在，请重建机器`);
    const options = buildNetworkOptions(userId);
    assertNetworkPolicy(userId, options);
    return this.docker.createNetwork(options);
  }

  private async ensureVolume(userId: string): Promise<void> {
    const name = volumeName(userId);
    const created = { Name: name, Driver: "local", Labels: { "vb.user": userId } };
    assertVolumePolicy(created);
    try {
      const info = await this.docker.getVolume(name).inspect();
      assertVolumePolicy({ Driver: info.Driver, DriverOpts: info.Options ?? undefined });
      return;
    } catch (error) {
      if (error instanceof MachinePolicyError) throw error;
      if (!isMissing(error)) throw error;
    }
    await this.docker.createVolume(created);
  }

  private async removeContainerIfPresent(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    try {
      await container.remove({ force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return statusCode(error) === 404;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const status = error.statusCode;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}
