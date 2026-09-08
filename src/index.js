import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { initEmbedder, embedText, isModelLoaded as isEmbedderReady, isModelLoading as isEmbedderLoading } from './embeddings.js';
import { initLLM, generateResponse, isLLMLoaded, isLLMLoading } from './llm.js';
import {
  initDatabase, getDocumentCount, getTotalChunkCount, getAllDocuments,
  deleteDocument, searchSimilar, saveConversation, getConversationHistory,
  insertDocument, clearAllData, ensureCollection, clearConversation,
  getDocumentByName, getOverviewChunks
} from './vectorStore.js';
import { parseDocument, getSupportedFormats } from './parser.js';
import { chunkText } from './chunker.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT) || 3002;
const TOP_K = parseInt(process.env.TOP_K) || 5;
const MIN_RELEVANCE_SCORE = parseFloat(process.env.MIN_RELEVANCE_SCORE || '0.30');
const VERSION = '2.1';

// Uploads are staged in the OS temp directory and ALWAYS deleted after ingestion.
// No data folder exists - every document must be uploaded fresh via the API/UI.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.env.TEMP || process.env.TMP || '/tmp', 'arcticloom-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ==================== UPLOAD STAGING (temporary, no persistence) ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (getSupportedFormats().includes(ext)) cb(null, true);
    else cb(new Error('Unsupported format: ' + ext + '. Supported: ' + getSupportedFormats().join(' ')));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Tiny request logger
app.use((req, _res, next) => {
  console.log(req.method + ' ' + req.path);
  next();
});

// ==================== SYSTEM STATE ====================
// The HTTP server opens IMMEDIATELY; heavier initialization (Weaviate cloud,
// embedding model) continues in the background. Endpoints that need the vector
// database answer HTTP 503 { retryable: true } until it is connected, so the
// UI can always distinguish "starting up" from "offline".
const systemState = { dbReady: false, initializing: true, lastInitError: null };

// Race any promise against a timeout so a slow Weaviate Cloud call can never
// hang the status poll that drives the frontend connectivity indicator.
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms))
]);

// ==================== LIVENESS (instant, zero dependencies) ====================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: VERSION, initializing: systemState.initializing, dbReady: systemState.dbReady });
});

// ==================== SYSTEM STATUS ====================
app.get('/api/status', async (req, res) => {
  try {
    res.json({
      status: 'running',
      version: VERSION,
      embedder: {
        loaded: isEmbedderReady(),
        loading: isEmbedderLoading(),
        model: process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2'
      },
      llm: {
        loaded: isLLMLoaded(),
        loading: isLLMLoading(),
        model: process.env.LLM_MODEL || 'Qwen/Qwen2.5-72B-Instruct'
      },
      vectorDb: process.env.WEAVIATE_URL ? (process.env.WEAVIATE_URL.includes('weaviate') ? 'Weaviate Cloud' : 'Weaviate') : 'not configured',
      dbReady: systemState.dbReady,
      initializing: systemState.initializing,
      documents: await withTimeout(getDocumentCount(), 6000, 'Document count').catch(() => 0),
      chunks: await withTimeout(getTotalChunkCount(), 6000, 'Chunk count').catch(() => 0)
    });
  } catch (e) {
    res.json({ status: 'running', documents: 0, chunks: 0, error: e.message });
  }
});

// ==================== SUPPORTED FORMATS ====================
app.get('/api/formats', (req, res) => {
  res.json({ formats: getSupportedFormats() });
});

