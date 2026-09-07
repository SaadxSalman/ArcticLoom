"use client";
import { useState, useEffect, useRef } from 'react';
import { Brain, FileText, Loader2, Sparkles, Upload, Trash2, Database, Send, ChevronDown, ChevronUp, Zap, Plus, RefreshCw } from 'lucide-react';

interface Source { filename: string; score: number; }
interface Message { role: 'user' | 'assistant'; content: string; sources?: Source[]; isError?: boolean; timestamp: Date; }
interface Document { id: string; filename: string; fileType: string; fileSize: number; totalChunks: number; uploadedAt: string; }

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(1) + ' ' + units[i];
}
function shorten(name: string, max = 30): string {
  return name.length > max ? name.slice(0, max - 2) + '…' : name;
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [showDocs, setShowDocs] = useState(false);
  const [stats, setStats] = useState({ documents: 0, chunks: 0 });
  const [backendOnline, setBackendOnline] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';

  // Persistent session id so server-side conversation history survives refreshes.
  // Guarded for SSR/prerendering where localStorage doesn't exist.
  const getSessionId = (): string => {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      try {
        let id = localStorage.getItem('arcticloom_session');
        if (!id) {
          id = typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : 'session-' + Date.now() + '-' + Math.round(Math.random() * 1e6);
          localStorage.setItem('arcticloom_session', id);
        }
        return id;
      } catch (e) { /* storage unavailable */ }
    }
    return 'session-' + Date.now();
  };
  const sessionId = getSessionId();

  useEffect(() => { fetchDocuments(); fetchStats(); }, []);

  // Poll the backend every 5s; drives the connectivity banner + button states.
  useEffect(() => {
    const timer = window.setInterval(() => { fetchStats(); }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  /** Robustly parse a fetch Response into { success?, ...payload | error } without throwing. */
  const parseResponse = async (r: Response): Promise<Record<string, unknown>> => {
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { return await r.json(); } catch (e) { /* fall through */ }
    }
    const text = (await r.text().catch(() => '')) || '';
    return text.includes('{') ? tryParse(text) : { error: 'Server error (HTTP ' + r.status + ')' };
  };
  const tryParse = (text: string): Record<string, unknown> => {
    try { return JSON.parse(text); } catch (e) { return { error: 'Server error (HTTP ' + text.slice(0, 80) + ')' }; }
  };

  const fetchDocuments = async () => {
    try { const r = await fetch(API_URL + '/api/documents'); const d = await r.json(); setDocuments(d.documents || []); setBackendOnline(true); }
    catch (e) { setBackendOnline(false); }
  };
  const fetchStats = async () => {
    try {
      const r = await fetch(API_URL + '/api/status');
      const d = await r.json();
      setStats({ documents: d.documents || 0, chunks: d.chunks || 0 });
      setBackendOnline(true);
    } catch (e) { setBackendOnline(false); }
  };
  const pushMessage = (msg: Message) => setMessages(prev => [...prev, msg]);

  const handleSearch = async () => {
    const text = query.trim();
    if (!text || loading) return;
    if (!backendOnline) { fetchStats(); pushMessage({ role: 'assistant', content: '⚠️ The backend is offline. Start it with `npm start` in the ArcticLoom folder, then try again.', isError: true, timestamp: new Date() }); return; }
    pushMessage({ role: 'user', content: text, timestamp: new Date() });
    setQuery('');
    setLoading(true);
    try {
      const r = await fetch(API_URL + '/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, sessionId })
      });
      const d = await parseResponse(r);
      if (d.error) pushMessage({ role: 'assistant', content: '⚠️ ' + d.error, isError: true, timestamp: new Date() });
      else pushMessage({
        role: 'assistant',
        content: (d.answer as string) || 'No response',
        sources: ((d.sources as Source[]) || []).map((s: Source) => ({ filename: s.filename, score: s.score })),
        timestamp: new Date()
      });
    } catch (e) {
      setBackendOnline(false);
      pushMessage({ role: 'assistant', content: '⚠️ Could not reach the backend (' + API_URL + '). Make sure `npm start` is running in the ArcticLoom folder, then try again.', isError: true, timestamp: new Date() });
    } finally { setLoading(false); fetchStats(); }
  };

  // ==================== UPLOAD (fresh files only - no data folder) ====================
  const handleFileUpload = async (file: File) => {
    if (!backendOnline) { fetchStats(); pushMessage({ role: 'assistant', content: '⚠️ The backend is offline. Start it with `npm start`, then upload again.', isError: true, timestamp: new Date() }); return; }
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    setUploadName(file.name);
    try {
      const r = await fetch(API_URL + '/api/upload', { method: 'POST', body: fd });
      const d = await parseResponse(r);
      if (r.ok && d.success) {
        const doc = d.document as Document;
        pushMessage({
          role: 'assistant',
          content: '📄 Ingested "' + doc.filename + '" - ' + doc.totalChunks +
            ' chunk' + (doc.totalChunks === 1 ? '' : 's') + ' (' + formatBytes(doc.fileSize) + '). Ask me anything about it!',
          timestamp: new Date()
        });
        fetchDocuments(); fetchStats();
      } else {
        pushMessage({ role: 'assistant', content: '⚠️ Upload failed: ' + (d.error || ('HTTP ' + r.status)), isError: true, timestamp: new Date() });
      }
    } catch (e) {
      setBackendOnline(false);
      pushMessage({ role: 'assistant', content: '⚠️ Upload failed - could not reach the backend (' + API_URL + '). Make sure `npm start` is running, then try again.', isError: true, timestamp: new Date() });
    } finally { setUploading(false); setUploadName(''); }
  };

  const handleDelete = async (filename: string) => {
    try {
      const r = await fetch(API_URL + '/api/documents/' + encodeURIComponent(filename), { method: 'DELETE' });
      if (!r.ok) pushMessage({ role: 'assistant', content: '⚠️ Delete failed (HTTP ' + r.status + ')', isError: true, timestamp: new Date() });
      fetchDocuments(); fetchStats();
    } catch (e) { setBackendOnline(false); }
  };
  const handleClearAll = async () => {
    try {
      const r = await fetch(API_URL + '/api/documents', { method: 'DELETE' });
      if (r.ok) setMessages([]);
      fetchDocuments(); fetchStats();
    } catch (e) { setBackendOnline(false); }
  };
  const handleClearChat = async () => {
    setMessages([]);
    try { await fetch(API_URL + '/api/history/' + encodeURIComponent(sessionId), { method: 'DELETE' }); } catch (e) {}
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFileUpload(f);
  };

  const suggestions = documents.length > 0
    ? ['Summarize "' + shorten(documents[0].filename) + '"', 'What are the key points?', 'List the main topics covered']
    : ['What is this document about?', 'Summarize the key facts', 'List the main sections'];
  const hasDocs = documents.length > 0;

  // === JSX-B ===
  return (
    <main className="min-h-screen bg-animated-gradient text-slate-200">
      <div className="max-w-6xl mx-auto px-4 py-6 h-screen flex flex-col">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 rounded-xl border border-blue-500/20 glow-blue"><Brain className="w-7 h-7 text-blue-400" /></div>
            <div>
              <h1 className="text-2xl font-bold text-white">ArcticLoom</h1>
              <p className="text-xs text-slate-500">RAG Intelligence · v2.1</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 glass rounded-lg text-xs">
              <Database className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-slate-400">{stats.documents} docs</span>
              <span className="text-slate-600">|</span>
              <span className="text-slate-400">{stats.chunks} chunks</span>
            </div>
            <button onClick={() => setShowDocs(!showDocs)} className="flex items-center gap-2 px-3 py-1.5 glass rounded-lg text-xs hover:bg-slate-800/50" title="Manage documents">
              <FileText className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-slate-400">Docs</span>
              {showDocs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {messages.length > 0 && (
              <button onClick={handleClearChat} className="flex items-center gap-1.5 px-2.5 py-1.5 glass rounded-lg text-xs hover:bg-slate-800/50" title="Clear chat">
                <RefreshCw className="w-3.5 h-3.5 text-slate-400" /><span className="text-slate-400">Chat</span>
              </button>
            )}
          </div>
        </header>

        {!backendOnline && (
          <div className="mb-4 flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300 animate-fade-in-up">
            <Zap className="w-3.5 h-3.5 shrink-0" />
            <span>
              ⚠️ Backend is offline — couldn't reach <code className="text-red-400">{API_URL}</code>.
              Start it with <code className="text-red-400">npm start</code> in the ArcticLoom folder, then this page reconnects automatically.
            </span>
          </div>
        )}
        {backendOnline && (
          <div className="mb-4 flex items-center gap-2 px-4 py-1.5 bg-green-500/10 border border-green-500/20 rounded-full text-[10px] text-green-400">
            <span>●</span>Backend connected
          </div>
        )}

        {showDocs && (
          <div className="mb-4 glass-strong rounded-xl p-4 animate-fade-in-up">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-300">Indexed Documents</h3>
              <div className="flex items-center gap-2">
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/20 border border-blue-500/30 rounded-lg text-xs text-blue-400 hover:bg-blue-600/30">
                  <Upload className="w-3.5 h-3.5" />Upload
                </button>
                {hasDocs && (
                  <button onClick={handleClearAll} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400 hover:bg-red-500/20">
                    <Trash2 className="w-3.5 h-3.5" />Clear All
                  </button>
                )}
              </div>
              <input ref={fileInputRef} type="file" className="hidden"
                accept=".pdf,.docx,.md,.markdown,.txt,.csv,.json,.html,.htm"
                onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])} />
            </div>
            {!hasDocs ? (
              <p className="text-xs text-slate-500 text-center py-4">
                No documents indexed. Upload a PDF, Word, Markdown, TXT, CSV, JSON or HTML file to get started.
              </p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {documents.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between px-3 py-2 bg-slate-800/30 rounded-lg">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="text-xs text-slate-300 truncate" title={doc.filename}>{doc.filename}</span>
                      <span className="text-xs text-slate-600 shrink-0">
                        ({doc.totalChunks} chunk{doc.totalChunks === 1 ? '' : 's'} · {formatBytes(doc.fileSize)})
                      </span>
                    </div>
                    <button onClick={() => handleDelete(doc.filename)} className="p-1 hover:bg-red-500/20 rounded" title="Delete document">
                      <Trash2 className="w-3 h-3 text-red-400" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
<div className="flex-1 overflow-y-auto mb-4 space-y-4" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-5">
              <div className="p-4 bg-blue-500/5 rounded-2xl border border-blue-500/10 pulse-glow"><Zap className="w-12 h-12 text-blue-400/50" /></div>
              {!hasDocs ? (
                <>
                  <h2 className="text-xl font-semibold text-white">Start by uploading a document</h2>
                  <p className="text-sm text-slate-500 max-w-md">
                    ArcticLoom answers questions strictly from the files <span className="text-slate-400">you</span> provide.
                    Upload a fresh file (drag & drop or click below) - previously uploaded files are never reused.
                  </p>
                  <button onClick={() => fileInputRef.current?.click()} disabled={!backendOnline}
                    className="flex items-center gap-2 px-6 py-3 bg-blue-600/20 border border-blue-500/40 rounded-2xl text-sm text-blue-300 hover:bg-blue-600/30 glow-blue disabled:opacity-40">
                    <Plus className="w-5 h-5" />{backendOnline ? 'Upload your first document' : 'Start the backend first'}
                  </button>
                  {!backendOnline && (
                    <p className="text-xs text-red-400 max-w-md">
                      Start the backend with <code>npm start</code> in the ArcticLoom folder, wait for the green "Backend connected" pill, then upload.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h2 className="text-xl font-semibold text-white">Ask your documents anything</h2>
                  <p className="text-sm text-slate-500 max-w-md">Try one of the suggestions below, or type your own question.</p>
                </>
              )}
              <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => setQuery(s)} className="px-3 py-1.5 glass rounded-full text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/50">{s}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={'animate-fade-in-up ' + (msg.role === 'user' ? 'flex justify-end' : '')}>
              {msg.role === 'user' ? (
                <div className="max-w-[70%] px-4 py-3 bg-blue-600/20 border border-blue-500/20 rounded-2xl rounded-br-md">
                  <p className="text-sm text-slate-200 whitespace-pre-wrap">{msg.content}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="p-1.5 bg-cyan-500/10 rounded-lg mt-0.5 shrink-0"><Sparkles className="w-4 h-4 text-cyan-400" /></div>
                    <p className={'text-sm leading-relaxed whitespace-pre-wrap flex-1 ' + (msg.isError ? 'text-red-400' : 'text-slate-300')}>
                      {msg.content}
                    </p>
                  </div>
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="ml-8 flex flex-wrap gap-1.5">
                      {msg.sources.map((src, i) => (
                        <span key={i} title={'Similarity: ' + (src.score * 100).toFixed(1) + '%'} className="px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs rounded-full">
                          {src.filename} · {(src.score * 100).toFixed(0)}%
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 ml-8">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-blue-400 rounded-full typing-dot"></div>
                <div className="w-2 h-2 bg-blue-400 rounded-full typing-dot"></div>
                <div className="w-2 h-2 bg-blue-400 rounded-full typing-dot"></div>
              </div>
              <span className="text-xs text-slate-500">Searching documents & generating answer…</span>
            </div>
          )}
          {uploading && (
            <div className="flex items-center gap-2 ml-8">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
              <span className="text-xs text-slate-500">Ingesting "{uploadName}"…</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
<div className="relative">
          <div className="glass-strong rounded-2xl glow-blue">
            <div className="flex items-end gap-2 p-3">
              <button onClick={() => fileInputRef.current?.click()} className="p-2.5 hover:bg-slate-800/50 rounded-xl" title="Upload document">
                <Upload className="w-5 h-5 text-slate-500" />
              </button>
              <textarea value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSearch(); } }}
                placeholder={hasDocs ? 'Ask your documents anything…' : 'Upload a document first, then ask…'}
                rows={1} disabled={uploading}
                className="flex-1 bg-transparent border-none py-2.5 px-2 text-sm text-white placeholder-slate-500 focus:ring-0 outline-none resize-none max-h-32" />
              <button onClick={handleSearch} disabled={loading || uploading || !query.trim()} className="p-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:opacity-50 rounded-xl">
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </div>
          </div>
          <p className="text-center text-xs text-slate-600 mt-2">
            ArcticLoom v2.1 · Weaviate Cloud + local embeddings + Hugging Face LLM · answers are grounded in the documents you upload
          </p>
        </div>
      </div>
    </main>
  );
}