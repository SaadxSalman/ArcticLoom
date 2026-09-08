import weaviate from 'weaviate-client';
import dotenv from 'dotenv';

dotenv.config();

const WEAVIATE_URL = process.env.WEAVIATE_URL;
const WEAVIATE_API_KEY = process.env.WEAVIATE_API_KEY;
const COLLECTION_NAME = process.env.WEAVIATE_COLLECTION || 'ArcticLoom_Documents';

let client = null;
let connected = false;

// Schema definition. Extra metadata lives on every chunk object so the document
// list can be rebuilt directly from the vector store, without a data folder.
const COLLECTION_PROPERTIES = [
  { name: 'content', dataType: 'text', tokenization: 'word' },
  { name: 'fileName', dataType: 'text' },
  { name: 'chunkIndex', dataType: 'int' },
  { name: 'fileType', dataType: 'text' },
  { name: 'fileSize', dataType: 'int' },
  { name: 'totalChunks', dataType: 'int' },
  { name: 'uploadedAt', dataType: 'text' },
];

export async function initDatabase() {
  if (connected) return client;

  if (!WEAVIATE_URL || !WEAVIATE_API_KEY) {
    throw new Error('Missing WEAVIATE_URL or WEAVIATE_API_KEY. Add them to your .env file (see .env.example).');
  }

  console.log('Connecting to Weaviate Cloud...');
  client = await weaviate.connectToWeaviateCloud(WEAVIATE_URL, {
    authCredentials: new weaviate.ApiKey(WEAVIATE_API_KEY),
    headers: {
      'X-HuggingFace-Api-Key': process.env.HUGGINGFACE_API_KEY || '',
    },
  });

  connected = true;
  console.log('Connected to Weaviate Cloud');
  return client;
}

export function getClient() { return client; }
export function isConnected() { return connected; }

export async function ensureCollection() {
  await initDatabase();
  const exists = await client.collections.exists(COLLECTION_NAME);
  if (exists) {
    // Best-effort additive schema sync. Weaviate Cloud ships with auto-schema
    // enabled, so new properties are normally created automatically on insert.
    try { await registerMissingProperties(); }
    catch (e) { console.log('Schema sync skipped (' + e.message + ') - auto-schema will handle new properties.'); }
    return;
  }
  await client.collections.create({ name: COLLECTION_NAME, properties: COLLECTION_PROPERTIES });
  console.log('Created ' + COLLECTION_NAME + ' collection');
}

async function registerMissingProperties() {
  if (typeof client.schema === 'undefined') return;
  try {
    const existing = await client.schema.get(COLLECTION_NAME);
    const present = new Set((existing?.properties || []).map(p => p.name));
    for (const prop of COLLECTION_PROPERTIES) {
      if (!present.has(prop.name) && typeof client.schema.update === 'function') {
        await client.schema.update(COLLECTION_NAME, { properties: [prop] });
        console.log('  Schema: added property "' + prop.name + '"');
      }
    }
  } catch (e) { /* client version may not expose schema API - ignore */ }
}

// ===================== PART 2 =====================

export async function insertDocument(filename, fileType, fileSize, chunks, embeddings) {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get(COLLECTION_NAME);

  // Replace any previously indexed version of this file (fresh re-ingest)
  await collection.data.deleteMany(
    collection.filter.byProperty('fileName').equal(filename)
  );

  const uploadedAt = new Date().toISOString();
  const objects = chunks.map((chunk, i) => ({
    properties: {
      content: chunk.content,
      fileName: filename,
      chunkIndex: i,
      fileType: fileType || 'unknown',
      fileSize: fileSize || 0,
      totalChunks: chunks.length,
      uploadedAt,
    },
    vectors: embeddings[i],
  }));

  // Insert in batches to stay well below request size limits
  const BATCH_SIZE = 50;
  for (let i = 0; i < objects.length; i += BATCH_SIZE) {
    await collection.data.insertMany(objects.slice(i, i + BATCH_SIZE));
  }

  // Read-back verification: Weaviate Cloud can briefly lag behind a successful
  // write (eventual consistency). Poll until the freshly inserted chunks are
  // actually retrievable, so a 200 from /api/upload guarantees the document is
  // listable and searchable immediately afterwards - no "it disappeared" or
  // "not relevant" moments right after ingestion.
  const expected = chunks.length;
  const deadline = Date.now() + 10000;
  let visible = 0;
  while (Date.now() < deadline) {
    try {
      const check = await collection.query.fetchObjects({
        filters: collection.filter.byProperty('fileName').equal(filename),
        limit: expected + 5,
        returnProperties: ['fileName'],
      });
      visible = (check.objects || []).length;
      if (visible >= expected) break;
    } catch (e) { /* transient read error - retry until the deadline */ }
    await new Promise(r => setTimeout(r, 400));
  }
  if (visible >= expected) {
    console.log('Read-back verified: ' + visible + ' chunk(s) visible for "' + filename + '"');
  } else {
    console.warn('Read-back: only ' + visible + '/' + expected + ' chunk(s) visible after 10s (write lag) - the document may take a moment to appear.');
  }

  return {
    id: filename,
    filename,
    fileType: fileType || 'unknown',
    fileSize: fileSize || 0,
    totalChunks: chunks.length,
    uploadedAt,
  };
}

