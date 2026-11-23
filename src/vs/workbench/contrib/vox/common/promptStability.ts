/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Tiene stabile l'inizio del prompt di una conversazione.
// llama-server riusa il lavoro già fatto solo se il prompt nuovo comincia come quello precedente: se il messaggio
// di sistema cambia (file attivo, file aperti, albero delle cartelle), il motore rilegge tutta la conversazione,
// e con 60.000 token sono più di un minuto di attesa a ogni richiesta.
// Perciò il messaggio di sistema si calcola una volta per conversazione e resta quello; se poi l'utente cambia
// file, la novità viaggia in fondo, dentro il suo messaggio successivo (che resta nella cronologia e non cambia più).

export type EditorSnapshot = {
	activeFile: string | undefined;
	openFiles: string[];
};

const snapshotKey = (snapshot: EditorSnapshot) => JSON.stringify([snapshot.activeFile ?? '', snapshot.openFiles]);

// L'elenco dei file aperti nella nota ha una misura massima: la nota viaggia nel messaggio dell'utente, che con i
// modelli locali non si accorcia mai, quindi con moltissimi file aperti non deve mangiarsi il contesto
const NOTE_OPEN_FILES_MAX_CHARS = 4000;
// (un percorso fuori misura non si elenca: nessun percorso vero arriva a questa lunghezza)
const NOTE_PATH_MAX_CHARS = 1000;
const pathForNote = (path: string) => path.length > NOTE_PATH_MAX_CHARS ? '(path too long to show)' : path;
const openFilesForNote = (openFiles: string[]): string => {
	if (openFiles.length === 0) return 'NO OPENED FILES';
	const shown: string[] = [];
	let chars = 0;
	for (const path of openFiles) {
		const file = pathForNote(path);
		if (shown.length > 0 && chars + file.length + 1 > NOTE_OPEN_FILES_MAX_CHARS) break;
		shown.push(file);
		chars += file.length + 1;
	}
	const more = openFiles.length - shown.length;
	return shown.join('\n') + (more > 0 ? `\n(and ${more} more open files)` : '');
};

export const editorStateNote = (snapshot: EditorSnapshot) => `<editor_state>
The files open in the user's editor have changed since the start of this conversation. Current state:
- Active file:
${snapshot.activeFile === undefined ? 'NO ACTIVE FILE' : pathForNote(snapshot.activeFile)}

- Open files:
${openFilesForNote(snapshot.openFiles)}
</editor_state>`;

// l'inizio esatto della nota scritta da `editorStateNote`: un blocco <editor_state> qualunque non basta
const NOTE_START = `<editor_state>
The files open in the user's editor have changed since the start of this conversation.`;
const NOTE_END = '</editor_state>';

// Oltre questa misura il taglio dei messaggi non conserva la nota: con moltissimi file aperti (o con un blocco
// uguale incollato dall'utente) costerebbe troppo contesto, e far entrare il prompt conta di più
export const EDITOR_NOTE_MAX_KEPT = 6000;

// L'indice del messaggio la cui nota il taglio deve conservare: l'ultimo messaggio dell'utente che ne ha una in
// coda (le note precedenti sono superate da quella), -1 se non c'è o se è più lunga di EDITOR_NOTE_MAX_KEPT.
export const indexOfEditorStateNoteToKeep = (messages: readonly { role: string; content: unknown }[]): number => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const { role, content } = messages[i];
		if (role !== 'user' || typeof content !== 'string') continue;
		const note = trailingEditorStateNote(content);
		if (note) return note.length <= EDITOR_NOTE_MAX_KEPT ? i : -1;
	}
	return -1;
};

// La nota in coda a un testo, riconosciuta dalla forma ('' se non c'è). Serve solo al taglio dei messaggi, che
// lavora sul testo e non deve togliere l'ultima nota: quali note ha scritto Vox lo dice il campo `editorStateNote`
// del messaggio, non il testo (l'utente può incollare un blocco uguale).
export const trailingEditorStateNote = (userContent: string): string => {
	if (!userContent.endsWith(NOTE_END)) return '';
	const start = userContent.lastIndexOf(NOTE_START);
	return start === -1 ? '' : userContent.slice(start);
};

