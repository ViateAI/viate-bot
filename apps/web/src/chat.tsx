import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { api, taskLabel, type ChatMessage, type Conversation, type Step, type Task } from "./api.js";

export function ChatPage({ botId }: { botId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [stream, setStream] = useState("");
  const [machine, setMachine] = useState<"starting" | "ready" | "idle">("idle");
  const [error, setError] = useState("");
  const bot = useQuery({
    queryKey: ["bot", botId],
    queryFn: () => api<{ bot: { id: string; name: string; model: string } }>(`/api/bots/${botId}`),
  });
  const conversations = useQuery({
    queryKey: ["conversations", botId],
    queryFn: () => api<{ conversations: Conversation[] }>(`/api/bots/${botId}/conversations`),
  });
  const conversationId = conversations.data?.conversations[0]?.id;
  const messages = useQuery({
    queryKey: ["messages", conversationId],
    enabled: Boolean(conversationId),
    queryFn: () => api<{ messages: ChatMessage[] }>(`/api/conversations/${conversationId}/messages`),
  });
  const tasks = useQuery({
    queryKey: ["tasks", conversationId],
    enabled: Boolean(conversationId),
    queryFn: () => api<{ tasks: Task[] }>(`/api/conversations/${conversationId}/tasks`),
    refetchInterval: (query) => {
      const latest = query.state.data?.tasks[0];
      return latest && (latest.state === "queued" || latest.state === "running") ? 1000 : false;
    },
  });
  const task = tasks.data?.tasks[0];
  const steps = useQuery({
    queryKey: ["steps", task?.id],
    enabled: Boolean(task?.id),
    queryFn: () => api<{ steps: Step[] }>(`/api/tasks/${task?.id}/steps`),
    refetchInterval: task && (task.state === "queued" || task.state === "running") ? 1000 : false,
  });
  const active = task?.state === "queued" || task?.state === "running";

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socket.addEventListener("open", () => {
      if (conversationId) socket.send(JSON.stringify({ type: "subscribe", conversationId }));
    });
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data)) as {
        type?: string;
        text?: string;
        phase?: "starting" | "ready";
        conversationId?: string;
      };
      if (data.type === "machine" && data.phase) setMachine(data.phase);
      if (data.type === "delta" && typeof data.text === "string") setStream(data.text);
      if (data.type === "message" || data.type === "task" || data.type === "step") {
        if (data.type === "message") setStream("");
        void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
        void queryClient.invalidateQueries({ queryKey: ["tasks", conversationId] });
        void queryClient.invalidateQueries({ queryKey: ["steps"] });
        void queryClient.invalidateQueries({ queryKey: ["conversations", botId] });
      }
    });
    return () => socket.close();
  }, [botId, conversationId, queryClient]);

  const send = useMutation({
    mutationFn: (text: string) =>
      api(`/api/bots/${botId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          text,
          mode: active ? mode : "queue",
          ...(conversationId ? { conversationId } : {}),
        }),
      }),
    onSuccess: async () => {
      setDraft("");
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["conversations", botId] });
      await queryClient.invalidateQueries({ queryKey: ["messages"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (caught: Error) => setError(caught.message),
  });
  const stop = useMutation({
    mutationFn: () => api(`/api/tasks/${task?.id}/stop`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["tasks", conversationId] });
    },
    onError: (caught: Error) => setError(caught.message),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send.mutate(draft);
  }

  return (
    <section className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link to="/" className="text-sm text-neutral-400">
            返回
          </Link>
          <h1 className="text-xl font-semibold">{bot.data?.bot.name ?? "对话"}</h1>
        </div>
        <p data-testid="task-status" className="text-sm text-amber-200">
          {taskLabel(task?.state ?? "", machine)}
        </p>
      </div>
      <div data-testid="transcript" className="mt-6 flex-1 space-y-4">
        <ol data-testid="message-list" className="space-y-3">
          {(messages.data?.messages ?? []).map((message) => (
            <li key={message.id} className="rounded border border-neutral-800 px-3 py-2">
              <p className="text-xs text-neutral-500">{message.role === "toolResult" ? "工具结果" : message.role}</p>
              <p className="whitespace-pre-wrap">{message.text}</p>
            </li>
          ))}
          {stream ? (
            <li className="rounded border border-dashed border-neutral-700 px-3 py-2 text-neutral-300">
              <p className="text-xs text-neutral-500">assistant</p>
              <p className="whitespace-pre-wrap">{stream}</p>
            </li>
          ) : null}
        </ol>
        <ol data-testid="step-list" className="space-y-2">
          {(steps.data?.steps ?? []).map((step) => (
            <li key={step.id}>
              <details className="rounded border border-neutral-800 px-3 py-2 text-sm">
                <summary>
                  {step.kind === "tool" ? "工具" : "模型"} · {step.status}
                </summary>
                <pre className="mt-2 overflow-auto text-xs text-neutral-300">{JSON.stringify(step.request, null, 2)}</pre>
                <pre className="mt-2 overflow-auto text-xs text-neutral-400">{JSON.stringify(step.response, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
        {task?.error ? <pre className="overflow-auto rounded bg-red-950 p-3 text-sm text-red-100">{task.error}</pre> : null}
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
      </div>
      <form className="mt-4 grid gap-2" onSubmit={onSubmit}>
        <textarea
          data-testid="message-input"
          className="min-h-20 rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="发一条消息"
        />
        <div className="flex items-center gap-2">
          <select
            data-testid="send-mode"
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-2 text-sm"
            value={mode}
            onChange={(event) => setMode(event.target.value === "steer" ? "steer" : "queue")}
          >
            <option value="queue">排队发送</option>
            <option value="steer">打断并发送</option>
          </select>
          <button
            data-testid="send-message"
            className="rounded bg-white px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50"
            type="submit"
            disabled={send.isPending || draft.trim().length === 0}
          >
            发送
          </button>
          <button
            data-testid="stop-task"
            className="rounded border border-neutral-600 px-3 py-2 text-sm disabled:opacity-40"
            type="button"
            disabled={!active || stop.isPending}
            onClick={() => stop.mutate()}
          >
            停止
          </button>
        </div>
      </form>
    </section>
  );
}
