export type StoredCitation = {
  fileId: string;
  filename: string;
  url?: string;
  marker?: string;
};

export type StoredMessage = {
  role: "user" | "assistant";
  text: string;
  citations?: StoredCitation[];
  newsSearched?: boolean;
  retryQuestion?: string;
};

export type ChatSnapshot = {
  messages: StoredMessage[];
  conversationId?: string;
  municipality?: string;
};

const MAX_STORED_MESSAGES = 40;

export function chatStorageKey(slug?: string) {
  return `munigpt-chat:${slug || "default"}`;
}

function sanitizeCitation(value: unknown): StoredCitation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.fileId !== "string" || typeof candidate.filename !== "string") return null;
  return {
    fileId: candidate.fileId.slice(0, 400),
    filename: candidate.filename.slice(0, 400),
    ...(typeof candidate.url === "string" ? { url: candidate.url.slice(0, 2_000) } : {}),
    ...(typeof candidate.marker === "string" ? { marker: candidate.marker.slice(0, 40) } : {}),
  };
}

function sanitizeMessage(value: unknown): StoredMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if ((candidate.role !== "user" && candidate.role !== "assistant") || typeof candidate.text !== "string") return null;
  const citations = Array.isArray(candidate.citations)
    ? candidate.citations.map(sanitizeCitation).filter((citation): citation is StoredCitation => citation !== null)
    : undefined;
  return {
    role: candidate.role,
    text: candidate.text.slice(0, 20_000),
    ...(citations?.length ? { citations } : {}),
    ...(candidate.newsSearched === true ? { newsSearched: true } : {}),
    ...(typeof candidate.retryQuestion === "string" ? { retryQuestion: candidate.retryQuestion.slice(0, 2_000) } : {}),
  };
}

export function parseChatSnapshot(raw: string | null): ChatSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.messages)) return null;
    const messages = record.messages
      .map(sanitizeMessage)
      .filter((message): message is StoredMessage => message !== null)
      .slice(-MAX_STORED_MESSAGES);
    if (!messages.length) return null;
    return {
      messages,
      ...(typeof record.conversationId === "string" ? { conversationId: record.conversationId.slice(0, 80) } : {}),
      ...(typeof record.municipality === "string" ? { municipality: record.municipality.slice(0, 120) } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeChatSnapshot(snapshot: ChatSnapshot) {
  return JSON.stringify({
    messages: snapshot.messages.slice(-MAX_STORED_MESSAGES),
    conversationId: snapshot.conversationId,
    municipality: snapshot.municipality,
  });
}
