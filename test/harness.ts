// A minimal fake of Pi's extension API: records handlers, commands, entries and UI calls.
type Handler = (event: any, ctx: any) => unknown;

export interface FakeJev {
  calls: Array<{ state: Record<string, unknown>; questions: Record<string, any>; options: any }>;
  answer: (questions: Record<string, any>, state: Record<string, unknown>) => any;
}

export function fakeJev(answer: FakeJev["answer"]): FakeJev & { registry: unknown } {
  const calls: FakeJev["calls"] = [];
  const registry = {
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id }),
    classify: async (_model: unknown, context: any, options: any) => {
      calls.push({ state: context.state, questions: context.questions, options });
      const result = answer(context.questions, context.state);
      if (result && typeof result === "object" && "stopReason" in result) return result;
      return { model: "jev-latest", stopReason: "stop", answers: result, usage: usage(300) };
    },
  };
  return { calls, answer, registry };
}

export function usage(input: number) {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function harness(options: { tools?: any[]; exec?: (cmd: string, args: string[]) => any } = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const messages: any[] = [];
  let thinking = "high";
  const thinkingChanges: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerShortcut: (key: string, options: any) => shortcuts.set(key, options),
    registerTool: () => undefined,
    registerFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    registerEntryRenderer: () => undefined,
    getFlag: () => undefined,
    getAllTools: () => options.tools ?? [],
    exec: async (cmd: string, args: string[]) => options.exec?.(cmd, args) ?? { code: 1, stdout: "", stderr: "", killed: false },
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    sendMessage: (message: any, opts: any) => messages.push({ message, opts }),
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: string) => {
      thinking = level;
      thinkingChanges.push(level);
      void emit("thinking_level_select", { type: "thinking_level_select", level, previousLevel: "?" });
    },
    events: { emit: () => undefined, on: () => () => undefined },
  };
  async function emit(event: string, payload: any, ctx?: any) {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx ?? lastCtx)) ?? result;
    return result;
  }
  let lastCtx: any;
  function ctx(overrides: Record<string, unknown> = {}) {
    const ui = {
      selects: [] as Array<{ title: string; options: string[] }>,
      selectAnswers: [] as Array<string | undefined>,
      inputAnswers: [] as Array<string | undefined>,
      notes: [] as Array<{ message: string; type?: string }>,
      status: new Map<string, string | undefined>(),
      select: async (title: string, opts: string[]) => {
        ui.selects.push({ title, options: opts });
        return ui.selectAnswers.shift();
      },
      input: async () => ui.inputAnswers.shift(),
      confirm: async () => true,
      notify: (message: string, type?: string) => ui.notes.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => ui.status.set(key, text),
      custom: async () => undefined,
    };
    lastCtx = {
      cwd: "/Users/me/Projects/app",
      hasUI: true,
      mode: "tui",
      ui,
      signal: undefined,
      sessionManager: { getBranch: () => [], getSessionId: () => "session-1" },
      modelRegistry: undefined,
      ...overrides,
    };
    return lastCtx;
  }
  return { pi: pi as any, handlers, commands, shortcuts, entries, messages, emit, ctx, thinkingChanges, get thinking() { return thinking; } };
}

export function userEntry(text: string) {
  return { type: "message", id: `u${Math.random()}`, message: { role: "user", content: text } };
}

export function assistantEntry(text: string) {
  return { type: "message", id: `a${Math.random()}`, message: { role: "assistant", content: [{ type: "text", text }] } };
}
