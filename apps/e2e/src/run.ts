import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { hostResolverRules } from "./hosts.js";
import { ignoreHTTPSErrors, type LoginModule } from "./login.js";

const TASK_TIMEOUT_MS = 45_000;
const paceRaw = process.env.VB_E2E_PACE_MS;
const REAL_PACE_MS = Number(paceRaw === undefined || paceRaw === "" ? 15_000 : paceRaw);
let nextRealSendAt = 0;
async function paceReal(): Promise<void> {
  if (process.env.VB_E2E_LOCAL === "1" || REAL_PACE_MS <= 0) return;
  const wait = nextRealSendAt - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  nextRealSendAt = Date.now() + REAL_PACE_MS;
}

export async function runSuite(): Promise<void> {
  const baseURL = required("VB_E2E_BASE_URL");
  const loginPath = required("VB_E2E_LOGIN_MODULE");
  const local = process.env.VB_E2E_LOCAL === "1";
  if (!local && process.env.VB_E2E_ALLOW_ACCOUNT_MUTATION !== "1") throw new Error("真实部署只允许专用测试账号；确认后设置 VB_E2E_ALLOW_ACCOUNT_MUTATION=1");
  if (!local) required("VB_E2E_AVATAR_PATH");
  const model = process.env.VB_E2E_MODEL || (local ? "fake" : "deepseek-flash");
  const limitModel = `vb-e2e-${randomUUID()}`;
  const cleanups: Array<() => Promise<void>> = [];
  const shots = process.env.VB_E2E_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser();
  // The login adapter is selected at runtime by VB_E2E_LOGIN_MODULE.
  const login = (await import(pathToFileURL(resolve(process.env.INIT_CWD || process.cwd(), loginPath)).href)) as LoginModule;
  try {
    const adminState = await login.login({ browser, baseURL, role: "admin" });
    const userState = await login.login({ browser, baseURL, role: "user" });
    const ignoreCertErrors = ignoreHTTPSErrors();
    const admin = await browser.newContext({ storageState: adminState, ignoreHTTPSErrors: ignoreCertErrors, viewport: { width: 1440, height: 900 } });
    const user = await browser.newContext({ storageState: userState, ignoreHTTPSErrors: ignoreCertErrors, viewport: { width: 1440, height: 900 } });
    const adminApi = await apiClient(admin, baseURL);
    const userApi = await apiClient(user, baseURL);
    const adminCsrf = await csrf(adminApi, baseURL);
    const userCsrf = await csrf(userApi, baseURL);
    const me = await json<{ id: string; email: string; isAdmin: boolean }>(userApi, `${baseURL}/api/me`);
    if (me.isAdmin) throw new Error("普通用户账号不能是管理员");
    type UserQuota = { id: string; maxBots: number; maxConcurrentTasks: number; maxRoutines: number; taskTokenBudget: number | null; showProcess: boolean; provisioned: boolean };
    const listed = await json<{ users: UserQuota[] }>(adminApi, `${baseURL}/api/admin/users`);
    const prior = listed.users.find((row) => row.id === me.id);
    if (!prior) throw new Error("管理端找不到测试用户");
    let botId: string;
    if (!prior.provisioned) {
      if (!local) throw new Error("请先开通专用测试账号，套件不会在真实部署创建机器");
      const provisionPage = await admin.newPage();
      await provisionPage.goto(`${baseURL}/admin`);
      await waitFor(async () => {
        const options = await provisionPage.getByTestId("provision-user").innerText();
        return options.includes(me.email) ? "ok" : "开通列表还没有测试用户";
      });
      await provisionPage.getByTestId("provision-user").selectOption({ label: me.email });
      await waitFor(async () => {
        const routines = await provisionPage.getByTestId("provision-routines").inputValue();
        const modelValue = await provisionPage.getByTestId("provision-model").inputValue();
        return routines !== "" && modelValue !== "" ? "ok" : "开通默认值还没到";
      });
      const submitted = {
        model: await provisionPage.getByTestId("provision-model").inputValue(),
        maxBots: Number(await provisionPage.getByTestId("provision-bots").inputValue()),
        maxConcurrentTasks: Number(await provisionPage.getByTestId("provision-tasks").inputValue()),
        maxRoutines: Number(await provisionPage.getByTestId("provision-routines").inputValue()),
      };
      await provisionPage.getByTestId("provision-routines").fill("");
      await provisionPage.getByTestId("provision-submit").click();
      await provisionPage.getByText("maxRoutines 必须是非负整数", { exact: true }).waitFor();
      await provisionPage.getByTestId("provision-routines").fill(String(submitted.maxRoutines));
      await provisionPage.getByTestId("provision-submit").click();
      await provisionPage.getByTestId("provision-result").waitFor({ timeout: TASK_TIMEOUT_MS });
      if (shots) await provisionPage.screenshot({ path: `${shots}/provision-form.png` });
      await provisionPage.close();
      const opened = (await json<{ users: UserQuota[] }>(adminApi, `${baseURL}/api/admin/users`)).users.find((row) => row.id === me.id);
      if (!opened?.provisioned) throw new Error("表单开通后用户仍未开通");
      if (opened.maxBots !== submitted.maxBots || opened.maxConcurrentTasks !== submitted.maxConcurrentTasks || opened.maxRoutines !== submitted.maxRoutines) {
        throw new Error(`配额和表单不一致: ${JSON.stringify(opened)} ${JSON.stringify(submitted)}`);
      }
      if (opened.taskTokenBudget !== null) throw new Error("留空的单任务预算不应覆盖全局值");
      const createdBots = await json<{ bots: Array<{ id: string; model: string }> }>(userApi, `${baseURL}/api/bots`);
      const createdBot = createdBots.bots.find((item) => item.model === submitted.model);
      if (!createdBot) throw new Error(`开通后的 bot 模型不是 ${submitted.model}`);
      botId = createdBot.id;
      const baseline = (await json<{ users: UserQuota[] }>(adminApi, `${baseURL}/api/admin/users`)).users.find((row) => row.id === me.id)!;
      cleanups.push(async () => { await json(adminApi, `${baseURL}/api/admin/users/${me.id}/quota`, { method: "PATCH", headers: { "x-vb-csrf": adminCsrf }, data: { maxBots: baseline.maxBots, maxConcurrentTasks: baseline.maxConcurrentTasks, maxRoutines: baseline.maxRoutines, taskTokenBudget: baseline.taskTokenBudget } }); });
    } else {
      cleanups.push(async () => {
        await json(adminApi, `${baseURL}/api/admin/users/${me.id}/quota`, { method: "PATCH", headers: { "x-vb-csrf": adminCsrf }, data: { maxBots: prior.maxBots, maxConcurrentTasks: prior.maxConcurrentTasks, maxRoutines: prior.maxRoutines, taskTokenBudget: prior.taskTokenBudget } });
      });
      await json(adminApi, `${baseURL}/api/admin/users/${me.id}/quota`, { method: "PATCH", headers: { "x-vb-csrf": adminCsrf }, data: { maxBots: prior.maxBots + 1, maxRoutines: prior.maxRoutines + 1, taskTokenBudget: 0 } });
      const created = await json<{ bot: { id: string } }>(userApi, `${baseURL}/api/bots`, { method: "POST", headers: { "x-vb-csrf": userCsrf }, data: { name: `E2E ${randomUUID()}`, model } });
      botId = created.bot.id;
    }
    cleanups.push(async () => {
      await json(userApi, `${baseURL}/api/bots/${botId}`, { method: "DELETE", headers: { "x-vb-csrf": userCsrf } });
      const remaining = await json<{ bots: Array<{ id: string }> }>(userApi, `${baseURL}/api/bots`);
      if (remaining.bots.some((item) => item.id === botId)) throw new Error("E2E resource leak: created bot still visible after suite");
    });
    cleanups.push(async () => {
      const routines = await json<{ routines: Array<{ id: string }> }>(userApi, `${baseURL}/api/bots/${botId}/routines`);
      for (const routine of routines.routines) await json(userApi, `${baseURL}/api/routines/${routine.id}`, { method: "DELETE", headers: { "x-vb-csrf": userCsrf } });
    });
    cleanups.push(async () => {
      const rules = await json<{ rules: Array<{ id: string }> }>(userApi, `${baseURL}/api/bots/${botId}/approval-rules`);
      for (const rule of rules.rules) await json(userApi, `${baseURL}/api/bots/${botId}/approval-rules/${rule.id}`, { method: "DELETE", headers: { "x-vb-csrf": userCsrf } });
    });
    cleanups.push(async () => {
      await json(adminApi, `${baseURL}/api/admin/users/${me.id}/process-detail`, { method: "PATCH", headers: { "x-vb-csrf": adminCsrf }, data: { enabled: prior.showProcess } });
    });
    await json(adminApi, `${baseURL}/api/admin/users/${me.id}/process-detail`, { method: "PATCH", headers: { "x-vb-csrf": adminCsrf }, data: { enabled: false } });
    const page = await user.newPage();
    await page.goto(`${baseURL}/b/${botId}`);
    await page.getByTestId("message-input").waitFor();
    if (local) {
      const previousRate = await json<{ modelRate: { userPerMin: number; botPerMin: number } }>(adminApi, `${baseURL}/api/admin/settings`);
      cleanups.push(async () => {
        await json(adminApi, `${baseURL}/api/admin/model-rate`, {
          method: "PUT",
          headers: { "x-vb-csrf": adminCsrf },
          data: previousRate.modelRate,
        });
      });
      await json(adminApi, `${baseURL}/api/admin/model-rate`, {
        method: "PUT",
        headers: { "x-vb-csrf": adminCsrf },
        data: { userPerMin: 0, botPerMin: 1 },
      });
      const firstRate = await say(page, botId, "e2e-rate-a");
      await waitState(userApi, baseURL, firstRate.taskId, "succeeded");
      const secondRate = await say(page, botId, "e2e-rate-b");
      await waitFor(async () => {
        const task = await json<{ task: { state: string; waitingRate?: boolean } }>(userApi, `${baseURL}/api/tasks/${secondRate.taskId}`);
        if (task.task.waitingRate) return "ok";
        if (task.task.state === "succeeded" || task.task.state === "failed" || task.task.state === "cancelled") {
          return `任务failed: 限流没有进入等待 (${task.task.state})`;
        }
        return "还没进入限流等待";
      });
      await waitFor(async () => {
        const label = await page.getByTestId("task-status").textContent();
        return label?.includes("请求较多，等待中") ? "ok" : `状态是 ${label ?? ""}`;
      });
      if (shots) await page.screenshot({ path: `${shots}/rate-wait.png` });
      await json(adminApi, `${baseURL}/api/admin/model-rate`, {
        method: "PUT",
        headers: { "x-vb-csrf": adminCsrf },
        data: previousRate.modelRate,
      });
      await waitState(userApi, baseURL, secondRate.taskId, "succeeded");
    }
    await json(userApi, `${baseURL}/api/bots/${botId}/approval-settings`, {
      method: "PUT",
      headers: { "x-vb-csrf": userCsrf },
      data: { alwaysAllow: ["shell"] },
    });

    const tools = await say(page, botId, "e2e-tools");
    await waitState(userApi, baseURL, tools.taskId, "succeeded");
    const hiddenSteps = await json<{ steps: Array<{ request?: { label?: string; args?: unknown } }> }>(userApi, `${baseURL}/api/tasks/${tools.taskId}/steps`);
    const shellSteps = hiddenSteps.steps.filter((step) => step.request?.label === "正在执行命令" || JSON.stringify(step.request).includes("shell_exec"));
    if (shellSteps.length < 6) throw new Error(`工具轮次不够: ${shellSteps.length}`);
    if (JSON.stringify(hiddenSteps).includes("echo round")) throw new Error("详细过程关闭时步骤里仍有命令参数");
    if (shots) await page.screenshot({ path: `${shots}/chat-detail-off.png` });

    const adminPage = await admin.newPage();
    await adminPage.goto(`${baseURL}/admin/settings`);
    await adminPage.getByTestId("model-settings").waitFor();
    if (local) {
      await adminPage.getByTestId("model-rate-user").fill("");
      await adminPage.getByRole("button", { name: "保存限流", exact: true }).click();
      await adminPage.getByText("限流必须是非负整数，0 表示不限制", { exact: true }).waitFor();
    }
    await adminPage.getByTestId("model-limit-name").fill(limitModel);
    cleanups.push(async () => { await json(adminApi, `${baseURL}/api/admin/model-limits`, { method: "PUT", headers: { "x-vb-csrf": adminCsrf }, data: { model: limitModel, clear: true } }); });
    await adminPage.getByTestId("model-context").fill("32000");
    await adminPage.getByTestId("model-output").fill("1000");
    await adminPage.getByTestId("model-settings").getByRole("button", { name: "保存", exact: true }).click();
    await waitFor(async () => {
      const settings = await json<{ modelLimits: Record<string, { maxTokens: number }> }>(adminApi, `${baseURL}/api/admin/settings`);
      return settings.modelLimits[limitModel]?.maxTokens === 1000 ? "ok" : "模型设置还没保存";
    });
    if (shots) await adminPage.screenshot({ path: `${shots}/model-settings.png` });

    await adminPage.goto(`${baseURL}/admin`);
    const userRow = adminPage.getByTestId("user-row").filter({ has: adminPage.getByRole("cell", { name: me.email, exact: true }) });
    const routineQuota = Math.max(6, (prior.maxRoutines ?? 0) + 1);
    await userRow.getByTestId("quota-routines").fill(String(routineQuota));
    await userRow.getByTestId("quota-editor").getByRole("button", { name: "保存" }).click();
    await waitFor(async () => {
      const listed = await json<{ users: Array<{ id: string | null; maxRoutines: number | null }> }>(adminApi, `${baseURL}/api/admin/users`);
      const row = listed.users.find((item) => item.id === me.id);
      return row?.maxRoutines === routineQuota ? "ok" : "配额还没保存";
    });
    if (shots) await adminPage.screenshot({ path: `${shots}/quota-editor.png` });
    await userRow.getByTestId("process-detail").click();
    await waitFor(async () => {
      const opened = await json<{ steps: Array<{ request?: { args?: { cmd?: string } } }> }>(userApi, `${baseURL}/api/tasks/${tools.taskId}/steps`);
      return JSON.stringify(opened).includes("echo round-0") ? "ok" : "打开详细过程后仍看不到命令";
    });
    await userRow.getByTestId("process-detail").click();

    await json(userApi, `${baseURL}/api/bots/${botId}/approval-settings`, {
      method: "PUT",
      headers: { "x-vb-csrf": userCsrf },
      data: { alwaysAllow: [] },
    });
    const renamed = await say(page, botId, "e2e-rename");
    await waitState(userApi, baseURL, renamed.taskId, "succeeded");
    const bot = await json<{ bot: { name: string; avatar: string | null } }>(userApi, `${baseURL}/api/bots/${botId}`);
    if (bot.bot.name !== "改名后的助手" || bot.bot.avatar !== "image/png") throw new Error(`资料没有改成预期: ${bot.bot.name} ${bot.bot.avatar}`);
    await page.getByRole("heading", { name: "改名后的助手", exact: true }).first().waitFor({ timeout: 5000 });
    await page.getByText("E2E 简介", { exact: true }).first().waitFor({ timeout: 5000 });
    const avatar = page.locator(`img[src^="/api/bots/${botId}/avatar"]`).first();
    await avatar.waitFor({ timeout: 5000 });
    if (!(await avatar.evaluate(async (image) => { const img = image as unknown as { complete: boolean; naturalWidth: number; decode(): Promise<void> }; await img.decode(); return img.complete && img.naturalWidth > 0; }))) throw new Error("自定义头像没有解码显示");

    const prompt = await say(page, botId, "e2e-prompt");
    await waitState(userApi, baseURL, prompt.taskId, "waiting_approval");
    await page.getByTestId("profile-diff").waitFor({ timeout: TASK_TIMEOUT_MS });
    if (shots) await page.screenshot({ path: `${shots}/profile-approval.png` });
    await page.getByRole("button", { name: "拒绝" }).click();
    await waitState(userApi, baseURL, prompt.taskId, "succeeded");

    await page.getByRole("button", { name: "资料库" }).click();
    await page.getByTestId("approval-rules").getByRole("combobox").selectOption("shell");
    await page.getByPlaceholder("匹配内容").fill("echo ok");
    await page.getByRole("button", { name: "添加规则" }).click();
    await page.getByText("echo").first().waitFor();
    if (shots) await page.screenshot({ path: `${shots}/approval-rules.png` });

    const allowed = await say(page, botId, "e2e-allow");
    await waitState(userApi, baseURL, allowed.taskId, "succeeded");
    const denied = await say(page, botId, "e2e-deny");
    await waitState(userApi, baseURL, denied.taskId, "waiting_approval");
    await page.getByTestId("rule-from-approval").waitFor({ timeout: TASK_TIMEOUT_MS });
    if (shots) await page.screenshot({ path: `${shots}/auto-approve.png` });
    await page.getByRole("button", { name: "拒绝" }).click();
    await waitState(userApi, baseURL, denied.taskId, "succeeded");

    await page.getByRole("button", { name: "资料库" }).click();
    await page.getByTestId("approve-none").click();
    await page.getByTestId("approve-none-risk").waitFor();
    if (shots) await page.screenshot({ path: `${shots}/approve-none.png` });
    const skippedPrompt = await say(page, botId, "e2e-skip-prompt");
    await waitQuiet(userApi, baseURL, skippedPrompt.taskId, "succeeded");
    const edited = await json<{ bot: { instructions: string } }>(userApi, `${baseURL}/api/bots/${botId}`);
    if (!edited.bot.instructions.includes("免审批提示词")) throw new Error("全部免审批没有放行提示词修改");
    const installName = `e2e-${botId.toLowerCase()}`;
    const beforeInstalls = await json<{ installs: Array<{ id: string; name: string }> }>(userApi, `${baseURL}/api/apps/installs`);
    if (beforeInstalls.installs.some((item) => item.name === installName)) throw new Error("测试安装名已存在，拒绝复用");
    cleanups.push(async () => {
      const after = await json<{ installs: Array<{ id: string; name: string; desired: string }> }>(userApi, `${baseURL}/api/apps/installs`);
      for (const install of after.installs) {
        if (install.name !== installName || beforeInstalls.installs.some((item) => item.id === install.id) || install.desired === "absent") continue;
        await json(userApi, `${baseURL}/api/apps/installs/${install.id}/uninstall`, { method: "POST", headers: { "x-vb-csrf": userCsrf }, data: {} });
      }
    });
    const skippedInstall = await say(page, botId, "e2e-skip-install");
    await waitQuiet(userApi, baseURL, skippedInstall.taskId);
    const proposal = await say(page, botId, "e2e-propose");
    await waitState(userApi, baseURL, proposal.taskId, "waiting_approval");
    await page.getByTestId("rule-proposal").waitFor({ timeout: TASK_TIMEOUT_MS });
    if (shots) await page.screenshot({ path: `${shots}/rule-proposal.png` });
    await page.getByRole("button", { name: "允许" }).click();
    await waitState(userApi, baseURL, proposal.taskId, "succeeded");
    const rules = await json<{ rules: Array<{ match: { prefix?: string[] }; expiresAt: string | null }> }>(userApi, `${baseURL}/api/bots/${botId}/approval-rules`);
    const proposed = rules.rules.find((rule) => rule.match.prefix?.join(" ") === "echo proposed");
    if (!proposed || proposed.expiresAt !== null) throw new Error("批准后的规则没有永久生效");
    const rejected = await say(page, botId, "e2e-propose-deny");
    await waitState(userApi, baseURL, rejected.taskId, "waiting_approval");
    await page.getByRole("button", { name: "拒绝" }).click();
    await waitState(userApi, baseURL, rejected.taskId, "succeeded");
    const afterDeny = await json<{ rules: Array<{ match: { prefix?: string[] } }> }>(userApi, `${baseURL}/api/bots/${botId}/approval-rules`);
    if (afterDeny.rules.some((rule) => rule.match.prefix?.join(" ") === "echo denied")) throw new Error("被拒绝的规则提议生效了");
    const flip = await say(page, botId, "e2e-flip");
    await waitQuiet(userApi, baseURL, flip.taskId);
    const switched = await json<{ approveNone: boolean }>(userApi, `${baseURL}/api/bots/${botId}/approval-settings`);
    if (switched.approveNone !== true) throw new Error("bot 改掉了全部免审批开关");

    const routine = await say(page, botId, "e2e-routine");
    await waitState(userApi, baseURL, routine.taskId, "succeeded");
    const drafted = await json<{ routines: Array<{ state: string }> }>(userApi, `${baseURL}/api/bots/${botId}/routines`);
    if (!drafted.routines.some((item) => item.state === "draft")) throw new Error("定时任务草稿没有创建");
    await page.reload();
    await page.getByRole("button", { name: "确认" }).click();
    await waitFor(async () => {
      const listed = await json<{ routines: Array<{ state: string }> }>(userApi, `${baseURL}/api/bots/${botId}/routines`);
      return listed.routines.some((item) => item.state !== "draft") ? "ok" : "定时任务还是草稿";
    });
    await json(adminApi, `${baseURL}/api/admin/users/${me.id}/quota`, {
      method: "PATCH",
      headers: { "x-vb-csrf": adminCsrf },
      data: { taskTokenBudget: 1 },
    });
    const budget = await say(page, botId, "e2e-budget");
    await waitFor(async () => {
      const task = await json<{ task: { state: string; error: string | null } }>(userApi, `${baseURL}/api/tasks/${budget.taskId}`);
      if (task.task.state === "failed" && (task.task.error ?? "").includes("已达到单任务 token 预算")) return "ok";
      if (task.task.state === "succeeded" || task.task.state === "cancelled") return `任务failed: 预算任务记成了${task.task.state}`;
      return `预算任务状态是 ${task.task.state}`;
    });
    if (shots) await page.screenshot({ path: `${shots}/budget-failed.png` });
    if (local) await publishOwnApp(page, adminPage, userApi, adminApi, baseURL, botId, userCsrf, adminCsrf);
  } finally {
    let cleanupFailures = 0;
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch { cleanupFailures += 1; }
    }
    await browser.close();
    if (cleanupFailures) throw new Error(`E2E cleanup failed: ${cleanupFailures} operation(s); verify test account resources`);
  }
  console.log("E2E passed; created bot/routines removed and temporary settings restored; login sessions stayed in memory");
}

