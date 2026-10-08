# MuniGPT

MuniGPT is a public-records research assistant for municipalities. It answers questions only from configured OpenAI vector stores and displays file citations returned by the OpenAI Responses API.

This repository contains a tenant-ready product foundation: public cited chat, an iframe widget, municipal administrator sign-in, private document storage and vector-store ingestion, and persistent public-question logging.

## Local development

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Copy `.env.example` to `.env.local` and provide the required values.

3. Start the development server:

   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Server-side OpenAI API credential. Never expose it to the browser. |
| `VECTOR_STORE_ID` | Yes* | Existing single vector store configuration. |
| `VECTOR_STORE_IDS` | Yes* | Comma-separated vector store IDs for municipal, county, state, or trusted-source collections. Takes precedence over `VECTOR_STORE_ID`. |
| `MUNICIPALITY_NAME` | Recommended | Public name displayed by the assistant and used to scope its instructions. |
| `OPENAI_MODEL` | No | Responses API model. Defaults to `gpt-4.1-mini`. |
| `OPENAI_MAX_OUTPUT_TOKENS` | No | Hard answer ceiling. Defaults to `800`; constrained to 100–2,000. |
| `RATE_LIMIT_SALT` | Production | Secret salt used to hash public-client identifiers before rate-limit storage. |
| `MUNICIPALITY_SLUG` | Recommended | Slug used by the environment-only fallback tenant. |
| `NEXT_PUBLIC_SUPABASE_URL` | Admin | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Admin | Browser-safe Supabase publishable key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Logging | Server-only key used for anonymous chat logging and tenant lookup. |
| `NEXT_PUBLIC_APP_URL` | Recommended | Canonical app origin used to generate embed code. |
| `EMBED_FRAME_ANCESTORS` | Production | Space-separated CSP origins allowed to embed `/widget/*`. |

\* Configure either `VECTOR_STORE_ID` or `VECTOR_STORE_IDS`.

Supabase variables are configuration-gated. Without them, the existing public single-municipality chat still works from environment configuration, chat logging is skipped, and administrator access is unavailable.

## Supabase setup

1. Create a Supabase project.
2. Apply every SQL file in `supabase/migrations` in filename order with the Supabase CLI or SQL editor.
3. Create the first staff account under Authentication > Users. Public self-signup is not provided by this app.
4. Insert the municipality and first membership. `supabase/seed.sql` contains a commented template.
5. Add the three Supabase variables to the Vercel project for Preview and Production.
6. Add the municipality's OpenAI vector store ID to `municipalities.vector_store_ids`.
7. Set `EMBED_FRAME_ANCESTORS` to the approved municipal website origins, for example `'self' https://www.example.gov`.

The service-role key must remain server-side and must never use the `NEXT_PUBLIC_` prefix.

## Product routes

| Route | Purpose |
| --- | --- |
| `/` | Environment-configured public research assistant. |
| `/widget/[municipalitySlug]` | Tenant-aware iframe destination. |
| `/admin/login` | Staff sign-in. |
| `/admin/set-password` | Invitation acceptance and initial password setup. |
| `/admin` | Protected document list, batch upload, question count, usage cost, and embed code. |
| `/api/chat` | File-search-only cited chat with best-effort analytics logging. |
| `/api/admin/documents` | Authenticated, role-checked document listing and ingestion. |

Example embed:

```html
<iframe
  src="https://your-munigpt-domain.example/widget/strawberry-point-ia"
  title="City of Strawberry Point public records assistant"
  width="100%"
  height="640"
  loading="lazy"
></iframe>
```

## Current safeguards

- File-search records are the only answer source; unrestricted web search is disabled.
- Municipality identity is configuration-driven rather than hard-coded.
- The server, not the browser, selects the vector stores.
- Citations are extracted from API response annotations rather than generated as plain text.
- Questions and submitted conversation history are length-limited.
- Answers have a hard output-token ceiling (800 by default).
- Atomic per-municipality monthly quotas prevent concurrent requests from exceeding the configured allowance.
- Hashed public-client rate limits reject more than 10 questions per minute by default without storing raw IP addresses.
- Exact API token counts, file-search calls, and estimated OpenAI cost are logged per successful response.
- Public error responses do not expose server exception details.
- Responses are marked `no-store`.
- Supabase row-level security isolates each municipality's staff data.
- The private storage bucket scopes paths to municipality IDs and editor roles.
- Administrator routes fail closed when Supabase is missing or the user lacks membership.
- Administrators can review and upload batches of up to 25 documents, with editable per-file titles, document types, and independent results.
- Uploads enforce a file allowlist and 20 MB per-file size limit.
- Widget embedding is controlled with a `frame-ancestors` Content Security Policy.

## Verification

```bash
npm run lint
npm test
npm run build
npm audit --omit=dev
```

## Still required before selling

- Provision the production Supabase project and apply the migration.
- Seed each municipality and invite its administrators.
- Configure approved embed origins and a vector-store strategy per customer.
- Add billing, retention jobs, document replacement/deletion workflows, full question review, audit reporting, and operational monitoring.
- Complete legal/privacy review, accessibility testing, incident procedures, backups, and municipal procurement/security materials.
