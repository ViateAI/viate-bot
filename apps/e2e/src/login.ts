import type { Browser, BrowserContextOptions } from "playwright-core";

export type LoginState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

export interface LoginInput {
  browser: Browser;
  baseURL: string;
  role: "admin" | "user";
}

export interface LoginModule {
  login(input: LoginInput): Promise<LoginState>;
}

/** 登录上下文和套件里的两个用户上下文共用。只有 VB_E2E_IGNORE_HTTPS_ERRORS=1 才忽略证书错误。 */
export function ignoreHTTPSErrors(): boolean {
  return process.env.VB_E2E_IGNORE_HTTPS_ERRORS === "1";
}