// ==================== DOCUMENT UPLOAD (fresh ingestion only) ====================
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!systemState.dbReady) {
      return res.status(503).json({ error: 'Backend is still initializing (connecting to the vector database). Please retry in a few seconds.', retryable: true });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send it as multipart form-data with field name "file".' });

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const originalExt = path.extname(originalName).toLowerCase();

    // Belt-and-braces extension check. Multer's fileFilter should catch these
    // already, but this guarantees a clean JSON 400 regardless of client version.
    if (!getSupportedFormats().includes(originalExt)) {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
      return res.status(400).json({ error: 'Unsupported format: ' + originalExt + '. Supported: ' + getSupportedFormats().join(' ') });
    }

    console.log('Parsing document: ' + originalName);
    const parsed = await parseDocument(filePath, originalName);
    const chunks = chunkText(parsed.text, {
      chunkSize: parseInt(process.env.CHUNK_SIZE) || 1000,
      overlap: parseInt(process.env.CHUNK_OVERLAP) || 200
    });

    if (chunks.length === 0) {
      throw new Error('No usable text could be extracted from this file.');
    }

    console.log('Embedding ' + chunks.length + ' chunk(s) from "' + originalName + '"...');
    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      embeddings.push(await embedText(chunks[i].content));
      if ((i + 1) % 5 === 0 || i === chunks.length - 1) {
        process.stdout.write('\r  Progress: ' + (i + 1) + '/' + chunks.length);
      }
    }
    console.log('');

    const doc = await insertDocument(originalName, parsed.fileType, parsed.fileSize, chunks, embeddings);
    console.log('Ingested "' + originalName + '" (' + chunks.length + ' chunks)');

    res.json({
      success: true,
      message: 'Ingested: ' + originalName,
      document: doc
    });
  } catch (error) {
    console.error('Upload error:', error.message);
    // Parser/validator messages are complete, user-facing sentences. Problems
    // with the client's file are 4xx; only genuine server faults are 5xx.
    const isClientFileIssue = /is not a valid PDF|password-protected|appears truncated|No extractable text|is empty \(0 bytes\)|Invalid JSON|Insufficient text|No usable text|Legacy \.doc/i.test(error.message);
    res.status(isClientFileIssue ? 400 : 500).json({ error: error.message });
  } finally {
    // Always remove the staged temp file - we never keep uploaded files on disk.
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) { console.log('Temp cleanup skipped:', e.message); }
    }
  }
});

// === PART2: ask, documents, history, init ===

// ==================== KEYWORD OVERLAP (lexical evidence) ====================
// Used by the accuracy gate: literal keyword evidence that a question is
// topically connected to the retrieved passages, even when embedding
// similarity is modest.
const STOPWORDS = new Set(('a,an,the,is,are,was,were,be,been,being,do,does,did,of,in,on,at,to,for,with,by,from,as,and,or,but,if,then,than,that,this,these,those,it,its,i,you,we,they,he,she,them,his,her,their,our,your,my,me,us,what,which,who,whom,whose,when,where,why,how,all,any,both,each,few,more,most,other,some,such,no,nor,not,only,own,same,so,too,very,can,will,just,should,now,about,into,over,under,again,further,once,here,there,please,tell,give,show,document,documents,file,files,doc,docs,pdf,report,text,thing,things,anything,everything,something,does,did,doing').split(','));