async function say(page: Page, botId: string, text: string): Promise<{ taskId: string }> {
  const installName = `e2e-${botId.toLowerCase()}`;
  let prompt = text === "e2e-skip-install" ? `${text} app=${installName}` : text;
  if (process.env.VB_E2E_LOCAL !== "1") {
    const scenarios: Record<string, string> = {
      "e2e-tools": "逐轮分别调用 shell_exec 六次，命令依次为 echo round-0 到 echo round-5，每轮读回后再下一次；最后回复结论。",
      "e2e-rename": `只调用一次 update_bot_profile，不要调用 shell_exec 或其他工具。将 name 改为「改名后的助手」，bio 改为「E2E 简介」，avatarPath 为 ${JSON.stringify(required("VB_E2E_AVATAR_PATH"))}。该文件已经是 PNG。不要改其他字段。`,
      "e2e-prompt": "调用 update_bot_profile，将 instructions 改为「第二行\\n改过的提示词」。等待审批结果；被拒绝后回复并结束，不重试。",
      "e2e-allow": "调用 shell_exec，cmd 必须是 echo ok，然后回复结果。",
      "e2e-deny": "调用 shell_exec，cmd 必须是 echo no; true。被拒绝后回复并结束，不重试。",
      "e2e-skip-prompt": "调用 update_bot_profile，将 instructions 改为「免审批提示词」，然后回复。",
      "e2e-skip-install": `调用 install_mcp，remote 为 {"name":"${installName}","url":"http://127.0.0.1:9/mcp"}，reason 为「端到端测试」。这是预期连接失败的测试；返回后回复并结束，不重试。`,
      "e2e-propose": "调用 propose_approval_rule，category=shell，match={\"prefix\":\"echo proposed\"}。等待人工批准，批准后再调用 shell_exec 执行 echo proposed，最后回复。",
      "e2e-propose-deny": "调用 propose_approval_rule，category=shell，match={\"prefix\":\"echo denied\"}。被拒绝后回复并结束，不重试。",
      "e2e-flip": "尝试调用 update_bot_profile，参数 approveNone=false；不能修改时回复并结束，不要做其他操作。",
      "e2e-routine": "调用 propose_routine，cron=0 9 * * *，timezone=Asia/Shanghai，prompt=每天看一眼。只建一个草稿然后回复。",
      "e2e-budget": "只回复「预算测试完成」，不调用工具。",
    };
    const scenario = scenarios[text];
    if (!scenario) throw new Error(`未知 E2E 场景 ${text}`);
    prompt = `这是专用测试账号的端到端验收。仅执行本条要求，不扩展任务，不修改其他资源。不要调用未点名的工具，不要先检查文件或环境。${scenario}`;
  }
  await page.getByTestId("message-input").fill(prompt);
  await paceReal();
  const response = page.waitForResponse((item) => item.url().includes(`/api/bots/${botId}/messages`) && item.request().method() === "POST");
  await page.getByTestId("send-message").click();
  const posted = await response;
  if (posted.status() !== 202) throw new Error(`发送失败 ${posted.status()} ${await posted.text()}`);
  return posted.json() as Promise<{ taskId: string }>;
}

