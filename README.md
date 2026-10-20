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
| `OPENAI_MAX_OUTPUT_TOKENS` | No | Hard answer ceiling, including reasoning tokens. Defaults to `800` (`1,600` for gpt-5 models such as the Oak Park newspaper model). Constrained to 100–2,000. |
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
- Citations are extracted from API response annotations rather than generated as plain text. A citation is a link when a URL is known from `documents.external_url`, a vector-store file attribute (`source_url`, `url`, or `external_url`), or a filename mapping. Agenda and minutes filenames link to the Village Board meetings page, labeled as the meetings page, until a per-file URL is stored. Naming an official page in an answer links that name. A remedial-action plan or request for proposal is omitted from the source list. Other packet PDFs stay plain text. Oak Park answers may also share a fixed list of official pages. Email addresses in an answer are `mailto` links.
- Questions and submitted conversation history are length-limited.
- The widget keeps the visible conversation in `sessionStorage` for the browser tab. Reloading that tab restores it. Closing the tab clears it. The anonymous rate-limit id stays in `localStorage`, separate from the transcript.
- Answers have a hard output-token ceiling (800 by default, 1,600 for gpt-5 models). An answer cut off by that ceiling is closed at the last complete sentence when possible and says it was cut off.
- Each OpenAI call uses a 50 second timeout and no automatic retries, and the route asks the platform to stop the function at 60 seconds.
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

## Source links and record quality

The assistant prefers adopted, current records over drafts and unrelated packets through its instructions. It does not filter the vector store, because a metadata filter would hide every file until attributes are set. Do not re-upload or delete production files to add that metadata. Update a file in place:

```js
await openai.vectorStores.files.update(vectorStoreId, fileId, {
  attributes: {
    source_url: "https://www.oak-park.us/...",
    document_type: "minutes",
    record_date: "2026-10-13",
    status: "adopted",
  },
});
```

`document_type` should be one of `ordinance`, `resolution`, `minutes`, `agenda`, `policy`, `guideline`, `draft`, or `study`. `status` should be `adopted`, `draft`, `proposed`, or `superseded`. `record_date` is the adoption, revision, or meeting date as `YYYY-MM-DD`.

For files already tracked in Supabase, set `documents.external_url` as well. The chat route uses that URL before a filename guess. Suggested labels for the records that produced weak answers: mark a real draft zoning text `status=draft` (the April 3, 2026 revision of the 2017 zoning ordinance is adopted, not a draft); mark the 2020 remedial-action plan `document_type=study` so it is not treated as a FOIA, noise, or parking source; set `record_date` and `source_url` on minutes and agendas, including the October 13, 2026 agenda and the May 6, 2025 minutes. Add a metadata filter only after those attributes exist. File search currently returns 16 results and does not sort by filename date.

## Tag vector store files

`npm run tag-vector-store` proposes attributes for files already in an OpenAI vector store. It does not change chat search, and it does not upload or delete files. Dry run is the default: it lists the store, reads each filename, and writes a CSV. It reads document text only when the filename has no `YYYY-MM-DD`. A second run reuses `.vector-store-tag-cache/` so those files are not downloaded again. The CSV uses a numeric `record_date` (`20261013`) and leaves `status` blank unless the evidence is clear. That is the schema this script writes. Chat search still ignores these attributes.

The CSV columns are `file_id`, `filename`, `city`, `source_url`, `record_date`, `document_type`, `status`, `title`, `date_source`, `confidence`, `needs_review`, and `notes`. `record_date` is an 8-digit number such as `20261013` when a full day was found. `date_source` is `filename`, `content`, or `none`. `status` is left blank unless the name says draft or superseded, or an older budget book is clearly superseded by a newer one. Rows with `needs_review` of `yes` are guesses for a person to check.

Set the Oak Park key, store, and slug, then review the CSV. Optional Supabase settings fill `source_url` from `documents.external_url` when those rows exist.

```bash
export OPENAI_API_KEY="sk-..."
export VECTOR_STORE_ID="vs_..."
export MUNICIPALITY_SLUG="oak-park-il"
# optional
export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."

npm run tag-vector-store -- --out oak-park-tags.csv
```

