import { HfInference } from '@huggingface/inference';
import dotenv from 'dotenv';

dotenv.config();

const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);

export async function initLLM() {
  return true;
}

export async function generateResponse(query, context, conversationHistory = []) {
  const historyPrompt = conversationHistory.length > 0
    ? '\n\nCONVERSATION HISTORY:\n' + conversationHistory.map(h => '[' + h.role + ']: ' + h.content).join('\n') + '\n'
    : '';

  const prompt = `You are ArcticLoom AI, an intelligent assistant that answers questions based on the provided document context.

RULES:
1. Answer the question using ONLY the information in the provided document context
2. Be comprehensive but concise - provide detailed answers when the context supports it
3. Always cite which document the information comes from
4. If the context does not contain enough information, say "The documents do not contain enough information to answer this question"
5. Do not make up information or use your general knowledge

DOCUMENT CONTEXT:${historyPrompt}
${context}

QUESTION: ${query}

ANSWER:`;

  try {
    const response = await hf.chatCompletion({
      model: 'meta-llama/Llama-3.2-3B-Instruct',
      messages: [
        { role: 'system', content: 'You are ArcticLoom AI, an expert research assistant. Answer questions strictly based on the provided document context. Cite your sources clearly. Be helpful and thorough.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.3,
      top_p: 0.9,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('LLM error:', error.message);
    const chunks = context.split('\n\n---\n\n').filter(c => c.trim());
    if (chunks.length > 0) {
      const bestChunk = chunks[0];
      const sourceMatch = bestChunk.match(/^\[(.+?)\]/);
      const source = sourceMatch ? sourceMatch[1] : 'Unknown';
      const contentPart = bestChunk.replace(/^\[.*?\]\n/, '').trim();
      return 'Based on the document "' + source + '":\n\n' + contentPart;
    }
    return 'The documents do not contain enough information to answer this question.';
  }
}

export function isLLMLoaded() { return true; }
export function isLLMLoading() { return false; }
export function getLLMError() { return null; }