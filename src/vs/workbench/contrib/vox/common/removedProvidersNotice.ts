import { t } from './voxI18n.js';
import { RemovedModelSelection, RemovedProvidersCleanup, titleOfRemovedProvider } from './removedProviders.js';

// un modello scelto, come in `ModelSelection` (qui basta la forma: questo file non dipende dai tipi delle impostazioni)
type NoticeSelection = { providerName: string, modelName: string }

// Cosa è cambiato al primo avvio dopo l'eliminazione dei fornitori in cloud e dei server locali di terzi.
export type RemovedProvidersNotice = {
	// fornitori tolti di cui sono state cancellate le chiavi API (o altre credenziali) salvate
	providersWithRemovedSecrets: string[],
	// modelli scelti che appartenevano a un fornitore tolto, con quello che li sostituisce (null = nessuno disponibile)
	replacedSelections: (RemovedModelSelection & { replacement: NoticeSelection | null })[],
}

// L'avviso da mostrare dopo la pulizia, o null se non c'è niente da dire. `selectionNow` dà il modello che la
// funzione ha dopo il ripiego. Unisce un avviso precedente non ancora mostrato, senza ripetere le voci.
export const removedProvidersNoticeOf = (opts: {
	cleanup: RemovedProvidersCleanup,
	selectionNow: (featureName: string) => NoticeSelection | null,
	pending: RemovedProvidersNotice | null,
}): RemovedProvidersNotice | null => {
	const { cleanup, selectionNow, pending } = opts
	const providersWithRemovedSecrets = [...new Set([...(pending?.providersWithRemovedSecrets ?? []), ...cleanup.providersWithRemovedSecrets])]
	const replacedNow = cleanup.removedSelections.map(removed => ({ ...removed, replacement: selectionNow(removed.featureName) }))
	const replacedSelections = [
		...(pending?.replacedSelections ?? []).filter(old => !replacedNow.some(now => now.featureName === old.featureName)),
		...replacedNow,
	]
	if (providersWithRemovedSecrets.length === 0 && replacedSelections.length === 0) return null
	return { providersWithRemovedSecrets, replacedSelections }
}

// L'avviso si prepara all'avvio, ma i modelli locali si rilevano a finestra aperta: una funzione rimasta senza
// modello può averne preso uno nel frattempo (succede al completamento automatico al primo avvio dopo l'aggiornamento).
// Prima di mostrare l'avviso, le voci senza sostituto prendono il modello che la funzione ha adesso.
export const withCurrentReplacements = (notice: RemovedProvidersNotice, selectionNow: (featureName: string) => NoticeSelection | null): RemovedProvidersNotice => ({
	...notice,
	replacedSelections: notice.replacedSelections.map(selection => {
		const now = selectionNow(selection.featureName)
		return { ...selection, replacement: now ? { providerName: now.providerName, modelName: now.modelName } : null }
	}),
})

// Legge l'avviso salvato; un valore rovinato o di forma diversa vale come assente. Un campo in più di un avviso
// salvato da una versione precedente si ignora.
export const parseRemovedProvidersNotice = (text: string | undefined): RemovedProvidersNotice | null => {
	if (!text) return null
	try {
		const value = JSON.parse(text)
		if (!value || typeof value !== 'object' || !Array.isArray(value.providersWithRemovedSecrets) || !Array.isArray(value.replacedSelections)) return null
		const notice: RemovedProvidersNotice = {
			providersWithRemovedSecrets: value.providersWithRemovedSecrets.filter((name: unknown) => typeof name === 'string'),
			replacedSelections: value.replacedSelections.filter((s: any) => s && typeof s.featureName === 'string' && typeof s.providerName === 'string' && typeof s.modelName === 'string'
				&& (s.replacement === null || (s.replacement && typeof s.replacement.providerName === 'string' && typeof s.replacement.modelName === 'string'))),
		}
		// senza voci (tutte di forma sbagliata, o un avviso salvato solo per un campo che non c'è più) non c'è niente da dire
		return notice.providersWithRemovedSecrets.length || notice.replacedSelections.length ? notice : null
	} catch { return null }
}

// Nomi mostrati all'utente; chi chiama passa quelli dell'interfaccia (funzioni e fornitori rimasti).
export type RemovedProvidersNoticeNames = {
	featureTitle: (featureName: string) => string,
	providerTitle: (providerName: string) => string,
}

/**
 * Il testo dell'avviso mostrato una volta dopo la pulizia dei fornitori tolti: cosa è cambiato, quali chiavi API sono
 * state cancellate e con che cosa è stato sostituito ogni modello scelto. Le funzioni che avevano lo stesso modello
 * e hanno lo stesso sostituto stanno nella stessa frase.
 */
export const textOfRemovedProvidersNotice = (notice: RemovedProvidersNotice, names: RemovedProvidersNoticeNames): string => {
	const parts: string[] = [t("Vox now uses only the local AI and the CLI AI installed on this PC: the other providers were removed.")]

	if (notice.providersWithRemovedSecrets.length > 0) {
		parts.push(t("The saved API keys and other credentials of these providers were deleted from the settings: {0}.", notice.providersWithRemovedSecrets.map(titleOfRemovedProvider).join(', ')))
	}

	const groups = new Map<string, { features: string[], modelName: string, providerName: string, replacement: RemovedProvidersNotice['replacedSelections'][number]['replacement'] }>()
	for (const { featureName, modelName, providerName, replacement } of notice.replacedSelections) {
		const key = JSON.stringify([providerName, modelName, replacement?.providerName ?? null, replacement?.modelName ?? null])
		const group = groups.get(key) ?? { features: [], modelName, providerName, replacement }
		group.features.push(names.featureTitle(featureName))
		groups.set(key, group)
	}
	for (const { features, modelName, providerName, replacement } of groups.values()) {
		const oldModel = modelName ? `${modelName} (${titleOfRemovedProvider(providerName)})` : titleOfRemovedProvider(providerName)
		parts.push(replacement
			? t("{0}: {1} was replaced with {2} ({3}).", features.join(', '), oldModel, replacement.modelName, names.providerTitle(replacement.providerName))
			: t("{0}: {1} is no longer available and there is no model to replace it. Choose one in Vox's Settings.", features.join(', '), oldModel))
	}

	return parts.join(' ')
}
