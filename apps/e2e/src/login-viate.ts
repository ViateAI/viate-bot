import { ignoreHTTPSErrors, type LoginInput, type LoginState } from "./login.js";

/**
 * Windows 部署的登录。控制面把浏览器送到 viate 的 `/portal/oauth-login`，
 * 表单是邮箱和密码。账号来自环境变量，不写进仓库。
 */
export async function login(input: LoginInput): Promise<LoginState> {
  const email = required(input.role === "admin" ? "VB_E2E_ADMIN_EMAIL" : "VB_E2E_USER_EMAIL");
  const password = required(input.role === "admin" ? "VB_E2E_ADMIN_PASSWORD" : "VB_E2E_USER_PASSWORD");
  const appOrigin = new URL(input.baseURL).origin;
  const context = await input.browser.newContext({ ignoreHTTPSErrors: ignoreHTTPSErrors() });
  const page = await context.newPage();
  try {
    await page.goto(`${input.baseURL}/auth/login?return_to=/`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname.includes("/portal/oauth-login") || backHome(url, appOrigin), { timeout: 30_000 });
    if (!backHome(new URL(page.url()), appOrigin)) {
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="password"]').fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((url) => backHome(url, appOrigin), { timeout: 30_000 });
    }
    return await context.storageState();
  } catch {
    // Playwright errors may embed fill values, URLs, or provider-rendered account details.
    throw new Error(`viate ${input.role} 登录失败（已省略敏感诊断）`);
  } finally {
    await context.close();
  }
}

function backHome(url: URL, appOrigin: string): boolean {
  return url.origin === appOrigin && !url.pathname.startsWith("/auth");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}
