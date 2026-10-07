"use client";

import { FormEvent, useRef, useState } from "react";

type Role = "user" | "assistant";

type Citation = {
  fileId: string;
  filename: string;
};

type Message = {
  role: Role;
  text: string;
  citations?: Citation[];
};

type ChatResponse = {
  answer?: string;
  citations?: Citation[];
  error?: string;
  municipality?: string;
  requestId?: string;
};

const INITIAL_MESSAGE: Message = {
  role: "assistant",
  text: "Ask a question about the municipality's public records.",
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [municipality, setMunicipality] = useState("MuniGPT");
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
        body: JSON.stringify({ message: text, history }),
      });

      const data = (await response.json()) as ChatResponse;
      const assistantMessage: Message = {
        role: "assistant",
        text: data.answer ?? data.error ?? "MuniGPT could not complete that request.",
        citations: data.citations,
      };

      if (data.municipality) setMunicipality(data.municipality);
      setMessages([...nextMessages, assistantMessage]);
    } catch {
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          text: "MuniGPT could not connect. Please try again.",
        },
      ]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <main className="app-shell">
      <section className="chat-card" aria-labelledby="munigpt-title">
        <header className="chat-header">
          <p className="eyebrow">Public records research</p>
          <h1 id="munigpt-title">{municipality === "MuniGPT" ? municipality : `${municipality} MuniGPT`}</h1>
          <p>Informational only. Verify answers against the cited official records.</p>
        </header>

        <div className="messages" aria-live="polite" aria-busy={busy}>
          {messages.map((message, index) => (
            <article className={`message message-${message.role}`} key={`${message.role}-${index}`}>
              <span className="message-label">{message.role === "user" ? "You" : "MuniGPT"}</span>
              <p>{message.text}</p>

              {message.citations && message.citations.length > 0 ? (
                <div className="sources" aria-label="Sources">
                  <strong>Sources</strong>
                  <ul>
                    {message.citations.map((citation) => (
                      <li key={citation.fileId}>{citation.filename}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </article>
          ))}

          {busy ? <p className="status">Searching the public records…</p> : null}
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
    </main>
  );
}
