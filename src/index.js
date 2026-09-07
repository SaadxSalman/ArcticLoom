import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { initEmbedder, embedText, isModelLoaded as isEmbedderReady, isModelLoading as isEmbedderLoading } from './embeddings.js';
import { generateResponse, isLLMLoaded, isLLMLoading } from './llm.js';
import {
  initDatabase, getDocumentCount, getTotalChunkCount, getAllDocuments,
  deleteDocument, searchSimilar, saveConversation, getConversationHistory,
  insertDocument, clearAllData, ensureCollection
} from './vectorStore.js';
import { parseDocument, getSupportedFormats } from './parser.js';
import { chunkText } from './chunker.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;
const DATA_DIR = process.env.DATA_DIR || './data';
const TOP_K = parseInt(process.env.TOP_K) || 5;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DATA_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (getSupportedFormats().includes(ext)) cb(null, true);
    else cb(new Error('Unsupported format: ' + ext));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});


app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==================== SYSTEM STATUS ====================
app.get('/api/status', async (req, res) => {
  try {
    res.json({
      status: 'running',
      version: '2.0',
      embedder: { loaded: isEmbedderReady(), loading: isEmbedderLoading() },
      llm: { loaded: isLLMLoaded(), loading: isLLMLoading() },
      documents: await getDocumentCount(),
      chunks: await getTotalChunkCount()
    });
  } catch (e) {
    res.json({ status: 'running', documents: 0, chunks: 0 });
  }
});

// ==================== DOCUMENT UPLOAD ====================
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = req.file.path;
    const originalName = req.file.originalname;
    console.log('Parsing document: ' + originalName);
    const parsed = await parseDocument(filePath);
    const chunks = chunkText(parsed.text, {
      chunkSize: parseInt(process.env.CHUNK_SIZE) || 1000,
      overlap: parseInt(process.env.CHUNK_OVERLAP) || 200
    });
    console.log('Embedding ' + chunks.length + ' chunks from ' + originalName + '...');
    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(chunks[i].content);
      embeddings.push(embedding);
      if ((i + 1) % 5 === 0 || i === chunks.length - 1) {
        process.stdout.write('\r  Progress: ' + (i + 1) + '/' + chunks.length);
      }
    }
    console.log('');
    await insertDocument(originalName, parsed.fileType, parsed.fileSize, chunks, embeddings);
    if (req.file.filename !== originalName) fs.unlinkSync(filePath);
    res.json({
      success: true,
      message: 'Ingested: ' + originalName,
             document: { filename: originalName, total_chunks: chunks.length }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

// ==================== QUERY ENDPOINT ====================
app.post('/api/ask', async (req, res) => {
  try {
    const { query, sessionId = 'default', filename = null } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ error: 'Query is required' });

    const docCount = await getDocumentCount();
    if (docCount === 0) return res.json({ answer: 'No documents ingested yet.', sources: [], query });

    console.log('Query: "' + query.substring(0, 80) + '"' + (filename ? ' (file: ' + filename + ')' : ''));
    const queryEmbedding = await embedText(query);
    const results = await searchSimilar(queryEmbedding, TOP_K, filename);

    if (results.length === 0) {
      return res.json({ answer: 'No relevant information found in the documents.', sources: [], query });
    }

    // Format context with citations
    const context = results.map(r =>
      '[' + r.filename + ' | Chunk ' + r.chunk_index + ' | Score: ' + (r.score * 100).toFixed(1) + '%]\n' + r.content
    ).join('\n\n---\n\n');

    const history = getConversationHistory(sessionId, 4);
    const answer = await generateResponse(query, context, history);

    // Deduplicate sources by filename, keeping highest score
    const sourceMap = {};
    results.forEach(r => {
      if (!sourceMap[r.filename] || r.score > sourceMap[r.filename].score) {
        sourceMap[r.filename] = { filename: r.filename, score: r.score };
      }
    });
    const sources = Object.values(sourceMap).sort((a, b) => b.score - a.score);

    saveConversation(sessionId, 'user', query);
    saveConversation(sessionId, 'assistant', answer, sources.map(s => s.filename));

    res.json({
      answer,
      sources: sources.map(s => s.filename),
      query,
      relevantChunks: results.map(r => ({
        content: r.content,
        filename: r.filename,
        chunk_index: r.chunk_index,
        score: r.score
            }))
    });
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ error: 'Failed: ' + error.message });
  }
});

// ==================== DOCUMENT MANAGEMENT ====================
app.get('/api/documents', async (req, res) => {
  try {
    const documents = await getAllDocuments();
    res.json({ documents, count: documents.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/documents/:filename', async (req, res) => {
  try {
    await deleteDocument(req.params.filename);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/documents', async (req, res) => {
  try {
    await clearAllData();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ==================== INIT ====================
async function initialize() {
  console.log('Starting ArcticLoom v2.0...');
  console.log('Connecting to Weaviate Cloud...');
  await initDatabase();
  await ensureCollection();
  console.log('Initializing embedding model...');
  try {
    await initEmbedder();
  } catch (e) {
    console.warn('Embedder will load on first query:', e.message);
  }

  const docCount = await getDocumentCount();
  const chunkCount = await getTotalChunkCount();

  app.listen(PORT, () => {
    console.log('');
    console.log('=====================================================');
    console.log('  ArcticLoom v2.0 - Weaviate Cloud RAG Engine');
    console.log('  Backend: http://localhost:' + PORT);
    console.log('  Documents: ' + docCount);
    console.log('  Chunks: ' + chunkCount);
    console.log('=====================================================');
    console.log('');
  });
}

initialize().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});