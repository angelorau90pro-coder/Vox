/*--------------------------------------------------------------------------------------
 *  Vox: occupazione della finestra di contesto per il pannello della chat (IA locali).
 *--------------------------------------------------------------------------------------*/

// Le misure vengono dalla stessa preparazione dei messaggi dell'invio (`prepareMessages`), fatta sulla conversazione
// con la richiesta che si sta scrivendo in fondo: sono caratteri del prompt finale, perché Vox non ha il
// tokenizzatore del modello. Si convertono in token con il rapporto osservato nell'ultima risposta (caratteri del
// prompt davvero inviato e token che llama-server ha contato per quello stesso prompt), oppure con 3 caratteri
// per token, il valore prudente del taglio.

export type ContextMeasures = {
	contextWindow: number; // token della finestra del modello
	reservedTokens: number; // token che Vox lascia liberi per la risposta: il prompt si accorcia oltre il resto
	systemChars: number; // messaggio di sistema di Vox e contesto di progetto (.vox/)
	rulesChars: number; // istruzioni dell'utente (.voxrules e impostazioni)
	toolsChars: number; // definizioni degli strumenti (formato nativo, o XML dentro il messaggio di sistema)
	conversationChars: number; // messaggi già scambiati, dopo l'eventuale taglio
	requestChars: number; // la prossima richiesta: testo scritto, file allegati e nota sui file aperti
	trimmedCount: number; // messaggi che Vox accorcia per far entrare il prossimo invio
};

export type ContextCalibration = {
	charsPerToken: number;
	calibrated: boolean; // true: rapporto osservato su un conteggio del motore
};

// Ciò che resta dell'ultima risposta di un modello locale: token del prompt contati da llama-server, caratteri di
// quello stesso prompt (dopo l'eventuale taglio del processo principale) e se il processo principale ha dovuto
// accorciare ancora la conversazione perché llama-server l'ha rifiutata. `model` è il modello che ha contato (ogni
// modello ha il suo tokenizzatore: il rapporto caratteri/token di uno non vale per un altro).
export type LastEngineCount = { promptTokens: number; promptChars: number | null; exact: boolean; shortened: boolean; model: string | null };

export type ContextPartKey = 'system' | 'rules' | 'tools' | 'conversation' | 'request';
export type ContextLevel = 'ok' | 'avviso' | 'pieno' | 'sconosciuto';

export type ContextUsage = {
	contextWindow: number;
	reservedTokens: number;
	promptBudgetTokens: number; // spazio per il prompt: oltre, i messaggi vecchi si accorciano
	usedTokens: number;
	parts: { key: ContextPartKey; tokens: number }[]; // solo le voci con almeno un token
	level: ContextLevel;
	trimmedCount: number;
	calibrated: boolean;
};

export const DEFAULT_CHARS_PER_TOKEN = 3;
const MIN_CHARS_PER_TOKEN = 1.5;
const MAX_CHARS_PER_TOKEN = 6;
export const WARNING_SHARE = 0.75; // dal 75% dello spazio per il prompt il pannello avvisa

const count = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

// Caratteri di un messaggio come li conta il processo principale (`charsOf` di localContextFit.ts, che deve restare
// uguale): testo e argomenti delle chiamate a strumento.
type CountedMessage = { content?: unknown; tool_calls?: unknown };
export function promptCharsOf(message: CountedMessage): number {
	let total = 0;
	if (typeof message.content === 'string') total += message.content.length;
	else if (Array.isArray(message.content)) for (const part of message.content) if (part && part.type === 'text' && typeof part.text === 'string') total += part.text.length;
	if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) {
		const args = call?.function?.arguments;
		if (typeof args === 'string') total += args.length;
	}
	return total;
}

// Rapporto caratteri/token da un prompt e dai token che il motore ha contato per lo stesso prompt.
// Fuori dai limiti (un conteggio che non corrisponde ai caratteri) si torna al valore prudente.
export function calibrationOf(promptChars: number | null | undefined, promptTokens: number | null | undefined): ContextCalibration {
	const chars = count(promptChars), tokens = count(promptTokens);
	if (chars > 0 && tokens > 0) {
		const ratio = chars / tokens;
		if (ratio >= MIN_CHARS_PER_TOKEN && ratio <= MAX_CHARS_PER_TOKEN) return { charsPerToken: ratio, calibrated: true };
	}
	return { charsPerToken: DEFAULT_CHARS_PER_TOKEN, calibrated: false };
}

// I messaggi che la prossima richiesta manda: dopo un ritorno a un checkpoint l'invio cancella quelli che vengono
// dopo (`addUserMessageAndStreamResponse`), quindi la misura, la taratura e la riga non li contano. Senza checkpoint,
// o con il checkpoint sull'ultimo messaggio, restituisce la stessa lista (stessa identità, per le memo di React).
export function messagesSentNext<T>(messages: T[], checkpointIdx: number | null | undefined): T[] {
	if (checkpointIdx === null || checkpointIdx === undefined || checkpointIdx + 1 >= messages.length) return messages;
	return messages.slice(0, checkpointIdx + 1);
}

