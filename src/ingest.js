import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { initDatabase, insertDocument, getDocumentByName, deleteDocument } from './vectorStore.js';
import { initEmbedder, embedText } from './embeddings.js';
import { parseDocument } from './parser.js';
import { chunkText } from './chunker.js';

dotenv.config();

const DATA_DIR = process.env.DATA_DIR || './data';

async function ingest() {
  console.log('ArcticLoom Document Ingestion (Weaviate Cloud)');
  console.log('==============================================\n');
  await initDatabase();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const files = fs.readdirSync(DATA_DIR).filter(f => !f.startsWith('.') && !f.endsWith('.json'));
  if (files.length === 0) { console.log('No files found in ' + path.resolve(DATA_DIR)); return; }
  console.log('Found ' + files.length + ' file(s)\n');
  await initEmbedder();
  let totalChunks = 0, processed = 0;
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    if (fs.statSync(filePath).isDirectory()) continue;
    console.log('Processing: ' + file);
    try {
      const parsed = await parseDocument(filePath);
      const existing = await getDocumentByName(file);
      if (existing) { console.log('  Re-indexing...'); await deleteDocument(file); }
      const chunks = chunkText(parsed.text, { chunkSize: parseInt(process.env.CHUNK_SIZE) || 1000, overlap: parseInt(process.env.CHUNK_OVERLAP) || 200 });
      console.log('  Chunks: ' + chunks.length);
      const embeddings = [];
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await embedText(chunks[i].content);
        embeddings.push(embedding);
        if ((i + 1) % 5 === 0 || i === chunks.length - 1) process.stdout.write('\r  Embedding: ' + (i + 1) + '/' + chunks.length);
      }
      console.log('');
      await insertDocument(file, parsed.fileType, parsed.fileSize, chunks, embeddings);
      totalChunks += chunks.length;
      processed++;
      console.log('  Done\n');
    } catch (error) { console.error('  Error: ' + error.message + '\n'); }
  }
  console.log('==============================================');
  console.log('Ingestion complete: ' + processed + ' files, ' + totalChunks + ' chunks');
}

ingest().catch(console.error);
