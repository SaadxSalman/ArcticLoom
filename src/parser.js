import fs from 'fs';
import path from 'path';
import pdf from '@cedrugs/pdf-parse';
import mammoth from 'mammoth';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx' });

export async function parseDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath);
  let text = '';
  let metadata = {};

  try {
    switch (ext) {
      case '.pdf': {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdf(dataBuffer);
        text = data.text.replace(/\s+/g, ' ').trim();
        metadata = { pages: data.numpages || 0 };
        break;
      }
      case '.docx': {
        const dataBuffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        text = result.value.replace(/\s+/g, ' ').trim();
        break;
      }
      case '.doc': {
        // mammoth is .docx-only; attempt it and surface a clear error if it fails
        const dataBuffer = fs.readFileSync(filePath);
        try {
          const result = await mammoth.extractRawText({ buffer: dataBuffer });
          text = result.value.replace(/\s+/g, ' ').trim();
        } catch (_) {
          throw new Error('Legacy .doc files are not supported - please convert the file to .docx, .pdf, or .txt before uploading.');
        }
        break;
      }
      case '.html':
      case '.htm': {
        const html = fs.readFileSync(filePath, 'utf8');
        text = turndown.turndown(html).replace(/\s+/g, ' ').trim();
        break;
      }
      case '.md':
      case '.markdown':
        text = fs.readFileSync(filePath, 'utf8').trim();
        break;
      case '.csv': {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        text = parseCsvToText(raw);
        break;
      }
      case '.json': {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        try {
          const parsed = JSON.parse(raw);
          text = JSON.stringify(parsed, null, 2);
        } catch (e) {
          throw new Error('Invalid JSON: ' + e.message);
        }
        break;
      }
      default:
        text = fs.readFileSync(filePath, 'utf8').replace(/\s+/g, ' ').trim();
    }

    if (!text || text.length < 10) throw new Error('Insufficient text extracted');

    return {
      text,
      metadata,
      filename,
      fileType: ext.slice(1),
      fileSize: fs.statSync(filePath).size,
    };
  } catch (error) {
    throw new Error('Failed to parse ' + filename + ': ' + error.message);
  }
}

/**
 * Convert CSV content into readable, RAG-friendly text so the LLM can answer
 * questions over tabular data ("what is the revenue for X?").
 */
function parseCsvToText(raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return '';
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(line => parseCsvLine(line));

  const parts = [];
  if (header.length > 0) {
    parts.push('TABLE HEADERS: ' + header.join(' | '));
  }
  rows.forEach((row, idx) => {
    if (row.some(c => c.trim())) {
      parts.push('ROW ' + (idx + 1) + ': ' + row.join(' | '));
    }
  });
  return parts.join('\n');
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { cells.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  cells.push(current.trim());
  return cells;
}

export function getSupportedFormats() {
  return ['.pdf', '.docx', '.doc', '.html', '.htm', '.md', '.markdown', '.txt', '.csv', '.json'];
}