// L'ultimo conteggio del motore nella conversazione: l'ultima risposta dell'assistente con i token del prompt.
type MessageWithStats = { role: string; tokenStats?: { promptTokens?: number | null; promptChars?: number; promptModel?: string; exact?: boolean; shortened?: boolean } };
export function lastEngineCountOf(messages: readonly MessageWithStats[]): LastEngineCount | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== 'assistant') continue;
		const stats = message.tokenStats;
		const promptTokens = count(stats?.promptTokens);
		if (!stats || promptTokens <= 0) continue;
		const model = typeof stats.promptModel === 'string' && stats.promptModel ? stats.promptModel : null;
		return { promptTokens, promptChars: count(stats.promptChars) || null, exact: stats.exact === true, shortened: stats.shortened === true, model };
	}
	return null;
}

// Si calibra solo su un conteggio esatto del motore che porta anche i caratteri dello stesso prompt, fatto dal modello
// scelto adesso (le risposte salvate prima di questa versione non hanno né caratteri né modello; dopo un cambio di
// modello nella conversazione il conteggio è di un altro tokenizzatore): altrimenti si usa il valore prudente.
export const calibrationOfLast = (last: LastEngineCount | null, modelName: string | undefined): ContextCalibration =>
	last && last.exact && last.model === modelName ? calibrationOf(last.promptChars, last.promptTokens) : calibrationOf(0, 0);

// `ok` sotto il 75% dello spazio per il prompt; `avviso` da lì; `pieno` a spazio finito; `sconosciuto` se la
// finestra non si conosce. Una finestra nota che la riserva per la risposta occupa tutta (un modello da 4K con
// 4K riservati) non lascia spazio al prompt: è `pieno`, perché Vox accorcerà la conversazione.
export function levelOf(usedTokens: number, promptBudgetTokens: number, contextWindow = 0): ContextLevel {
	if (promptBudgetTokens <= 0) return count(contextWindow) > 0 ? 'pieno' : 'sconosciuto';
	const share = count(usedTokens) / promptBudgetTokens;
	return share >= 1 ? 'pieno' : share >= WARNING_SHARE ? 'avviso' : 'ok';
}

// Come si divide il messaggio di sistema inviato (`sentChars`) fra le regole dell'utente in testa (`rulesBlockChars`),
// le definizioni XML degli strumenti (`xmlToolsChars`, che cominciano a `xmlToolsAt` nel messaggio intero; -1 se non
// si sa: subito dopo le regole) e il resto. Se prepareMessages l'ha accorciato (`sentChars` < `fullChars`) ne resta
// l'inizio più «...»: di ogni blocco conta la parte che cade in quell'inizio, e i «...» vanno al resto.
export function systemPartsOf({ sentChars, fullChars, rulesBlockChars, xmlToolsAt, xmlToolsChars }: { sentChars: number; fullChars: number; rulesBlockChars: number; xmlToolsAt: number; xmlToolsChars: number }): { systemChars: number; rulesChars: number; xmlChars: number } {
	const sent = count(sentChars);
	const kept = sent < count(fullChars) ? Math.max(0, sent - '...'.length) : sent;
	const rulesChars = Math.min(count(rulesBlockChars), kept);
	const xmlStart = xmlToolsAt >= 0 ? xmlToolsAt : rulesChars;
	const xmlChars = Math.max(0, Math.min(count(xmlToolsChars), kept - xmlStart, sent - rulesChars));
	return { systemChars: sent - rulesChars - xmlChars, rulesChars, xmlChars };
}

export function contextUsageOf(measures: ContextMeasures, calibration: ContextCalibration): ContextUsage {
	const perToken = count(calibration.charsPerToken) || DEFAULT_CHARS_PER_TOKEN;
	const tokensOf = (chars: number) => Math.round(count(chars) / perToken);
	const contextWindow = Math.round(count(measures.contextWindow));
	const reservedTokens = Math.min(contextWindow, Math.round(count(measures.reservedTokens)));
	const promptBudgetTokens = contextWindow - reservedTokens;
	const all: { key: ContextPartKey; tokens: number }[] = [
		{ key: 'system', tokens: tokensOf(measures.systemChars) },
		{ key: 'rules', tokens: tokensOf(measures.rulesChars) },
		{ key: 'tools', tokens: tokensOf(measures.toolsChars) },
		{ key: 'conversation', tokens: tokensOf(measures.conversationChars) },
		{ key: 'request', tokens: tokensOf(measures.requestChars) },
	];
	const parts = all.filter(part => part.tokens > 0);
	const usedTokens = parts.reduce((sum, part) => sum + part.tokens, 0);
	return {
		contextWindow, reservedTokens, promptBudgetTokens, usedTokens, parts,
		level: levelOf(usedTokens, promptBudgetTokens, contextWindow),
		trimmedCount: Math.round(count(measures.trimmedCount)),
		calibrated: calibration.calibrated,
	};
}

// Token in forma breve, come la libreria dei modelli («64K» = 64 × 1024): sotto 1024 il numero intero, sotto 10K
// con un decimale, poi intero. `locale` decide la virgola (nei test si passa esplicito).
export function formatTokens(tokens: number, locale?: string): string {
	const value = Math.round(count(tokens));
	if (value < 1024) return value.toLocaleString(locale);
	const k = value / 1024;
	return `${k.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: k < 10 ? 1 : 0 })}K`;
}

// Quota intera (0-100) dello spazio per il prompt, per la barra: mai oltre il 100%. Arrotondata per difetto, così il
// 100% arriva solo a spazio finito, insieme al livello `pieno` (con 32616 su 32768 si legge 99%, non 100%).
export const percentOfBudget = (tokens: number, promptBudgetTokens: number) => promptBudgetTokens > 0 ? Math.min(100, Math.floor(count(tokens) / promptBudgetTokens * 100)) : 0;
