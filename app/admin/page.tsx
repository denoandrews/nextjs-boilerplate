import { headers } from "next/headers";
import { requireAdminContext } from "@/lib/admin-auth";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";
import { UploadForm } from "./upload-form";

export default async function AdminPage() {
  const context = await requireAdminContext();
  const supabase = await createClient();
  const [{ data: documents }, { count: questionCount }, { data: recentQuestions }, { data: usageData }] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, document_type, status, created_at")
      .eq("municipality_id", context.municipalityId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("messages")
      .select("id, conversations!inner(municipality_id)", { count: "exact", head: true })
      .eq("role", "user")
      .eq("conversations.municipality_id", context.municipalityId),
    supabase
      .from("messages")
      .select("id, content, created_at, conversations!inner(municipality_id)")
      .eq("role", "user")
      .eq("conversations.municipality_id", context.municipalityId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.rpc("get_municipality_usage_summary", {
      p_municipality_id: context.municipalityId,
    }),
  ]);
  const usage = Array.isArray(usageData) ? usageData[0] : usageData;
  const monthlyQueryCount = Number(usage?.query_count ?? 0);
  const monthlyQueryLimit = Number(usage?.monthly_limit ?? 15_000);
  const estimatedCost = Number(usage?.estimated_cost_microusd ?? 0) / 1_000_000;
  const requestHeaders = await headers();
  const origin = requestHeaders.get("x-forwarded-host")
    ? `${requestHeaders.get("x-forwarded-proto") || "https"}://${requestHeaders.get("x-forwarded-host")}`
    : process.env.NEXT_PUBLIC_APP_URL || "https://your-munigpt-domain.example";
  const embedUrl = `${origin}/widget/${context.municipalitySlug}`;
  const embedCode = `<iframe src="${embedUrl}" title="${context.municipalityName} public records assistant" width="100%" height="640" loading="lazy"></iframe>`;

  return (
    <main className="admin-shell">
      <header className="admin-topbar">
        <div><p className="eyebrow">MuniGPT administration</p><h1>{context.municipalityName}</h1></div>
        <SignOutButton />
      </header>
      <section className="admin-grid">
        <article className="admin-card metric"><strong>{documents?.length ?? 0}</strong><span>Recent documents</span></article>
        <article className="admin-card metric"><strong>{questionCount ?? 0}</strong><span>Public questions saved</span></article>
        <article className="admin-card metric"><strong>{monthlyQueryCount.toLocaleString()} / {monthlyQueryLimit.toLocaleString()}</strong><span>Questions this month</span></article>
        <article className="admin-card metric"><strong>{estimatedCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}</strong><span>Estimated OpenAI cost this month</span></article>
      </section>
      <section className="admin-card">
        <h2>Upload a public document</h2>
        <p>Accepted: PDF, Word, text, Markdown, and HTML. Maximum 20 MB.</p>
        <UploadForm canEdit={context.role === "admin" || context.role === "editor"} />
      </section>
      <section className="admin-card">
        <h2>Documents</h2>
        {documents?.length ? (
          <div className="table-wrap"><table><thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Added</th></tr></thead><tbody>
            {documents.map((document) => <tr key={document.id}><td>{document.title}</td><td>{document.document_type}</td><td><span className={`status-badge status-${document.status}`}>{document.status}</span></td><td>{new Date(document.created_at).toLocaleDateString()}</td></tr>)}
          </tbody></table></div>
        ) : <p>No documents have been uploaded yet.</p>}
      </section>
      <section className="admin-card">
        <h2>Recent public questions</h2>
        <p>Anonymous questions are retained according to the municipality&apos;s configured retention period.</p>
        {recentQuestions?.length ? (
          <div className="table-wrap"><table><thead><tr><th>Question</th><th>Asked</th></tr></thead><tbody>
            {recentQuestions.map((question) => <tr key={question.id}><td>{question.content}</td><td>{new Date(question.created_at).toLocaleString()}</td></tr>)}
          </tbody></table></div>
        ) : <p>No public questions have been saved yet.</p>}
      </section>
      <section className="admin-card">
        <h2>Website embed</h2>
        <p>Paste this HTML into the municipality website.</p>
        <textarea className="embed-code" readOnly value={embedCode} aria-label="Embed code" />
      </section>
    </main>
  );
}
