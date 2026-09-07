const DEFAULT_CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 1000;
const DEFAULT_CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP) || 200;

/**
 * Sentence-boundary-aware text chunking with configurable overlap.
 * Breaks at the sentence closest to the target size (but never earlier than
 * 50% of the chunk size) to keep semantic units intact.
 */
export function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = Math.min(options.overlap || DEFAULT_CHUNK_OVERLAP, Math.max(0, chunkSize - 1));

  if (!text || text.trim().length === 0) return [];
  if (text.length <= chunkSize) {
    return [{ content: text.trim(), index: 0, start: 0, end: text.length }];
  }

  const chunks = [];
  let index = 0;
  let position = 0;

  while (position < text.length) {
    let end = Math.min(position + chunkSize, text.length);

    // Prefer breaking at a sentence boundary near the chunk edge
    if (end < text.length) {
      const sentenceEnd = findSentenceBoundary(text, end);
      if (sentenceEnd > position + chunkSize * 0.5) {
        end = sentenceEnd;
      }
    }

    const content = text.substring(position, end).trim();
    if (content.length > 0) {
      chunks.push({ content, index, start: position, end });
      index++;
    }

    const nextPosition = end - overlap;
    const lastStart = chunks.length > 0 ? chunks[chunks.length - 1].start : 0;
    if (nextPosition <= lastStart || end >= text.length) break;
    position = nextPosition;
  }

  return chunks;
}

function findSentenceBoundary(text, position) {
  const windowSize = 75;
  const start = Math.max(0, position - windowSize);
  const end = Math.min(text.length, position + windowSize);
  const window = text.substring(start, end);

  let closest = -1;
  let minDist = Infinity;

  for (let i = 0; i < window.length; i++) {
    const ch = window[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      // Avoid splitting on decimal numbers / abbreviations
      if (ch === '.' && i > 0 && /[0-9]/.test(window[i - 1]) && i + 1 < window.length && /[0-9]/.test(window[i + 1])) {
        continue;
      }
      const absPos = start + i + 1;
      const dist = Math.abs(absPos - position);
      if (dist < minDist && absPos > start + 10) {
        minDist = dist;
        closest = absPos;
      }
    }
  }

  return closest > 0 ? closest : position;
}