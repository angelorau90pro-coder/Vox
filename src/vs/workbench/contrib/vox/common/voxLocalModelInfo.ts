// Dati dei modelli delle IA locali di Vox che servono già all'avvio, prima del primo rilevamento: la finestra di
// contesto e l'uso (chat o completamento). Si salvano in due chiavi: `vox.voxLocal.contextWindows` (nome -> token,
// com'era nelle versioni precedenti) e `vox.voxLocal.completionModels` (nomi dei modelli di completamento).

export type VoxLocalModelInfo = { name: string, contextWindow: number | undefined, uso?: 'chat' | 'completamento' }

const isValidContextWindow = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value > 0

const parseJson = (text: string | undefined): unknown => {
	if (!text) return undefined
	try { return JSON.parse(text) } catch { return undefined } // valore rovinato: si aspetta il primo rilevamento
}

// Ricostruisce i dati dai due valori salvati. Un valore mancante o rovinato vale come vuoto, senza toccare l'altro.
export const parseSavedVoxLocalModelInfo = (contextWindowsJson: string | undefined, completionModelsJson: string | undefined): VoxLocalModelInfo[] => {
	const models = new Map<string, VoxLocalModelInfo>()

	const contextWindows = parseJson(contextWindowsJson)
	if (contextWindows && typeof contextWindows === 'object' && !Array.isArray(contextWindows)) {
		for (const [name, contextWindow] of Object.entries(contextWindows)) {
			models.set(name, { name, contextWindow: isValidContextWindow(contextWindow) ? contextWindow : undefined })
		}
	}

	const completionModels = parseJson(completionModelsJson)
	if (Array.isArray(completionModels)) {
		for (const name of completionModels) {
			if (typeof name !== 'string' || !name) continue
			models.set(name, { name, contextWindow: models.get(name)?.contextWindow, uso: 'completamento' })
		}
	}

	return [...models.values()]
}

// I due valori da salvare; l'ordine dei nomi è stabile, così si può confrontare il testo per scrivere solo se cambia.
export const serializeVoxLocalModelInfo = (models: VoxLocalModelInfo[]): { contextWindows: string, completionModels: string } => {
	const contextWindows: Record<string, number> = {}
	const completionModels: string[] = []
	for (const { name, contextWindow, uso } of models) {
		if (isValidContextWindow(contextWindow)) contextWindows[name] = contextWindow
		if (uso === 'completamento') completionModels.push(name)
	}
	return { contextWindows: JSON.stringify(contextWindows), completionModels: JSON.stringify(completionModels.sort()) }
}
