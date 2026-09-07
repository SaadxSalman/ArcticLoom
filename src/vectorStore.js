import weaviate from 'weaviate-client';
import dotenv from 'dotenv';

dotenv.config();

const WEAVIATE_URL = process.env.WEAVIATE_URL;
const WEAVIATE_API_KEY = process.env.WEAVIATE_API_KEY;

let client = null;
let connected = false;

export async function initDatabase() {
  if (connected) return client;

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
  const exists = await client.collections.exists('ArcticLoom_Documents');
  if (!exists) {
    await client.collections.create({
      name: 'ArcticLoom_Documents',
      properties: [
        { name: 'content', dataType: 'text', tokenization: 'word' },
        { name: 'fileName', dataType: 'text' },
        { name: 'chunkIndex', dataType: 'int' },
      ],
    });
    console.log('Created ArcticLoom_Documents collection');
  }
}

export async function insertDocument(filename, fileType, fileSize, chunks, embeddings) {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get('ArcticLoom_Documents');

  // Delete existing chunks for this file
  await collection.data.deleteMany(
    collection.filter.byProperty('fileName').equal(filename)
  );

    // Insert new chunks with pre-computed embeddings
  const objects = chunks.map((chunk, i) => ({
    properties: {
      content: chunk.content,
      fileName: filename,
      chunkIndex: i,
    },
    vectors: embeddings[i],
  }));

  await collection.data.insertMany(objects);

  return {
    id: filename,
    filename,
    fileType,
    fileSize,
    totalChunks: chunks.length,
  };
}

export async function getAllDocuments() {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get('ArcticLoom_Documents');

  const result = await collection.query.fetchObjects({
    returnProperties: ['fileName'],
    limit: 1000,
  });

  const fileMap = {};
  result.objects.forEach(obj => {
    const name = obj.properties.fileName;
    if (!fileMap[name]) {
      fileMap[name] = { filename: name, totalChunks: 0 };
    }
    fileMap[name].totalChunks++;
  });

  return Object.values(fileMap);
}

export async function getDocumentByName(filename) {
  const docs = await getAllDocuments();
  return docs.find(d => d.filename === filename);
}

export async function deleteDocument(filename) {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get('ArcticLoom_Documents');
  await collection.data.deleteMany(
    collection.filter.byProperty('fileName').equal(filename)
  );
}

export async function clearAllData() {
  await initDatabase();
  const exists = await client.collections.exists('ArcticLoom_Documents');
  if (exists) {
    await client.collections.delete('ArcticLoom_Documents');
  }
  await ensureCollection();
}

export async function getDocumentCount() {
  const docs = await getAllDocuments();
  return docs.length;
}

export async function getTotalChunkCount() {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get('ArcticLoom_Documents');
  const result = await collection.aggregate.overAll();
  return result.totalCount;
}

export async function searchSimilar(queryEmbedding, topK = 5, filename = null) {
  await initDatabase();
  await ensureCollection();
  const collection = client.collections.get('ArcticLoom_Documents');

  const opts = {
    limit: topK,
    returnMetadata: ['distance'],
    returnProperties: ['content', 'fileName', 'chunkIndex'],
  };

  if (filename) {
    opts.where = collection.filter.byProperty('fileName').equal(filename);
  }

  const result = await collection.query.nearVector(queryEmbedding, opts);

  return result.objects.map(obj => ({
    content: obj.properties.content,
    filename: obj.properties.fileName,
    chunk_index: obj.properties.chunkIndex,
    score: 1 - (obj.metadata?.distance || 0),
  }));
}

// Conversation history (stored locally since it's small)
const conversations = [];

export function saveConversation(sessionId, role, content, sources = []) {
  conversations.push({
    session_id: sessionId,
    role,
    content,
    sources: JSON.stringify(sources),
    created_at: new Date().toISOString(),
  });
}

export function getConversationHistory(sessionId, limit = 20) {
  return conversations
    .filter(c => c.session_id === sessionId)
    .slice(-limit)
    .map(c => ({ ...c, sources: JSON.parse(c.sources || '[]') }));
}