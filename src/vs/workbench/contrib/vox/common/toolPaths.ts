/*--------------------------------------------------------------------------------------
 *  Vox: percorsi passati dal modello agli strumenti (uri, cwd).
 *--------------------------------------------------------------------------------------*/

// Il modello a volte passa un percorso relativo («calcolo.py», «src/app.py»): senza questa analisi `URI.file` lo
// rende «\calcolo.py», cioè la radice del disco. A volte incolla nel percorso anche il contenuto del file
// («main.py\n<new_content>…»). Qui si decide solo che cosa è la stringa: la risoluzione con le cartelle del progetto la
// fa `toolsService`, che traduce anche i problemi in messaggi per il modello.

export type ToolPathProblem = 'empty' | 'content' | 'driveRelative' | 'driveRoot' | 'home' | 'colon' | 'variable' | 'device'

export type ToolPathKind =
	| { kind: 'absolute', path: string }
	| { kind: 'relative', rel: string }
	| { kind: 'invalid', problem: ToolPathProblem }

// caratteri di controllo (a capo, tabulazione, zero) e tag di markup come <new_content> o </uri>: non stanno in un percorso
const CONTROL_CHARS = /[\u0000-\u001f]/
const MARKUP_TAG = /<\/?[A-Za-z_][\w.-]*>/

// Uno schema (file://, vscode-remote://…) sta in testa ed è lungo almeno due lettere: «C://a» è un'unità, non lo schema
// «c», e «note/http://x» non ha schema. Serve anche a toolsService per scegliere fra URI.parse e URI.file.
export function hasUriScheme(path: string): boolean {
	return /^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(path)
}

// `windows`: il progetto è su un disco di Windows (lì una barra sola in testa indica la radice dell'unità)
export function toolPathKindOf(raw: string, options: { windows?: boolean } = {}): ToolPathKind {
	const path = raw.trim()
	if (path === '') return { kind: 'invalid', problem: 'empty' }
	if (CONTROL_CHARS.test(path) || MARKUP_TAG.test(path)) return { kind: 'invalid', problem: 'content' }
	// «${workspaceFolder}» (VS Code), «%USERPROFILE%» (cmd), «$HOME» (shell) e «$env:TEMP» (PowerShell, anche «$Env:TEMP»)
	// sono variabili: qui nessuno le espande, e come percorso relativo diventerebbero una cartella che si chiama così
	// dentro il progetto. Le ultime tre
	// solo in testa e come nome intero, perché «$» e «%» stanno bene in un nome («$RECYCLE.BIN», «50%.txt»)
	if (/\$\{[^}]*\}|^%[A-Za-z_]\w*%|^\$(?:[Ee][Nn][Vv]:)?[A-Za-z_]\w*(?=[\\/]|$)/.test(path)) return { kind: 'invalid', problem: 'variable' }
	// con uno schema o una lettera di unità seguita dalla barra: assoluto, come prima
	if (hasUriScheme(path)) return { kind: 'absolute', path }
	// Su Windows «:» sta solo dopo la lettera dell'unità: altrove («src/a.py:10», con il numero di riga) indica un flusso
	// nascosto del file (NTFS), dove la scrittura riuscirebbe senza cambiare il file che si vede
	const colon = { kind: 'invalid', problem: 'colon' } as const
	if (/^[A-Za-z]:[\\/]/.test(path)) return options.windows && path.slice(2).includes(':') ? colon : { kind: 'absolute', path }
	// «C:a.py» è relativo alla cartella corrente di quell'unità, che Vox non conosce
	if (/^[A-Za-z]:/.test(path)) return { kind: 'invalid', problem: 'driveRelative' }
	// «/a» e «\a» (anche UNC «\\server») restano assoluti: fuori dal progetto chiedono conferma come oggi. Su Windows
	// però una barra sola in testa («\main.py», «/src/app.py») è la radice dell'unità corrente: i modelli la scrivono
	// per dire «dalla cartella del progetto», quindi è un errore che dice cosa passare. Restano assoluti UNC
	// («\\server», «//server») e la forma degli URI «/C:/…». Un UNC ha il nome del server subito dopo le due barre:
	// «//», «\\» e «///main.py» non ne hanno, e come file indicano la radice dell'unità, quindi lo stesso errore.
	if (path.startsWith('/') || path.startsWith('\\')) {
		// Su Windows un percorso lungo («\\?\C:\…», «\\.\C:\…», «\\?\UNC\server\…») è lo stesso file senza il prefisso:
		// si toglie, così si confronta con le cartelle del progetto (e con il blocco della cancellazione) come quello
		// normale. Senza la lettera dell'unità il prefisso indica un dispositivo («\\.\PhysicalDrive0»), non un file
		// («\\.» e «\\?» da soli sono il prefisso senza niente dopo: dispositivo anche loro)
		if (options.windows && /^[\\/]{2}[?.](?:[\\/]|$)/.test(path)) {
			const rest = path.slice(4)
			// dopo «UNC\» viene il nome di un server: «?» o «.» lì farebbero un altro prefisso, da non togliere di nuovo
			if (/^UNC[\\/]/i.test(rest)) return /^[?.](?:[\\/]|$)/.test(rest.slice(4)) ? { kind: 'invalid', problem: 'device' } : toolPathKindOf('\\\\' + rest.slice(4), options)
			if (/^[A-Za-z]:/.test(rest)) return toolPathKindOf(rest, options)
			return { kind: 'invalid', problem: 'device' }
		}
		// «/C:a.py» e «/C:» sono la forma degli URI di «C:a.py»: relativi alla cartella corrente dell'unità, come sopra
		if (options.windows && /^\/[A-Za-z]:(?![\\/])/.test(path)) return { kind: 'invalid', problem: 'driveRelative' }
		if (options.windows && !/^[\\/]{2}[^\\/]/.test(path) && !/^\/[A-Za-z]:/.test(path)) return { kind: 'invalid', problem: 'driveRoot' }
		// il «:» ammesso: quello della lettera dell'unità nella forma degli URI («/C:/…»)
		if (options.windows && (/^\/[A-Za-z]:/.test(path) ? path.slice(3) : path).includes(':')) return colon
		return { kind: 'absolute', path }
	}
	if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return { kind: 'invalid', problem: 'home' }
	if (options.windows && path.includes(':')) return colon
	let rel = path.replace(/\\/g, '/')
	while (rel.startsWith('./')) rel = rel.slice(2).replace(/^\/+/, '')
	if (rel === '.') rel = ''
	return { kind: 'relative', rel }
}

