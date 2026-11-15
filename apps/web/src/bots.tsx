import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api, type Bot, type Me } from "./api.js";

export function BotList() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me") });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<{ bots: Bot[] }>("/api/bots") });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api<{ models: string[]; unrestricted: boolean }>("/api/models"),
  });
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
    onSuccess: async () => {
      setName("");
      setModel("");
      setInstructions("");
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["bots"] });
    },
    onError: (caught: Error) => setError(caught.message),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  if (me.data && !me.data.provisioned) {
    return (
      <section className="mx-auto grid max-w-3xl gap-4 px-6 py-10">
        <h1 className="text-2xl font-semibold">我的 bot</h1>
        <p data-testid="not-provisioned" className="rounded border border-neutral-800 px-4 py-6 text-neutral-300">
          尚未开通，请联系管理员
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto grid max-w-3xl gap-8 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">我的 bot</h1>
        <p className="mt-2 text-sm text-neutral-400">每个 bot 用你自己的机器。第一台会在创建时准备好。</p>
      </div>
      <form className="grid gap-3 rounded-lg border border-neutral-800 p-4" onSubmit={onSubmit}>
        <label className="grid gap-1 text-sm">
          名字
          <input
            data-testid="bot-name"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <label className="grid gap-1 text-sm">
          模型
          <input
            data-testid="bot-model"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
            value={model}
            list="model-choices"
            onChange={(event) => setModel(event.target.value)}
            required
          />
          <datalist id="model-choices">
            {(models.data?.models ?? []).map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>
        <label className="grid gap-1 text-sm">
          指令
          <textarea
            data-testid="bot-instructions"
            className="min-h-24 rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
        <button
          data-testid="create-bot"
          className="rounded bg-white px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
          type="submit"
          disabled={create.isPending}
        >
          创建 bot
        </button>
      </form>
      <ul className="grid gap-2">
        {(bots.data?.bots ?? []).map((bot) => (
          <li key={bot.id}>
            <Link
              to="/b/$botId"
              params={{ botId: bot.id }}
              className="block rounded border border-neutral-800 px-4 py-3 hover:border-neutral-600"
            >
              <span className="font-medium">{bot.name}</span>
              <span className="ml-3 text-sm text-neutral-400">{bot.model}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
