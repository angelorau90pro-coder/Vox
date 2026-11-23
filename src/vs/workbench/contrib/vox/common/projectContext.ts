// Logica pura del contesto di progetto (.vox/): nessun import, cosi' il test la carica con stripTypeScriptTypes.

export const PROJECT_DIR_NAME = '.vox'
export const PROJECT_INSTRUCTIONS_FILE = 'instructions.md'
export const PROJECT_MEMORY_FILE = 'memory.md'
export const PROJECT_KNOWLEDGE_DIR = 'knowledge'
export const PROJECT_KNOWLEDGE_EXTENSIONS: readonly string[] = ['.md', '.txt', '.json', '.csv', '.yaml', '.yml']

// name = percorso relativo a knowledge/, con '/'; skipped = non letto (troppo grande, illeggibile o oltre i limiti)
export type ProjectKnowledgeFile = { name: string; content: string; skipped?: boolean }
export type ProjectContext = {
	folderName: string;          // nome della cartella del progetto
	instructions: string;        // '' se il file manca
	memory: string;              // '' se manca
	knowledge: ProjectKnowledgeFile[];   // [] se manca
}
export type ProjectContextLimits = {
	maxInstructionsChars: number;
	maxMemoryChars: number;
	maxKnowledgeFileChars: number;
	maxKnowledgeTotalChars: number;
	maxKnowledgeFiles: number;
}

export const DEFAULT_PROJECT_CONTEXT_LIMITS: ProjectContextLimits = {
	maxInstructionsChars: 20_000,
	maxMemoryChars: 20_000,
	maxKnowledgeFileChars: 30_000,
	maxKnowledgeTotalChars: 120_000,
	maxKnowledgeFiles: 50,
}

// toglie il BOM iniziale e normalizza CRLF/CR in LF
const normalizeNewlines = (s: string) => (s.codePointAt(0) === 0xFEFF ? s.slice(1) : s).replace(/\r\n?/g, '\n')

