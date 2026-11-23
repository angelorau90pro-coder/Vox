import { localModelManager, LocalModelLease } from './localModels.js';
import { isLoopbackURL } from './providerGuard.js';
import { t } from '../../common/voxI18n.js';

export type VoxLocalFIMParams = {
	folder: string,
	modelName: string,
	prefix: string,
	suffix: string,
	stopTokens: string[],
	maxTokens?: number,
	signal?: AbortSignal,
};
type Deps = { acquire: (folder: string, nome: string, options: { signal?: AbortSignal, uso: 'completamento' }) => Promise<LocalModelLease>, fetch: typeof fetch, timeoutMs: number };

// Un completamento che non arriva entro questo tempo non serve più: la richiesta si chiude e il modello torna libero.
const FIM_TIMEOUT_MS = 30_000;
const abortError = () => Object.assign(new Error(t('Local model request canceled.')), { name: 'AbortError' });

// Chiede al modello di completamento locale il codice fra `prefix` e `suffix`, con l'endpoint `/infill` di
// llama-server (che usa i token di completamento del modello). Avvia il modello se serve e lo restituisce sempre.
export const requestVoxLocalFIM = async (params: VoxLocalFIMParams, deps: Partial<Deps> = {}): Promise<string> => {
	const acquire = deps.acquire ?? localModelManager.acquire.bind(localModelManager);
	const fetcher = deps.fetch ?? fetch;
	const timeoutMs = deps.timeoutMs ?? FIM_TIMEOUT_MS;
	if (params.signal?.aborted) throw abortError();
	const lease = await acquire(params.folder, params.modelName, { signal: params.signal, uso: 'completamento' });
	// il tempo massimo vale solo per la risposta: l'avvio del modello ha già i suoi limiti in `acquire`
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), timeoutMs);
	const onAbort = () => timeout.abort();
	params.signal?.addEventListener('abort', onAbort, { once: true });
	const failure = (detail: string) => new Error(t('The local model {0} could not complete the code: {1}', params.modelName, detail));
	try {
		if (params.signal?.aborted) throw abortError();
		// come per la chat: solo un indirizzo di questo PC, e nessun reindirizzamento seguito (più sotto)
		if (!isLoopbackURL(lease.baseURL)) throw new Error(t("Vox only talks to local models on this PC: {0} was refused.", lease.baseURL));
		const origin = lease.baseURL.replace(/\/v1\/?$/, '');
		const body = {
			input_prefix: params.prefix,
			input_suffix: params.suffix,
			n_predict: params.maxTokens ?? 300,
			...(params.stopTokens.length ? { stop: params.stopTokens } : {}),
			stream: false,
			cache_prompt: true,
		};
		let response: Response, result: any;
		try {
			response = await fetcher(`${origin}/infill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: timeout.signal });
			try { result = await response.json() }
			catch (error) {
				// un corpo non JSON si tratta più sotto; un annullamento durante la lettura invece no
				if (timeout.signal.aborted) throw error;
				result = undefined;
			}
		} catch (error) {
			// annullata da chi ha chiamato (l'utente ha continuato a scrivere): resta un annullamento, non un guasto
			if (params.signal?.aborted) throw abortError();
			if (timeout.signal.aborted) throw failure(t('no answer within {0} seconds.', Math.round(timeoutMs / 1000)));
			throw failure(error instanceof Error ? error.message : String(error));
		}
		if (!response.ok) {
			const detail = typeof result?.error === 'string' ? result.error : typeof result?.error?.message === 'string' ? result.error.message : typeof result?.message === 'string' ? result.message : `HTTP ${response.status}`;
			throw failure(detail.slice(0, 300));
		}
		if (typeof result?.content !== 'string') throw failure(t('The server response did not contain text content.'));
		return result.content;
	} finally {
		clearTimeout(timer);
		params.signal?.removeEventListener('abort', onAbort);
		lease.release();
	}
};
