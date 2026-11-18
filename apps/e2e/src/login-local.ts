import type { LoginInput, LoginState } from "./login.js";

/** 本地 oidc-provider 的可替换登录。真实部署换掉 VB_E2E_LOGIN_MODULE。 */
export async function login(input: LoginInput): Promise<LoginState> {
  const idp = process.env.VB_E2E_IDP_ORIGIN;
  if (!idp) throw new Error("本地登录需要 VB_E2E_IDP_ORIGIN");
  const sub = input.role === "admin" ? "admin" : "user";
  const selected = await fetch(`${idp}/test/use?sub=${sub}`);
  if (!selected.ok) throw new Error(`切换登录身份失败 ${selected.status}`);
  const page = await input.browser.newPage();
  try {
    await page.goto(`${input.baseURL}/auth/login?return_to=/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.origin === new URL(input.baseURL).origin && !url.pathname.startsWith("/auth"), { timeout: 20_000 });
    return await page.context().storageState();
  } finally {
    await page.close();
  }
}
