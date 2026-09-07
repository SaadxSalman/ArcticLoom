<p align="center">
<img src="ALRIS.png" alt="ArcticLoom Logo" width="600">
</p>

# ArcticLoom ❄️🧠

**ArcticLoom v2.1** is a production-grade **Retrieval-Augmented Generation (RAG) intelligence engine** that answers natural-language questions *strictly* from documents that **you** provide. It blends a **local, privacy-friendly embedding model**, a **cloud vector database**, and a **state-of-the-art instruction-tuned LLM** to deliver answers that are grounded in your files, cited line-by-line, and never invented from thin air.

Think of ArcticLoom as a "brain in a box" for your documents:

- 📄 **Upload fresh files** → they are parsed, chunked, embedded, and indexed on the spot
- 🧠 **Ask anything** → ArcticLoom retrieves the most relevant passages and synthesizes a cited answer
- 🔎 **See the evidence** → every answer lists the exact source files and similarity scores
- 🚫 **No hallucination** → if your documents don't contain the answer, it says so honestly

Built with **Node.js 18+, Express 5, Next.js 16, Transformers.js, Weaviate Cloud, and the Hugging Face Inference API**, ArcticLoom is designed to be simple to run, logically complete, and easy to extend.

---

## 📑 Table of Contents

- [✨ Key Features](#-key-features)
- [🔮 Real-World Use Cases](#-real-world-use-cases)
- [🏗️ How ArcticLoom Works (Architecture)](#-how-arcticloom-works-architecture)
- [🛠️ Tech Stack](#%EF%B8%8F-tech-stack)
- [📂 Repository Structure](#-repository-structure)
- [⚙️ Prerequisites](#%EF%B8%8F-prerequisites)
- [🚀 Installation & Setup](#-installation--setup)
- [🔐 Environment Configuration](#-environment-configuration)
- [▶️ Running ArcticLoom](#%EF%B8%8F-running-arcticloom)
- [📖 Usage Guide](#-usage-guide)
- [🔌 API Reference](#-api-reference)
- [🔨 CLI Tools](#-cli-tools)
- [🎯 Accuracy & Grounding](#-accuracy--grounding)
- [🔒 Data Privacy & Security](#-data-privacy--security)
- [🩺 Troubleshooting](#-troubleshooting)
- [❓ FAQ](#-faq)
- [🗺️ Roadmap](#%EF%B8%8F-roadmap)
- [🤝 Contributing](#-contributing)
- [📜 License & Credits](#-license--credits)

---

## ✨ Key Features

### Document Intelligence, Done Right

| Feature | What it does |
| --- | --- |
| 🆕 **Fresh-File-Only Ingestion** | There is **no `/data` folder**. Every session starts empty — you upload documents through the UI (or the API), they are processed immediately, and the uploaded files are **deleted from disk** the moment they are indexed. Nothing from a previous run is ever silently reused. |
| 📚 **Multi-Format Parsing** | PDF, Word (`.docx`), legacy Word (`.doc` best-effort), HTML/HTM, Markdown, plain TXT, CSV (converted into readable, queryable rows), and JSON (pretty-printed for retrieval). |
| ✂️ **Smart Sentence-Aware Chunking** | Documents are split into ~1000-character chunks with a 200-character overlap, breaking at **sentence boundaries** (and skipping decimal points) so semantic units stay intact and context flows across chunk edges. |
| 🔢 **Local Semantic Embeddings** | `all-MiniLM-L6-v2` runs locally via Transformers.js — your text is vectorized **on your machine** (after the model is downloaded once), producing 384-dimensional, L2-normalized embeddings. |
| 🗃️ **Weaviate Cloud Vector Database** | Embeddings and metadata (file name, type, size, chunk index, upload timestamp) live in a managed Weaviate collection. Similarity search is fast, filtered, and tunable. |
| 🤖 **Instruction-Tuned LLM Generation** | `Qwen/Qwen2.5-72B-Instruct` (via the Hugging Face Inference API) synthesizes the final answer from the retrieved evidence — with strict grounding rules and inline citations. |
| 🎯 **Relevance Confidence Gate** | Every query is scored against your documents. If the best match is below the `MIN_RELEVANCE_SCORE` threshold (default 30% / `0.30`), ArcticLoom **refuses to guess** and tells you the documents don't cover the topic. |
| 📝 **Cited, Verifiable Answers** | The model tags every claim with `[filename | Chunk N]` and ends with a **"Sources used: …"** line. The UI renders source badges with per-file similarity percentages. |
| 💬 **Multi-Turn Conversation** | Per-session chat history (session IDs stored in your browser's `localStorage`) keeps context across questions — while the model is still explicitly told to answer *only from the documents*. |
| 🎛️ **Document Management** | View every indexed file with chunk/size stats, delete individual documents, or wipe the whole collection — all from the UI or the REST API. |
| 🌐 **Clean REST API** | A small, well-documented HTTP surface (`/api/status`, `/api/upload`, `/api/ask`, `/api/documents`, `/api/history`) makes it trivial to script, embed, or rebuild a new frontend. |

---

## 🔮 Real-World Use Cases

- **📚 Personal knowledge hub** — Drop your research papers, textbooks, and notes in (fresh upload each session). Ask: *"What were the three main criticisms in the quantum-computing paper?"* and get a cited synthesis.
- **📁 Technical documentation assistant** — Point it at your project's markdown docs. Ask: *"How do I configure the auth middleware?"* and it will quote the exact config block with the file it came from.
- **⚖️ Legal & contract analysis** — Upload lease agreements or contracts. Ask: *"What is the notice period for early termination?"* — the answer cites the exact clause.
- **📊 Tabular data interrogation** — Upload a CSV. Ask: *"What was revenue in Q3?"* — CSV rows are converted into readable text so the model can reason over them.
- **✍️ Content consistency** — Maintain character and lore consistency in creative writing. Ask: *"How did I describe the protagonist's childhood in chapter 3?"*
- **🎓 Exam prep** — Upload lecture slides/summaries and quiz yourself with grounded, verifiable answers.

---

## 🏗️ How ArcticLoom Works (Architecture)

ArcticLoom is a classic **Retrieval-Augmented Generation** pipeline with two asynchronous phases: **Ingestion** (documents → vectors) and **Inference** (question → grounded answer).

```text
                          ┌───────────────────────────────────────────────┐
                          │            ARCTICLOOM (v2.1)                  │
                          └───────────────────────────────────────────────┘

  INGESTION  ──►  ┌────────────┐   ┌───────────────┐   ┌──────────────┐
  (fresh       │  Parser     │   │  Chunker      │   │  Embedder    │
   upload)     │  (pdf/docx) │──►│  (sentence-   │──►│  all-MiniLM-  │
               │  (md/csv/…) │   │   aware, 1000 │   │  L6-v2 (local)│
               └────────────┘   │   +200 ovrlp)  │   └──────┬───────┘
               └────────────┘                              │ vectors
                          │                                 ▼
                          │                ┌───────────────────────────────┐
                          │                │  Weaviate Cloud               │
                          │                │  "ArcticLoom_Documents"       │
                          │                │  content · fileName ·         │
                          │                │  chunkIndex · fileType ·      │
                          │                │  fileSize · totalChunks ·     │
                          │                │  uploadedAt · !!!vector!!!    │
                          │                └───────────────────────────────┘
                          │
  INFERENCE   ──►  question ──► embed ──► nearVector search (TOP_K)
                          │                      │ best ≥ 0.30?
                          ▼                      ▼
              ┌──────────────────┐      ┌──────────────────────┐
              │  Qwen 72B        │◄─────│  ranked chunks with  │
              │  (HF Inference)  │      │  citations + scores  │
              └────────┬─────────┘      └──────────────────────┘
                       ▼
              cited, grounding-checked answer + sources
```

### Stage-by-Stage Breakdown

1. **Ingestion (upload time)**
   - A file arrives as `multipart/form-data`. It is staged in the OS **temp directory** (never a project folder, never persisted).
   - `src/parser.js` extracts plain text by format:
     - **PDF** via `@cedrugs/pdf-parse` (includes page count in metadata).
     - **DOCX** via `mammoth`.
     - **HTML/HTM** via `turndown` (HTML → Markdown).
     - **Markdown / TXT** read directly.
     - **CSV** parsed into `TABLE HEADERS: …` + `ROW n: …` readable lines.
     - **JSON** validated and pretty-printed.
   - `src/chunker.js` slices the text into ~1000-char chunks with 200-char overlap, snapping to sentence boundaries (and ignoring decimal dots like `3.14`).
   - `src/embeddings.js` embeds every chunk **locally** with `all-MiniLM-L6-v2` (mean pooling → 384-dim normalized vector).
   - `src/vectorStore.js` replaces any previous version of that file, then inserts the chunks with their vectors **and metadata** into the `ArcticLoom_Documents` collection on Weaviate Cloud.
   - The temporary upload file is **deleted immediately** — the vector index is the only home of your data.

2. **Retrieval (question time)**
   - Your question is embedded with the same local model.
   - A `nearVector` search returns the `TOP_K` most similar chunks (default 5), including each chunk's `distance` (converted to a 0–1 similarity score) and metadata.
   - Optional filter: pass `filename` to search within a single document only.

3. **Accuracy gate**
   - If the single best match scores below `MIN_RELEVANCE_SCORE` (default `0.30`), ArcticLoom **does not invoke the LLM**. Instead it replies honestly: *"The documents are not sufficiently relevant…"* — this is the anti-hallucination guarantee.

4. **Synthesis**
   - The top-passing chunks are formatted as citable evidence blocks:
     `[report.pdf | Chunk 2 | Score: 87.3%]` + passage text.
   - The last 4 turns of the session's conversation are attached for continuity.
   - `src/llm.js` builds a **strict grounding prompt** and calls `Qwen/Qwen2.5-72B-Instruct` through the Hugging Face Inference API (`temperature 0.2`, `top_p 0.95`).
   - The model must cite every claim with `[filename | Chunk N]` and end with a `Sources used:` line.

5. **Response**
   - The API returns `{ answer, sources[{filename, score}], confidence, relevantChunks[…] }`.
   - Sources are deduplicated per file (keeping the highest score) and sorted by score.
   - The UI shows the answer plus clickable topic badges with similarity percentages.

---

## 🛠️ Tech Stack

| Layer | Technology | Version | Role |
| --- | --- | --- | --- |
| **Runtime** | Node.js | 18+ (tested on 26) | Server-side JS runtime |
| **Backend** | Express | 5.2 | REST API, routing, middleware |
| **Uploads** | Multer | 2.0 | Multipart uploads (temp staging only) |
| **Document parsing** | `@cedrugs/pdf-parse`, `mammoth`, `turndown` | — | PDF / DOCX / HTML → text |
| **Embeddings** | `@xenova/transformers` + `all-MiniLM-L6-v2` | 2.17 | Local 384-dim embeddings |
| **Vector database** | Weaviate Cloud (`weaviate-client`) | 3.14 | Vector index + metadata store |
| **LLM** | Hugging Face Inference API + `Qwen/Qwen2.5-72B-Instruct` | `@huggingface/inference` 4.13 | Grounded answer synthesis |
| **Frontend** | Next.js 16 (App Router) · React 19 | 16.1 | Chat UI |
| **Styling** | Tailwind CSS 4 · custom glass-morphism | 4.1 | UI |
| **Icons** | `lucide-react` | 0.471 | Icon set |
| **Config** | `dotenv` | 17 | Loads `.env` secrets |

> **Why "local embeddings + cloud LLM"?** Embedding models are small (≈80 MB) and fast on a laptop, so running them locally keeps your document text private on your machine. Modern instruction-tuned LLMs (like a 72B parameter model) are far more accurate at grounded reasoning but too large to run locally on commodity hardware — so the LLM inference is delegated to the Hugging Face Inference API using your own token. The **retrieved evidence** (not your full documents) is what is sent to the LLM.

---

## 📂 Repository Structure

```text
ArcticLoom/
├── src/                         # Express backend (Node.js, ESM)
│   ├── index.js                 # Server: routes, uploads, RAG orchestration
│   ├── vectorStore.js           # Weaviate Cloud client + conversation store
│   ├── embeddings.js            # Local all-MiniLM-L6-v2 embeddings
│   ├── llm.js                   # HF Inference LLM (grounded, cited answers)
│   ├── parser.js                # PDF/DOCX/HTML/MD/TXT/CSV/JSON extraction
│   ├── chunker.js               # Sentence-aware chunking + overlap
│   ├── ingest.js                # CLI: ingest explicit file paths
│   └── setup.js                 # Preflight diagnostics (npm run setup)
│
├── frontend/                    # Next.js 16 chat UI
│   └── src/app/
│       ├── page.tsx             # Chat, upload, document management
│       ├── layout.tsx           # Global layout & fonts
│       └── globals.css          # Tailwind + glass/glow/typing animations
│
├── .env                         # ⚠️ SECRETS — git-ignored, never commit
├── .env.example                 # Template for all environment variables
├── .gitignore
├── package.json                 # Backend manifest & scripts
└── README.md
```

> **No `data/`, `uploads/`, or persistent document folder exists.** Uploaded files flow: browser → OS temp staging → parser → vectors in Weaviate → **file deleted**. The project root stays clean.

---

## ⚙️ Prerequisites

- **Node.js 18+** (recommended: latest LTS; verified on Node 26) and `npm`.
- **A Weaviate Cloud sandbox** (free) — create one at [weaviate.io/developers/wcs](https://weaviate.io/developers/wcs) and copy the cluster URL + API key.
- **A Hugging Face access token** — create one at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens). Your token must be able to access **`Qwen/Qwen2.5-72B-Instruct`** on the Inference API.
- **A browser** for the UI, plus an internet connection for Weaviate Cloud and the HF Inference API.

> No GPU is required. The embedding model runs on CPU and is downloaded once on first launch (~80 MB).

---

## 🚀 Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/SaadxSalman/ArcticLoom.git
cd ArcticLoom
```

### 2. Install backend dependencies

```bash
npm install
```

### 3. Install frontend dependencies

```bash
cd frontend && npm install && cd ..
```

### 4. Configure secrets

Copy the template and fill in your real keys (see [Environment Configuration](#-environment-configuration)):

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

Edit `.env` and set `WEAVIATE_URL`, `WEAVIATE_API_KEY`, and `HUGGINGFACE_API_KEY`. Your `.env` is **git-ignored** — it stays private on your machine.

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:3002
```

### 5. Run the preflight diagnostics (optional but recommended)

```bash
npm run setup
```

This verifies your `.env` values, connects to Weaviate Cloud, (re)creates the `ArcticLoom_Documents` collection if needed, and reports the current index size.

---

## 🔐 Environment Configuration

All backend secrets and tuning knobs live in the **git-ignored** `.env` at the project root. `dotenv` injects them into every module (`src/index.js`, `src/llm.js`, `src/vectorStore.js`, …). The frontend reads exactly one variable from `frontend/.env.local`.

### `.env` (backend)

```env
# ── Server ──────────────────────────────────────────────
PORT=3002

# ── RAG pipeline ────────────────────────────────────────
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
LLM_MODEL=Qwen/Qwen2.5-72B-Instruct
CHUNK_SIZE=1000
CHUNK_OVERLAP=200
TOP_K=5
MIN_RELEVANCE_SCORE=0.30
LLM_MAX_TOKENS=1200
LLM_TEMPERATURE=0.2

# ── Weaviate Cloud ──────────────────────────────────────
WEAVIATE_URL=https://YOUR-INSTANCE.weaviate.cloud
WEAVIATE_API_KEY=YOUR-WEAVIATE-API-KEY

# ── Hugging Face ────────────────────────────────────────
HUGGINGFACE_API_KEY=hf_YOUR_HF_TOKEN
```

### Variable reference

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3002` | Backend HTTP port. |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Local embedding model (must be a Xenova/ONNX-converted model). |
| `LLM_MODEL` | `Qwen/Qwen2.5-72B-Instruct` | Model used by the Hugging Face Inference API for generation. |
| `CHUNK_SIZE` | `1000` | Target characters per chunk. |
| `CHUNK_OVERLAP` | `200` | Characters shared between consecutive chunks. |
| `TOP_K` | `5` | Number of chunks retrieved per query. |
| `MIN_RELEVANCE_SCORE` | `0.30` | Similarity gate (`0`–`1`). Below this, ArcticLoom refuses to answer rather than hallucinate. |
| `LLM_MAX_TOKENS` | `1200` | Max generated tokens per answer. |
| `LLM_TEMPERATURE` | `0.2` | Sampling temperature — low for factual, grounded answers. |
| `WEAVIATE_URL` | — | **Required.** Your Weaviate Cloud cluster URL. |
| `WEAVIATE_API_KEY` | — | **Required.** Weaviate Cloud API key. |
| `HUGGINGFACE_API_KEY` | — | **Required.** HF token with Inference API access to the configured model. |
| `UPLOAD_DIR` | OS temp dir | Where uploads are staged before ingestion. Files are deleted immediately after indexing. |
| `WEAVIATE_COLLECTION` | `ArcticLoom_Documents` | Optional collection-name override. |

### `frontend/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:3002
```

`NEXT_PUBLIC_API_URL` tells the Next.js UI where the backend lives. If you run the backend elsewhere, point it there.

---

## ▶️ Running ArcticLoom

You need two processes: the **backend API** and the **frontend**.

### Terminal 1 — Backend

```bash
cd ArcticLoom
npm start
```

Expected banner:

```text
Starting ArcticLoom v2.1...
Connecting to Weaviate Cloud...
Connected to Weaviate Cloud
Initializing embedding model...
Loading embedding model: Xenova/all-MiniLM-L6-v2...
Embedding model loaded successfully
LLM ready (Hugging Face Inference API): Qwen/Qwen2.5-72B-Instruct

=========================================================
  ArcticLoom v2.1 - RAG Intelligence Engine
  Backend:      http://localhost:3002
  Documents:    0
  Chunks:       0
  >> No data folder is used. Upload documents via the UI…
=========================================================
```

### Terminal 2 — Frontend

```bash
cd ArcticLoom/frontend
npm run dev
```

Open **http://localhost:3000** in your browser.

> **First run** downloads the local embedding model (~80 MB) and caches it — subsequent starts are fast.

---

## 📖 Usage Guide

### 1. Upload fresh documents

- Click the **Upload** button (or drag & drop a file anywhere on the chat pane).
- Supported: `.pdf`, `.docx`, `.doc*`, `.html`, `.htm`, `.md`, `.markdown`, `.txt`, `.csv`, `.json` — up to **50 MB** per file.
- The file is parsed, chunked, embedded, and indexed; the confirmation appears as a chat message with chunk count and size.

### 2. Ask questions

- Type any question and press **Enter** (or the send button).
- ArcticLoom retrieves the most relevant passages and answers **strictly from them**, tagging claims like `[report.pdf | Chunk 2]`.
- Below each answer you'll see **source badges** showing the file name and the retrieval similarity percentage.

### 3. Manage documents

- Click **Docs** in the header to open the document panel: list, upload more, delete a single file, or **Clear All**.
- The header also shows the live doc/chunk counters.

### 4. Follow up

- Conversation context is preserved per session (a session ID is stored in your browser).
- Use the **Chat** button to clear the current conversation.

### 5. What if the documents don't contain the answer?

ArcticLoom will tell you honestly — e.g. *"not sufficiently relevant (best match: 0.0% similarity)"* — instead of making something up. Upload a more relevant document and try again.

---

## 🔌 API Reference

Base URL: `http://localhost:3002` (configurable via `PORT` / `NEXT_PUBLIC_API_URL`). All endpoints return JSON.

### `GET /api/status` — system health

```json
{
  "status": "running",
  "version": "2.1",
  "embedder": { "loaded": true, "loading": false, "model": "Xenova/all-MiniLM-L6-v2" },
  "llm": { "loaded": true, "loading": false, "model": "Qwen/Qwen2.5-72B-Instruct" },
  "vectorDb": "Weaviate Cloud",
  "documents": 2,
  "chunks": 14
}
```

### `GET /api/formats` — supported upload formats

```json
{ "formats": [".pdf", ".docx", ".doc", ".html", ".htm", ".md", ".markdown", ".txt", ".csv", ".json"] }
```

### `POST /api/upload` — ingest a fresh document

Send a `multipart/form-data` request with field name **`file`** (max 50 MB).

```bash
curl -X POST http://localhost:3002/api/upload -F "file=@report.pdf"
```

```json
{
  "success": true,
  "message": "Ingested: report.pdf",
  "document": {
    "id": "report.pdf",
    "filename": "report.pdf",
    "fileType": "pdf",
    "fileSize": 184022,
    "totalChunks": 6,
    "uploadedAt": "2026-09-07T23:26:00.207Z"
  }
}
```

Re-uploading a file with the same name **replaces** its previous index. The uploaded file is deleted from disk after ingestion.

### `POST /api/ask` — ask a grounded question

```json
{
  "query": "What is the notice period for early termination?",
  "sessionId": "browser-generated-id",      // optional
  "filename": "contract.pdf",               // optional: restrict to one file
  "topK": 5                                 // optional: override retrieval count
}
```

```json
{
  "answer": "The contract requires 60 days written notice [contract.pdf | Chunk 3].\n\nSources used: [contract.pdf | Chunk 3]",
  "sources": [{ "filename": "contract.pdf", "score": 0.912 }],
  "query": "What is the notice period for early termination?",
  "confidence": 0.912,
  "relevantChunks": [
    { "content": "…", "filename": "contract.pdf", "chunk_index": 3, "fileType": "pdf", "score": 0.912 }
  ]
}
```

Behavior rules:
- Empty query → `400`.
- No documents ingested → returns a "please upload a file first" message.
- Best match below `MIN_RELEVANCE_SCORE` → returns an honest refusal with `confidence`.
- Otherwise the LLM generates a cited, grounded answer.

### `GET /api/documents` — list indexed documents

```json
{
  "documents": [
    { "id": "report.pdf", "filename": "report.pdf", "fileType": "pdf",
      "fileSize": 184022, "totalChunks": 6, "uploadedAt": "2026-09-07T23:26:00.207Z" }
  ],
  "count": 1
}
```

### `GET /api/documents/:filename` — one document's details

`404` if not found.

### `DELETE /api/documents/:filename` — delete one document

```json
{ "success": true, "message": "Deleted: report.pdf" }
```

### `DELETE /api/documents` — wipe everything

```json
{ "success": true, "message": "All documents and conversations cleared." }
```

### `GET /api/history?sessionId=…` — fetch a session's conversation

```json
{ "sessionId": "abc", "history": [ { "role": "user", "content": "…", "sources": [], "created_at": "…" } ] }
```

### `DELETE /api/history/:sessionId` — clear a session's conversation

```json
{ "success": true, "message": "Conversation cleared: abc" }
```

---

## 🔨 CLI Tools

### `npm run setup` — preflight diagnostics

Checks `.env` presence, validates every configuration value, connects to Weaviate Cloud, verifies the collection, and reports index size. Exit code is non-zero on any failure.

```text
ArcticLoom Preflight Setup & Diagnostics
 ========================================
 ✔ .env found at …
 -- Configuration --
  ✔ PORT: 3002
  ✔ WEAVIATE_URL: https://…weaviate.cloud
  ✔ WEAVIATE_API_KEY: …
  ✔ HUGGINGFACE_API_KEY: …
 -- Live connectivity --
  ✔ Weaviate connection: OK
  ✔ Collection ready (ArcticLoom_Documents)
  Currently indexed: 0 document(s), 0 chunk(s)
```

### `npm run ingest -- <files…>` — CLI ingestion

Ingest explicit file paths (no folder scanning — consistent with the fresh-file-only philosophy):

```bash
npm run ingest -- ./report.pdf ./notes.md ./data.csv
node src/ingest.js "C:\path\to\contract.docx"
```

- Files are parsed, chunked, embedded, and inserted; same-name files are re-indexed (replaced).
- This is the same pipeline the UI/API uses, useful for scripts and automation.

---

## 🎯 Accuracy & Grounding

ArcticLoom is deliberately engineered to **avoid hallucination**:

1. **Evidence-only answering.** The generation prompt is explicit: base every claim on the provided passages, cite `[filename | Chunk N]`, and *never* use general knowledge to fill gaps.
2. **Confidence gate.** Retrieval similarity (`1 − distance`, normalized to 0–1) must clear `MIN_RELEVANCE_SCORE` (default 0.30) before the LLM is even consulted. Below that, ArcticLoom answers truthfully that the documents aren't relevant.
3. **Low-temperature synthesis.** `temperature=0.2` keeps the model conservative and extractive rather than creative.
4. **Verifiable citations.** Every claim references a concrete chunk, and the web UI shows per-source similarity so you can sanity-check any answer in seconds.
5. **Honest fallback.** If the Hugging Face API is unavailable or the key is invalid, ArcticLoom returns the top passage verbatim with a disclosure note — it never fabricates an answer.
6. **Fresh data only.** Because every session starts from the files you upload right now, there is no stale or cross-user data to poison answers.

Tuning tips:
- **Raising `MIN_RELEVANCE_SCORE`** (e.g. `0.45`) makes ArcticLoom even more conservative.
- **Raising `TOP_K`** (e.g. `8`) surfaces more evidence for long documents.
- **Lowering `CHUNK_SIZE`** to `500` improves precision for Q&A on dense technical text; raising it to `1500` improves long-form summarization.

---

## 🔒 Data Privacy & Security

- **No project data folder.** Uploaded files live in the OS temp directory only until embedding finishes, then are **deleted**.
- **Local embeddings.** Document text is vectorized on your machine; full document content is never sent to the vector provider — only 384-dimensional vectors and metadata.
- **Secrets hygiene.** API keys live in the git-ignored `.env` and are never referenced in source code. `.env.example` is a safe template. Search the history before pushing: `.env` is excluded by `.gitignore`.
- **Minimal LLM exposure.** Only the top-`TOP_K` retrieved passages (the evidence) are sent to the Hugging Face Inference API — never your whole corpus.
- **Per-session isolation.** Conversation history is in-memory and session-scoped; clearing chat or a server restart removes it.
- **Transport.** All external traffic is HTTPS (Weaviate Cloud and HF Inference API).

> ⚠️ Run ArcticLoom on your own trusted machine. This is a local tool for personal/team document Q&A, not a multi-tenant SaaS backend.

---

## 🩺 Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Missing WEAVIATE_URL or WEAVIATE_API_KEY` | `.env` missing or incomplete | `npm run setup` to diagnose; copy `.env.example` → `.env` and fill keys |
| `Collection not found` / schema errors | Stale collection from an older version | Delete the collection on Weaviate Cloud (or run a one-time migration), then `npm run setup` recreates it with the current schema |
| LLM answers are the "top passage verbatim" fallback | Hugging Face API error (key, model access, rate limit, network) | Check the server stderr log; verify `HUGGINGFACE_API_KEY`; confirm your HF token can access `LLM_MODEL` via the **Settings → Billing/Models** page or a direct API call |
| `model_not_supported` from Hugging Face | Your HF token/provider doesn't serve that model | Switch `LLM_MODEL` to a model your token can access (e.g. `Qwen/Qwen2.5-72B-Instruct`) |
| `address already in use` / port 3002 busy | A previous server instance is still running | `taskkill /F /PID <pid>` (Windows) or `kill <pid>` (Linux/macOS), then restart |
| Frontend can't reach backend | Wrong `NEXT_PUBLIC_API_URL` | Confirm `frontend/.env.local` points at the backend URL, restart `npm run dev` |
| Uploaded PDF yields "Insufficient text extracted" | Scanned/image-only PDF (no text layer) | Use an OCR'd/exported text PDF, or save as Markdown/TXT |
| Embedding model stuck at "Loading…" | First-time download or HF model cache issue | Ensure internet access; delete `~/…/.cache` for `@xenova/transformers` or `models/` and retry |
| Slow answers | Large docs, cold cache, or a 72B model call | Raise `MIN_RELEVANCE_SCORE`, lower `TOP_K`, split large PDFs into chapters |

---

## ❓ FAQ

**Q: Where do I put my documents?**  
A: In no folder on disk — upload them through the UI or `POST /api/upload`. There is no `/data` folder by design. Files are staged in the OS temp directory during ingestion and **deleted immediately after** indexing.

**Q: Does ArcticLoom reuse documents from previous sessions?**  
A: No. The vector index only contains what you (or the API/CLI) explicitly uploaded. If you want a clean slate, use *Docs → Clear All*.

**Q: Are my documents sent to the cloud?**  
A: Your document **text** is embedded locally and only 384-dim vectors + metadata go to Weaviate Cloud. During a question, only the *retrieved passages* (not your whole library) are sent to the Hugging Face LLM API.

**Q: Which LLM is used? Why not run it locally?**  
A: `Qwen/Qwen2.5-72B-Instruct` (configurable via `LLM_MODEL`) through the Hugging Face Inference API. A 72B model delivers markedly better grounded reasoning than 1–3B models that fit on a laptop.

**Q: Can ArcticLoom answer questions about anything?**  
A: Only about **uploaded documents**. Out-of-scope questions are refused with a low-relevance message — that's the anti-hallucination guarantee.

**Q: How do I clear everything?**  
A: Docs panel → **Clear All** (documents + conversations), or `DELETE /api/documents`, or `DELETE /api/documents/:filename` per file.

**Q: Can I use a different embedding model or LLM?**  
A: Yes. Change `EMBEDDING_MODEL` (must be a `Xenova/…` ONNX model) and `LLM_MODEL` (must be served to your HF token). Run `npm run setup` afterwards.

**Q: Is there a bulk-upload endpoint?**  
A: Not yet — one file per request keeps uploads simple and reliable. Script multiple calls or use the CLI `npm run ingest -- a.pdf b.md …`.

**Q: Do I need to pay for Weaviate or Hugging Face?**  
A: Both offer free tiers. Weaviate Cloud has free sandboxes; Hugging Face offers free Inference API tokens with access to a set of models. Verify model access on your account.

---

## 🗺️ Roadmap

- [x] Fresh-file-only ingestion (no data folder)
- [x] Multi-format parser (PDF, DOCX, HTML, MD, TXT, CSV, JSON)
- [x] Sentence-aware chunking with overlap
- [x] Local embeddings + Weaviate Cloud vector store
- [x] Relevance confidence gate (anti-hallucination)
- [x] Cited, grounded LLM answers (Qwen 72B via HF)
- [x] Document management + per-session chat history
- [x] Preflight setup diagnostics & CLI ingestion
- [ ] Streaming (SSE) token-by-token answers
- [ ] Multi-document upload in a single request
- [ ] Hybrid search (keyword + vector) via Weaviate BM25
- [ ] Re-ranking pass (cross-encoder) for even sharper top-k
- [ ] PDF OCR fallback for scanned documents
- [ ] Persistent (file-backed) conversation history
- [ ] Docker Compose one-command startup

---

## 🤝 Contributing

Contributions are welcome! To keep the codebase consistent:

1. **Follow the existing patterns** — ESM modules in `src/`, route handlers in `index.js`, functions exported from feature modules.
2. **Keep the no-data-folder rule** — never persist uploaded files; stage in temp and delete after processing.
3. **Keep secrets out of code** — add any new key to `.env.example` (placeholder) and read it via `process.env`.
4. **Test your changes** — `npm run setup`, then start the backend, upload a fixture, and run a question through `/api/ask`.
5. Open a PR with a clear description of the change and how you verified it.

---

## 📜 License & Credits

**ArcticLoom** is open source under the **ISC License**.

Built with ❤️ by **[Saad Salman](https://github.com/SaadxSalman)**.

Powered by:
- [Weaviate Cloud](https://weaviate.io) — vector database
- [Hugging Face Inference API](https://huggingface.co) — LLM serving (`Qwen/Qwen2.5-72B-Instruct`)
- [Transformers.js](https://huggingface.co/docs/transformers.js) — local embeddings (`all-MiniLM-L6-v2`)
- [Next.js](https://nextjs.org) · [Express](https://expressjs.com) · [Tailwind CSS](https://tailwindcss.com) · [Lucide](https://lucide.dev)

---

*ArcticLoom v2.1 — ask your documents, not your memory. ❄️🧠*