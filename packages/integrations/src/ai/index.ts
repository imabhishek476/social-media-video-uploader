import type { AppConfig } from '@shorts/config';
import { GeminiHighlightAnalyzer } from './gemini';
import { ClaudeHighlightAnalyzer, HeuristicHighlightAnalyzer } from './highlights';
import { MockTranscriptionProvider, OpenAiCompatibleTranscriptionProvider } from './transcription';
import type { HighlightAnalyzer, TranscriptionProvider } from './types';

export * from './types';
export * from './signals';
export { ClaudeHighlightAnalyzer, HeuristicHighlightAnalyzer, buildTranscriptBlock, buildHighlightPrompt } from './highlights';
export { GeminiHighlightAnalyzer } from './gemini';
export { MockTranscriptionProvider, OpenAiCompatibleTranscriptionProvider } from './transcription';

export function createTranscriptionProvider(config: AppConfig): TranscriptionProvider {
  const t = config.integrations.transcription;
  return t.provider === 'openai'
    ? new OpenAiCompatibleTranscriptionProvider({ apiKey: t.apiKey!, baseUrl: t.baseUrl, model: t.model, costPerMinuteUsd: t.costPerMinuteUsd })
    : new MockTranscriptionProvider();
}

export function createHighlightAnalyzer(config: AppConfig): HighlightAnalyzer {
  const l = config.integrations.llm;
  if (l.provider === 'anthropic') return new ClaudeHighlightAnalyzer({ apiKey: l.apiKey, model: l.model });
  if (l.provider === 'gemini') return new GeminiHighlightAnalyzer({ apiKey: l.gemini.apiKey!, model: l.gemini.model });
  return new HeuristicHighlightAnalyzer();
}

export * from './metadata';
import { ClaudeMetadataGenerator, GeminiMetadataGenerator, TemplateMetadataGenerator, type MetadataGenerator } from './metadata';

/** Metadata uses the same LLM provider as highlight analysis. */
export function createMetadataGenerator(config: AppConfig): MetadataGenerator {
  const l = config.integrations.llm;
  if (l.provider === 'anthropic') return new ClaudeMetadataGenerator({ apiKey: l.apiKey, model: l.model });
  if (l.provider === 'gemini') return new GeminiMetadataGenerator({ apiKey: l.gemini.apiKey!, model: l.gemini.model });
  return new TemplateMetadataGenerator();
}
