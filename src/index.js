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
  getDocumentByName
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
      documents: await getDocumentCount(),
      chunks: await getTotalChunkCount()
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
    const parsed = await parseDocument(filePath);
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
    res.status(500).json({ error: 'Failed: ' + error.message });
  } finally {
    // Always remove the staged temp file - we never keep uploaded files on disk.
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) { console.log('Temp cleanup skipped:', e.message); }
    }
  }
});

// === PART2: ask, documents, history, init ===

// ==================== QUERY (RAG) ENDPOINT ====================
app.post('/api/ask', async (req, res) => {
  try {
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
    const queryEmbedding = await embedText(asked);
    const results = await searchSimilar(queryEmbedding, topK || TOP_K, filename);

    if (results.length === 0) {
      return res.json({
        answer: 'No matching passages found in the uploaded documents.',
        sources: [],
        query: asked,
        relevantChunks: []
      });
    }

    // ACCURACY GATE: if the best match is below the confidence threshold we do NOT
    // let the LLM guess. We return an honest message instead of a hallucination.
    const bestScore = results[0].score;
    if (bestScore < MIN_RELEVANCE_SCORE) {
      return res.json({
        answer: 'The uploaded documents are not sufficiently relevant to "' + asked + '" (best match: ' +
          (bestScore * 100).toFixed(1) + '% similarity). Please upload a document that covers this topic, or rephrase your question.',
        sources: [],
        query: asked,
        relevantChunks: results.map(r => ({ content: r.content, filename: r.filename, chunk_index: r.chunk_index, score: r.score })),
        confidence: bestScore
      });
    }

    // Format context with numbered, citable passages
    const context = results.map(r =>
      '[' + r.filename + ' | Chunk ' + r.chunk_index + ' | Score: ' + (r.score * 100).toFixed(1) + '%]\n' + r.content
    ).join('\n\n---\n\n');

    const history = getConversationHistory(sessionId, 4);
    const answer = await generateResponse(asked, context, history);

    // Deduplicate sources by filename, keeping the highest score
    const sourceMap = {};
    results.forEach(r => {
      if (!sourceMap[r.filename] || r.score > sourceMap[r.filename].score) {
        sourceMap[r.filename] = { filename: r.filename, score: r.score };
      }
    });
    const sources = Object.values(sourceMap).sort((a, b) => b.score - a.score);

    saveConversation(sessionId, 'user', asked);
    saveConversation(sessionId, 'assistant', answer, sources.map(s => s.filename));

    res.json({
      answer,
      sources: sources.map(s => ({ filename: s.filename, score: s.score })),
      query: asked,
      confidence: bestScore,
      relevantChunks: results.map(r => ({
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

async function initialize() {
  console.log('Starting ArcticLoom v' + VERSION + '...');
  sweepStaleTempFiles();

  try {
    await initDatabase();
    await ensureCollection();
  } catch (e) {
    console.error('Weaviate connection failed:', e.message);
  }

  console.log('Initializing embedding model...');
  try {
    await initEmbedder();
  } catch (e) {
    console.error('Embedder will load lazily on first request:', e.message);
  }

  try { await initLLM(); } catch (e) { console.error('LLM init warning:', e.message); }

  const docCount = await getDocumentCount();
  const chunkCount = await getTotalChunkCount();

  app.listen(PORT, () => {
    console.log('');
    console.log('=========================================================');
    console.log('  ArcticLoom v' + VERSION + ' - RAG Intelligence Engine');
    console.log('  Backend:      http://localhost:' + PORT);
    console.log('  Embeddings:   ' + (process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2') + ' (local)');
    console.log('  LLM:          ' + (process.env.LLM_MODEL || 'Qwen/Qwen2.5-72B-Instruct') + ' (Hugging Face)');
    console.log('  Documents:    ' + docCount);
    console.log('  Chunks:       ' + chunkCount);
    console.log('');
    console.log('  >> No data folder is used. Upload documents via the UI at');
    console.log('     http://localhost:3000 or POST /api/upload');
    console.log('=========================================================');
    console.log('');
  });
}

initialize().catch(e => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});