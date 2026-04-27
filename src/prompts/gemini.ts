/**
 * Minimal Gemini API client for prompt generation.
 * Uses fetch directly — no SDK needed in a Worker environment.
 *
 * API key is only concatenated inside this module.
 */

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  /** Max output tokens (default: 1024) */
  maxTokens?: number;
  /** Temperature 0-1 (default: 0.9) */
  temperature?: number;
  /**
   * Thinking budget for Gemini 2.5+ models.
   * Set to 0 to disable thinking (faster, cheaper, sufficient for structured JSON).
   * Omit for models that don't support thinkingConfig (e.g. gemini-2.0-flash).
   */
  thinkingBudget?: number;
}

export class GeminiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`Gemini API error (HTTP ${status}): ${detail}`);
    this.name = 'GeminiError';
  }
}

/**
 * Call the Gemini generateContent API with a single user prompt.
 * Returns the text content of the first candidate.
 */
export async function geminiGenerate(
  systemPrompt: string,
  userPrompt: string,
  config: GeminiConfig,
): Promise<string> {
  const url = `${BASE_URL}/${config.model}:generateContent?key=${config.apiKey}`;

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: config.maxTokens ?? 1024,
    temperature: config.temperature ?? 0.9,
  };
  if (config.thinkingBudget !== undefined) {
    generationConfig['thinkingConfig'] = { thinkingBudget: config.thinkingBudget };
  }

  const body = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      { role: 'user', parts: [{ text: userPrompt }] },
    ],
    generationConfig,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new GeminiError(response.status, text.slice(0, 300));
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
  };

  // Gemini 2.5+ with thinking enabled returns two parts: thought (thought=true)
  // then the actual response. Skip thinking parts and take the last real text part.
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const textPart = parts.filter(p => !p.thought).at(-1);
  const text = textPart?.text;
  if (!text) {
    throw new GeminiError(200, 'Empty response from Gemini');
  }

  return text.trim();
}
