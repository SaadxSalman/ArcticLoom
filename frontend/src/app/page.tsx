"use client";

import { useState, useEffect, useRef } from 'react';
import { Brain, FileText, Loader2, Sparkles, Upload, Trash2, Database, Send, ChevronDown, ChevronUp, Zap } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  timestamp: Date;
}

interface Document {
  filename: string;
  total_chunks: number;
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [showDocs, setShowDocs] = useState(false);
  const [stats, setStats] = useState({ documents: 0, chunks: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';

  useEffect(() => { fetchDocuments(); fetchStats(); }, []);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const fetchDocuments = async () => {
    try { const r = await fetch(API_URL + '/api/documents'); const d = await r.json(); setDocuments(d.documents || []); } catch (e) {}
  };
  const fetchStats = async () => {
    try { const r = await fetch(API_URL + '/api/status'); const d = await r.json(); setStats({ documents: d.documents, chunks: d.chunks }); } catch (e) {}
  };

  const handleSearch = async () => {
    if (!query.trim() || loading) return;
    const userMsg = { role: 'user' as const, content: query, timestamp: new Date() };
    setMessages(prev => [...prev, userMsg]);
    setQuery('');
    setLoading(true);
    try {
      const r = await fetch(API_URL + '/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userMsg.content })
      });
      const d = await r.json();
      setMessages(prev => [...prev, { role: 'assistant', content: d.answer || 'No response', sources: d.sources || [], timestamp: new Date() }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error occurred', timestamp: new Date() }]);
    } finally { setLoading(false); fetchStats(); }
  };

  const handleFileUpload = async (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    setLoading(true);
    try {
      const r = await fetch(API_URL + '/api/upload', { method: 'POST', body: fd });
      const d = await r.json();
      if (d.success) {
        setMessages(prev => [...prev, { role: 'assistant', content: 'Uploaded: ' + d.document.filename + ' (' + d.document.totalChunks + ' chunks)', timestamp: new Date() }]);
        fetchDocuments(); fetchStats();
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Upload failed', timestamp: new Date() }]);
    } finally { setLoading(false); }
  };

  const handleDelete = async (filename: string) => {
    try { await fetch(API_URL + '/api/documents/' + encodeURIComponent(filename), { method: 'DELETE' }); fetchDocuments(); fetchStats(); } catch (e) {}
  };

  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileUpload(f); };

  return (
    <main className="min-h-screen bg-animated-gradient text-slate-200">
      <div className="max-w-6xl mx-auto px-4 py-6 h-screen flex flex-col">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 rounded-xl border border-blue-500/20 glow-blue"><Brain className="w-7 h-7 text-blue-400" /></div>
            <div><h1 className="text-2xl font-bold text-white">ArcticLoom</h1><p className="text-xs text-slate-500">Local RAG Intelligence</p></div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 glass rounded-lg text-xs">
              <Database className="w-3.5 h-3.5 text-cyan-400" /><span className="text-slate-400">{stats.documents} docs</span>
              <span className="text-slate-600">|</span><span className="text-slate-400">{stats.chunks} chunks</span>
            </div>
            <button onClick={() => setShowDocs(!showDocs)} className="flex items-center gap-2 px-3 py-1.5 glass rounded-lg text-xs hover:bg-slate-800/50">
              <FileText className="w-3.5 h-3.5 text-blue-400" /><span className="text-slate-400">Docs</span>
              {showDocs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </div>
        </header>

        {showDocs && (
          <div className="mb-4 glass-strong rounded-xl p-4 animate-fade-in-up">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-300">Indexed Documents</h3>
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/20 border border-blue-500/30 rounded-lg text-xs text-blue-400 hover:bg-blue-600/30">
                <Upload className="w-3.5 h-3.5" />Upload
              </button>
              <input ref={fileInputRef} type="file" className="hidden" accept=".pdf,.docx,.md,.txt,.csv,.json" onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])} />
            </div>
            {documents.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-4">No documents indexed yet</p>
            ) : (
              <div className="space-y-2 max-h-40 overflow-y-auto">
                {documents.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between px-3 py-2 bg-slate-800/30 rounded-lg">
                    <div className="flex items-center gap-2">
                      <FileText className="w-3.5 h-3.5 text-slate-500" />
                      <span className="text-xs text-slate-300">{doc.filename}</span>
                      <span className="text-xs text-slate-600">({doc.total_chunks} chunks)</span>
                    </div>
                    <button onClick={() => handleDelete(doc.id)} className="p-1 hover:bg-red-500/20 rounded">
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
            <div className="flex flex-col items-center justify-center h-full text-center space-y-6">
              <div className="p-4 bg-blue-500/5 rounded-2xl border border-blue-500/10 pulse-glow"><Zap className="w-12 h-12 text-blue-400/50" /></div>
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-slate-300">Ask your documents anything</h2>
                <p className="text-sm text-slate-500 max-w-md">Upload PDFs, Word docs, markdown files, or drag and drop them here.</p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                {['What is machine learning?', 'Tell me about space exploration', 'Best programming practices'].map((s) => (
                  <button key={s} onClick={() => setQuery(s)} className="px-3 py-1.5 glass rounded-full text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/50">{s}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={'animate-fade-in-up ' + (msg.role === 'user' ? 'flex justify-end' : '')}>
              {msg.role === 'user' ? (
                <div className="max-w-[70%] px-4 py-3 bg-blue-600/20 border border-blue-500/20 rounded-2xl rounded-br-md">
                  <p className="text-sm text-slate-200">{msg.content}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="p-1.5 bg-cyan-500/10 rounded-lg mt-0.5"><Sparkles className="w-4 h-4 text-cyan-400" /></div>
                    <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap flex-1">{msg.content}</p>
                  </div>
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="ml-8 flex flex-wrap gap-1.5">
                      {msg.sources.map((src, i) => (<span key={i} className="px-2 py-0.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs rounded-full">{src}</span>))}
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
              <span className="text-xs text-slate-500">Processing...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div className="relative">
          <div className="glass-strong rounded-2xl glow-blue">
            <div className="flex items-end gap-2 p-3">
              <button onClick={() => fileInputRef.current?.click()} className="p-2.5 hover:bg-slate-800/50 rounded-xl" title="Upload"><Upload className="w-5 h-5 text-slate-500" /></button>
              <textarea value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSearch(); } }} placeholder="Ask your documents anything..." rows={1} className="flex-1 bg-transparent border-none py-2.5 px-2 text-sm text-white placeholder-slate-500 focus:ring-0 outline-none resize-none max-h-32" />
              <button onClick={handleSearch} disabled={loading || !query.trim()} className="p-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:opacity-50 rounded-xl">
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </div>
          </div>
                  <p className="text-center text-xs text-slate-600 mt-2">ArcticLoom v2.0 - Weaviate Cloud RAG Engine</p>
        </div>
      </div>
    </main>
  );
}
