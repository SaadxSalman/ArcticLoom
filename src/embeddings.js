import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = true;
env.useBrowserCache = false;
env.localModelPath = process.env.MODEL_PATH || './models';

let embedder = null;
let modelLoading = false;
let modelLoaded = false;

const MODEL_NAME = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';

export async function initEmbedder() {
  if (modelLoaded) return embedder;
  if (modelLoading) {
    while (modelLoading) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return embedder;
  }

  modelLoading = true;
  console.log('Loading embedding model: ' + MODEL_NAME + '...');

  try {
    embedder = await pipeline('feature-extraction', MODEL_NAME, {
      quantized: true
    });
    modelLoaded = true;
    modelLoading = false;
    console.log('Embedding model loaded successfully');
    return embedder;
  } catch (error) {
    modelLoading = false;
    console.error('Failed to load embedding model:', error.message);
    throw error;
  }
}

export async function embedText(text) {
  const model = await initEmbedder();
  const output = await model(text, {
    pooling: 'mean',
    normalize: true
  });
  return Array.from(output.data);
}

export async function embedTexts(texts) {
  const model = await initEmbedder();
  const embeddings = [];
  for (const text of texts) {
    const output = await model(text, {
      pooling: 'mean',
      normalize: true
    });
    embeddings.push(Array.from(output.data));
  }
  return embeddings;
}

export function isModelLoaded() {
  return modelLoaded;
}

export function isModelLoading() {
  return modelLoading;
}
