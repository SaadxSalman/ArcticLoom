import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import pdf from '@cedrugs/pdf-parse';
import mammoth from 'mammoth';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx' });

export async function parseDocument(filePath, originalName = null) {
  const ext = path.extname(filePath).toLowerCase();
  const filename = originalName || path.basename(filePath);
  let text = '';
  let metadata = {};

  try {
    switch (ext) {
      case '.pdf': {
        const res = await parsePdf(filePath, filename);
        text = res.text;
        metadata = res.metadata;
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

// ===================== PDF RESILIENT PARSING =====================
// Strategy:
//   1. Validate the file really is a PDF (%PDF- magic) and reject look-alikes
//      (HTML error pages, images, .docx renamed to .pdf) with a clear message.
//   2. Reject password-protected PDFs early with actionable advice.
//   3. Primary extraction via the pdf.js-based @cedrugs/pdf-parse.
//   4. Fallback: a raw content-stream extractor (zlib inflate + PDF text
//      operators) that survives broken/missing xref tables and leading junk.
//   5. If still nothing, explain exactly why (truncated vs scanned/image-only).
async function parsePdf(filePath, displayName) {
  const buffer = fs.readFileSync(filePath);

  if (buffer.length === 0) {
    throw new Error('"' + displayName + '" is empty (0 bytes). Re-export or re-download the file and try again.');
  }

  // A real PDF starts with "%PDF-". Tolerate leading junk by slicing to the header.
  const pdfOffset = buffer.indexOf(Buffer.from('%PDF-', 'latin1'));
  if (pdfOffset === -1) {
    throw new Error(
      '"' + displayName + '" is not a valid PDF (no %PDF header found). ' +
      'It may be corrupted, password-protected, or actually a different file type renamed to .pdf.'
    );
  }
  const work = pdfOffset > 0 ? buffer.subarray(pdfOffset) : buffer;

  // Password-protected PDFs cannot be text-extracted - detect and explain early.
  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
  if (/\/Encrypt\b/.test(tail)) {
    throw new Error(
      '"' + displayName + '" is password-protected. Remove the password (e.g. re-save via Print > Save as PDF) and upload again.'
    );
  }

  const truncated = !buffer.subarray(Math.max(0, buffer.length - 2048)).toString('latin1').includes('%%EOF');

  // 1) Primary extraction.
  try {
    const data = await pdf(work);
    const parsedText = (data && data.text ? data.text : '').replace(/\s+/g, ' ').trim();
    if (parsedText.length >= 10) {
      return { text: parsedText, metadata: { pages: data.numpages || 0 } };
    }
    console.log('pdf-parse returned no text, trying raw fallback extractor...');
  } catch (e) {
    console.log('pdf-parse failed (' + e.message + '), trying raw fallback extractor...');
  }

  // 2) Fallback extraction (broken xref tables, unusual structure, etc.).
  const rawText = extractPdfTextFallback(work);
  if (rawText && rawText.length >= 10) {
    console.log('Raw fallback extractor recovered ' + rawText.length + ' characters.');
    return { text: rawText, metadata: { pages: 0, extractor: 'raw-fallback' } };
  }

  // 3) Precise, actionable failure reasons.
  if (truncated) {
    throw new Error('"' + displayName + '" appears truncated or corrupted (missing %%EOF). Re-download or re-export the PDF and try again.');
  }
  throw new Error(
    'No extractable text found in "' + displayName + '". It is likely a scanned/image-only PDF (OCR is not supported yet) or uses an unsupported internal structure.'
  );
}

/**
 * Fallback PDF text extractor. Scans every stream object, inflates FlateDecode
 * payloads, and harvests text-showing operators (Tj, TJ, ', "). This bypasses
 * the xref table entirely, so it works on PDFs pdf.js cannot open.
 */
function extractPdfTextFallback(buf) {
  const out = [];
  let idx = 0;
  while (idx < buf.length) {
    const s = buf.indexOf('stream', idx);
    if (s === -1) break;
    let dataStart = s + 6;
    if (buf[dataStart] === 0x0d) dataStart++;   // \r
    if (buf[dataStart] === 0x0a) dataStart++;   // \n
    const e = buf.indexOf('endstream', dataStart);
    if (e === -1) break;
    idx = e + 9;
    if (e - dataStart < 8) continue;            // degenerate stream, skip
    const chunk = buf.subarray(dataStart, e);
    let content = null;
    try { content = zlib.inflateSync(chunk).toString('latin1'); }
    catch (_) {
      try { content = zlib.inflateRawSync(chunk).toString('latin1'); } catch (_e) { content = null; }
    }
    if (content === null) content = chunk.toString('latin1'); // uncompressed stream
    const t = extractTextOps(content);
    if (t.trim()) out.push(t.trim());
  }
  if (out.length === 0) {
    // Last resort: strings sitting outside any stream (rare, uncompressed objects).
    const t = extractTextOps(buf.toString('latin1'));
    if (t.trim()) out.push(t.trim());
  }
  return out.join('\n').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}

/** Harvest (string) Tj / [(s1)(s2)]TJ / hex-strings from one content stream. */
function extractTextOps(content) {
  let out = '';
  const pending = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '(') {
      const r = readPdfLiteralString(content, i);
      if (!r) { i++; continue; }
      pending.push(r.text);
      i = r.next;
    } else if (ch === '<' && content[i + 1] === '<') {
      i += 2;                                   // dictionary start - skip markers
    } else if (ch === '<') {
      const end = content.indexOf('>', i + 1);
      if (end === -1) break;
      pending.push(decodePdfHexString(content.slice(i + 1, end)));
      i = end + 1;
    } else if (ch === ')') {
      i++;
    } else if (/[A-Za-z'"*]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9*'"]/.test(content[j])) j++;
      const op = content.slice(i, j);
      if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
        out += pending.join('');
        pending.length = 0;
        if (op === "'" || op === '"') out += '\n';
      } else if (op === 'T*' || op === 'Td' || op === 'TD' || op === 'ET') {
        out += ' ';
        pending.length = 0;
      }
      i = j;
    } else {
      i++;
    }
  }
  return out.replace(/ {2,}/g, ' ');
}

/** Read a PDF literal string starting at s[start] === '(' with escapes and nesting. */
function readPdfLiteralString(s, start) {
  let i = start + 1;
  let out = '';
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const d = s[i + 1];
      if (d === undefined) return null;
      if (d >= '0' && d <= '7') {
        let oct = '';
        let k = i + 1;
        while (k < s.length && oct.length < 3 && s[k] >= '0' && s[k] <= '7') { oct += s[k]; k++; }
        out += String.fromCharCode(parseInt(oct, 8));
        i = k;
      } else if (d === 'n') { out += '\n'; i += 2; }
      else if (d === 'r') { i += 2; }
      else if (d === 't') { out += '\t'; i += 2; }
      else if (d === 'b' || d === 'f') { out += ' '; i += 2; }
      else if (d === '\r') { i += (s[i + 2] === '\n') ? 3 : 2; }
      else if (d === '\n') { i += 2; }
      else { out += d; i += 2; }
    } else if (c === '(') {
      depth++; out += c; i++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return { text: out, next: i + 1 };
      out += c; i++;
    } else { out += c; i++; }
  }
  return null;
}

/** Decode a PDF hex string <...>; handles UTF-16BE (BOM) text. */
function decodePdfHexString(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 ? clean + '0' : clean;
  const bytes = Buffer.from(padded, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2) {
      const fixed = Buffer.concat([bytes.subarray(2), Buffer.from([0])]);
      fixed.swap16();
      return fixed.toString('utf16le');
    }
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return bytes.toString('latin1');
}

export function getSupportedFormats() {
  return ['.pdf', '.docx', '.doc', '.html', '.htm', '.md', '.markdown', '.txt', '.csv', '.json'];
}