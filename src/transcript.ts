/** Text of a message's content (string or blocks), without thinking or tool calls. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
}

interface EntryLike {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/** The latest user message and the latest assistant text on the branch. */
export function recentTexts(entries: readonly unknown[]): { user: string; assistant: string } {
  let user = "";
  let assistant = "";
  for (let i = entries.length - 1; i >= 0 && (!user || !assistant); i--) {
    const entry = entries[i] as EntryLike;
    if (entry?.type !== "message" || !entry.message) continue;
    const text = messageText(entry.message.content).trim();
    if (!text) continue;
    if (!user && entry.message.role === "user") user = text;
    if (!assistant && !user && entry.message.role === "assistant") assistant = text;
  }
  return { user, assistant };
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}
