"use client";

import { FormEvent, useRef, useState } from "react";
import { approvedNewspaperUrl, splitNewsReferences, type ChatCitation } from "@/lib/news-search";

type Role = "user" | "assistant";
type Citation = ChatCitation;
type Message = { role: Role; text: string; citations?: Citation[]; newsSearched?: boolean };
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

function getAnonymousSessionId() {
  const key = "munigpt-anonymous-session";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(key, created);
  return created;
}

export function Chat({ municipalitySlug, compact = false }: { municipalitySlug?: string; compact?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [municipality, setMunicipality] = useState("MuniGPT");
  const conversationId = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    const userMessage: Message = { role: "user", text };
    const nextMessages = [...messages, userMessage];
    setBusy(true);
    setInput("");
    setMessages(nextMessages);

    try {
      const history = messages
        .filter((message) => message !== INITIAL_MESSAGE)
        .map((message) => ({ role: message.role, content: message.text }));
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history,
          municipalitySlug,
          conversationId: conversationId.current,
          anonymousSessionId: getAnonymousSessionId(),
        }),
      });
      const data = (await response.json()) as ChatResponse;
      if (data.conversationId) conversationId.current = data.conversationId;
      if (data.municipality) setMunicipality(data.municipality);
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          text: data.answer ?? data.error ?? "MuniGPT could not complete that request.",
          citations: data.citations,
          newsSearched: data.newsSearched,
        },
      ]);
    } catch {
      setMessages([
        ...nextMessages,
        { role: "assistant", text: "MuniGPT could not connect. Please try again." },
      ]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <section className={`chat-card${compact ? " chat-card-compact" : ""}`} aria-labelledby="munigpt-title">
      <header className="chat-header">
        <p className="eyebrow">Public records research</p>
        <h1 id="munigpt-title">
          {municipality === "MuniGPT" ? municipality : `${municipality} MuniGPT`}
        </h1>
        <p>Informational only. Verify answers against the cited official records.</p>
        {municipalitySlug === "oak-park-il" ? <p>News search: Wednesday Journal and Chicago Tribune. Article availability may be limited by access restrictions.</p> : null}
      </header>

      <div className="messages" aria-live="polite" aria-busy={busy}>
        {messages.map((message, index) => (
          <article className={`message message-${message.role}`} key={`${message.role}-${index}`}>
            <span className="message-label">{message.role === "user" ? "You" : "MuniGPT"}</span>
            <p>{splitNewsReferences(message.text, message.citations).map((part, partIndex) =>
              part.citation?.url ? <a key={partIndex} href={part.citation.url} target="_blank" rel="noopener noreferrer" aria-label={`News source: ${part.citation.filename}`}>{part.text}</a> : part.text
            )}</p>
            {message.newsSearched ? <p className="status">Searched the approved newspapers. News reporting is a secondary source.</p> : null}
            {message.citations?.length ? (
              <div className="sources" aria-label="Sources">
                <strong>Sources</strong>
                <ul>
                  {message.citations.map((citation) => (
                    <li key={citation.fileId}>
                      {citation.url && approvedNewspaperUrl(citation.url) ? (
                        <><span>News: </span><a href={citation.url} target="_blank" rel="noopener noreferrer">{citation.filename}</a></>
                      ) : <><span>Document: </span>{citation.filename}</>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
        ))}
        {busy ? <p className="status">Searching records and available sources…</p> : null}
      </div>

      <form className="composer" onSubmit={send}>
        <label htmlFor="munigpt-question">Ask a question</label>
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