Open `oak-park-tags.csv`. Correct any date, type, status, title, or URL. For each row that should be written, set `needs_review` to `no`. Leave `yes` on a row to skip it. A cleared row still needs a `document_type`. Blank `status` and blank `record_date` are allowed and are omitted from the update.

This command is the only one that writes. It calls the vector store file update endpoint with attributes and nothing else. Each update, retry, or skip is printed and appended to `oak-park-tags.csv.apply.log`. Each request uses a 30 second timeout (`--timeout-ms`) and 2 client retries. A row that still fails is tried up to 3 times with a short backoff, then logged as `failed` so the loop can move on.

```bash
npm run tag-vector-store -- --apply oak-park-tags.csv
```

If a run stops, continue without rewriting files already logged as `updated`:

```bash
npm run tag-vector-store -- --apply oak-park-tags.csv --resume oak-park-tags.csv.apply.log
```

To send only the rows whose latest log line is `failed`:

```bash
npm run tag-vector-store -- --apply oak-park-tags.csv --retry-failed oak-park-tags.csv.apply.log
```

`--delay-ms 200` is the pause between API calls. `--refresh` ignores the text cache. `--limit 20` scans a short sample; do not treat that CSV as the full store. The same commands work for a later city by changing `MUNICIPALITY_SLUG` and `VECTOR_STORE_ID`.

## Extract roll-call votes

`npm run extract-votes` reads minutes that are already in a vector store and writes a JSONL file plus a review CSV. It does not change chat, and it does not upload or delete municipal files. The chat query tool is not part of this step.

Supabase is already running, but its REST API cannot apply this DDL. In the Supabase SQL editor, paste `supabase/migrations/20261020150000_roll_call_votes.sql` and run it once. That SQL is safe to run again. It creates `vote_members`, `meetings`, `motions`, and `member_votes`, enables row level security, and lets municipality members read. Only the service role can insert or update.

The pilot uses the regular API, costs a few dollars, and does not write to Supabase. It picks 20 minutes files spread across years. Tagged `document_type=minutes` files are selected first. Untagged files whose names contain "minutes" are included and marked for review. Agendas, proposals, and studies are skipped. Text comes from the vector-store file content endpoint.

```bash
export OPENAI_API_KEY="sk-..."
export VECTOR_STORE_ID="vs_697291646f88819190c616d2a4c98955"
export MUNICIPALITY_SLUG="oak-park-il"

npm run extract-votes -- --pilot --out oak-park-votes-pilot.jsonl
```

Review `oak-park-votes-pilot.review.csv`. Check the tally against the names, and the motion title against the minutes. `tally_mismatch` means the printed split does not match the names. `needs_review` means an unknown member, a date that does not match `record_date`, an untagged file, or two approved files for the same meeting. The Oak Park alias list shipped with the script is only Andrews, Scaman, and Walker-Peddakotla. Other trustees stay `needs_review` until you pass a reviewed `--aliases` JSON file. A voice vote with no names is kept as a result and a note, without invented member rows.

Each OpenAI call uses a 120 second timeout (`--timeout-ms`) and 2 client retries. A file that still fails is tried 3 times, then logged, and the script moves on. A later run skips files already extracted. `--refresh` extracts them again. `--retry-failed` reruns only files whose last extraction failed. `--limit 10` with `--pilot` spreads 10 files instead of 20.

After the CSV looks right and the SQL above has been applied, this is the command that upserts. It matches meetings on municipality plus source file, motions on meeting plus item key, and member votes on motion plus the raw name.

```bash
export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."

npm run extract-votes -- --write --out oak-park-votes-pilot.jsonl
```

The full run was approved at about $10–25 with the Batch API. Use it only after the pilot looks right. The command submits the batch and returns while OpenAI is still working. Run it again to collect the finished batch and write the CSV. Add `--write` only when that CSV is reviewed.

```bash
npm run extract-votes -- --batch --out oak-park-votes.jsonl
```

## Still required before selling

- Provision the production Supabase project and apply the migration.
- Seed each municipality and invite its administrators.
- Configure approved embed origins and a vector-store strategy per customer.
- Add billing, retention jobs, document replacement/deletion workflows, full question review, audit reporting, and operational monitoring.
- Complete legal/privacy review, accessibility testing, incident procedures, backups, and municipal procurement/security materials.
