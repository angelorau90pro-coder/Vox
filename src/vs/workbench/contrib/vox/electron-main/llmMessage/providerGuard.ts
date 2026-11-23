// Vox invia richieste solo a questi due motori: le IA locali (llama-server su questo PC) e le IA in CLI installate.
// Il nome del fornitore arriva dalla finestra insieme alle impostazioni salvate, che possono venire da una versione
// precedente o da un file importato: qui si controlla prima di fare qualunque altra cosa.
export const allowedProviderNames = ['voxLocal', 'cliAgent'] as const
export type AllowedProviderName = typeof allowedProviderNames[number]

export const isAllowedProviderName = (providerName: unknown): providerName is AllowedProviderName =>
	typeof providerName === 'string' && (allowedProviderNames as readonly string[]).includes(providerName)

// L'unico server a cui Vox invia richieste è llama-server avviato da Vox su questo PC. L'indirizzo arriva dal modello
// locale avviato (`localModels.ts`) e deve essere di questa macchina: qualunque altro viene rifiutato.
export const isLoopbackURL = (url: string): boolean => {
	try {
		const { protocol, hostname } = new URL(url)
		return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]')
	} catch { return false }
}

// Le richieste ai modelli locali non seguono i reindirizzamenti: chi risponde sulla porta locale non può far
// proseguire la richiesta (con il codice o la conversazione) verso un altro indirizzo. Un reindirizzamento è un errore.
export const withoutRedirects = <F extends (input: any, init?: any) => Promise<any>>(fetcher: F): F =>
	((input: any, init?: any) => fetcher(input, { ...init, redirect: 'error' })) as F
