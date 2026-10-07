# MuniGPT

MuniGPT is a public-records research assistant for municipalities. It answers questions only from configured OpenAI vector stores and displays file citations returned by the OpenAI Responses API.

This repository currently contains the public research prototype. Municipal administration, document ingestion, persistent question logging, and the embeddable widget are planned product milestones.

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

\* Configure either `VECTOR_STORE_ID` or `VECTOR_STORE_IDS`.

## Current safeguards

- File-search records are the only answer source; unrestricted web search is disabled.
- Municipality identity is configuration-driven rather than hard-coded.
- The server, not the browser, selects the vector stores.
- Citations are extracted from API response annotations rather than generated as plain text.
- Questions and submitted conversation history are length-limited.
- Public error responses do not expose server exception details.
- Responses are marked `no-store`.

## Verification

```bash
npm run lint
npm test
npm run build
npm audit --omit=dev
```

The next milestone will add persistent storage, municipal administrator authentication, document ingestion and publishing, question review, tenant isolation, and iframe embed delivery.
