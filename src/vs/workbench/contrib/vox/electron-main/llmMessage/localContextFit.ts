/*--------------------------------------------------------------------------------------
 *  Vox: adattamento dei messaggi al contesto dei modelli locali (llama-server).
 *--------------------------------------------------------------------------------------*/

// La stima del renderer (caratteri per token) può sbagliare per difetto: codice, JSON e testo italiano
// hanno meno caratteri per token, e il modello di chat aggiunge il proprio formato. llama-server, quando il
// prompt non entra, risponde 400 con il conteggio esatto: da quello si accorciano i messaggi e si riprova.

export type ContextOverflow = { promptTokens: number, contextTokens: number };

type TextPart = { type: 'text', text: string };
type FitMessage = {
	role: string,
	content?: string | ({ type: string, text?: string } & Record<string, unknown>)[],
	tool_calls?: { type: 'function', id: string, function: { name: string, arguments: string } }[],
	[key: string]: unknown,
};

const positive = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

// Riconosce l'errore "exceed_context_size_error" di llama-server (corpo JSON o solo testo del messaggio).
export function contextOverflowOf(error: unknown): ContextOverflow | null {
	const seen = new Set<unknown>();
	const visit = (value: unknown, depth: number): ContextOverflow | null => {
		if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return null;
		seen.add(value);
		const record = value as Record<string, unknown>;
		const promptTokens = positive(record.n_prompt_tokens), contextTokens = positive(record.n_ctx);
		if (promptTokens && contextTokens && promptTokens > contextTokens) return { promptTokens, contextTokens };
		return visit(record.error, depth + 1) ?? visit(record.body, depth + 1);
	};
	const structured = visit(error, 0);
	if (structured) return structured;
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	const match = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(message);
	if (!match) return null;
	const promptTokens = Number(match[1]), contextTokens = Number(match[2]);
	return promptTokens > contextTokens ? { promptTokens, contextTokens } : null;
}

// Token da lasciare liberi per la risposta: un quarto del contesto, almeno 1024, mai più di metà.
export const answerReserveOf = (contextTokens: number) => Math.min(Math.floor(contextTokens / 2), Math.max(1024, Math.floor(contextTokens / 4)));

const MARK = ' […]';
const KEEP_OLD = 160; // caratteri che restano di un messaggio vecchio accorciato
const KEEP_PARAM = 160; // caratteri che restano di un parametro lungo di una chiamata a strumento

const cut = (text: string, keep: number) => text.length <= keep + MARK.length ? text : text.slice(0, keep) + MARK;

function shortenArguments(args: string, keep: number): string {
	let parsed: unknown;
	try { parsed = JSON.parse(args) } catch { return cut(args, keep) }
	const shorten = (value: unknown): unknown => typeof value === 'string' ? cut(value, keep)
		: Array.isArray(value) ? value.map(shorten)
			: value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shorten(inner)]))
				: value;
	return JSON.stringify(shorten(parsed));
}

// Caratteri di un messaggio che contano per il prompt: testo e argomenti delle chiamate a strumento.
export function charsOf(message: FitMessage): number {
	let total = 0;
	if (typeof message.content === 'string') total += message.content.length;
	else if (Array.isArray(message.content)) for (const part of message.content) if (part.type === 'text' && typeof part.text === 'string') total += part.text.length;
	for (const call of message.tool_calls ?? []) total += call.function.arguments.length;
	return total;
}

// Testo fatto di risultati XML di strumenti (`<read_file_result>…</read_file_result>`, come li scrive
// `prepareMessages_XML_tools`): comincia con `<x_result>` e finisce con `</y_result>`. Si guardano solo i due
// estremi, perché il contenuto (un file letto) può contenere a sua volta questi tag.
const TOOL_RESULT_OPEN = /^\s*<([\w-]+)_result>/;
const TOOL_RESULT_CLOSE = /<\/[\w-]+_result>\s*$/;
const CLOSE_WINDOW = 200; // la chiusura si cerca solo in fondo al testo, non in decine di migliaia di caratteri
const closingOf = (text: string) => TOOL_RESULT_CLOSE.exec(text.slice(-CLOSE_WINDOW));
const isXmlToolResults = (text: string) => TOOL_RESULT_OPEN.test(text) && !!closingOf(text);

