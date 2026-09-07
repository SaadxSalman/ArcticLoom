import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { initDatabase, ensureCollection, getDocumentCount, getTotalChunkCount } from './vectorStore.js';

dotenv.config();

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let failures = 0;

function check(name, value, rules = {}) {
  const { required = false, isUrl = false, isPort = false } = rules;
  if (!value || (typeof value === 'string' && !value.trim())) {
    if (required) {
      console.log('  ' + RED + '✖' + RESET + ' ' + name + ': MISSING (set it in .env)');
      failures++;
    } else {
      console.log('  ' + YELLOW + '◐' + RESET + ' ' + name + ': (optional, using default)');
    }
    return;
  }
  if (isUrl && !/^https?:\/\//.test(value)) {
    console.log('  ' + RED + '✖' + RESET + ' ' + name + ': not a valid http(s) URL');
    failures++;
    return;
  }
  if (isPort && (Number.isNaN(parseInt(value)) || parseInt(value) < 1 || parseInt(value) > 65535)) {
    console.log('  ' + RED + '✖' + RESET + ' ' + name + ': not a valid port number');
    failures++;
    return;
  }
  console.log('  ' + GREEN + '✔' + RESET + ' ' + name + ': ' + (isUrl ? value.replace(/(:[^/]+)@/, '***@') : value));
}

async function main() {
  console.log('');
  console.log('  ArcticLoom Preflight Setup & Diagnostics');
  console.log('  ========================================');
  console.log('');

  // 1. Environment file
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    console.log(' ' + GREEN + '✔' + RESET + ' .env found at ' + envPath);
  } else {
    console.log(' ' + RED + '✖' + RESET + ' .env not found. Copy .env.example to .env and fill in your keys.');
    failures++;
  }

  // 2. Config checks
  console.log('\n -- Configuration --');
  check('PORT', process.env.PORT, { isPort: true });
  check('WEAVIATE_URL', process.env.WEAVIATE_URL, { required: true, isUrl: true });
  check('WEAVIATE_API_KEY', process.env.WEAVIATE_API_KEY, { required: true });
  check('HUGGINGFACE_API_KEY', process.env.HUGGINGFACE_API_KEY, { required: true });
  check('EMBEDDING_MODEL', process.env.EMBEDDING_MODEL);
  check('LLM_MODEL', process.env.LLM_MODEL);

  if (failures > 0) {
    console.log('\n ' + RED + 'Setup failed with ' + failures + ' problem(s). Fix your .env and re-run "npm run setup".' + RESET);
    process.exit(1);
  }

  // 3. Live connectivity test
  console.log('\n -- Live connectivity --');
  try {
    console.log('  Connecting to Weaviate Cloud...');
    await initDatabase();
    await ensureCollection();
    const docs = await getDocumentCount();
    const chunks = await getTotalChunkCount();
    console.log(' ' + GREEN + '✔' + RESET + ' Weaviate connection: OK');
    console.log(' ' + GREEN + '✔' + RESET + ' Collection ready (ArcticLoom_Documents)');
    console.log('  Currently indexed: ' + docs + ' document(s), ' + chunks + ' chunk(s)');
  } catch (e) {
    console.log(' ' + RED + '✖' + RESET + ' Weaviate connection failed: ' + e.message);
    process.exit(1);
  }

  console.log('');
  console.log(' ' + GREEN + '✔ Setup complete.' + RESET);
  console.log('  Start the backend with:  npm start');
  console.log('  Start the frontend with: cd frontend && npm run dev');
  console.log('  Then upload fresh documents and start asking questions.');
  console.log('');
}

main().catch(e => {
  console.error('Setup error:', e.message);
  process.exit(1);
});