async function publishOwnApp(
  page: Page,
  adminPage: Page,
  userApi: HttpClient,
  adminApi: HttpClient,
  baseURL: string,
  botId: string,
  userCsrf: string,
  adminCsrf: string,
): Promise<void> {
  const shots = process.env.VB_E2E_SHOTS || "/tmp/vb-req001-shots";
  mkdirSync(shots, { recursive: true });
  await json(userApi, `${baseURL}/api/bots/${botId}/approval-settings`, {
    method: "PUT",
    headers: { "x-vb-csrf": userCsrf },
    data: { approveNone: false, alwaysAllow: ["fs_write"] },
  });
  await json(adminApi, `${baseURL}/api/admin/users/${(await json<{ id: string }>(userApi, `${baseURL}/api/me`)).id}/quota`, {
    method: "PATCH",
    headers: { "x-vb-csrf": adminCsrf },
    data: { taskTokenBudget: 0 },
  });
  const task = await say(page, botId, "e2e-publish");
  await page.getByTestId("install-title").waitFor({ timeout: TASK_TIMEOUT_MS });
  await json(userApi, `${baseURL}/api/bots/${botId}/approval-settings`, {
    method: "PUT",
    headers: { "x-vb-csrf": userCsrf },
    data: { approveNone: true, alwaysAllow: ["fs_write"] },
  });
  await page.getByRole("button", { name: "允许" }).click();
  await page.getByTestId("publish-approval").waitFor({ timeout: TASK_TIMEOUT_MS });
  await page.screenshot({ path: `${shots}/publish-approval.png` });
  await page.getByRole("button", { name: "允许" }).click();
  await waitState(userApi, baseURL, task.taskId, "succeeded");
  await adminPage.goto(`${baseURL}/admin/app-reviews`);
  await adminPage.getByTestId("admin-review-list").waitFor({ timeout: TASK_TIMEOUT_MS });
  await adminPage.getByTestId("admin-review-list").screenshot({ path: `${shots}/admin-review-list.png` });
  await adminPage.getByTestId("admin-review-detail").waitFor({ timeout: TASK_TIMEOUT_MS });
  await adminPage.getByTestId("admin-review-detail").screenshot({ path: `${shots}/admin-review-detail.png` });
  await adminPage.getByTestId("admin-review-approve").click();
  await waitFor(async () => {
    const listed = await json<{ requests: Array<{ name: string; state: string }> }>(adminApi, `${baseURL}/api/admin/app-reviews`);
    const row = listed.requests.find((item) => item.name === "e2enotes");
    return row?.state === "approved" ? "ok" : "发布申请还没通过";
  });
  await page.goto(`${baseURL}/apps`);
  await page.getByTestId("app-card").filter({ hasText: "e2enotes" }).click();
  await page.getByText("1.0.0 · 已公开").waitFor({ timeout: TASK_TIMEOUT_MS });
  await page.screenshot({ path: `${shots}/user-publish-status.png` });
  const ada = await json<{ id: string }>(adminApi, `${baseURL}/api/me`);
  const directory = await json<{ users: Array<{ id: string | null; provisioned: boolean }> }>(adminApi, `${baseURL}/api/admin/users`);
  if (!directory.users.some((user) => user.id === ada.id && user.provisioned)) {
    const opened = await json<{ ok?: boolean }>(adminApi, `${baseURL}/api/admin/users/provision`, {
      method: "POST",
      headers: { "x-vb-csrf": adminCsrf },
      data: { userId: ada.id, templateId: "general", model: "fake", maxBots: 1, maxConcurrentTasks: 1, maxRoutines: 0, spec: { cpu: 1, memMb: 1024, diskGb: 10 } },
    });
    if (!opened) throw new Error("第二个测试用户没有开通");
  }
  const catalog = await json<{ apps: Array<{ name: string; publisher?: string | null }> }>(adminApi, `${baseURL}/api/apps`);
  const published = catalog.apps.find((app) => app.name === "e2enotes");
  if (!published?.publisher) throw new Error("另一个用户看不到已公开的应用或发布者");
  await json(adminApi, `${baseURL}/api/apps/e2enotes/install`, {
    method: "POST",
    headers: { "x-vb-csrf": adminCsrf },
    data: { version: "1.0.0" },
  });
  const installs = await json<{ installs: Array<{ name: string; state: string }> }>(adminApi, `${baseURL}/api/apps/installs`);
  if (!installs.installs.some((install) => install.name === "e2enotes" && install.state === "installed")) throw new Error("另一个用户没有装上已公开的应用");
}