// Confini dei blocchi come li scrive `prepareMessages_XML_tools`: `<x_result>` a inizio messaggio o dopo una riga
// vuota, seguito da un a capo; `</x_result>` a inizio riga, seguito da una riga vuota (il blocco successivo) o dalla
// fine del testo tenuto. Un file letto che contenesse proprio queste righe potrebbe confondere il conteggio: è il
// limite del formato XML.
const BLOCK_TAG = /(?:^|\n\n)<([\w-]+)_result>\n|\n<\/([\w-]+)_result>(?=\n\n|\n?$)/g;

// Accorcia risultati XML tenendo l'inizio (con il tag di apertura intero) e chiudendo con il suo tag il blocco in
// cui cade il taglio: il modello vede risultati completi e, ai nuovi tentativi, il messaggio resta riconoscibile.
// Se il taglio cade fra due blocchi, il testo tenuto finisce con l'ultimo blocco completo.
function cutToolResults(text: string, keep: number): string {
	if (text.length <= keep + MARK.length) return text;
	const open = TOOL_RESULT_OPEN.exec(text)!;
	const body = text.slice(0, text.length - closingOf(text)![0].length);
	const kept = cut(body, Math.max(open[0].length, keep - `\n</${open[1]}_result>`.length));
	if (kept === body) return text;
	const visible = kept.slice(0, kept.length - MARK.length);
	let openName: string | undefined, lastCloseEnd = -1;
	for (const tag of visible.matchAll(BLOCK_TAG)) {
		if (tag[1] !== undefined) openName = tag[1];
		else { openName = undefined; lastCloseEnd = tag.index! + tag[0].length }
	}
	if (openName !== undefined) return kept + `\n</${openName}_result>`;
	if (lastCloseEnd > 0) return visible.slice(0, lastCloseEnd);
	// nessun confine riconosciuto (per esempio è rimasto solo il tag di apertura): si chiude il primo blocco
	return kept + `\n</${open[1]}_result>`;
}
const cutText = (text: string, keep: number) => isXmlToolResults(text) ? cutToolResults(text, keep) : cut(text, keep);

// Domanda attuale segnata dal renderer (`voxRequestChars` in sendLLMMessageTypes.ts): indice del messaggio e
// caratteri finali che sono la domanda. Prima di quei caratteri può esserci un risultato di strumento fuso nello
// stesso messaggio (formato XML), oppure il messaggio di sistema fuso nel primo messaggio.
export type RequestMark = { index: number, chars: number };
const REQUEST_MARK = 'voxRequestChars';

// Legge il segno della domanda attuale e lo toglie dai messaggi (copie), perché non deve arrivare al modello.
// Un segno non valido si ignora: allora la domanda si riconosce dal testo, come ripiego.
export function takeRequestMark<T extends FitMessage>(messages: readonly T[]): { messages: T[], mark: RequestMark | undefined } {
	let mark: RequestMark | undefined;
	const clean = messages.map((message, index) => {
		if (!(REQUEST_MARK in message)) return message;
		const { [REQUEST_MARK]: chars, ...rest } = message;
		if (message.role === 'user' && typeof message.content === 'string' && typeof chars === 'number' && Number.isInteger(chars) && chars >= 0 && chars <= message.content.length) mark = { index, chars };
		return rest as unknown as T;
	});
	return { messages: clean, mark };
}

