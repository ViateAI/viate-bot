import * as client from "openid-client";
import type { ExternalIdentity, IdentityProvider, OidcTransaction } from "./providers.js";

export interface OidcProviderOptions {
  id: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

export class OidcIdentityProvider implements IdentityProvider {
  readonly id: string;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private pending: Promise<client.Configuration> | undefined;

  constructor(options: OidcProviderOptions) {
    this.id = options.id;
    this.issuer = options.issuer;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetch;
  }

  async authorizeUrl(transaction: OidcTransaction, redirectUri: string): Promise<URL> {
    const config = await this.configuration();
    return client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid email profile",
      code_challenge: transaction.codeChallenge,
      code_challenge_method: "S256",
      state: transaction.state,
      nonce: transaction.nonce,
    });
  }

  async handleCallback(
    callbackUrl: URL,
    transaction: OidcTransaction,
  ): Promise<{ identity: ExternalIdentity; refreshToken: string }> {
    const config = await this.configuration();
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("身份提供方没有返回 id_token");
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) throw new Error("身份提供方没有返回 refresh_token");
    const identity = await this.identityWithUserInfo(config, tokens.access_token, claims);
    return { identity, refreshToken };
  }

  async refresh(
    refreshToken: string,
  ): Promise<{ identity: ExternalIdentity | null; refreshToken: string } | "revoked"> {
    try {
      const config = await this.configuration();
      const tokens = await client.refreshTokenGrant(config, refreshToken);
      const claims = tokens.claims();
      // 省略的 email / email_verified 不是撤权。userinfo 补齐后这两项仍缺失，就保持本地资料不变。
      // 明确的 email_verified false 会更新。令牌可能已经轮换，所以仍然交回新的 refresh token。
      const identity = claims ? await this.refreshIdentity(config, tokens.access_token, claims) : null;
      return {
        identity,
        refreshToken: tokens.refresh_token ?? refreshToken,
      };
    } catch (error) {
      if (invalidGrant(error)) return "revoked";
      throw error;
    }
  }

  private async refreshIdentity(
    config: client.Configuration,
    accessToken: string,
    claims: client.IDToken,
  ): Promise<ExternalIdentity | null> {
    const fromToken = identityFromClaims(claims);
    let email = presentString(fromToken.email);
    let name = presentString(fromToken.name);
    let emailVerified = booleanClaim(claims.email_verified);
    if (email === null || name === null || emailVerified === undefined) {
      let info: client.UserInfoResponse;
      try {
        info = await client.fetchUserInfo(config, accessToken, claims.sub);
      } catch (error) {
        if (invalidGrant(error)) throw error;
        return null;
      }
      if (email === null) email = presentString(info.email);
      if (name === null) name = presentString(info.name);
      if (emailVerified === undefined) emailVerified = booleanClaim(info.email_verified);
    }
    if (email === null || emailVerified === undefined) return null;
    return { sub: claims.sub, email, emailVerified, name };
  }

  private async identityWithUserInfo(
    config: client.Configuration,
    accessToken: string,
    claims: client.IDToken,
  ): Promise<ExternalIdentity> {
    const identity = identityFromClaims(claims);
    const missing = identity.email === null || identity.name === null || claims.email_verified === undefined;
    if (!missing) return identity;
    const info = await client.fetchUserInfo(config, accessToken, claims.sub);
    return {
      sub: claims.sub,
      email: identity.email ?? (typeof info.email === "string" ? info.email : null),
      emailVerified: claims.email_verified === undefined ? info.email_verified === true : identity.emailVerified,
      name: identity.name ?? (typeof info.name === "string" ? info.name : null),
    };
  }

  private configuration(): Promise<client.Configuration> {
    this.pending ??= this.discover().catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }

  private discover(): Promise<client.Configuration> {
    const http = new URL(this.issuer).protocol === "http:";
    return client.discovery(new URL(this.issuer), this.clientId, this.clientSecret, undefined, {
      execute: http
        ? [client.allowInsecureRequests, client.enableNonRepudiationChecks]
        : [client.enableNonRepudiationChecks],
      ...(this.fetchImpl ? { [client.customFetch]: this.fetchImpl as client.CustomFetch } : {}),
    });
  }
}

export async function newTransaction(): Promise<OidcTransaction> {
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  return {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier,
    codeChallenge,
  };
}

function invalidGrant(error: unknown): boolean {
  return error instanceof client.ResponseBodyError && error.error === "invalid_grant";
}

function booleanClaim(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  return undefined;
}

function presentString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

function identityFromClaims(claims: client.IDToken): ExternalIdentity {
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
  };
}
