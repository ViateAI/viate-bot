import { BrowserClient, UserBrowserLock } from "@viate-bot/browser";
import type { MachineEndpoint } from "@viate-bot/protocol";

export interface BoundBrowser {
  botId: string;
  run<T>(action: (client: BrowserClient) => Promise<T>): Promise<T>;
}

/**
 * 每个用户一个 BrowserClient 和一把 UserBrowserLock。
 * 工具创建时绑定 userId 对应的机器，参数里不能换机器。
 */
export class BrowserPool {
  private readonly locks = new Map<string, UserBrowserLock>();
  private readonly clients = new Map<string, { client: BrowserClient; key: string }>();
  private readonly opening = new Map<string, Promise<BrowserClient>>();

  bind(userId: string, botId: string, endpoint: MachineEndpoint): BoundBrowser {
    return {
      botId,
      run: (action) => this.run(userId, endpoint, action),
    };
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((slot) => slot.client.close().catch(() => undefined)));
  }

  private lockFor(userId: string): UserBrowserLock {
    const existing = this.locks.get(userId);
    if (existing) return existing;
    const created = new UserBrowserLock();
    this.locks.set(userId, created);
    return created;
  }

  private async run<T>(userId: string, endpoint: MachineEndpoint, action: (client: BrowserClient) => Promise<T>): Promise<T> {
    const client = await this.connect(userId, endpoint);
    try {
      return await action(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (client.connected && !message.includes("CDP 连接已关闭")) throw error;
      this.drop(userId);
      const again = await this.connect(userId, endpoint);
      return action(again);
    }
  }

  private drop(userId: string): void {
    const slot = this.clients.get(userId);
    this.clients.delete(userId);
    if (slot) void slot.client.close().catch(() => undefined);
  }

  private connect(userId: string, endpoint: MachineEndpoint): Promise<BrowserClient> {
    const key = `${endpoint.host}:${endpoint.port}:${endpoint.token}`;
    const current = this.clients.get(userId);
    if (current && current.key === key && current.client.connected) return Promise.resolve(current.client);
    const pending = this.opening.get(userId);
    if (pending) return pending;
    const promise = this.open(userId, endpoint, key);
    this.opening.set(userId, promise);
    return promise.finally(() => {
      if (this.opening.get(userId) === promise) this.opening.delete(userId);
    });
  }

  private async open(userId: string, endpoint: MachineEndpoint, key: string): Promise<BrowserClient> {
    this.drop(userId);
    const deadline = Date.now() + 30_000;
    let last = "浏览器连接失败";
    while (Date.now() < deadline) {
      try {
        const client = await BrowserClient.connect(`ws://${endpoint.host}:${endpoint.port}/browser/cdp`, {
          headers: { authorization: `Bearer ${endpoint.token}` },
          lock: this.lockFor(userId),
        });
        this.clients.set(userId, { client, key });
        return client;
      } catch (error) {
        last = error instanceof Error ? error.message : last;
        if (last.includes("401") || last.includes("403")) throw error;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 400);
        await promise;
      }
    }
    throw new Error(last);
  }
}