// La nota sui file aperti in coda a un messaggio dell'utente (la scrive `editorStateNote` in
// common/promptStability.ts, da cui vengono questo inizio e la misura massima): la conversazione la dà per detta
// e non la ripete, quindi accorciando il messaggio che porta l'ultima nota la nota resta e si taglia solo il testo
// che la precede. Le note più vecchie sono superate da quella, e una nota troppo lunga costerebbe troppo
// contesto: si tagliano come il resto.
const EDITOR_NOTE_START = `<editor_state>
The files open in the user's editor have changed since the start of this conversation.`;
const EDITOR_NOTE_END = '</editor_state>';
const EDITOR_NOTE_MAX_KEPT = 6000;
const editorNoteStart = (content: unknown) => typeof content === 'string' && content.endsWith(EDITOR_NOTE_END) ? content.lastIndexOf(EDITOR_NOTE_START) : -1;
// l'indice del messaggio la cui nota va conservata (-1: nessuna)
const indexOfEditorNoteToKeep = (messages: readonly FitMessage[]): number => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i], start = message.role === 'user' ? editorNoteStart(message.content) : -1;
		if (start !== -1) return (message.content as string).length - start <= EDITOR_NOTE_MAX_KEPT ? i : -1;
	}
	return -1;
};
const cutUserText = (text: string, keep: number, keepNote: boolean) => {
	const start = keepNote ? editorNoteStart(text) : -1;
	if (start === -1) return cutText(text, keep);
	const body = text.slice(0, start).trimEnd();
	// `keep` vale per tutto il messaggio: la nota che resta si toglie da ciò che può restare del testo
	return cutText(body, Math.max(0, keep - (text.length - body.length))) + '\n\n' + text.slice(start);
};

// Accorcia il messaggio (copia) fino a lasciarne circa `keep` caratteri di testo; restituisce i caratteri tolti.
function shortenMessage(message: FitMessage, keep: number, keepNote = false): { message: FitMessage, removed: number } {
	const before = charsOf(message);
	const next: FitMessage = { ...message };
	if (typeof next.content === 'string') next.content = next.role === 'user' ? cutUserText(next.content, keep, keepNote) : cut(next.content, keep);
	else if (Array.isArray(next.content)) next.content = next.content.map(part => part.type === 'text' && typeof part.text === 'string' ? { ...part, text: cut(part.text, keep) } as TextPart : part);
	if (next.tool_calls) next.tool_calls = next.tool_calls.map(call => ({ ...call, function: { ...call.function, arguments: shortenArguments(call.function.arguments, KEEP_PARAM) } }));
	return { message: next, removed: Math.max(0, before - charsOf(next)) };
}

// Il messaggio di sistema fuso nel primo messaggio utente (modelli senza ruolo di sistema, vedi
// `prepareMessages`): contiene istruzioni e definizioni degli strumenti, va protetto come il sistema.
const FUSED_SYSTEM = '<SYSTEM_MESSAGE>';
const isSystemLike = (message: FitMessage | undefined) => !!message && (message.role === 'system' || message.role === 'developer'
	|| (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(FUSED_SYSTEM)));

// Risultato di uno strumento: messaggio `tool` (formato nativo) oppure messaggio `user` con risultati XML.
// Serve solo come ripiego, quando manca il segno della domanda: dal solo testo un risultato seguito da una domanda
// che finisce con un tag XML non si distingue da un risultato.
const isToolResult = (message: FitMessage) => message.role === 'tool'
	|| (message.role === 'user' && typeof message.content === 'string' && isXmlToolResults(message.content));

