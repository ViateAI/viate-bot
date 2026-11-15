import type { ContainerCreateOptions, NetworkCreateOptions } from "dockerode";
import { describe, expect, it } from "vitest";
import {
  assertMachinePolicy,
  assertNetworkPolicy,
  assertVolumePolicy,
  bridgeName,
  buildCreateOptions,
  buildNetworkOptions,
  MachinePolicyError,
} from "./policy.js";

const input = {
  userId: "user-1",
  machineId: "machine-1",
  image: "viate-bot/machine:dev",
  token: "token",
  spec: { cpu: 1, memMb: 2048, diskGb: 20 },
};

function patched(change: (options: ContainerCreateOptions) => void): ContainerCreateOptions {
  const options = buildCreateOptions(input);
  change(options);
  return options;
}

describe("machine create policy", () => {
  it("accepts the documented container shape", () => {
    const options = buildCreateOptions(input);
    expect(options.HostConfig?.NetworkMode).toBe("vb-net-user-1");
    expect(options.HostConfig?.Mounts).toEqual([
      { Type: "volume", Source: "vb-home-user-1", Target: "/home/bot" },
    ]);
    expect(options.HostConfig?.CapDrop).toEqual(["ALL"]);
    expect(options.Env?.some((item) => item.startsWith("VB_CONTROL_URL="))).toBe(false);
    expect(options.User).toBeUndefined();
    expect(() => assertMachinePolicy(input.userId, options)).not.toThrow();
  });

  it("accepts an empty security opt and a subset of capabilities", () => {
    const options = patched((current) => {
      current.HostConfig!.SecurityOpt = [];
      current.HostConfig!.CapAdd = ["CHOWN", "FOWNER"];
    });
    expect(() => assertMachinePolicy(input.userId, options)).not.toThrow();
  });

  it.each([
    ["bind mount", (options: ContainerCreateOptions) => {
      options.HostConfig!.Binds = ["/var/run/docker.sock:/var/run/docker.sock"];
    }],
    ["non-volume mount", (options: ContainerCreateOptions) => {
      options.HostConfig!.Mounts = [{ Type: "bind", Source: "/etc", Target: "/etc" }];
    }],
    ["extra volume", (options: ContainerCreateOptions) => {
      options.HostConfig!.Mounts = [
        { Type: "volume", Source: "vb-home-user-1", Target: "/home/bot" },
        { Type: "volume", Source: "other", Target: "/opt" },
      ];
    }],
    ["wrong volume source", (options: ContainerCreateOptions) => {
      options.HostConfig!.Mounts = [{ Type: "volume", Source: "other", Target: "/home/bot" }];
    }],
    ["volume driver config bind", (options: ContainerCreateOptions) => {
      options.HostConfig!.Mounts = [
        {
          Type: "volume",
          Source: "vb-home-user-1",
          Target: "/home/bot",
          VolumeOptions: {
            NoCopy: false,
            Labels: {},
            DriverConfig: { Name: "local", Options: { type: "none", o: "bind", device: "/etc" } },
          },
        },
      ];
    }],
    ["anonymous volume", (options: ContainerCreateOptions) => {
      options.Volumes = { "/etc": {} };
    }],
    ["volumes from", (options: ContainerCreateOptions) => {
      options.HostConfig!.VolumesFrom = ["other"];
    }],
    ["privileged", (options: ContainerCreateOptions) => {
      options.HostConfig!.Privileged = true;
    }],
    ["device", (options: ContainerCreateOptions) => {
      options.HostConfig!.Devices = [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/sda", CgroupPermissions: "rwm" }];
    }],
    ["device request", (options: ContainerCreateOptions) => {
      options.HostConfig!.DeviceRequests = [{ Count: -1, Capabilities: [["gpu"]] }];
    }],
    ["device cgroup rule", (options: ContainerCreateOptions) => {
      options.HostConfig!.DeviceCgroupRules = ["c 1:1 rwm"];
    }],
    ["sys admin cap", (options: ContainerCreateOptions) => {
      options.HostConfig!.CapAdd = ["CHOWN", "SYS_ADMIN"];
    }],
    ["cap drop without ALL", (options: ContainerCreateOptions) => {
      options.HostConfig!.CapDrop = ["NET_RAW"];
    }],
    ["host network", (options: ContainerCreateOptions) => {
      options.HostConfig!.NetworkMode = "host";
    }],
    ["container network", (options: ContainerCreateOptions) => {
      options.HostConfig!.NetworkMode = "container:other";
    }],
    ["host pid", (options: ContainerCreateOptions) => {
      options.HostConfig!.PidMode = "host";
    }],
    ["container pid", (options: ContainerCreateOptions) => {
      options.HostConfig!.PidMode = "container:other";
    }],
    ["host ipc", (options: ContainerCreateOptions) => {
      options.HostConfig!.IpcMode = "host";
    }],
    ["container ipc", (options: ContainerCreateOptions) => {
      options.HostConfig!.IpcMode = "container:other";
    }],
    ["host uts", (options: ContainerCreateOptions) => {
      options.HostConfig!.UTSMode = "host";
    }],
    ["host user namespace", (options: ContainerCreateOptions) => {
      options.HostConfig!.UsernsMode = "host";
    }],
    ["container user namespace", (options: ContainerCreateOptions) => {
      options.HostConfig!.UsernsMode = "container:other";
    }],
    ["host cgroup namespace", (options: ContainerCreateOptions) => {
      (options.HostConfig as { CgroupnsMode?: string }).CgroupnsMode = "host";
    }],
    ["container cgroup namespace", (options: ContainerCreateOptions) => {
      (options.HostConfig as { CgroupnsMode?: string }).CgroupnsMode = "container:other";
    }],
    ["unconfined seccomp", (options: ContainerCreateOptions) => {
      options.HostConfig!.SecurityOpt = ["seccomp=unconfined"];
    }],
    ["unconfined apparmor", (options: ContainerCreateOptions) => {
      options.HostConfig!.SecurityOpt = ["apparmor=unconfined"];
    }],
    ["extra security opt", (options: ContainerCreateOptions) => {
      options.HostConfig!.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"];
    }],
  ])("rejects %s", (_name, change) => {
    expect(() => assertMachinePolicy(input.userId, patched(change))).toThrow(MachinePolicyError);
  });
});

describe("user network policy", () => {
  it("pins a 14-character bridge name derived from the user id", () => {
    const options = buildNetworkOptions(input.userId);
    const bridge = bridgeName(input.userId);
    expect(bridge).toMatch(/^vb[0-9a-f]{12}$/);
    expect(bridge.length).toBeLessThanOrEqual(15);
    expect(options).toEqual({
      Name: "vb-net-user-1",
      Driver: "bridge",
      Options: { "com.docker.network.bridge.name": bridge },
      Labels: { "vb.user": "user-1" },
    });
    expect(() => assertNetworkPolicy(input.userId, options)).not.toThrow();
  });

  it("uses a different bridge for a different user", () => {
    expect(bridgeName("user-1")).not.toBe(bridgeName("user-2"));
  });

  it.each([
    ["icc disabled", (options: NetworkCreateOptions) => {
      options.Options = { ...options.Options, "com.docker.network.bridge.enable_icc": "true" };
    }],
    ["masquerade disabled", (options: NetworkCreateOptions) => {
      options.Options = { ...options.Options, "com.docker.network.bridge.enable_ip_masquerade": "false" };
    }],
    ["renamed bridge", (options: NetworkCreateOptions) => {
      options.Options = { "com.docker.network.bridge.name": "br-other" };
    }],
    ["missing bridge name", (options: NetworkCreateOptions) => {
      options.Options = {};
    }],
    ["host driver", (options: NetworkCreateOptions) => {
      options.Driver = "host";
    }],
    ["custom ipam", (options: NetworkCreateOptions) => {
      options.IPAM = { Config: [{ Subnet: "10.1.0.0/16", Gateway: "10.1.0.1" }] };
    }],
    ["internal", (options: NetworkCreateOptions) => {
      options.Internal = true;
    }],
    ["ipv6", (options: NetworkCreateOptions) => {
      options.EnableIPv6 = true;
    }],
  ])("rejects %s", (_name, change) => {
    const options = buildNetworkOptions(input.userId);
    change(options);
    expect(() => assertNetworkPolicy(input.userId, options)).toThrow(MachinePolicyError);
  });
});

describe("volume create policy", () => {
  it("accepts the local driver without options", () => {
    expect(() => assertVolumePolicy({ Name: "vb-home-user-1", Driver: "local" })).not.toThrow();
    expect(() => assertVolumePolicy({ Name: "vb-home-user-1" })).not.toThrow();
  });

  it("rejects a non-local driver", () => {
    expect(() => assertVolumePolicy({ Driver: "nfs" })).toThrow(MachinePolicyError);
  });

  it("rejects driver options that can bind a host directory", () => {
    expect(() =>
      assertVolumePolicy({
        Driver: "local",
        DriverOpts: { type: "none", o: "bind", device: "/etc" },
      }),
    ).toThrow(/DriverOpts/);
  });
});
