import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { api, taskLabel, type ChatMessage, type Conversation, type MemoryItem, type Step, type Task } from "./api.js";
import { Computer } from "./computer.js";
import { Routines } from "./routines.js";

export function ChatPage({ botId }: { botId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [stream, setStream] = useState("");
  const [machine, setMachine] = useState<"starting" | "ready" | "idle">("idle");
  const [error, setError] = useState("");
  const memories = useQuery({
    queryKey: ["memories", botId],
    queryFn: () => api<{ memories: MemoryItem[] }>(`/api/bots/${botId}/memories`),
  });
  const removeMemory = useMutation({
    mutationFn: (id: string) => api(`/api/bots/${botId}/memories/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["memories", botId] });
    },
    onError: (caught: Error) => setError(caught.message),
  });
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
      return latest && ["queued", "running", "waiting_input", "waiting_approval", "waiting_takeover"].includes(latest.state) ? 1000 : false;
    },
  });
  const task = tasks.data?.tasks[0];
  useEffect(() => {
    if (task?.state === "succeeded" || task?.state === "failed" || task?.state === "cancelled") {
      void queryClient.invalidateQueries({ queryKey: ["memories", botId] });
    }
  }, [botId, queryClient, task?.id, task?.state]);
  const steps = useQuery({
    queryKey: ["steps", task?.id],
    enabled: Boolean(task?.id),
    queryFn: () => api<{ steps: Step[] }>(`/api/tasks/${task?.id}/steps`),
    refetchInterval: task && ["queued", "running", "waiting_input", "waiting_approval", "waiting_takeover"].includes(task.state) ? 1000 : false,
  });
  const active = task?.state === "queued" || task?.state === "running";
  const stoppable = active || task?.state === "waiting_input" || task?.state === "waiting_approval" || task?.state === "waiting_takeover";
  const secret = task?.state === "waiting_input" ? pendingSecret(steps.data?.steps ?? []) : undefined;

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
  const acceptRemote = useMutation({
    mutationFn: () => api(`/api/tasks/${task?.id}/accept-remote-risk`, { method: "POST" }),
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
          {taskLabel(task?.state ?? "", machine, task?.error)}
        </p>
      </div>
      <Computer botId={botId} />
      <Routines botId={botId} />
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
        {secret && task ? (
          <SecretForm key={`${task.id}:${secret.name}`} taskId={task.id} request={secret} onDone={() => void queryClient.invalidateQueries({ queryKey: ["tasks", conversationId] })} />
        ) : null}
        <ol data-testid="step-list" className="space-y-2">
          {(steps.data?.steps ?? []).map((step) => (
            <li key={step.id}>
              <details className="rounded border border-neutral-800 px-3 py-2 text-sm">
                <summary className={step.kind === "compact" ? "text-neutral-500" : undefined}>
                  {stepTitle(step)}
                  {step.kind === "compact" ? "" : ` · ${step.status}`}
                </summary>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-neutral-300">{stepBody(step)}</pre>
              </details>
            </li>
          ))}
        </ol>
        {task?.error === "remote_unconfirmed" ? (
          <div className="rounded bg-red-950 p-3 text-sm text-red-100" data-testid="remote-unconfirmed">
            <p>停止只结束了本地等待。远端可能仍在执行。继续写操作或接管可能并发或重复。这不是远端已停止。</p>
            {task.remoteUncertain ? (
              <button
                type="button"
                data-testid="accept-remote-risk"
                className="mt-2 rounded border border-red-300 px-3 py-2"
                disabled={acceptRemote.isPending}
                onClick={() => acceptRemote.mutate()}
              >
                我知道远端可能仍在执行，仍要继续
              </button>
            ) : null}
          </div>
        ) : task?.error ? <pre className="overflow-auto rounded bg-red-950 p-3 text-sm text-red-100">{task.error}</pre> : null}
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
      </div>
      <div data-testid="memory-list" className="mt-6 rounded border border-neutral-800 p-3">
        <h2 className="text-sm font-medium">记忆</h2>
        <ul className="mt-2 space-y-2">
          {(memories.data?.memories ?? []).map((item) => (
            <li key={item.id} data-testid="memory-item" className="flex items-start justify-between gap-3 text-sm">
              <span className="whitespace-pre-wrap">{item.content}</span>
              <button
                data-testid={`delete-memory-${item.id}`}
                className="shrink-0 text-neutral-400"
                type="button"
                onClick={() => removeMemory.mutate(item.id)}
              >
                删除
              </button>
            </li>
          ))}
          {(memories.data?.memories.length ?? 0) === 0 ? <li className="text-sm text-neutral-500">还没有记忆</li> : null}
        </ul>
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
            disabled={!stoppable || stop.isPending}
            onClick={() => stop.mutate()}
          >
            {task?.error === "remote_unconfirmed" ? "停止本地等待" : "停止"}
          </button>
        </div>
      </form>
    </section>
  );
}

interface SecretRequestView {
  name: string;
  label: string;
  kind: "password" | "otp" | "text";
  reason: string;
}

function SecretForm({ taskId, request, onDone }: { taskId: string; request: SecretRequestView; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [save, setSave] = useState(request.kind === "password");
  const [error, setError] = useState("");
  const submit = useMutation({
    mutationFn: (decision: "provide" | "reject") =>
      api(`/api/tasks/${taskId}/secrets`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          name: request.name,
          ...(decision === "provide" ? { value, ...(request.kind === "otp" ? {} : { save }) } : {}),
        }),
      }),
    onSuccess: () => {
      setValue("");
      setError("");
      onDone();
    },
    onError: (caught: Error) => setError(caught.message),
  });

  return (
    <form
      data-testid="secret-form"
      className="grid gap-2 rounded border border-amber-700/60 bg-neutral-900 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate("provide");
      }}
    >
      <p className="text-sm font-medium">{request.label}</p>
      <p className="text-sm text-neutral-400">{request.reason}</p>
      <input
        data-testid="secret-value"
        className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2"
        type={request.kind === "text" ? "text" : "password"}
        autoComplete={request.kind === "otp" ? "one-time-code" : request.kind === "password" ? "current-password" : "off"}
        inputMode={request.kind === "otp" ? "numeric" : undefined}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      {request.kind === "otp" ? null : (
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input data-testid="secret-save" type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} />
          保存以便下次使用
        </label>
      )}
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      <div className="flex gap-2">
        <button data-testid="secret-submit" className="rounded bg-white px-3 py-2 text-sm font-medium text-neutral-950" type="submit" disabled={submit.isPending || value.length === 0}>
          提交
        </button>
        <button data-testid="secret-reject" className="rounded border border-neutral-600 px-3 py-2 text-sm" type="button" disabled={submit.isPending} onClick={() => submit.mutate("reject")}>
          拒绝
        </button>
      </div>
    </form>
  );
}

function pendingSecret(steps: Step[]): SecretRequestView | undefined {
  const step = [...steps].reverse().find((item) => item.kind === "tool" && item.status === "running");
  const request = step?.request;
  if (!request || typeof request !== "object") return undefined;
  const record = request as { name?: string; args?: { name?: string; label?: string; kind?: string; reason?: string } };
  if (record.name !== "request_secret" || !record.args) return undefined;
  const kind = record.args.kind;
  if (kind !== "password" && kind !== "otp" && kind !== "text") return undefined;
  if (!record.args.name || !record.args.label || !record.args.reason) return undefined;
  return { name: record.args.name, label: record.args.label, kind, reason: record.args.reason };
}

function stepTitle(step: Step): string {
  if (step.kind === "compact") return "已压缩较早的上下文";
  if (step.kind === "tool") return toolTitle(step);
  return "模型";
}

function toolTitle(step: Step): string {
  const request = step.request as { name?: string } | null;
  return request?.name ? `工具 ${request.name}` : "工具";
}

function stepBody(step: Step): string {
  if (step.kind === "compact") return "较早的对话已收成摘要，原文仍留在记录里。";
  const request = step.request as { name?: string; args?: unknown } | null;
  const response = step.response as { text?: string } | null;
  if (request?.name === "browser_screenshot") return response?.text ?? "截图";
  if (request?.name === "browser_snapshot") return clip(response?.text ?? "");
  const args = JSON.stringify(request?.args ?? request, null, 2);
  const result = response?.text ? `\n\n${clip(response.text)}` : "";
  return `${args}${result}`;
}

function clip(text: string): string {
  if (text.length <= 2000) return text;
  return `${text.slice(0, 2000)}\n…[已截断]…`;
}
