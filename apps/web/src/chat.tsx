import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, taskLabel, type ChatMessage, type MemoryItem, type Step, type Task } from "./api.js";
import { ApprovalList } from "./approval.js";
import { Computer } from "./computer.js";
import { BotMark } from "./presence.js";
import { Routines } from "./routines.js";

export function ChatPage({ botId }: { botId: string }) {
  const queryClient = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [stream, setStream] = useState("");
  const [machine, setMachine] = useState<"starting" | "ready" | "idle">("idle");
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState(false);
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
    queryFn: () => api<{ bot: { id: string; name: string; model: string; instructions: string } }>(`/api/bots/${botId}`),
  });
  const conversations = useQuery({
    queryKey: ["conversations", botId],
    queryFn: () => api<{ conversations: { id: string }[] }>(`/api/bots/${botId}/conversations`),
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
  const name = bot.data?.bot.name ?? "对话";
  const status = taskLabel(task?.state ?? "", machine, task?.error);

  useEffect(() => {
    setSheet(false);
  }, [botId]);

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

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.data, stream, secret, task?.error, error]);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 128)}px`;
  }, [draft]);

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

  function submitDraft() {
    if (send.isPending || draft.trim().length === 0) return;
    send.mutate(draft);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submitDraft();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitDraft();
  }

  const items = messages.data?.messages ?? [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#f5f5f5]">
        <header className="flex shrink-0 items-center gap-3 px-4 py-3 lg:hidden">
          <Link to="/" className="rounded-full px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 md:hidden">
            返回
          </Link>
          <h1 className="min-w-0 truncate text-[15px] font-medium lg:sr-only">{name}</h1>
          <p data-testid="task-status" className="ml-auto truncate text-xs text-neutral-500">
            {status}
          </p>
          <button
            type="button"
            className="rounded-full px-2 py-1 text-sm text-neutral-600 hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900 lg:hidden"
            onClick={() => setSheet(true)}
          >
            资料
          </button>
        </header>
        <div ref={scroller} data-testid="transcript" className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4 lg:pt-8">
          <ol data-testid="message-list" className="mx-auto grid w-full max-w-3xl gap-3">
            {items.map((message, index) => (
              <MessageItem key={message.id} message={message} previous={items[index - 1]} />
            ))}
            {stream ? (
              <li className="flex justify-start">
                <div className="max-w-[75%] rounded-[1.25rem] bg-[#e9e9e9] px-4 py-2.5 text-[15px] leading-6 text-neutral-800">
                  <p className="whitespace-pre-wrap break-words">{stream}</p>
                </div>
              </li>
            ) : null}
            {items.length === 0 && !stream ? <li className="py-16 text-center text-sm text-neutral-400">发一条消息，开始和 {name} 对话</li> : null}
          </ol>
        </div>
        {secret && task ? (
          <div className="mx-auto w-full max-w-3xl px-4">
            <SecretForm key={`${task.id}:${secret.name}`} taskId={task.id} request={secret} onDone={() => void queryClient.invalidateQueries({ queryKey: ["tasks", conversationId] })} />
          </div>
        ) : null}
        {task?.state === "waiting_approval" ? (
          <div className="mx-auto w-full max-w-3xl px-4">
            <section data-testid="task-approval" className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-neutral-900">
              <h2 className="mb-2 text-sm font-medium text-amber-950">待批准</h2>
              <ApprovalList taskId={task.id} />
            </section>
          </div>
        ) : null}
        {task?.error === "remote_unconfirmed" ? (
          <div className="mx-auto mb-3 w-full max-w-3xl rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-900 px-4" data-testid="remote-unconfirmed">
            <p>停止只结束了本地等待。远端可能仍在执行。继续写操作或接管可能并发或重复。这不是远端已停止。</p>
            {task.remoteUncertain ? (
              <button
                type="button"
                data-testid="accept-remote-risk"
                className="mt-2 rounded-full border border-red-400 px-3 py-2"
                disabled={acceptRemote.isPending}
                onClick={() => acceptRemote.mutate()}
              >
                我知道远端可能仍在执行，仍要继续
              </button>
            ) : null}
          </div>
        ) : task?.error ? (
          <pre className="mx-auto mb-3 max-h-48 w-full max-w-3xl overflow-auto whitespace-pre-wrap break-all rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{task.error}</pre>
        ) : null}
        {error ? <p className="mx-auto mb-3 w-full max-w-3xl px-4 text-sm text-red-700">{error}</p> : null}
        <form className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]" onSubmit={onSubmit}>
          <div className="flex items-end gap-2 rounded-full bg-white py-1.5 pr-1.5 pl-3 shadow-sm ring-1 ring-black/10">
            <select
              data-testid="send-mode"
              aria-label="发送方式"
              className="mb-1 h-9 max-w-[5.5rem] shrink-0 rounded-full bg-transparent text-sm text-neutral-600 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900"
              value={mode}
              onChange={(event) => setMode(event.target.value === "steer" ? "steer" : "queue")}
            >
              <option value="queue">排队</option>
              <option value="steer">打断</option>
            </select>
            <textarea
              ref={inputRef}
              data-testid="message-input"
              rows={1}
              aria-label={`给 ${name} 发消息`}
              className="max-h-32 min-h-10 w-full min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-neutral-900 outline-none placeholder:text-neutral-400"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={`给 ${name} 发消息`}
            />
            {stoppable ? (
              <button
                data-testid="stop-task"
                className="mb-1 shrink-0 rounded-full border border-neutral-300 px-3 py-2 text-sm text-neutral-700 disabled:opacity-40"
                type="button"
                disabled={stop.isPending}
                onClick={() => stop.mutate()}
              >
                {task?.error === "remote_unconfirmed" ? "停止本地等待" : "停止"}
              </button>
            ) : (
              <button data-testid="stop-task" className="sr-only" type="button" disabled>
                停止
              </button>
            )}
            <button
              data-testid="send-message"
              aria-label="发送"
              className="mb-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-neutral-900 text-white disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
              type="submit"
              disabled={send.isPending || draft.trim().length === 0}
            >
              <ArrowUp />
            </button>
          </div>
        </form>
      </section>
      {sheet ? (
        <button type="button" className="fixed inset-0 z-20 bg-black/30 lg:hidden" aria-label="关闭资料" onClick={() => setSheet(false)} />
      ) : null}
      <ProfilePanel
        botId={botId}
        name={name}
        model={bot.data?.bot.model ?? ""}
        instructions={bot.data?.bot.instructions ?? ""}
        machine={machine}
        sheet={sheet}
        onClose={() => setSheet(false)}
        status={status}
        memories={memories.data?.memories ?? []}
        memoryReady={Boolean(memories.data)}
        onDeleteMemory={(id) => removeMemory.mutate(id)}
        steps={steps.data?.steps ?? []}
      />
    </div>
  );
}

function ProfilePanel({
  botId,
  name,
  model,
  instructions,
  machine,
  sheet,
  onClose,
  status,
  memories,
  memoryReady,
  onDeleteMemory,
  steps,
}: {
  botId: string;
  name: string;
  model: string;
  instructions: string;
  machine: "starting" | "ready" | "idle";
  sheet: boolean;
  onClose: () => void;
  status: string;
  memories: MemoryItem[];
  memoryReady: boolean;
  onDeleteMemory: (id: string) => void;
  steps: Step[];
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<"activity" | "library">("activity");
  const [screen, setScreen] = useState(false);
  useEffect(() => {
    if (!sheet) return;
    closeRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sheet]);

  return (
    <aside
      className={`${sheet ? "fixed inset-y-0 right-0 z-30 flex w-[min(100%,24rem)] shadow-2xl" : "hidden"} min-h-0 flex-col border-l border-black/5 bg-white lg:static lg:flex lg:w-[320px] lg:shrink-0 lg:shadow-none`}
    >
      <div className="flex justify-end px-3 pt-3 lg:hidden">
        <button
          ref={closeRef}
          type="button"
          className="rounded-full px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900"
          onClick={onClose}
        >
          关闭
        </button>
      </div>
      <div className="flex flex-col items-center px-6 pt-4 pb-2">
        <BotMark name={name} className="size-20 rounded-[1.6rem] text-2xl" />
        <h2 className="mt-4 text-center text-xl font-semibold">{name}</h2>
        {model ? <p className="mt-1 text-sm text-neutral-500">{model}</p> : null}
        <p className="mt-1 text-sm text-neutral-500">{status}</p>
      </div>
      <div className="flex justify-center gap-6 px-6 pt-2 text-sm">
        <button
          type="button"
          className={`border-b-2 px-1 py-2 ${tab === "activity" ? "border-neutral-900 font-medium text-neutral-900" : "border-transparent text-neutral-400"}`}
          aria-pressed={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          动态
        </button>
        <button
          type="button"
          className={`border-b-2 px-1 py-2 ${tab === "library" ? "border-neutral-900 font-medium text-neutral-900" : "border-transparent text-neutral-400"}`}
          aria-pressed={tab === "library"}
          onClick={() => setTab("library")}
        >
          资料库
        </button>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto px-4 py-4 ${tab === "activity" ? "" : "hidden"}`}>
        <div className="grid gap-6">
          <Routines botId={botId} />
          <section>
            <h3 className="px-1 text-xs text-neutral-500">电脑</h3>
            <button
              type="button"
              className="mt-2 flex w-full items-center gap-3 rounded-2xl bg-[#f6f6f6] px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-900"
              aria-expanded={screen}
              onClick={() => setScreen((open) => !open)}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-neutral-200 text-xs text-neutral-600">屏</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Bot 的电脑</span>
                <span className="block text-xs text-neutral-500">{machineCaption(machine)}</span>
              </span>
            </button>
            {screen ? (
              <div className="mt-3">
                <Computer botId={botId} />
              </div>
            ) : null}
          </section>
          <section>
            <h3 className="px-1 text-xs text-neutral-500">步骤</h3>
            <ol data-testid="step-list" className="mt-2 grid gap-2">
              {steps.map((step) => (
                <li key={step.id}>
                  <details className="rounded-2xl bg-[#f6f6f6] px-3 py-2 text-sm">
                    <summary className={`cursor-pointer break-all ${step.kind === "compact" ? "text-neutral-500" : ""}`}>
                      {stepTitle(step)}
                      {step.kind === "compact" ? "" : ` · ${step.status}`}
                    </summary>
                    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-600">{stepBody(step)}</pre>
                  </details>
                </li>
              ))}
              {steps.length === 0 ? <li className="px-1 text-sm text-neutral-400">还没有步骤</li> : null}
            </ol>
          </section>
        </div>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto px-4 py-4 ${tab === "library" ? "" : "hidden"}`}>
        {instructions ? (
          <section className="mb-6">
            <h3 className="text-xs text-neutral-500">指令</h3>
            <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">{instructions}</p>
          </section>
        ) : null}
        <div data-testid="memory-list">
          <h3 className="text-xs text-neutral-500">记忆</h3>
          <ul className="mt-2 grid gap-2">
            {memories.map((item) => (
              <li key={item.id} data-testid="memory-item" className="flex items-start justify-between gap-3 rounded-2xl bg-[#f6f6f6] px-3 py-2 text-sm">
                <span className="whitespace-pre-wrap">{item.content}</span>
                <button
                  data-testid={`delete-memory-${item.id}`}
                  className="shrink-0 rounded px-1 text-neutral-500 hover:text-neutral-900"
                  type="button"
                  onClick={() => onDeleteMemory(item.id)}
                >
                  删除
                </button>
              </li>
            ))}
            {memoryReady && memories.length === 0 ? <li className="text-sm text-neutral-400">还没有记忆</li> : null}
          </ul>
        </div>
      </div>
    </aside>
  );
}

function MessageItem({ message, previous }: { message: ChatMessage; previous?: ChatMessage | undefined }) {
  const text = messageText(message);
  const stamp = showStamp(message.createdAt, previous?.createdAt) ? formatStamp(message.createdAt) : null;
  return (
    <>
      {stamp ? <li className="py-1 text-center text-xs text-neutral-400">{stamp}</li> : null}
      {message.role === "toolResult" ? (
        <li className="max-w-[85%] justify-self-start rounded-2xl bg-white px-3 py-2 text-xs text-neutral-500 ring-1 ring-black/5">
          <p>工具结果{message.toolName ? ` · ${message.toolName}` : ""}{message.isError ? " · 失败" : ""}</p>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all">{text}</pre>
        </li>
      ) : message.role === "user" ? (
        <li className="flex justify-end">
          <div className="max-w-[75%] rounded-[1.25rem] bg-white px-4 py-2.5 text-[15px] leading-6 text-neutral-900 shadow-sm ring-1 ring-black/5">
            <p className="whitespace-pre-wrap break-words">{text}</p>
          </div>
        </li>
      ) : (
        <li className="flex justify-start">
          <div className="max-w-[75%] rounded-[1.25rem] bg-[#e9e9e9] px-4 py-2.5 text-[15px] leading-6 text-neutral-900">
            <p className="whitespace-pre-wrap break-words">{text}</p>
          </div>
        </li>
      )}
    </>
  );
}

function messageText(message: ChatMessage): string {
  if (message.text.trim()) return message.text;
  if (message.toolCalls?.length) return message.toolCalls.map((call) => call.name).join("、");
  return "";
}

function showStamp(current: string, previous?: string): boolean {
  const next = Date.parse(current);
  if (!Number.isFinite(next)) return false;
  if (!previous) return true;
  const prev = Date.parse(previous);
  if (!Number.isFinite(prev)) return true;
  return next - prev > 5 * 60_000;
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (start === startToday) return `今天 ${time}`;
  if (startToday - start === 86_400_000) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function machineCaption(machine: "starting" | "ready" | "idle"): string {
  if (machine === "starting") return "启动中";
  if (machine === "ready") return "使用中";
  return "空闲";
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
      className="mb-3 grid gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-neutral-900"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate("provide");
      }}
    >
      <p className="text-sm font-medium">{request.label}</p>
      <p className="text-sm text-neutral-600">{request.reason}</p>
      <input
        data-testid="secret-value"
        className="rounded-xl border border-neutral-300 bg-white px-3 py-2"
        type={request.kind === "text" ? "text" : "password"}
        autoComplete={request.kind === "otp" ? "one-time-code" : request.kind === "password" ? "current-password" : "off"}
        inputMode={request.kind === "otp" ? "numeric" : undefined}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      {request.kind === "otp" ? null : (
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input data-testid="secret-save" type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} />
          保存以便下次使用
        </label>
      )}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <div className="flex gap-2">
        <button data-testid="secret-submit" className="rounded-full bg-neutral-900 px-3 py-2 text-sm font-medium text-white" type="submit" disabled={submit.isPending || value.length === 0}>
          提交
        </button>
        <button data-testid="secret-reject" className="rounded-full border border-neutral-300 px-3 py-2 text-sm" type="button" disabled={submit.isPending} onClick={() => submit.mutate("reject")}>
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

function ArrowUp() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 12.5V3.5M8 3.5 4.5 7M8 3.5 11.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
