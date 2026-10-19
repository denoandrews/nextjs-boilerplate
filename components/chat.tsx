"use client";

import { FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHAT_CLIENT_TIMEOUT_MS } from "@/lib/chat-request";
import { chatStorageKey, parseChatSnapshot, serializeChatSnapshot, type StoredMessage } from "@/lib/chat-session";
import { answerSegments, approvedNewspaperUrl, type ChatCitation } from "@/lib/news-search";
import { safeHttpsUrl } from "@/lib/source-links";
import { sourceLabels, uiLocale } from "@/lib/ui-locale";

type Role = "user" | "assistant";
type Citation = ChatCitation;
type Message = StoredMessage & { role: Role; citations?: Citation[] };
type ChatResponse = {
  answer?: string;
  newsSearched?: boolean;
  citations?: Citation[];
  error?: string;
  municipality?: string;
  requestId?: string;
  conversationId?: string;
};

const INITIAL_MESSAGE: Message = {
  role: "assistant",
  text: "Ask a question about the municipality's public records.",
};

function isGreeting(message: Message) {
  return (
    message.role === "assistant" &&
    message.text === INITIAL_MESSAGE.text &&
    !message.citations?.length &&
    !message.retryQuestion
  );
}

function getAnonymousSessionId() {
  const key = "munigpt-anonymous-session";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(key, created);
  return created;
}

function readSnapshot(slug?: string) {
  try {
    return parseChatSnapshot(window.sessionStorage.getItem(chatStorageKey(slug)));
  } catch {
    return null;
  }
}

function writeSnapshot(slug: string | undefined, messages: Message[], conversationId?: string, municipality?: string) {
  try {
    window.sessionStorage.setItem(
      chatStorageKey(slug),
      serializeChatSnapshot({ messages, conversationId, municipality })
    );
  } catch {
    // A full quota or private mode should not block the conversation.
  }
}

export function Chat({ municipalitySlug, compact = false }: { municipalitySlug?: string; compact?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [municipality, setMunicipality] = useState("MuniGPT");
  const [ready, setReady] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  useLayoutEffect(() => {
    const saved = readSnapshot(municipalitySlug);
    if (saved) {
      setMessages(saved.messages);
      conversationId.current = saved.conversationId;
      if (saved.municipality) setMunicipality(saved.municipality);
    }
    setReady(true);
  }, [municipalitySlug]);

  useEffect(() => {
    if (!ready) return;
    writeSnapshot(municipalitySlug, messages, conversationId.current, municipality);
  }, [ready, messages, municipality, municipalitySlug]);

  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  async function sendQuestion(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;

    const prior = messages[messages.length - 1]?.retryQuestion === text ? messages.slice(0, -1) : messages;
    const userMessage: Message = { role: "user", text };
    const nextMessages = [...prior, userMessage];
    setBusy(true);
    setInput("");
    setMessages(nextMessages);

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), CHAT_CLIENT_TIMEOUT_MS);
    abortRef.current = controller;

    try {
      const history = prior
        .filter((message) => !isGreeting(message) && !message.retryQuestion)
        .map((message) => ({ role: message.role, content: message.text }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          history,
          municipalitySlug,
          conversationId: conversationId.current,
          anonymousSessionId: getAnonymousSessionId(),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as ChatResponse;
      if (data.conversationId) conversationId.current = data.conversationId;
      if (data.municipality) setMunicipality(data.municipality);
      const failed = !response.ok || !data.answer;
      if (aliveRef.current) {
        setMessages([
          ...nextMessages,
          {
            role: "assistant",
            text: data.answer ?? data.error ?? "MuniGPT could not complete that request.",
            citations: data.citations,
            newsSearched: data.newsSearched,
            ...(failed ? { retryQuestion: text } : {}),
          },
        ]);
      }
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      if (aliveRef.current) {
        setMessages([
          ...nextMessages,
          {
            role: "assistant",
            text: timedOut
              ? "That search took too long. Please try again."
              : "MuniGPT could not connect. Please try again.",
            retryQuestion: text,
          },
        ]);
      }
    } finally {
      window.clearTimeout(timer);
      if (abortRef.current === controller) abortRef.current = null;
      if (aliveRef.current) {
        setBusy(false);
        inputRef.current?.focus();
      }
    }
  }

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendQuestion(input);
  }

  return (
    <section className={`chat-card${compact ? " chat-card-compact" : ""}`} aria-labelledby="munigpt-title">
      <header className="chat-header">
        <p className="eyebrow">Public records research</p>
        <h1 id="munigpt-title">
          {municipality === "MuniGPT" ? municipality : `${municipality} MuniGPT`}
        </h1>
        <p className="chat-note">Informational only. Verify answers against the cited official records.</p>
        {municipalitySlug === "oak-park-il" ? <p className="chat-news">News search: Wednesday Journal and Chicago Tribune. Article availability may be limited by access restrictions.</p> : null}
      </header>

      <div className="messages" ref={messagesRef} aria-live="polite" aria-busy={busy}>
        {messages.map((message, index) => {
          const previousQuestion = [...messages.slice(0, index + 1)].reverse().find((item) => item.role === "user");
          const labels = sourceLabels(uiLocale(`${previousQuestion?.text ?? ""} ${message.text}`));
          return (
            <article className={`message message-${message.role}`} key={`${message.role}-${index}`}>
              <span className="message-label">{message.role === "user" ? labels.you : "MuniGPT"}</span>
              <p>{answerSegments(message.text, message.citations, municipalitySlug).map((part, partIndex) =>
                part.href ? <a key={partIndex} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a> : part.text
              )}</p>
              {message.newsSearched ? <p className="status">Searched the approved newspapers. News reporting is a secondary source.</p> : null}
              {message.citations?.length ? (
                <div className="sources" aria-label={labels.sources}>
                  <strong>{labels.sources}</strong>
                  <ul>
                    {message.citations.map((citation) => {
                      const href = citation.url ? safeHttpsUrl(citation.url) : null;
                      const news = href ? approvedNewspaperUrl(href) : null;
                      return (
                        <li key={citation.fileId}>
                          <span>{news ? `${labels.news}: ` : `${labels.document}: `}</span>
                          {href ? <a href={href} target="_blank" rel="noopener noreferrer">{citation.filename}</a> : citation.filename}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              {message.retryQuestion ? (
                <button type="button" className="retry-button" onClick={() => void sendQuestion(message.retryQuestion!)}>
                  {labels.tryAgain}
                </button>
              ) : null}
            </article>
          );
        })}
        {busy ? <p className="status">Searching records and available sources…</p> : null}
      </div>

      <form className="composer" onSubmit={send}>
        <label htmlFor="munigpt-question" className={compact ? "sr-only" : undefined}>Ask a question</label>
        <div className="composer-row">
          <input
            id="munigpt-question"
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="What would you like to research?"
            maxLength={2_000}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !input.trim()}>
            {busy ? "Searching" : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}
