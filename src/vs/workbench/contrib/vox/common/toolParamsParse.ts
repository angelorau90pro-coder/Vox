// Lettura tollerante dei parametri JSON di una chiamata a uno strumento (logica pura, nessun import).
// I modelli locali a volte scrivono JSON quasi giusto: recinti di codice, testo attorno, virgole finali, stringa vuota.
// Il recupero non tocca mai il contenuto delle stringhe: comandi e codice passano così come li ha scritti il modello.

type Parsed = { ok: true; value: unknown } | { ok: false }
type ParamsObj = { [key: string]: unknown }

const tryJson = (s: string): Parsed => {
	try { return { ok: true, value: JSON.parse(s) } } catch { return { ok: false } }
}

const asObject = (value: unknown): ParamsObj | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ParamsObj : null

// Toglie le virgole finali prima di } o ] soltanto fuori dalle stringhe.
export const removeTrailingCommas = (s: string): string => {
	let out = ''
	let inString = false
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]
		if (inString) {
			out += ch
			if (ch === '\\') { i++; if (i < s.length) out += s[i] }
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') { inString = true; out += ch; continue }
		if (ch === ',') {
			let j = i + 1
			while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++
			if (s[j] === '}' || s[j] === ']') continue // virgola strutturale finale: si salta
		}
		out += ch
	}
	return out
}

// Restituisce l'oggetto dei parametri, oppure null se il testo non è recuperabile.
// JSON valido ma del tipo sbagliato (elenco, numero, null) non si "recupera": resta null.
export const parseToolParamsLenient = (raw: string): ParamsObj | null => {
	const text = (raw ?? '').trim()
	// nessun parametro: vale come oggetto vuoto (strumenti senza parametri obbligatori)
	if (text === '') return {}

	const direct = tryJson(text)
	if (direct.ok) {
		// alcuni modelli codificano due volte: una stringa JSON che contiene l'oggetto
		if (typeof direct.value === 'string') {
			const inner = tryJson(direct.value)
			return inner.ok ? asObject(inner.value) : null
		}
		return asObject(direct.value)
	}

	// toglie il recinto di codice ```json ... ```
	const unfenced = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
	if (unfenced !== text) {
		const fromFence = tryJson(unfenced)
		if (fromFence.ok) return asObject(fromFence.value)
	}
	// un elenco al livello più alto non è un insieme di parametri, nemmeno se scritto male
	if (unfenced.startsWith('[')) return null

	// prende dalla prima graffa aperta all'ultima chiusa (testo prima o dopo l'oggetto)
	const start = unfenced.indexOf('{')
	const end = unfenced.lastIndexOf('}')
	if (start === -1 || end <= start) return null
	const inner = unfenced.slice(start, end + 1)
	const fromInner = tryJson(inner)
	if (fromInner.ok) return asObject(fromInner.value)

	// virgole finali prima di } o ], solo fuori dalle stringhe
	const fixed = tryJson(removeTrailingCommas(inner))
	return fixed.ok ? asObject(fixed.value) : null
}
