import { createHash } from "node:crypto";
import type { ContainerCreateOptions, NetworkCreateOptions, VolumeCreateOptions } from "dockerode";

const ALLOWED_CAPS: Record<string, true> = {
  CHOWN: true,
  SETUID: true,
  SETGID: true,
  DAC_OVERRIDE: true,
  FOWNER: true,
};

export interface MachineSpec {
  cpu: number;
  memMb: number;
  diskGb: number;
}

export interface MachineCreateInput {
  userId: string;
  machineId: string;
  image: string;
  token: string;
  spec: MachineSpec;
  dns?: readonly string[];
}

export class MachinePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachinePolicyError";
  }
}

export function networkName(userId: string): string {
  return `vb-net-${userId}`;
}

/**
 * Linux 接口名最多 15 字符，而 userId 是 ULID（26 字符），网络名放不进接口名。
 * 用 userId 的 sha256 前 12 个十六进制字符，得到固定的 `vb` + 12 = 14 字符网桥名。
 * 防火墙按 `vb+` 前缀匹配；Docker 默认的 `br-<id>` 匹配不到。
 */
export function bridgeName(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 12);
  return `vb${digest}`;
}

/** 创建用户网络时使用。com.docker.network.bridge.name 让网桥名稳定，供防火墙按前缀匹配。 */
export function buildNetworkOptions(userId: string): NetworkCreateOptions {
  return {
    Name: networkName(userId),
    Driver: "bridge",
    Options: { "com.docker.network.bridge.name": bridgeName(userId) },
    Labels: { "vb.user": userId },
  };
}

/**
 * 只允许收紧：驱动必须是 bridge，网桥名必须是该用户的固定短名，其余选项不能改。
 * 不接受 IPAM、Internal、EnableIPv6 等会改变隔离边界的字段。
 */
export function assertNetworkPolicy(userId: string, options: NetworkCreateOptions): void {
  if (options.Name !== networkName(userId)) {
    throw new MachinePolicyError(`网络名必须是 ${networkName(userId)}`);
  }
  if (options.Driver !== undefined && options.Driver !== "bridge") {
    throw new MachinePolicyError("用户网络驱动必须是 bridge");
  }
  if (options.Internal === true) throw new MachinePolicyError("禁止 Internal 网络");
  if (options.EnableIPv6 === true) throw new MachinePolicyError("禁止 EnableIPv6");
  if (options.Attachable === true) throw new MachinePolicyError("禁止 Attachable");
  if (options.Ingress === true) throw new MachinePolicyError("禁止 Ingress");
  if (options.ConfigOnly === true) throw new MachinePolicyError("禁止 ConfigOnly");
  if (options.IPAM !== undefined) throw new MachinePolicyError("禁止自定义 IPAM");
  if (options.ConfigFrom !== undefined) throw new MachinePolicyError("禁止 ConfigFrom");
  const expected = bridgeName(userId);
  const bridge = options.Options?.["com.docker.network.bridge.name"];
  if (bridge !== expected) {
    throw new MachinePolicyError(`网桥名必须是 ${expected}`);
  }
  const optionsRecord = options.Options ?? {};
  for (const key of Object.keys(optionsRecord)) {
    if (key !== "com.docker.network.bridge.name") {
      throw new MachinePolicyError(`不允许的网络选项：${key}`);
    }
  }
}

export function volumeName(userId: string): string {
  return `vb-home-${userId}`;
}

export function containerName(userId: string): string {
  return `vb-machine-${userId}`;
}

type HostConfig = NonNullable<ContainerCreateOptions["HostConfig"]> & {
  CgroupnsMode?: string;
};