async function fetchAllObjects(collection, returnProperties) {
  const objects = [];
  const LIMIT = 500;
  let offset = 0;
  while (true) {
    const page = await collection.query.fetchObjects({
      returnProperties,
      limit: LIMIT,
      offset,
    });
    objects.push(...(page.objects || []));
    if (!page.objects || page.objects.length < LIMIT) break;
    offset += LIMIT;
    if (offset > 10000) break; // hard safety cap
  }
  return objects;
}

export async function getAllDocuments() {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get(COLLECTION_NAME);

  const objects = await fetchAllObjects(collection, [
    'fileName', 'chunkIndex', 'fileType', 'fileSize', 'totalChunks', 'uploadedAt'
  ]);

  const fileMap = {};
  objects.forEach(obj => {
    const p = obj.properties || {};
    const name = p.fileName;
    if (!name) return;
    if (!fileMap[name]) {
      fileMap[name] = {
        id: name,
        filename: name,
        fileType: p.fileType || 'unknown',
        fileSize: p.fileSize || 0,
        totalChunks: 0,
        uploadedAt: p.uploadedAt || '',
      };
    }
    fileMap[name].totalChunks++;
  });

  return Object.values(fileMap).sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
}

export async function getDocumentByName(filename) {
  const docs = await getAllDocuments();
  return docs.find(d => d.filename === filename);
}

export async function deleteDocument(filename) {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get(COLLECTION_NAME);
  await collection.data.deleteMany(
    collection.filter.byProperty('fileName').equal(filename)
  );
}

export async function clearAllData() {
  await initDatabase();
  const exists = await client.collections.exists(COLLECTION_NAME);
  if (exists) {
    await client.collections.delete(COLLECTION_NAME);
  }
  await ensureCollection();
  conversations = [];
}

// ===================== OVERVIEW RETRIEVAL =====================
// Broad questions ("what is this document about?") are about the WHOLE
// document, so semantic nearest-neighbor search is the wrong tool: they can
// never score high against any single specific chunk. This returns a
// REPRESENTATIVE sample instead - the opening chunks (title/purpose) plus
// evenly spaced chunks across each document - giving the LLM real material
// to summarize.
export async function getOverviewChunks(filename = null, perDoc = 6) {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get(COLLECTION_NAME);

  const opts = {
    returnProperties: ['content', 'fileName', 'chunkIndex', 'fileType'],
    limit: 500,
  };
  if (filename) {
    opts.filters = collection.filter.byProperty('fileName').equal(filename);
  }
  const res = await collection.query.fetchObjects(opts);

  const byDoc = {};
  (res.objects || []).forEach(obj => {
    const name = obj.properties.fileName;
    if (!name) return;
    (byDoc[name] = byDoc[name] || []).push(obj);
  });

  const chunks = [];
  Object.values(byDoc).forEach(objs => {
    objs.sort((a, b) => (a.properties.chunkIndex || 0) - (b.properties.chunkIndex || 0));
    const total = objs.length;
    const take = Math.max(1, Math.min(perDoc, total));
    const seen = new Set();
    for (let i = 0; i < take; i++) {
      const pos = Math.round((i * (total - 1)) / Math.max(1, take - 1));
      if (seen.has(pos)) continue;
      seen.add(pos);
      const obj = objs[pos];
      chunks.push({
        content: obj.properties.content,
        filename: obj.properties.fileName,
        chunk_index: obj.properties.chunkIndex,
        fileType: obj.properties.fileType,
        score: null
      });
    }
  });
  return chunks;
}

export async function getDocumentCount() {
  const docs = await getAllDocuments();
  return docs.length;
}

export async function getTotalChunkCount() {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get(COLLECTION_NAME);
  const result = await collection.aggregate.overAll();
  return result.totalCount || 0;
}

// ===================== PART 3 =====================

export async function searchSimilar(queryEmbedding, topK = 5, filename = null) {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get(COLLECTION_NAME);

  const opts = {
    limit: topK,
    returnMetadata: ['distance'],
    returnProperties: ['content', 'fileName', 'chunkIndex', 'fileType', 'totalChunks', 'uploadedAt'],
  };

  if (filename) {
    opts.where = collection.filter.byProperty('fileName').equal(filename);
  }

  const result = await collection.query.nearVector(queryEmbedding, opts);

  return result.objects.map(obj => ({
    content: obj.properties.content,
    filename: obj.properties.fileName,
    chunk_index: obj.properties.chunkIndex,
    fileType: obj.properties.fileType,
    uploadedAt: obj.properties.uploadedAt,
    score: Math.max(0, Math.min(1, 1 - (obj.metadata?.distance || 1))),
  }));
}

// ==================== CONVERSATION HISTORY (in-memory per session) ====================
let conversations = [];
const MAX_CONVERSATIONS = 2000;

export function saveConversation(sessionId, role, content, sources = []) {
  conversations.push({
    session_id: sessionId,
    role,
    content,
    sources: JSON.stringify(sources),
    created_at: new Date().toISOString(),
  });
  if (conversations.length > MAX_CONVERSATIONS) {
    conversations = conversations.slice(-MAX_CONVERSATIONS);
  }
}

export function getConversationHistory(sessionId, limit = 20) {
  return conversations
    .filter(c => c.session_id === sessionId)
    .slice(-limit)
    .map(c => ({ ...c, sources: JSON.parse(c.sources || '[]') }));
}

export function clearConversation(sessionId) {
  conversations = conversations.filter(c => c.session_id !== sessionId);
}