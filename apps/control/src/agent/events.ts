import type { MessageView, StepView, TaskView } from "./view.js";

export type ChatEvent =
  | { type: "message"; conversationId: string; message: MessageView }
  | { type: "delta"; conversationId: string; taskId: string; text: string }
  | { type: "task"; conversationId: string; task: TaskView }
  | { type: "step"; conversationId: string; step: StepView }
  | { type: "machine"; conversationId: string; phase: "starting" | "ready" };

export interface ChatHub {
  publish(conversationId: string, event: ChatEvent): void;
}
