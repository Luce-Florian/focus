import type { ModelOption } from '../../../domain/agent.ts';

/** Models offered at creation. The empty id means "no --model flag". */
export const MODELS: readonly ModelOption[] = [
  { id: '', label: 'défaut' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
];

// The initial prompt is summarised out of band, for the session tooltip.
export const SUMMARY_MODEL = 'haiku';
export const SUMMARY_TIMEOUT_MS = 20000;
export const SUMMARY_MAX_CHARS = 120;