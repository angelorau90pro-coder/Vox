/*--------------------------------------------------------------------------------------
 *  Conteggio dei token di una risposta in streaming di llama-server (API compatibile con OpenAI).
 *--------------------------------------------------------------------------------------*/

import { LLMTokenStats } from '../../common/sendLLMMessageTypes.js';

const positive = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
const hasText = (value: unknown): boolean => typeof value === 'string' && value.length > 0

// Segue i pezzi di una risposta e dice quanti token sono stati generati e a che velocità.
// Tre fonti, dalla più precisa: `usage` (a fine risposta, con `stream_options.include_usage`), `timings` di
// llama-server (a ogni pezzo con `timings_per_token`, altrimenti solo alla fine) e, se il motore non manda niente,
// una stima: llama-server manda un pezzo per ogni token, quindi si contano i pezzi con del contenuto.
export function createTokenStatsTracker(now: () => number = () => Date.now()) {
	let pieces = 0, firstAt: number | null = null, lastAt = 0
	let engineCount: number | null = null, engineSpeed: number | null = null
	let usageCompletion: number | null = null, promptTokens: number | null = null

	const current = (): LLMTokenStats => {
		const generated = usageCompletion ?? engineCount ?? pieces
		// la velocità stimata parte dal primo pezzo: il tempo di lettura del prompt non conta come generazione
		const estimated = pieces >= 2 && firstAt !== null && lastAt > firstAt ? (pieces - 1) * 1000 / (lastAt - firstAt) : null
		const speed = engineSpeed ?? estimated
		return {
			generated,
			tokensPerSecond: speed === null ? null : Math.round(speed * 10) / 10,
			promptTokens,
			exact: usageCompletion !== null || engineCount !== null,
			// il motore può dare i conteggi (`usage`) senza la velocità: allora la velocità resta una stima
			speedExact: engineSpeed !== null,
		}
	}

	return {
		current,
		onChunk(chunk: unknown): LLMTokenStats {
			if (chunk === null || typeof chunk !== 'object') return current()
			const { choices, timings, usage } = chunk as { choices?: unknown, timings?: unknown, usage?: unknown }
			const delta = Array.isArray(choices) ? choices[0]?.delta : null
			if (delta !== null && typeof delta === 'object') {
				const { content, reasoning_content, reasoning, tool_calls } = delta as Record<string, unknown>
				if (hasText(content) || hasText(reasoning_content) || hasText(reasoning) || (Array.isArray(tool_calls) && tool_calls.length > 0)) {
					const time = now()
					pieces += 1
					if (firstAt === null) firstAt = time
					lastAt = time
				}
			}
			if (timings !== null && typeof timings === 'object') {
				const { predicted_n, predicted_per_second } = timings as Record<string, unknown>
				const count = positive(predicted_n)
				if (count !== null) engineCount = Math.round(count)
				engineSpeed = positive(predicted_per_second) ?? engineSpeed
			}
			if (usage !== null && typeof usage === 'object') {
				const { completion_tokens, prompt_tokens } = usage as Record<string, unknown>
				const completion = positive(completion_tokens)
				if (completion !== null) usageCompletion = Math.round(completion)
				const prompt = positive(prompt_tokens)
				if (prompt !== null) promptTokens = Math.round(prompt)
			}
			return current()
		},
	}
}
