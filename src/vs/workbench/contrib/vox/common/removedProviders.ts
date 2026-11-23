// Vox usa solo le IA locali (`voxLocal`) e le IA in CLI installate (`cliAgent`).
// Questi sono i fornitori delle versioni precedenti che non esistono più: i nomi servono soltanto per ripulire
// le impostazioni già salvate (chiavi API e modelli scelti), non per inviare richieste.
export const removedProviderNames = [
	'anthropic', 'openAI', 'deepseek', 'ollama', 'vLLM', 'openRouter', 'openAICompatible', 'gemini', 'groq',
	'xAI', 'mistral', 'lmStudio', 'liteLLM', 'googleVertex', 'microsoftAzure', 'awsBedrock',
] as const

// Titoli con cui i fornitori tolti comparivano nell'interfaccia: servono solo per l'avviso al primo avvio.
const removedProviderTitles: Record<string, string> = {
	anthropic: 'Anthropic', openAI: 'OpenAI', deepseek: 'DeepSeek', ollama: 'Ollama', vLLM: 'vLLM',
	openRouter: 'OpenRouter', openAICompatible: 'OpenAI-Compatible', gemini: 'Gemini', groq: 'Groq', xAI: 'Grok (xAI)',
	mistral: 'Mistral', lmStudio: 'LM Studio', liteLLM: 'LiteLLM', googleVertex: 'Google Vertex AI',
	microsoftAzure: 'Microsoft Azure OpenAI', awsBedrock: 'AWS Bedrock',
}
export const titleOfRemovedProvider = (providerName: string): string =>
	Object.hasOwn(removedProviderTitles, providerName) ? removedProviderTitles[providerName] : providerName

export const isRemovedProviderName = (providerName: unknown): boolean =>
	typeof providerName === 'string' && (removedProviderNames as readonly string[]).includes(providerName)

export type RemovedModelSelection = { featureName: string, providerName: string, modelName: string }

export type RemovedProvidersCleanup = {
	// vero se lo stato è cambiato e va salvato di nuovo
	changed: boolean,
	// fornitori tolti che avevano una chiave API o un altro segreto salvato, ora cancellato
	providersWithRemovedSecrets: string[],
	// modelli scelti che appartenevano a un fornitore tolto: la scelta è stata azzerata
	removedSelections: RemovedModelSelection[],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value)

// Un indirizzo può portare con sé delle credenziali: `https://utente:password@host` oppure `?key=...`.
// Si tolgono nome utente e password prima dell'host (fino all'ultima chiocciola prima del percorso: una password
// può contenerne altre) e tutto ciò che segue `?` o `#`: non si può sapere quale parametro è una chiave, quindi
// vanno via tutti. Il resto dell'indirizzo (host, porta, percorso) resta.
// Le barre dopo lo schema possono mancare, essere più di due o essere rovesciate (`https:utente:password@host`,
// `https:///utente:password@host`): chi legge gli indirizzi `http` e `https` le accetta tutte, quindi anche qui.
// Per gli altri schemi valgono solo le due barre: in `file:///cartella@x/v1` la chiocciola sta nel percorso.
export const endpointWithoutCredentials = (endpoint: string): string => {
	const cleaned = endpoint.replace(/[?#][\s\S]*$/, '')
		.replace(/^(\s*(?:https?:[\/\\]*|[a-z][a-z0-9+.-]*:[\/\\]{2}|[\/\\]{0,2}))[^\/\\]*@/i, '$1')
	// seconda rete: una forma che sfugge alla regola qui sopra ma che viene comunque letta come un indirizzo
	// con nome utente o password (per esempio con una tabulazione dentro lo schema)
	try {
		const url = new URL(cleaned)
		if (!url.username && !url.password) return cleaned
		url.username = ''
		url.password = ''
		return url.toString()
	} catch {
		return cleaned
	}
}

/**
 * Ripulisce lo stato delle impostazioni letto dal disco, modificandolo sul posto:
 * - cancella dai fornitori tolti la chiave API (`apiKey`), le intestazioni personalizzate (`headersJSON`, che possono
 *   contenere un `Authorization`), e toglie dall'indirizzo le credenziali che contiene (`endpointWithoutCredentials`);
 * - azzera i modelli scelti che appartenevano a un fornitore tolto (chi chiama sceglie poi il ripiego).
 * Tutto il resto (indirizzi, elenchi di modelli, opzioni e modifiche ai modelli dei fornitori tolti) resta com'è.
 * Si può chiamare a ogni lettura: dopo la prima pulizia non trova più niente e `changed` è falso.
 * Con `secretsOnly` toglie soltanto i segreti e lascia i modelli scelti: serve per la copia delle impostazioni
 * rimasta sotto la chiave di salvataggio precedente, che non viene più letta e deve restare com'era, senza chiavi.
 */
export const cleanRemovedProviders = (state: unknown, options?: { secretsOnly?: boolean }): RemovedProvidersCleanup => {
	const result: RemovedProvidersCleanup = { changed: false, providersWithRemovedSecrets: [], removedSelections: [] }
	if (!isRecord(state)) return result

	const settingsOfProvider = state.settingsOfProvider
	if (isRecord(settingsOfProvider)) {
		for (const providerName of removedProviderNames) {
			const settings = settingsOfProvider[providerName]
			if (!isRecord(settings)) continue
			let hadSecret = false
			for (const settingName of ['apiKey', 'headersJSON', 'endpoint']) {
				if (!Object.hasOwn(settings, settingName)) continue
				const value = settings[settingName]
				const text = typeof value === 'string' ? value.trim() : ''
				if (settingName === 'endpoint') {
					// l'indirizzo non è un segreto: resta, senza le credenziali che conteneva
					const cleaned = endpointWithoutCredentials(text)
					if (cleaned === text) continue
					hadSecret = true
					settings[settingName] = cleaned
					result.changed = true
					continue
				}
				// un valore non testuale non dovrebbe esistere: non si sa cosa contiene, quindi conta come segreto
				else if (typeof value === 'string' ? (text !== '' && !(settingName === 'headersJSON' && text === '{}')) : value != null) hadSecret = true
				delete settings[settingName]
				result.changed = true
			}
			if (hadSecret) result.providersWithRemovedSecrets.push(providerName)
		}
	}

	const modelSelectionOfFeature = state.modelSelectionOfFeature
	if (!options?.secretsOnly && isRecord(modelSelectionOfFeature)) {
		for (const featureName of Object.keys(modelSelectionOfFeature)) {
			const selection = modelSelectionOfFeature[featureName]
			if (!isRecord(selection) || !isRemovedProviderName(selection.providerName)) continue
			result.removedSelections.push({
				featureName,
				providerName: selection.providerName as string,
				modelName: typeof selection.modelName === 'string' ? selection.modelName : '',
			})
			modelSelectionOfFeature[featureName] = null
			result.changed = true
		}
	}

	return result
}
