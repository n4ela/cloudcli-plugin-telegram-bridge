export type PluginContext = {
  theme: 'dark' | 'light';
  /** CloudCLI UI language. Older hosts omit it, so plugins must keep a fallback. */
  language?: string;
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};

export type PluginAPI = {
  readonly context: PluginContext;
  onContextChange(callback: (context: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
};

export type BridgeBinding = {
  key: string;
  chatId: number;
  threadId: number;
  chatTitle: string;
  sessionId: string;
  sessionTitle: string;
  ownerUserId: number;
  locale?: string;
  createdAt: string;
  permissionMode?: string;
};

export type BridgeStatus = {
  botConfigured: boolean;
  botUsername: string | null;
  telegramConnected: boolean;
  cloudcliConnected: boolean;
  serviceConfigured: boolean;
  bindings: BridgeBinding[];
  outboxPending: number;
  lastError: string | null;
};

export type BridgeSchedule = {
  id: string;
  name: string;
  sessionId: string;
  sessionTitle: string;
  prompt: string;
  time: string;
  timezone: string;
  model: string;
  effort: string;
  enabled: boolean;
  workingDirectory?: string;
  preCommand?: string[];
  createdAt: string;
  updatedAt: string;
};

export type BridgeScheduleStatus = BridgeSchedule & {
  unitName: string;
  timerActive: boolean;
  running: boolean;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
};