async function waitQuiet(api: HttpClient, baseURL: string, taskId: string, expectState?: string): Promise<void> {
  await waitFor(async () => {
    const task = await json<{ task: { state: string; error: string | null } }>(api, `${baseURL}/api/tasks/${taskId}`);
    if (task.task.state === "waiting_approval") return `任务failed: ${taskId} 不应该等待审批`;
    if (expectState && task.task.state === expectState) return "ok";
    if (task.task.state === "failed" || task.task.state === "cancelled") {
      if (!expectState) return "ok";
      return `任务${task.task.state}: ${task.task.error ?? ""}`;
    }
    if (!expectState && task.task.state === "succeeded") return "ok";
    return `任务状态是 ${task.task.state}`;
  });
}

async function waitState(api: HttpClient, baseURL: string, taskId: string, state: string): Promise<void> {
  await waitFor(async () => {
    const task = await json<{ task: { state: string; error: string | null } }>(api, `${baseURL}/api/tasks/${taskId}`);
    if (task.task.state === state) return "ok";
    if (task.task.state === "failed" || task.task.state === "cancelled") return `任务${task.task.state}: ${task.task.error ?? ""}`;
    return `任务状态是 ${task.task.state}`;
  });
}

async function csrf(api: HttpClient, baseURL: string): Promise<string> {
  const me = await json<{ csrf: string }>(api, `${baseURL}/api/me`);
  return me.csrf;
}

