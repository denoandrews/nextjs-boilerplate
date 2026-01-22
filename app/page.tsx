"use client";

import { useState } from "react";

type Role = "user" | "assistant";
type Msg = { role: Role; text: string };

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", text: "MuniGPT demo. Type a question below." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    setBusy(true);
    setInput("");

    const next: Msg[] = [...messages, { role: "user" as Role, text }];
    setMessages(next);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = (await res.json()) as {
  reply?: string;
  citations?: { file_id: string; filename: string }[];
};

      const replyMsg: Msg = {
        role: "assistant",
        text: data.reply ?? "No reply.",
      };

      setMessages([...next, replyMsg]);
    } catch {
      setMessages([...next, { role: "assistant", text: "Error calling /api/chat" }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", fontFamily: "system-ui", padding: 16 }}>
      <h1 style={{ marginBottom: 6 }}>MuniGPT Demo</h1>
      <div style={{ color: "#555", marginBottom: 16 }}>
        Informational only. Verify against official records.
      </div>

      <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12, height: 420, overflowY: "auto" }}>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
              {m.role === "user" ? "You" : "MuniGPT"}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Type a question"
          style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
        />
        <button
          onClick={send}
          disabled={busy}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd" }}
        >
          {busy ? "Sending" : "Send"}
        </button>
      </div>
    </main>
  );
}