// i caratteri pericolosi per il tag <file name="..."> vengono sostituiti
const sanitizeTagName = (name: string) => name.replace(/["<>\r\n\u2028\u2029\u0085]/g, '_')
const sanitizeFolderName = (name: string) => name.replace(/[\r\n\u2028\u2029\u0085[\]]/g, ' ')
// quanti nomi di file esclusi si elencano al massimo per cartella
const MAX_SKIPPED_NAMES = 20

export const isKnowledgeFileName = (name: string): boolean => {
	const lower = name.toLowerCase()
	return PROJECT_KNOWLEDGE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

export const truncateForContext = (text: string, maxChars: number): { text: string; truncated: boolean } => {
	if (text.length <= maxChars) return { text, truncated: false }
	return { text: text.slice(0, Math.max(0, maxChars)), truncated: true }
}

export const isProjectContextEmpty = (ctx: ProjectContext): boolean =>
	!(ctx.instructions ?? '').trim() && !(ctx.memory ?? '').trim() && (ctx.knowledge ?? []).length === 0

// taglia il testo e, se serve, chiude con la riga dei caratteri omessi
const cutWithMarker = (text: string, maxChars: number): string => {
	const { text: kept, truncated } = truncateForContext(text, maxChars)
	if (!truncated) return kept
	return `${kept}\n[... truncated: ${text.length - kept.length} more characters]`
}

export const buildProjectContextBlock = (contexts: ProjectContext[], limits: ProjectContextLimits = DEFAULT_PROJECT_CONTEXT_LIMITS): string => {
	const active = contexts.filter(c => !isProjectContextEmpty(c))
	if (active.length === 0) return ''
	const multi = active.length > 1
	const parts: string[] = []

	const section = (header: string, pick: (ctx: ProjectContext) => { text: string; maxChars: number } | null) => {
		const chunks: string[] = []
		for (const ctx of active) {
			const item = pick(ctx)
			if (item === null) continue
			const body = cutWithMarker(normalizeNewlines(item.text).trimEnd(), item.maxChars)
			chunks.push(multi ? `[${sanitizeFolderName(ctx.folderName)}]\n${body}` : body)
		}
		if (chunks.length > 0) parts.push(`${header}:\n${chunks.join('\n\n')}`)
	}

	section('PROJECT INSTRUCTIONS (from .vox/instructions.md)', ctx =>
		(ctx.instructions ?? '').trim() ? { text: ctx.instructions ?? '', maxChars: limits.maxInstructionsChars } : null)
	section('PROJECT MEMORY (from .vox/memory.md — notes saved in earlier conversations)', ctx =>
		(ctx.memory ?? '').trim() ? { text: ctx.memory ?? '', maxChars: limits.maxMemoryChars } : null)

	// conoscenza: budget unico condiviso fra tutte le cartelle; il totale conta la lunghezza dopo il taglio
	// per file, e un file che non entra nel budget rimanente viene saltato ma non blocca i successivi
	const knowledgeChunks: string[] = []
	let knowledgeFilesUsed = 0
	let knowledgeCharsUsed = 0
	for (const ctx of active) {
		const files = [...(ctx.knowledge ?? [])].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
		const included: string[] = []
		const skipped: string[] = []
		for (const f of files) {
			if (f.skipped) {
				skipped.push(sanitizeTagName(f.name))
				continue
			}
			const body = cutWithMarker(normalizeNewlines(f.content ?? '').trimEnd(), limits.maxKnowledgeFileChars)
			if (knowledgeFilesUsed >= limits.maxKnowledgeFiles || knowledgeCharsUsed + body.length > limits.maxKnowledgeTotalChars) {
				skipped.push(sanitizeTagName(f.name))
				continue
			}
			knowledgeFilesUsed++
			knowledgeCharsUsed += body.length
			included.push(`<file name="${sanitizeTagName(f.name)}">\n${body}\n</file>`)
		}
		if (included.length === 0 && skipped.length === 0) continue
		let chunk = multi ? `[${sanitizeFolderName(ctx.folderName)}]\n` : ''
		chunk += included.join('\n')
		// l'elenco degli esclusi ha un tetto, altrimenti migliaia di nomi mangerebbero il contesto
		if (skipped.length > 0) {
			const shown = skipped.slice(0, MAX_SKIPPED_NAMES).join(', ')
			const more = skipped.length > MAX_SKIPPED_NAMES ? `, ... and ${skipped.length - MAX_SKIPPED_NAMES} more` : ''
			chunk += `${included.length > 0 ? '\n' : ''}Not included (limit reached): ${shown}${more}`
		}
		knowledgeChunks.push(chunk)
	}
	if (knowledgeChunks.length > 0) parts.push(`PROJECT KNOWLEDGE (files in .vox/knowledge/):\n${knowledgeChunks.join('\n\n')}`)

	return parts.join('\n\n')
}

// ---------- memoria di progetto: aggiunta di una nota ----------

// Traduzione dei messaggi di errore: chi chiama passa t() del dizionario di Vox; senza, i messaggi restano in inglese.
// Qui il dizionario non si importa perché il test carica questo file senza import.
export type ProjectContextTranslate = (english: string, ...parameters: unknown[]) => string
const englishText: ProjectContextTranslate = (english, ...parameters) =>
	english.replace(/\{(\d+)\}/g, (placeholder, index: string) => parameters[Number(index)] === undefined ? placeholder : String(parameters[Number(index)]))

export const MAX_PROJECT_MEMORY_NOTE_CHARS = 2_000
// oltre questa misura memory.md non accetta altre note finché non viene riscritto in breve.
// Uguale a DEFAULT_PROJECT_CONTEXT_LIMITS.maxMemoryChars: una nota salvata deve sempre rientrare nella parte mostrata nelle chat.
export const MAX_PROJECT_MEMORY_FILE_CHARS = 20_000

// Aggiunge una nota in fondo al testo di memory.md come voce di elenco datata; le righe successive della nota sono rientrate.
// Lancia un errore se la nota e' vuota o troppo lunga.
export const appendProjectMemoryNote = (existing: string, note: string, dateStr: string, t: ProjectContextTranslate = englishText): string => {
	const clean = normalizeNewlines(note ?? '').split('\n').map(l => l.trimEnd()).join('\n').trim()
	if (!clean) throw new Error(t("The note is empty."))
	if (clean.length > MAX_PROJECT_MEMORY_NOTE_CHARS) throw new Error(t("The note is too long ({0} characters, the limit is {1}). Save a shorter note.", clean.length, MAX_PROJECT_MEMORY_NOTE_CHARS))
	const lines = clean.split('\n')
	const entry = `- ${dateStr}: ${lines[0]}` + lines.slice(1).map(l => l ? `\n  ${l}` : '\n').join('')
	const base = normalizeNewlines(existing ?? '').trimEnd()
	return (base ? `${base}\n` : '# Project memory\n\n') + entry + '\n'
}

// ---------- elenco dei compiti ----------

export type ProjectTaskStatus = 'pending' | 'in_progress' | 'completed'
export type ProjectTask = { text: string; status: ProjectTaskStatus }
export const MAX_PROJECT_TASKS = 30
export const MAX_PROJECT_TASK_CHARS = 200

// Legge l'elenco scritto dal modello, un compito per riga: "[ ] da fare", "[~] in corso", "[x] fatto".
// Tollera trattini, asterischi e numeri davanti, e le parole di stato scritte per esteso. Le righe vuote si saltano.
export const parseTaskList = (raw: string, t: ProjectContextTranslate = englishText): ProjectTask[] => {
	const tasks: ProjectTask[] = []
	for (const line0 of normalizeNewlines(raw ?? '').split('\n')) {
		let line = line0.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '')
		if (!line) continue
		let status: ProjectTaskStatus = 'pending'
		const m = line.match(/^\[([^\]]*)\]\s*(.*)$/)
		if (m) {
			const mark = m[1].trim().toLowerCase()
			status = (mark === 'x' || mark === 'done' || mark === 'completed') ? 'completed'
				: (mark === '~' || mark === '>' || mark === '-' || mark === 'in_progress' || mark === 'in progress' || mark === 'wip') ? 'in_progress'
					: 'pending'
			// numero o trattino rimasto dopo la casella, come in "[ ] 1. Testo"
			line = m[2].trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '')
		}
		if (!line) continue
		if (line.length > MAX_PROJECT_TASK_CHARS) line = line.slice(0, MAX_PROJECT_TASK_CHARS - 1) + '…'
		tasks.push({ text: line, status })
	}
	// un solo compito in corso alla volta: se il modello ne segna di più, resta in corso il primo
	let seenInProgress = false
	for (const task of tasks) {
		if (task.status !== 'in_progress') continue
		if (seenInProgress) task.status = 'pending'
		seenInProgress = true
	}
	if (tasks.length === 0) throw new Error(t('The task list is empty. Write one task per line, for example "[ ] Read the config file".'))
	if (tasks.length > MAX_PROJECT_TASKS) throw new Error(t("Too many tasks ({0}, the limit is {1}). Group them into fewer steps.", tasks.length, MAX_PROJECT_TASKS))
	return tasks
}

