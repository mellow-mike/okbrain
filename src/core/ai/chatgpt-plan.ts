import type { ChatMessage } from "./recipes.ts";

export interface ChatgptPlanStatus {
  connected: boolean;
  sharing: boolean;
}

export interface ChatgptPlanAnswer {
  model: string;
  text: string;
}

/** Local account control and text inference are the only capabilities for this route. */
export interface ChatgptPlan {
  connect(): Promise<ChatgptPlanStatus>;
  status(): Promise<ChatgptPlanStatus>;
  disconnect(): Promise<void>;
  complete(messages: ChatMessage[], model?: string): Promise<ChatgptPlanAnswer>;
}
