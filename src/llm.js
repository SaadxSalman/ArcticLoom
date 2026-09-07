import { HfInference } from '@huggingface/inference';
import dotenv from 'dotenv';

dotenv.config();

const HF_API_KEY = process.env.HUGGINGFACE_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'Qwen/Qwen2.5-72B-Instruct';

const hf = new HfInference(HF_API_KEY);

/**
 * Validate that the LLM is usable. The LLM runs through the Hugging Face
 * Inference API (the model weights live remotely - nothing is stored locally).
 */
export async function initLLM() {
  if (!HF_API_KEY) {
    console.error('LLM not configured: HUGGINGFACE_API_KEY is missing from .env');
    return false;
  }
  console.log('LLM ready (Hugging Face Inference API): ' + LLM_MODEL);
  return true;
}

/**
 * Generate a grounded answer from the retrieved document context.
 * The prompt is engineered for accuracy: the model is told to rely ONLY on
 * the supplied passages and to cite every claim by source.
 */
export async function generateResponse(query, context, conversationHistory = []) {
  const historyPrompt = conversationHistory.length > 0
    ? '\n\nCONVERSATION HISTORY (for continuity only, do not answer from it):\n' +
      conversationHistory.map(h => '[' + h.role + ']: ' + h.content).join('\n') + '\n'
    : '';

  const prompt = `You are ArcticLoom AI, an expert research assistant that answers questions using ONLY the provided document context.

GROUNDING RULES (strict):
1. Base every claim on the numbered passages inside DOCUMENT CONTEXT.
2. Cite sources inline using their bracketed tag, e.g. [report.pdf | Chunk 2].
3. If the context does not contain enough information to answer, reply exactly:
   "The uploaded documents do not contain enough information to answer this question." and stop.
4. Never invent facts, numbers, names, or figures. Do not use general knowledge to fill gaps.
5. Be comprehensive but stay strictly within the evidence. Prefer exact terms from the documents.
6. Structure long answers with short paragraphs or bullet points when helpful.
7. At the very end, add a line "Sources used: " followed by the unique [filename | Chunk N] tags you actually cited.

DOCUMENT CONTEXT:${historyPrompt}
${context}

QUESTION: ${query}

ANSWER:`;

  if (!HF_API_KEY) {
    // No API key -> honest fallback that returns the highest-ranked passage verbatim.
    return buildFallbackAnswer(context);
  }

  try {
    const response = await hf.chatCompletion({
      model: LLM_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are ArcticLoom AI, a precise research assistant. Answer strictly from the provided document context, cite your sources with exact [filename | Chunk N] tags, and never fabricate information.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: parseInt(process.env.LLM_MAX_TOKENS) || 1200,
      temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.2'),
      top_p: 0.95,
    });

    const answer = response?.choices?.[0]?.message?.content?.trim();
    return answer && answer.length > 0 ? answer : buildFallbackAnswer(context);
  } catch (error) {
    console.error('LLM error (' + LLM_MODEL + '):', error.message);
    return buildFallbackAnswer(context);
  }
}

/** If the LLM is unavailable, return the single best matching passage verbatim with a disclosure. */
function buildFallbackAnswer(context) {
  const chunks = context.split('\n\n---\n\n').filter(c => c.trim());
  if (chunks.length === 0) {
    return 'The uploaded documents do not contain enough information to answer this question.';
  }
  const best = chunks[0];
  const sourceMatch = best.match(/^\[(.+?)\]/);
  const source = sourceMatch ? sourceMatch[1] : 'Uploaded document';
  const contentPart = best.replace(/^\[.*?\]\n/, '').trim();
  return (
    'Exact passage from "' + source + '":\n\n' + contentPart +
    '\n\n(Note: the language model is temporarily unavailable, so this is the top-ranked passage returned verbatim from your documents.)'
  );
}

export function isLLMLoaded() { return !!HF_API_KEY; }
export function isLLMLoading() { return false; }
export function getLLMError() {
  return HF_API_KEY ? null : 'HUGGINGFACE_API_KEY is missing from .env';
}