// Alcuni modelli mandano l'elenco come JSON invece che come testo: ogni voce diventa una riga "[ ] testo".
// Le voci possono essere stringhe oppure oggetti nelle forme più comuni ({ text | task | content | title | name | description, status | done | completed }).
export const taskLineOfUnknown = (item: unknown): string => {
	if (typeof item === 'string') return item
	if (item === null || typeof item !== 'object' || Array.isArray(item)) return ''
	const o = item as { [key: string]: unknown }
	const textValue = [o.text, o.task, o.content, o.title, o.name, o.description].find(v => typeof v === 'string' && v.trim() !== '')
	if (typeof textValue !== 'string') return ''
	const statusValue = typeof o.status === 'string' ? o.status.trim().toLowerCase() : ''
	const isDone = o.done === true || o.completed === true || statusValue === 'completed' || statusValue === 'done'
	const isInProgress = statusValue === 'in_progress' || statusValue === 'in progress' || statusValue === 'wip' || statusValue === 'running'
	// il testo va su una riga sola: un ritorno a capo creerebbe compiti in più
	return `${isDone ? '[x]' : isInProgress ? '[~]' : '[ ]'} ${textValue.replace(/\s+/g, ' ').trim()}`
}

export const stringOfTaskList =(tasks: ProjectTask[]): string =>
	tasks.map(t => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.text}`).join('\n')