/** 第 6.4 节的硬性规则。只接受白名单里的容器形态，创建之前必须调用。 */
export function assertMachinePolicy(userId: string, options: ContainerCreateOptions, dns: readonly string[] = []): void {
  const host: HostConfig = options.HostConfig ?? {};
  if ((host.Dns !== undefined && !Array.isArray(host.Dns)) || (host.Dns?.length ?? 0) !== dns.length || dns.some((address, index) => host.Dns?.[index] !== address)) {
    throw new MachinePolicyError("DNS 必须等于 VB_MACHINE_DNS 配置");
  }
  const binds = stringList(host.Binds, "Binds");
  if (binds.length > 0) throw new MachinePolicyError("Binds 必须为空");
  if (options.Volumes && Object.keys(options.Volumes).length > 0) {
    throw new MachinePolicyError("禁止 Volumes");
  }
  if (host.VolumesFrom !== undefined && (!Array.isArray(host.VolumesFrom) || host.VolumesFrom.length > 0)) {
    throw new MachinePolicyError("禁止 VolumesFrom");
  }

  const mounts = host.Mounts ?? [];
  if (mounts.length !== 1) throw new MachinePolicyError("Mounts 必须恰好是一个 named volume");
  const mount = mounts[0];
  if (
    !mount ||
    mount.Type !== "volume" ||
    mount.Source !== volumeName(userId) ||
    mount.Target !== "/home/bot"
  ) {
    throw new MachinePolicyError("只允许把 vb-home-<userId> 挂到 /home/bot");
  }
  if (mount.VolumeOptions?.DriverConfig) {
    throw new MachinePolicyError("禁止用 VolumeOptions.DriverConfig 伪装挂载");
  }

  const dropped = stringList(host.CapDrop, "CapDrop");
  if (!dropped.includes("ALL")) throw new MachinePolicyError("CapDrop 必须包含 ALL");
  for (const cap of stringList(host.CapAdd, "CapAdd")) {
    if (ALLOWED_CAPS[cap] !== true) throw new MachinePolicyError(`不允许的 CapAdd：${cap}`);
  }

  assertEmpty(host.Devices, "Devices");
  assertEmpty(host.DeviceRequests, "DeviceRequests");
  assertEmpty(host.DeviceCgroupRules, "DeviceCgroupRules");
  if (host.Privileged !== undefined && host.Privileged !== false) {
    throw new MachinePolicyError("禁止 Privileged");
  }

  if (host.NetworkMode !== networkName(userId)) {
    throw new MachinePolicyError(`NetworkMode 必须是 ${networkName(userId)}`);
  }
  rejectSharedNamespace("PidMode", host.PidMode);
  rejectSharedNamespace("IpcMode", host.IpcMode);
  rejectSharedNamespace("UTSMode", host.UTSMode);
  rejectSharedNamespace("UsernsMode", host.UsernsMode);
  rejectSharedNamespace("CgroupnsMode", host.CgroupnsMode);

  const security = stringList(host.SecurityOpt, "SecurityOpt");
  if (security.length > 1 || (security.length === 1 && security[0] !== "no-new-privileges")) {
    throw new MachinePolicyError("SecurityOpt 只允许 no-new-privileges");
  }
}

/** 创建 named volume 时调用。local 驱动加上 DriverOpts 可以把宿主机目录伪装成 volume。 */
export function assertVolumePolicy(options: VolumeCreateOptions): void {
  const driver = options.Driver ?? "local";
  if (driver !== "local") throw new MachinePolicyError(`volume 驱动必须是 local，收到 ${driver}`);
  if (options.DriverOpts && Object.keys(options.DriverOpts).length > 0) {
    throw new MachinePolicyError("禁止 volume DriverOpts");
  }
}

export function buildCreateOptions(input: MachineCreateInput): ContainerCreateOptions {
  const options: ContainerCreateOptions = {
    name: containerName(input.userId),
    Image: input.image,
    Env: [`VB_MACHINED_TOKEN=${input.token}`, `VB_MACHINE_ID=${input.machineId}`, `VB_USER_ID=${input.userId}`],
    Labels: {
      "vb.user": input.userId,
      "vb.machine": input.machineId,
      "vb.image": input.image,
    },
    HostConfig: {
      ...(input.dns?.length ? { Dns: [...input.dns] } : {}),
      Binds: [],
      Mounts: [
        {
          Type: "volume",
          Source: volumeName(input.userId),
          Target: "/home/bot",
        },
      ],
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"],
      // no-new-privileges 对 setuid 二进制生效，不阻止 root 进程调用 setuid(2) 降权。
      // 引擎默认 seccomp 仍然生效。见 TECH-DESIGN 6.4 实现备注。
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: false,
      Tmpfs: {
        "/tmp": "rw,nosuid,nodev,size=512m",
        "/dev/shm": "rw,nosuid,nodev,size=1024m",
      },
      NanoCpus: Math.round(input.spec.cpu * 1_000_000_000),
      Memory: input.spec.memMb * 1024 * 1024,
      MemorySwap: input.spec.memMb * 1024 * 1024,
      PidsLimit: 1024,
      NetworkMode: networkName(input.userId),
      RestartPolicy: { Name: "unless-stopped" },
    },
  };
  assertMachinePolicy(input.userId, options, input.dns);
  return options;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MachinePolicyError(`${label} 必须是字符串列表`);
  }
  return value;
}

function assertEmpty(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value) && value.length === 0) return;
  throw new MachinePolicyError(`${label} 必须为空`);
}

function rejectSharedNamespace(label: string, value: string | undefined): void {
  if (value === undefined || value === "") return;
  if (value === "host" || value.startsWith("container:")) {
    throw new MachinePolicyError(`禁止 ${label}=${value}`);
  }
}
