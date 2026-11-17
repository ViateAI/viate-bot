import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api, type Bot, type Me } from "./api.js";
import { BotMark, initials } from "./presence.js";

/** Suggestions when the server publishes no whitelist. Creation still accepts any name. */
const suggestedModels = ["grok-4.7", "grok-4", "grok-4-fast", "grok-3"];

function modelChoices(models: { models: string[]; unrestricted: boolean } | undefined, used: string[]): string[] {
  const listed = models?.models ?? [];
  if (listed.length > 0) return listed;
  if (!models?.unrestricted) return [];
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const item of [...used, ...suggestedModels]) {
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    choices.push(value);
  }
  return choices;
}

function preview(bot: Bot): string {
  const line = bot.instructions.trim().split("\n").find((item) => item.trim())?.trim();
  if (!line) return bot.model;
  return line.length > 36 ? `${line.slice(0, 36)}…` : line;
}

const field = "w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-neutral-900 outline-none focus-visible:border-neutral-400";

export function BotSidebar({ activeId, onLogout }: { activeId?: string | undefined; onLogout: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<{ bots: Bot[] }>("/api/bots") });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api<{ models: string[]; unrestricted: boolean }>("/api/models"),
  });
  const choices = modelChoices(
    models.data,
    (bots.data?.bots ?? []).map((bot) => bot.model),
  );
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api<{ bot: Bot }>("/api/bots", {
        method: "POST",
        body: JSON.stringify({ name, model, instructions }),
      }),
    onSuccess: async (result) => {
      setName("");
      setModel("");
      setInstructions("");
      setError("");
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["bots"] });
      await navigate({ to: "/b/$botId", params: { botId: result.bot.id } });
    },
    onError: (caught: Error) => setError(caught.message),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  const listed = (bots.data?.bots ?? []).filter((bot) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return bot.name.toLowerCase().includes(needle) || bot.model.toLowerCase().includes(needle);
  });
  const userName = me.data?.name ?? "";

  return (
    <aside className={`${activeId ? "hidden md:flex" : "flex"} h-full w-full shrink-0 flex-col border-r border-black/5 bg-[#f7f7f7] md:w-[280px]`}>
      <div className="flex items-center gap-2 px-3 py-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-white px-3 py-2 text-sm ring-1 ring-black/10">
          <SearchIcon />
          <input
            aria-label="搜索 bot"
            className="w-full bg-transparent text-neutral-900 outline-none placeholder:text-neutral-400"
            placeholder="搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-white text-neutral-800 ring-1 ring-black/10 hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
          aria-expanded={creating}
          aria-label={creating ? "关闭新建" : "新建 bot"}
          onClick={() => setCreating((open) => !open)}
        >
          <PlusIcon />
        </button>
      </div>
      {me.data && !me.data.provisioned ? (
        <p data-testid="not-provisioned" className="mx-3 rounded-2xl bg-white px-4 py-6 text-sm text-neutral-600 ring-1 ring-black/5">
          尚未开通，请联系管理员
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {creating ? (
            <form className="grid gap-3 rounded-2xl bg-white p-3 ring-1 ring-black/5" onSubmit={onSubmit}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">新建 bot</h2>
                <button type="button" className="text-sm text-neutral-500" onClick={() => setCreating(false)}>
                  取消
                </button>
              </div>
              <label className="grid gap-1 text-sm">
                名字
                <input data-testid="bot-name" className={field} value={name} onChange={(event) => setName(event.target.value)} required />
              </label>
              <label className="grid gap-1 text-sm">
                模型
                <input
                  data-testid="bot-model"
                  className={field}
                  value={model}
                  list="model-choices"
                  placeholder="例如 grok-4.7"
                  onChange={(event) => setModel(event.target.value)}
                  required
                />
                <datalist id="model-choices">
                  {choices.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
                {models.data?.unrestricted ? <span className="text-xs text-neutral-500">可从建议里选，也可以输入其他模型名。</span> : null}
              </label>
              <label className="grid gap-1 text-sm">
                指令
                <textarea
                  data-testid="bot-instructions"
                  className={`${field} min-h-24`}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>
              {error ? <p className="text-sm text-red-700">{error}</p> : null}
              <button
                data-testid="create-bot"
                className="rounded-full bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                type="submit"
                disabled={create.isPending}
              >
                创建 bot
              </button>
            </form>
          ) : (
            <>
              {bots.isPending ? <p className="px-2 py-3 text-sm text-neutral-500">正在加载…</p> : null}
              {bots.isError ? <p role="alert" className="px-2 py-3 text-sm text-red-700">{bots.error.message}</p> : null}
              {bots.data && listed.length === 0 ? (
                <p className="px-2 py-6 text-sm text-neutral-500">{query.trim() ? "没有匹配的 bot" : "还没有 bot。点右上角加号创建一个。"}</p>
              ) : null}
              <ul className="grid gap-1">
                {listed.map((bot) => {
                  const selected = bot.id === activeId;
                  return (
                    <li key={bot.id}>
                      <Link
                        to="/b/$botId"
                        params={{ botId: bot.id }}
                        aria-current={selected ? "page" : undefined}
                        className={`flex items-center gap-3 rounded-2xl px-2 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 ${selected ? "bg-white shadow-sm ring-1 ring-black/5" : "hover:bg-black/[0.04]"}`}
                      >
                        <BotMark name={bot.name} className="size-12 rounded-full text-sm" />
                        <span className="min-w-0">
                          <span className="block truncate text-[15px] font-medium text-neutral-900">{bot.name}</span>
                          <span className="block truncate text-sm text-neutral-500">{preview(bot)}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="mt-auto border-t border-black/5 px-3 py-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-700" aria-hidden>
            {initials(userName)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{userName}</span>
        </div>
        <nav className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500" aria-label="账户">
          <Link to="/approvals" className="rounded px-1 py-1 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900">
            批准
          </Link>
          <Link to="/apps" className="rounded px-1 py-1 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900">
            应用
          </Link>
          {me.data?.isAdmin ? (
            <Link to="/admin" data-testid="admin-link" className="rounded px-1 py-1 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900">
              管理
            </Link>
          ) : null}
          <button type="button" className="rounded px-1 py-1 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900" onClick={onLogout}>
            退出
          </button>
        </nav>
      </div>
    </aside>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-neutral-400">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