async function json<T>(api: HttpClient, url: string, init: { method?: string; headers?: Record<string, string>; data?: unknown } = {}): Promise<T> {
  const response = await api.fetch(url, {
    method: init.method ?? "GET",
    headers: { ...(init.data ? { "content-type": "application/json" } : {}), ...init.headers },
    ...(init.data ? { data: init.data } : {}),
  });
  const text = await response.text();
  if (!response.ok()) throw new Error(`${init.method ?? "GET"} ${url} -> ${response.status()} ${text}`);
  return JSON.parse(text) as T;
}

async function waitFor(read: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let last = "没有结果";
  while (Date.now() < deadline) {
    last = await read();
    if (last === "ok") return;
    if (last.startsWith("任务failed") || last.startsWith("任务cancelled")) throw new Error(last);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(last);
}

interface HttpClient {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; data?: unknown }): Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>;
}

async function apiClient(context: BrowserContext, baseURL: string): Promise<HttpClient> {
  if (!hostResolverRules()) return context.request;
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  const origin = new URL(baseURL).origin;
  if (new URL(page.url()).origin !== origin) throw new Error(`打开 ${baseURL} 后不在本站: ${page.url()}`);
  return browserFetch(page);
}

/** Playwright 自己的请求不走 Chromium DNS。有 host-resolver-rules 时改在页面里 fetch。 */
function browserFetch(page: Page): HttpClient {
  return {
    async fetch(url, init) {
      const result = await page.evaluate(async (request: { url: string; method: string; headers: Record<string, string>; body: string | null }) => {
        const fetchFn = (globalThis as unknown as {
          fetch: (input: string, init: { method: string; headers: Record<string, string>; body?: string; credentials: "include" }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
        }).fetch;
        const response = await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body !== null ? { body: request.body } : {}),
          credentials: "include",
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
      }, {
        url,
        method: init?.method ?? "GET",
        headers: { ...(init?.data !== undefined ? { "content-type": "application/json" } : {}), ...init?.headers },
        body: init?.data !== undefined ? JSON.stringify(init.data) : null,
      });
      return {
        ok: () => result.ok,
        status: () => result.status,
        text: async () => result.text,
      };
    },
  };
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.VB_E2E_BROWSER_PATH;
  const channel = executablePath ? undefined : process.env.VB_E2E_BROWSER_CHANNEL || "chrome";
  const rules = hostResolverRules();
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(channel ? { channel: channel as "chrome" | "msedge" } : {}),
    ...(rules ? { args: [`--host-resolver-rules=${rules}`] } : {}),
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

if (process.argv[1]?.endsWith("run.ts")) {
  runSuite().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
