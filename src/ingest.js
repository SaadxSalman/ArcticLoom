import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { initDatabase, insertDocument, getDocumentByName, deleteDocument } from './vectorStore.js';
import { initEmbedder, embedText } from './embeddings.js';
import { parseDocument } from './parser.js';
import { chunkText } from './chunker.js';

dotenv.config();

const USAGE = `ArcticLoom CLI Ingest
=======================

Ingests explicit file paths into the vector database. There is NO data folder -
you must always pass the files you want to ingest:

  npm run ingest -- <file1> [file2] [file3 ...]

Examples:
  npm run ingest -- ./report.pdf ./notes.md ./data.csv
  node src/ingest.js "C:\\Users\\you\\Documents\\contract.docx"

If a file with the same name is already indexed, it is replaced (re-ingested).
`;

async function ingestFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error('  ✖ Not found: ' + resolved);
    return null;
  }
  if (fs.statSync(resolved).isDirectory()) {
    console.error('  ✖ Is a directory (pass files, not folders): ' + resolved);
    return null;
  }

  const filename = path.basename(filePath);
  console.log('Processing: ' + filename);

  const parsed = await parseDocument(resolved);
  console.log('  Extracted ' + parsed.text.length + ' chars (' + parsed.fileType + ', ' + parsed.fileSize + ' bytes)');

  const existing = await getDocumentByName(filename);
  if (existing) {
    console.log('  Re-indexing existing file...');
    await deleteDocument(filename);
  }

  const chunks = chunkText(parsed.text, {
    chunkSize: parseInt(process.env.CHUNK_SIZE) || 1000,
    overlap: parseInt(process.env.CHUNK_OVERLAP) || 200,
  });
  console.log('  Chunks: ' + chunks.length);

  const embeddings = [];
  for (let i = 0; i < chunks.length; i++) {
    embeddings.push(await embedText(chunks[i].content));
    if ((i + 1) % 5 === 0 || i === chunks.length - 1) {
      process.stdout.write('\r  Embedding: ' + (i + 1) + '/' + chunks.length);
    }
  }
  console.log('');

  const doc = await insertDocument(filename, parsed.fileType, parsed.fileSize, chunks, embeddings);
  console.log('  ✔ Ingested "' + doc.filename + '" (' + doc.totalChunks + ' chunks)');
  return doc;
}

async function main() {
  // npm run ingest -- a b c  => argv = [node, src/ingest.js, a, b, c]
  const targets = process.argv.slice(2);

  if (targets.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }

  console.log('ArcticLoom CLI Ingest');
  console.log('=====================\n');
  await initDatabase();
  await initEmbedder();

  let done = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      const doc = await ingestFile(target);
      if (doc) done++; else failed++;
    } catch (e) {
      console.error('  ✖ ' + target + ': ' + e.message);
      failed++;
    }
  }

  console.log('\n==============================================');
  console.log('Ingest complete: ' + done + ' file(s) ingested, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});