function hasMeaningfulOverlap(question, text) {
  const words = (question.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const meaningful = [...new Set(words)].filter(w => !STOPWORDS.has(w));
  if (meaningful.length === 0) return false;
  const hay = text.toLowerCase();
  return meaningful.some(w => hay.includes(w));
}

// ==================== QUESTION ROUTER ====================
// Broad, document-referential questions ("what is this document about",
// "tell me what it covers", "summarize the key points") can never score high
// against any single chunk, because they are about the document AS A WHOLE.
// Embedding similarity is the right tool for "find the passage about X" and
// the wrong tool for "describe this document". This router detects the latter
// in a phrase-order-independent way (word order must not matter).
const OVERVIEW_EXPLICIT = /\b(summar(y|ise|ize|ising|izing)|overview|tl ?;?dr|key (points|topics|sections|themes|ideas|takeaways|facts)|main (points|topics|themes|sections|ideas|takeaways)|important (points|topics|sections|facts)|takeaways?|highlights?|gist|table of contents|what topics|list (the )?(topics|sections|chapters)|abstract|what('s| is| are) new|new (things|features|modules|subjects|changes|additions|updates|papers|levels)|been added|added to the (syllabus|scheme|document|curriculum|program|programme)|compared? (to|with|against|the previous)|differences?( between| from)?|what changed|changes (in|to|from)|latest (updates|changes|additions))\b/i;
const DOC_NOUN_RE = /\b(doc(ument)?s?|file|pdf|report|paper|text|it|this|that|these|those|them)\b/i;
const DESCRIBE_VERB_RE = /\b(about|cover(s|ed|age)?|contain(s|ed)?|discuss(es|ed)?|mention(s|ed)?|include(s|d)?|talk(s|ed)? about|deal(s)? with|topics?|contents?|summar(y|ise|ize)?|explain|describe|tell|read|say(s|ing)?|have|has|show(s|n)?|info(rmation)?)\b/i;

function isOverviewQuestion(q) {
  if (OVERVIEW_EXPLICIT.test(q)) return true;
  if (/\btell me about\b/i.test(q)) return true;
  // "what is this document about", "what is covered in the file",
  // "what does the report contain", "tell me what the document is about" ...
  if (DOC_NOUN_RE.test(q) && DESCRIBE_VERB_RE.test(q)) return true;
  return false;
}

// ==================== QUERY (RAG) ENDPOINT ====================
app.post('/api/ask', async (req, res) => {
  try {
    if (!systemState.dbReady) {
      return res.status(503).json({ error: 'Backend is still initializing (connecting to the vector database). Please retry in a few seconds.', retryable: true });
    }
    const { query, sessionId = 'default', filename = null, topK = null } = req.body || {};
    if (!query || !query.trim()) return res.status(400).json({ error: 'Query is required.' });

    const asked = query.trim();
    const docCount = await getDocumentCount();
    if (docCount === 0) {
      return res.json({
        answer: 'No documents are ingested yet. Upload a file first (use the upload button above), then ask me anything about it.',
        sources: [],
        query: asked,
        relevantChunks: []
      });
    }

    console.log('Query: "' + asked.substring(0, 80) + '"' + (filename ? ' (file: ' + filename + ')' : ''));

    // ============ QUESTION ROUTING (logically correct RAG) ============
    // Broad/meta questions ("what is this document about", "summarize the key
    // points") are about the WHOLE document and can never score high against
    // any single chunk - routing them through vector search + the relevance
    // gate would wrongly refuse them. They are answered from a representative,
    // evenly-spaced chunk sample instead. Specific questions keep semantic
    // search + the accuracy gate.
    const isOverview = isOverviewQuestion(asked);

    let contextChunks;
    let mode;
    if (isOverview) {
      contextChunks = await getOverviewChunks(filename, 8);
      mode = 'overview';
      // Fold in the top semantic matches as well, so the embedding pipeline
      // contributes to overview answers too (union, deduplicated).
      try {
        const semantic = await searchSimilar(await embedText(asked), 3, filename);
        semantic.forEach(s => {
          if (!contextChunks.some(c => c.filename === s.filename && c.chunk_index === s.chunk_index)) contextChunks.push(s);
        });
      } catch (e) { /* embeddings are an enhancement here, not a requirement */ }
      console.log('Routing: overview question -> ' + contextChunks.length + ' context chunk(s)');
      if (contextChunks.length === 0) {
        return res.json({
          answer: 'No document content is available to summarize.',
          sources: [],
          query: asked,
          relevantChunks: []
        });
      }
    } else {
      const queryEmbedding = await embedText(asked);
      contextChunks = await searchSimilar(queryEmbedding, topK || TOP_K, filename);
      mode = 'specific';

      if (contextChunks.length === 0) {
        return res.json({
          answer: 'No matching passages found in the uploaded documents.',
          sources: [],
          query: asked,
          relevantChunks: []
        });
      }

      // ACCURACY GATE for specific questions: if the best semantic match is
      // below the confidence threshold we normally refuse instead of guessing.
      // One logical exception: if the question shares a meaningful keyword with
      // the top passages AND the match is not absurdly low, that lexical
      // evidence of topical relevance is enough to let the grounded LLM answer
      // (its own rules force it to admit when the context lacks the answer).
      const bestScore = contextChunks[0].score;
      const lexicalEvidence = bestScore >= 0.12 && bestScore < MIN_RELEVANCE_SCORE &&
        hasMeaningfulOverlap(asked, contextChunks.slice(0, 3).map(r => r.content).join(' '));
      // "tell me what this document is about", "what is covered in the pdf"...
      // The question references the document itself, so per-chunk similarity is
      // meaningless. Fall back to the overview retriever instead of refusing.
      const docReferential = /\b(doc(ument)?s?|file|pdf|report|paper|it|this|that|them|these|those)\b/i.test(asked);
      // Conversational follow-ups ("what changed?", "what new things have been
      // added?") refer to the ongoing conversation and the documents behind it.
      // For those, let the grounded LLM adjudicate - its own rules force it to
      // admit when the passages lack the answer - instead of a hard refusal.
      const conversational = getConversationHistory(sessionId, 4).length > 0 &&
        asked.split(/\s+/).length <= 12;
      if (bestScore < MIN_RELEVANCE_SCORE && !lexicalEvidence && docReferential) {
        contextChunks = await getOverviewChunks(filename, 8);
        mode = 'overview';
        console.log('Routing: doc-referential question with low similarity -> overview fallback (' + contextChunks.length + ' chunks)');
      } else if (bestScore < MIN_RELEVANCE_SCORE && conversational) {
        console.log('Routing: conversational follow-up with low similarity (' + (bestScore * 100).toFixed(1) + '%) -> grounded LLM adjudicates');
      } else if (bestScore < MIN_RELEVANCE_SCORE) {
        const allDocs = await getAllDocuments();
        const docList = allDocs.map(d => d.filename).join(', ') || 'none';
        return res.json({
          answer: 'The uploaded documents are not sufficiently relevant to "' + asked + '" (best match: ' +
            (bestScore * 100).toFixed(1) + '% similarity). Currently ingested: ' + docList +
            '. Ask about one of those, or upload a document that covers this topic.',
          sources: [],
          query: asked,
          relevantChunks: contextChunks.map(r => ({ content: r.content, filename: r.filename, chunk_index: r.chunk_index, score: r.score })),
          confidence: bestScore
        });
      } else {
        console.log('Routing: specific question -> top match ' + (bestScore * 100).toFixed(1) + '%' + (lexicalEvidence ? ' (lexical evidence)' : ''));
      }
    }

    // Format context with citable passage tags
    const context = contextChunks.map(r =>
      '[' + r.filename + ' | Chunk ' + r.chunk_index + ']' + (r.score != null ? ' [relevance: ' + (r.score * 100).toFixed(1) + '%]' : '') + '\n' + r.content
    ).join('\n\n---\n\n');

    const history = getConversationHistory(sessionId, 4);
    const answer = await generateResponse(asked, context, history, { mode });

    // Deduplicate sources by filename, keeping the highest score
    const sourceMap = {};
    contextChunks.forEach(r => {
      if (!sourceMap[r.filename] || (r.score != null && (sourceMap[r.filename].score == null || r.score > sourceMap[r.filename].score))) {
        sourceMap[r.filename] = { filename: r.filename, score: r.score };
      }
    });
    const sources = Object.values(sourceMap).sort((a, b) => (b.score || 0) - (a.score || 0));

    saveConversation(sessionId, 'user', asked);
    saveConversation(sessionId, 'assistant', answer, sources.map(s => s.filename));

    res.json({
      answer,
      sources,
      query: asked,
      confidence: mode === 'specific' ? contextChunks[0].score : null,
      mode,
      relevantChunks: contextChunks.map(r => ({
        content: r.content,
        filename: r.filename,
        chunk_index: r.chunk_index,
        fileType: r.fileType,
        score: r.score
      }))
    });
  } catch (error) {
    console.error('Query error:', error.message);
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

// === PART2B: documents, history, init ===

// ==================== DOCUMENT MANAGEMENT ====================
app.get('/api/documents', async (req, res) => {
  try {
    const documents = await getAllDocuments();
    res.json({ documents, count: documents.length });
  } catch (error) {
    console.error('List documents error:', error.message);
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

app.get('/api/documents/:filename', async (req, res) => {
  try {
    const doc = await getDocumentByName(req.params.filename);
    if (!doc) return res.status(404).json({ error: 'Document not found: ' + req.params.filename });
    res.json({ document: doc });
  } catch (error) {
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

app.delete('/api/documents/:filename', async (req, res) => {
  try {
    await deleteDocument(req.params.filename);
    res.json({ success: true, message: 'Deleted: ' + req.params.filename });
  } catch (error) {
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

app.delete('/api/documents', async (req, res) => {
  try {
    await clearAllData();
    res.json({ success: true, message: 'All documents and conversations cleared.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

// ==================== CONVERSATION HISTORY ====================
app.get('/api/history', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const history = getConversationHistory(sessionId, 100);
    res.json({ sessionId, history });
  } catch (error) {
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

app.delete('/api/history/:sessionId', async (req, res) => {
  try {
    clearConversation(req.params.sessionId);
    res.json({ success: true, message: 'Conversation cleared: ' + req.params.sessionId });
  } catch (error) {
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

// ==================== GLOBAL JSON ERROR HANDLER ====================
// Any error (multer rejection, bad payload, parser failure, etc.) is returned
// as JSON so the UI can always surface a helpful, accurate message.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = 500;
  const msg = err?.message || 'Unexpected server error';

  if (typeof multer.MulterError !== 'undefined' && err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  } else if (/unsupported format/i.test(msg)) {
    status = 400;
  } else if (/no file|no usable text|insufficient text/i.test(msg)) {
    status = 400;
  } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600) {
    status = err.status;
  }

  if (req.file?.path) {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
  }

  res.status(status).json({ error: msg });
});

// ==================== CRASH HARDENING ====================
// A hard crash (native module fault, unhandled rejection, etc.) would leave the
// frontend staring at "could not reach the backend". Log loudly instead of
// dying silently; the HTTP server keeps serving whatever still works.
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason instanceof Error ? reason.stack : reason);
});

// ==================== INIT ====================
function sweepStaleTempFiles() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  fs.readdirSync(UPLOAD_DIR).forEach(f => {
    const fp = path.join(UPLOAD_DIR, f);
    try {
      const stat = fs.statSync(fp);
      if (Date.now() - stat.mtime > ONE_DAY) fs.unlinkSync(fp);
    } catch (e) { /* ignore */ }
  });
}

async function connectWeaviateWithRetry(attempts = 5, delayMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await initDatabase();
      await ensureCollection();
      return true;
    } catch (e) {
      systemState.lastInitError = e.message;
      console.error('Weaviate connection attempt ' + i + '/' + attempts + ' failed: ' + e.message);
      if (i < attempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

async function initialize() {
  console.log('Starting ArcticLoom v' + VERSION + '...');
  sweepStaleTempFiles();

  // 1) Open the HTTP port FIRST so the frontend can always reach the API
  //    while heavier services initialize in the background.
  app.listen(PORT, () => {
    console.log('HTTP server listening on http://localhost:' + PORT + ' (services initializing...)');
  });

  // 2) Vector database (Weaviate Cloud) with retries. Upload/ask stay in 503
  //    "retryable" mode until this succeeds.
  const dbOk = await connectWeaviateWithRetry();
  if (dbOk) {
    systemState.dbReady = true;
    console.log('Weaviate connected and collection ready.');
  } else {
    console.error('Weaviate unreachable after retries: ' + systemState.lastInitError);
    console.error('Upload/ask endpoints will keep returning HTTP 503 until it connects.');
  }

  // 3) Embedding model (local ONNX). embedText() also lazy-loads on first use.
  console.log('Initializing embedding model...');
  try {
    await initEmbedder();
  } catch (e) {
    console.error('Embedder will load lazily on first request:', e.message);
  }

  // 4) LLM client (Hugging Face router).
  try { await initLLM(); } catch (e) { console.error('LLM init warning:', e.message); }

  systemState.initializing = false;

  let docCount = 0, chunkCount = 0;
  if (dbOk) {
    try {
      docCount = await withTimeout(getDocumentCount(), 8000, 'Document count');
      chunkCount = await withTimeout(getTotalChunkCount(), 8000, 'Chunk count');
    } catch (e) { /* the /api/status endpoint reports live numbers anyway */ }
  }

  console.log('');
  console.log('=========================================================');
  console.log('  ArcticLoom v' + VERSION + ' - RAG Intelligence Engine');
  console.log('  Backend:      http://localhost:' + PORT + (dbOk ? '' : '  [DB OFFLINE - 503 mode]'));
  console.log('  Embeddings:   ' + (process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2') + ' (local)');
  console.log('  LLM:          ' + (process.env.LLM_MODEL || 'Qwen/Qwen2.5-72B-Instruct') + ' (Hugging Face)');
  console.log('  Documents:    ' + docCount);
  console.log('  Chunks:       ' + chunkCount);
  console.log('');
  console.log('  >> No data folder is used. Upload documents via the UI at');
  console.log('     http://localhost:3000 or POST /api/upload');
  console.log('=========================================================');
  console.log('');
}

initialize().catch(e => {
  // Never exit: the HTTP server is already listening, so the frontend gets a
  // clear 503/health status instead of "connection refused".
  console.error('Initialization failed:', e.message);
  systemState.initializing = false;
});