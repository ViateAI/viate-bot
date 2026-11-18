declare module "oidc-provider" {
  class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    use(fn: (ctx: { path: string; query: Record<string, string | undefined>; req: unknown; res: unknown; body?: unknown }, next: () => Promise<void>) => Promise<void>): void;
    listen(port: number, host: string): import("node:http").Server;
    interactionDetails(req: unknown, res: unknown): Promise<{ params: { client_id?: string; scope?: string } }>;
    interactionFinished(req: unknown, res: unknown, result: unknown): Promise<void>;
    Grant: new (input: { accountId: string; clientId: string }) => { addOIDCScope(scope: string): void; save(): Promise<string> };
  }
  export default Provider;
}
