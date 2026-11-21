import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api, type Bot, type Me } from "./api.js";
import { botAvatarUrl } from "./avatar-url.js";
import { BotMark } from "./presence.js";

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
  const line = (bot.bio || bot.instructions).trim().split("\n").find((item) => item.trim())?.trim();
  if (!line) return bot.model;
  return line.length > 36 ? `${line.slice(0, 36)}…` : line;
}

const field = "ui-field";

export function BotSidebar({ activeId }: { activeId?: string | undefined }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<{ bots: Bot[] }>("/api/bots"), refetchInterval: 1000 });
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

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-roster">
      <div className="flex items-center gap-2 px-3 py-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-elevated px-3 py-2 text-sm ring-1 ring-line">
          <SearchIcon />
          <input
            aria-label="搜索 bot"
            className="w-full bg-transparent text-fg outline-none placeholder:text-muted"
            placeholder="搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-elevated text-fg ring-1 ring-line hover:bg-hover"
          aria-expanded={creating}
          aria-label={creating ? "关闭新建" : "新建 bot"}
          onClick={() => setCreating((open) => !open)}
        >
          <PlusIcon />
        </button>
      </div>
      {me.data && !me.data.provisioned ? (
        <p data-testid="not-provisioned" className="mx-3 rounded-2xl bg-elevated px-4 py-6 text-sm text-secondary ring-1 ring-line">
          尚未开通，请联系管理员
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {creating ? (
            <form className="grid gap-3 rounded-2xl bg-elevated p-3 ring-1 ring-line" onSubmit={onSubmit}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">新建 bot</h2>
                <button type="button" className="text-sm text-muted" onClick={() => setCreating(false)}>
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
                {models.data?.unrestricted ? <span className="text-xs text-muted">可从建议里选，也可以输入其他模型名。</span> : null}
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
              {error ? <p className="text-sm text-danger">{error}</p> : null}
              <button data-testid="create-bot" className="ui-btn" type="submit" disabled={create.isPending}>
                创建 bot
              </button>
            </form>
          ) : (
            <>
              {bots.isPending ? <p className="px-2 py-3 text-sm text-muted">正在加载…</p> : null}
              {bots.isError ? <p role="alert" className="px-2 py-3 text-sm text-danger">{bots.error.message}</p> : null}
              {bots.data && listed.length === 0 ? (
                <p className="px-2 py-6 text-sm text-muted">{query.trim() ? "没有匹配的 bot" : "还没有 bot。点右上角加号创建一个。"}</p>
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
                        className={`bot-row flex items-center gap-2.5 rounded-xl py-1.5 pr-2 pl-3.5 ${selected ? "is-selected bg-active" : "hover:bg-hover"}`}
                      >
                        <BotMark name={bot.name} avatarUrl={botAvatarUrl(bot.id, bot.avatar, bot.updatedAt)} presence={bot.busy ? "live" : "idle"} className="size-10 text-xs" />
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[15px] font-medium text-fg">{bot.name}</span>
                            {bot.primary ? <span data-testid="primary-bot" className="shrink-0 rounded bg-active px-1.5 py-0.5 text-[10px] font-medium text-primary">主 bot</span> : null}
                            {bot.busy ? <span data-testid="bot-busy" aria-label="进行中" className="size-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" /> : null}
                          </span>
                          <span className="block truncate text-sm text-muted">{preview(bot)}</span>
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
    </aside>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-muted">
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
