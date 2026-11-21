import type { AppConfig } from '@shorts/config';
import { GeminiHighlightAnalyzer } from './gemini';
import { ClaudeHighlightAnalyzer } from './highlights';
import { OpenAiCompatibleTranscriptionProvider } from './transcription';
import type { HighlightAnalyzer, TranscriptionProvider } from './types';

export * from './types';
export * from './signals';
export { ClaudeHighlightAnalyzer, buildTranscriptBlock, buildHighlightPrompt } from './highlights';
export { GeminiHighlightAnalyzer } from './gemini';
export { OpenAiCompatibleTranscriptionProvider, retryAfterMs, wordsWithin } from './transcription';

export function createTranscriptionProvider(config: AppConfig): TranscriptionProvider {
  const t = config.integrations.transcription;
  return new OpenAiCompatibleTranscriptionProvider({ apiKey: t.apiKey!, baseUrl: t.baseUrl, model: t.model, costPerMinuteUsd: t.costPerMinuteUsd });
}

export function createHighlightAnalyzer(config: AppConfig): HighlightAnalyzer {
  const l = config.integrations.llm;
  if (l.provider === 'anthropic') return new ClaudeHighlightAnalyzer({ apiKey: l.apiKey, model: l.model });
  return new GeminiHighlightAnalyzer({ apiKey: l.gemini.apiKey!, model: l.gemini.model });
}

export * from './metadata';
import { ClaudeMetadataGenerator, GeminiMetadataGenerator, type MetadataGenerator } from './metadata';

/** Metadata uses the same LLM provider as highlight analysis. */
export function createMetadataGenerator(config: AppConfig): MetadataGenerator {
  const l = config.integrations.llm;
  if (l.provider === 'anthropic') return new ClaudeMetadataGenerator({ apiKey: l.apiKey, model: l.model });
  return new GeminiMetadataGenerator({ apiKey: l.gemini.apiKey!, model: l.gemini.model });
}

export * from './facecam';
import { ClaudeFacecamDetector, GeminiFacecamDetector, type FacecamDetector } from './facecam';

/** Facecam detection uses the configured LLM's vision. */
export function createFacecamDetector(config: AppConfig): FacecamDetector {
  const l = config.integrations.llm;
  if (l.provider === 'anthropic') return new ClaudeFacecamDetector({ apiKey: l.apiKey, model: l.model });
  return new GeminiFacecamDetector({ apiKey: l.gemini.apiKey!, model: l.gemini.model });
}
