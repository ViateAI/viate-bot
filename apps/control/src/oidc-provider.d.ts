declare module "oidc-provider" {
  import type { IncomingMessage, Server, ServerResponse } from "node:http";

  interface InteractionDetails {
    params: Record<string, string | undefined>;
  }

  interface Grant {
    addOIDCScope(scope: string): void;
    save(): Promise<string>;
  }

  interface ProviderContext {
    path: string;
    req: IncomingMessage;
    res: ServerResponse;
  }

  class Provider {
    constructor(issuer: string, configuration: object);
    listen(port: number, hostname?: string): Server;
    use(middleware: (ctx: ProviderContext, next: () => Promise<void>) => Promise<void>): void;
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<InteractionDetails>;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: { login: { accountId: string }; consent: { grantId: string } },
    ): Promise<void>;
    Grant: new (properties: { accountId: string; clientId: string }) => Grant;
  }

  export default Provider;
}