// Nel prompt l'albero dei file comincia con il nome della cartella del progetto («progetto/»), e il modello lo copia:
// «progetto/calcolo.py» invece di «calcolo.py». Se il primo segmento è uno dei nomi della cartella (quello su disco e
// quello dato nel file .code-workspace, senza badare alle maiuscole) restituisce il resto, altrimenti null. Chi chiama
// toglie il nome solo se dentro la cartella non c'è davvero una sottocartella con lo stesso nome (per esempio il
// pacchetto Python «myapp/myapp/»).
export function withoutRootFolderName(rel: string, rootNames: readonly string[]): { first: string, rest: string } | null {
	const [first, ...rest] = rel.split('/')
	if (!rootNames.some(name => name !== '' && first.toLowerCase() === name.toLowerCase())) return null
	return { first, rest: rest.join('/') }
}

// Con più cartelle nel progetto, un percorso relativo che comincia con uno dei nomi di una di esse (quello su disco,
// che compare nell'albero dei file, o quello del file .code-workspace; senza badare alle maiuscole) va in quella
// cartella, e il nome si toglie; altrimenti va nella prima. Con una cartella sola il percorso resta com'è:
// «programma/main.py» può essere una sottocartella vera. Se il nome è di più cartelle («client/app» e «server/app»,
// tutte e due «app/» nell'albero) non si sa quale: `index` è -1 e chi chiama chiede il percorso completo.
export function folderOfRelativePath(rel: string, folderNames: readonly (readonly string[])[]): { index: number, rel: string } {
	if (folderNames.length > 1) {
		const [first, ...rest] = rel.split('/')
		const matches = folderNames.flatMap((names, index) => names.some(name => name !== '' && name.toLowerCase() === first.toLowerCase()) ? [index] : [])
		if (matches.length > 1) return { index: -1, rel }
		if (matches.length === 1) return { index: matches[0], rel: rest.join('/') }
	}
	return { index: 0, rel }
}
