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
      case '.docx':
      case '.doc': {
        const dataBuffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        text = result.value.replace(/\s+/g, ' ').trim();
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
      case '.txt':
        text = fs.readFileSync(filePath, 'utf8').replace(/\s+/g, ' ').trim();
        break;
      default:
        text = fs.readFileSync(filePath, 'utf8').replace(/\s+/g, ' ').trim();
    }

    if (!text || text.length < 10) throw new Error('Insufficient text extracted');

    return { text, metadata, filename, fileType: ext.slice(1), fileSize: fs.statSync(filePath).size };
  } catch (error) {
    throw new Error('Failed to parse ' + filename + ': ' + error.message);
  }
}

export function getSupportedFormats() {
  return ['.pdf', '.docx', '.doc', '.html', '.htm', '.md', '.markdown', '.txt', '.csv', '.json'];
}