// Il messaggio dell'utente senza la nota che Vox gli ha messo in coda (`note`: il campo `editorStateNote` del
// messaggio): per le IA che non la devono ricevere (vedi `editorStateNoteForNewUserMessage` in
// convertToLLMMessageService.ts). Si toglie esattamente ciò che Vox ha aggiunto (separatore e nota): il testo
// dell'utente resta identico, spazi finali compresi, anche se contiene un blocco uguale.
export const withoutEditorStateNote = (userContent: string, note: string | undefined): string => {
	const suffix = note ? '\n\n' + note : '';
	return suffix && userContent.endsWith(suffix) ? userContent.slice(0, userContent.length - suffix.length) : userContent;
};

export const createSystemMessageMemo = (maxThreads = 30) => {
	// Map conserva l'ordine di inserimento: la prima chiave è la conversazione usata meno di recente
	const byThread = new Map<string, { key: string; systemMessage: string; systemEditorKey: string }>();
	return {
		// il messaggio di sistema già calcolato per la conversazione, se è nato dalle stesse premesse (`key`)
		get(threadId: string, key: string): string | undefined {
			const entry = byThread.get(threadId);
			if (!entry || entry.key !== key) return undefined;
			byThread.delete(threadId);
			byThread.set(threadId, entry);
			return entry.systemMessage;
		},
		// come `get`, ma senza segnare la conversazione come usata: per chi guarda soltanto (il pannello di contesto)
		peek(threadId: string, key: string): string | undefined {
			const entry = byThread.get(threadId);
			return entry && entry.key === key ? entry.systemMessage : undefined;
		},
		// `editor` è lo stato dell'editor scritto dentro `systemMessage`: il modello lo conosce già
		set(threadId: string, key: string, systemMessage: string, editor: EditorSnapshot) {
			byThread.delete(threadId);
			byThread.set(threadId, { key, systemMessage, systemEditorKey: snapshotKey(editor) });
			while (byThread.size > maxThreads) byThread.delete(byThread.keys().next().value!);
		},
		// La nota da aggiungere al nuovo messaggio dell'utente: vuota se la conversazione non ha ancora un messaggio
		// di sistema (lo stato attuale ci finirà dentro) o se l'editor è come il modello lo conosce già.
		// Ciò che il modello conosce si ricava dalla conversazione com'è adesso (`earlierNotes`: le note dei messaggi
		// dell'utente rimasti, in ordine): l'ultima nota presente, altrimenti lo stato scritto nel messaggio di sistema.
		// Così, se il messaggio che portava una nota viene modificato o tolto tornando a un checkpoint, la nota riparte.
		noteForNewUserMessage(threadId: string, editor: EditorSnapshot, earlierNotes: (string | undefined)[]): string {
			const note = editorStateNote(editor);
			// una nota già presente vale anche senza messaggio di sistema in memoria (dopo un riavvio):
			// il messaggio di sistema verrà ricalcolato, ma quella nota resta nella cronologia e va superata
			const lastTold = earlierNotes.filter(told => !!told).pop();
			if (lastTold !== undefined) return lastTold === note ? '' : note;
			const entry = byThread.get(threadId);
			if (!entry) return '';
			return entry.systemEditorKey === snapshotKey(editor) ? '' : note;
		},
	};
};

// Quanti caratteri togliere a un messaggio quando basta accorciarlo in parte: si arrotonda al passo superiore,
// così il punto del taglio cambia solo ogni `step` caratteri di crescita della conversazione e non a ogni richiesta
// (un taglio che si sposta ogni volta cambia il prompt a metà e fa rileggere al motore tutto ciò che segue).
export const stableTrimLength = (charsToTrim: number, maxTrim: number, step: number) =>
	Math.max(0, Math.min(maxTrim, Math.ceil(charsToTrim / step) * step));
