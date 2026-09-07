const DEFAULT_CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 1000;
const DEFAULT_CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP) || 200;

export function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap || DEFAULT_CHUNK_OVERLAP;

  if (text.length <= chunkSize) {
    return [{ content: text, index: 0, start: 0, end: text.length }];
  }

  const chunks = [];
  let index = 0;
  let position = 0;

  while (position < text.length) {
    let end = Math.min(position + chunkSize, text.length);

    // Try to break at a sentence boundary
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

    position = end - overlap;
    if (position <= (chunks[chunks.length - 1]?.start || 0) || position >= text.length) {
      break;
    }
  }

  return chunks;
}

function findSentenceBoundary(text, position) {
  const windowSize = 100;
  const start = Math.max(0, position - windowSize);
  const end = Math.min(text.length, position + windowSize);
  const window = text.substring(start, end);

  let closest = -1;
  let minDist = Infinity;

  // Find sentence endings
  for (let i = 0; i < window.length; i++) {
    if (window[i] === '.' || window[i] === '!' || window[i] === '?') {
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