// Accorcia i messaggi perché il prompt entri nel contesto lasciando spazio alla risposta.
// - La domanda attuale dell'utente non si tronca mai di nascosto, anche quando dopo ci sono chiamate e risultati
//   di strumenti (modalità agente). La indica `mark` (segno del renderer, vedi `takeRequestMark`); senza segno è
//   l'ultimo messaggio `user` che non sembra un risultato di strumento. Del messaggio con la domanda si può
//   accorciare solo la parte che la precede (un risultato fuso nello stesso messaggio).
// - Ordine: i messaggi intermedi dal più vecchio, togliendo da ciascuno solo quanto serve (almeno `KEEP_OLD`
//   caratteri restano); poi il risultato fuso prima della domanda e l'ultimo messaggio se è un risultato di
//   strumento (per esempio un file letto molto lungo); per ultimo il messaggio di sistema, di cui restano almeno
//   2000 caratteri (istruzioni e strumenti).
// - La struttura resta la stessa (stessi ruoli, chiamate e risultati degli strumenti, stessa lunghezza della
//   domanda), così il modello di chat non trova coppie spezzate e il segno vale anche ai nuovi tentativi.
//   `fitted` è falso se secondo la stima non basta: allora conviene un errore chiaro.
export function shrinkToFit<T extends FitMessage>(messages: readonly T[], overflow: ContextOverflow, mark?: RequestMark): { messages: T[], fitted: boolean, removed: number } {
	const target = overflow.contextTokens - answerReserveOf(overflow.contextTokens);
	const total = messages.reduce((sum, message) => sum + charsOf(message), 0);
	if (total === 0 || overflow.promptTokens <= target) return { messages: [...messages], fitted: overflow.promptTokens <= target, removed: 0 };
	// caratteri per token osservati su questo prompt: la parte fissa (strumenti, formato del modello) non è
	// contata nei caratteri, quindi il rapporto è per difetto e il taglio pure; il margine compensa in parte,
	// e se non basta llama-server risponde di nuovo con il conteggio esatto e si accorcia ancora
	const charsPerToken = total / overflow.promptTokens;
	const needed = Math.ceil((overflow.promptTokens - target) * charsPerToken);
	let toRemove = Math.ceil(needed * 1.25);
	const result = [...messages];
	const last = result.length - 1;
	const firstIsSystem = isSystemLike(result[0]);
	const marked = !!mark && Number.isInteger(mark.index) && mark.index >= 0 && mark.index <= last
		&& result[mark.index].role === 'user' && typeof result[mark.index].content === 'string'
		&& Number.isInteger(mark.chars) && mark.chars >= 0 && mark.chars <= (result[mark.index].content as string).length;
	let request = marked ? mark!.index : -1;
	if (!marked) for (let i = last; i >= 0; i--) if (result[i].role === 'user' && !isToolResult(result[i])) { request = i; break }
	// il sistema fuso nel primo messaggio contiene anche la prima domanda: se è la domanda attuale, il sistema è la
	// parte che la precede (si accorcia come il sistema, sotto); altrimenti il messaggio si accorcia come il sistema
	const systemIndex = firstIsSystem && request !== 0 ? 0 : -1;
	// dopo la domanda segnata vengono solo assistente e risultati: l'ultimo messaggio, se non è dell'assistente, è un risultato
	const lastToolResult = last > 0 && last !== request && (marked ? last > request && result[last].role !== 'assistant' : isToolResult(result[last])) ? last : -1;
	const keptNoteIndex = indexOfEditorNoteToKeep(messages);
	const apply = (index: number, keep: number) => {
		if (toRemove <= 0) return;
		const { message, removed } = shortenMessage(result[index], keep, index === keptNoteIndex);
		result[index] = message as T;
		toRemove -= removed;
	};
	// si tiene l'inizio e si toglie solo quanto serve (si sottrae anche il segno di taglio, che si aggiunge al testo tenuto)
	const keepFor = (index: number, minimum: number) => Math.max(minimum, charsOf(result[index]) - toRemove - MARK.length);
	// parte del messaggio segnato che precede la domanda: si accorcia, la domanda (gli ultimi `mark.chars` caratteri) no
	const applyBeforeRequest = (minimum: number) => {
		if (toRemove <= 0 || !marked) return;
		const message = result[request], text = message.content as string;
		const before = text.slice(0, text.length - mark!.chars), body = before.trimEnd();
		if (!body) return;
		const shorter = cutText(body, Math.max(minimum, body.length - toRemove - MARK.length));
		if (shorter.length >= body.length) return;
		result[request] = { ...message, content: shorter + before.slice(body.length) + text.slice(text.length - mark!.chars) };
		toRemove -= body.length - shorter.length;
	};
	for (let i = 0; i < last; i++) if (i !== systemIndex && i !== request && !(firstIsSystem && i === 0)) apply(i, keepFor(i, KEEP_OLD));
	const requestHoldsSystem = firstIsSystem && request === 0;
	if (!requestHoldsSystem) applyBeforeRequest(KEEP_OLD);
	if (lastToolResult >= 0) apply(lastToolResult, keepFor(lastToolResult, KEEP_OLD));
	if (systemIndex >= 0) apply(systemIndex, keepFor(systemIndex, 2000));
	if (requestHoldsSystem) applyBeforeRequest(2000);
	const removed = total - result.reduce((sum, message) => sum + charsOf(message), 0);
	// il margine serve a tagliare un po' di più quando si può; basta però togliere quanto stimato senza margine
	return { messages: result, fitted: removed >= needed, removed };
}
