// Controlli su formattazione, percentuale, tempo stimato, "già installato" e verifica del modulo della libreria locale.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { loadI18n } from '../../../../common/voxI18n.fixture.mjs';

const stripImports = source => source.replace(/^import [^;]*;?[ \t]*\r?\n/gm, '');
const toPlainJs = source => stripTypeScriptTypes(stripImports(source)).replace(/^export /gm, '');

const typesSource = await readFile(new URL('../../../../common/localModelLibraryTypes.ts', import.meta.url), 'utf8');
assert.equal(/^import /m.test(typesSource), false, 'localModelLibraryTypes.ts deve restare senza importazioni');
const formatSource = await readFile(new URL('./localModelLibraryFormat.ts', import.meta.url), 'utf8');

const body = `${toPlainJs(typesSource)}\n${toPlainJs(formatSource)}\nreturn { formatGigabytes, formatSpeedMBps, downloadPercent, formatRemainingTime, formatLocalModelUse, isCatalogEntryInstalled, catalogEntryForMissingModel, isModelInDownload, detectionNotice, shownDetectionNotice, featuresUsingLocalModel, validateCustomModelForm, canDeletePermanently, mayNotFitOnDisk, describeError, PERMANENT_DELETE_DELAY_MS, LOCAL_MODEL_RESERVED_BYTES, parseContextText, formatContextTokens, LOCAL_MODEL_CONTEXT_PRESETS, LOCAL_MODEL_MIN_CONTEXT, LOCAL_MODEL_MAX_CONTEXT, matchesModelFilter, suggestLocalModelName, suggestContext, suggestLocalModelUse, formatCount, LOCAL_MODEL_NAME_PATTERN, LOCAL_MODEL_REPO_PATTERN };`;
const load = lang => new Function('t', body)(loadI18n(lang).t);

const {
	canDeletePermanently,
	mayNotFitOnDisk,
	describeError,
	PERMANENT_DELETE_DELAY_MS,
	LOCAL_MODEL_RESERVED_BYTES,
	formatGigabytes,
	formatSpeedMBps,
	downloadPercent,
	formatRemainingTime,
	formatLocalModelUse,
	isCatalogEntryInstalled,
	catalogEntryForMissingModel,
	isModelInDownload,
	detectionNotice,
	shownDetectionNotice,
	featuresUsingLocalModel,
	validateCustomModelForm,
	parseContextText,
	formatContextTokens,
	LOCAL_MODEL_CONTEXT_PRESETS,
	LOCAL_MODEL_MIN_CONTEXT,
	LOCAL_MODEL_MAX_CONTEXT,
	matchesModelFilter,
	suggestLocalModelName,
	suggestContext,
	suggestLocalModelUse,
	formatCount,
	LOCAL_MODEL_NAME_PATTERN,
	LOCAL_MODEL_REPO_PATTERN,
} = load('it');

test('formatGigabytes e formatSpeedMBps gestiscono valori validi, zero e non validi', () => {
	const gib = 1024 ** 3;
	const mib = 1024 ** 2;
	// sotto 1 GB si mostrano i MB (prima un modello da 146 MB appariva come «0.1 GB» e uno da 1 MB come «0.0 GB»)
	assert.equal(formatGigabytes(0), '0 MB');
	assert.equal(formatGigabytes(146146432), '139 MB');
	assert.equal(formatGigabytes(gib - 1), '1024 MB');
	assert.equal(formatGigabytes(gib), '1.0 GB');
	assert.equal(formatGigabytes(4.7 * gib), '4.7 GB');
	// un valore non valido usa la stessa unità dello zero (prima «0.0 GB» accanto a «0 MB»)
	assert.equal(formatGigabytes(-10), '0 MB');
	assert.equal(formatGigabytes(NaN), '0 MB');
	assert.equal(formatSpeedMBps(0), '0.0 MB/s');
	assert.equal(formatSpeedMBps(12.5 * mib), '12.5 MB/s');
	assert.equal(formatSpeedMBps(-5), '0.0 MB/s');
});

test('downloadPercent calcola percentuali fra 0 e 100 e restituisce null senza totale', () => {
	assert.equal(downloadPercent(500, null), null);
	assert.equal(downloadPercent(500, 0), null);
	assert.equal(downloadPercent(0, 1000), 0);
	assert.equal(downloadPercent(-10, 1000), 0);
	assert.equal(downloadPercent(500, 1000), 50);
	// quasi finito ma non ancora uguale al totale: non mostra 100% prima del termine
	assert.equal(downloadPercent(999, 1000), 99);
	assert.equal(downloadPercent(1000, 1000), 100);
	assert.equal(downloadPercent(1200, 1000), 100);
});

test('formatRemainingTime stima secondi, minuti e ore e restituisce null se non stimabile', () => {
	assert.equal(formatRemainingTime(100, null, 100), null);
	assert.equal(formatRemainingTime(100, 1000, 0), null);
	assert.equal(formatRemainingTime(-1, 1000, 100), null);
	// simboli del Sistema internazionale, validi in tutte e due le lingue (prima «2m 5s», abbreviazioni inglesi)
	assert.equal(formatRemainingTime(1000, 1000, 100), '0 s');
	assert.equal(formatRemainingTime(500, 1000, 100), '5 s');
	assert.equal(formatRemainingTime(0, 1200, 10), '2 min');
	assert.equal(formatRemainingTime(0, 1250, 10), '2 min 5 s');
	assert.equal(formatRemainingTime(0, 7200, 1), '2 h');
	assert.equal(formatRemainingTime(0, 5400, 1), '1 h 30 min');
});

test('formatLocalModelUse traduce l\'uso del modello', () => {
	assert.equal(formatLocalModelUse('chat'), 'Chat');
	assert.equal(formatLocalModelUse('completamento'), 'Completamento');
	assert.equal(formatLocalModelUse('embedding'), 'Embedding');
});

test('isCatalogEntryInstalled confronta per nome o file senza distinzione fra maiuscole e minuscole sul file', () => {
	const installati = [
		{ nome: 'qwen', file: 'Qwen2.5-7B.gguf' },
		{ nome: 'coder', file: 'coder.gguf' },
	];
	assert.equal(isCatalogEntryInstalled({ nome: 'qwen', file: 'altro.gguf' }, installati), true);
	assert.equal(isCatalogEntryInstalled({ nome: 'nuovo', file: 'qwen2.5-7b.gguf' }, installati), true);
	assert.equal(isCatalogEntryInstalled({ nome: 'altro', file: 'altro.gguf' }, installati), false);
});

test('catalogEntryForMissingModel: solo per un modello senza file, con lo stesso nome e lo stesso file di una voce consigliata', () => {
	const catalog = [{ id: 'qwen', nome: 'qwen', file: 'Qwen2.5-7B.gguf' }, { id: 'coder', nome: 'coder', file: 'coder.gguf' }];
	assert.equal(catalogEntryForMissingModel({ nome: 'QWEN', file: 'qwen2.5-7b.gguf', bytes: null }, catalog)?.id, 'qwen');
	// file presente, file diverso, nome diverso: niente da riscaricare
	assert.equal(catalogEntryForMissingModel({ nome: 'qwen', file: 'Qwen2.5-7B.gguf', bytes: 10 }, catalog), null);
	assert.equal(catalogEntryForMissingModel({ nome: 'qwen', file: 'mio.gguf', bytes: null }, catalog), null);
	assert.equal(catalogEntryForMissingModel({ nome: 'mio', file: 'coder.gguf', bytes: null }, catalog), null);
});

test('isModelInDownload: stesso nome o stesso file dello scarico o del controllo in corso, come il processo principale', () => {
	const inCorso = stato => ({ stato, nome: 'Qwen', file: 'Qwen2.5-7B.gguf', ricevuti: 0, totale: 10, bytesAlSecondo: 0 });
	for (const stato of ['scarico', 'controllo']) {
		assert.equal(isModelInDownload({ nome: 'qwen', file: 'altro.gguf' }, inCorso(stato)), true, `${stato}: stesso nome`);
		assert.equal(isModelInDownload({ nome: 'mio', file: 'qwen2.5-7b.gguf' }, inCorso(stato)), true, `${stato}: stesso file`);
		assert.equal(isModelInDownload({ nome: 'mio', file: 'mio.gguf' }, inCorso(stato)), false, `${stato}: un altro modello`);
	}
	// anche il controllo di un file già presente (si sta solo controllando, non scaricando)
	assert.equal(isModelInDownload({ nome: 'Qwen', file: 'Qwen2.5-7B.gguf' }, { ...inCorso('controllo'), giaPresente: true }), true, 'controllo di un file già presente');
	// a scarico fermo, finito, annullato o in errore si può togliere
	for (const scarico of [{ stato: 'fermo' }, { stato: 'finito', nome: 'Qwen' }, { stato: 'annullato', nome: 'Qwen', parziale: true }, { stato: 'errore', nome: 'Qwen', messaggio: 'x' }]) {
		assert.equal(isModelInDownload({ nome: 'Qwen', file: 'Qwen2.5-7B.gguf' }, scarico), false, scarico.stato);
	}
});

test("detectionNotice: l'errore del rilevamento se non ripete quelli della libreria, altrimenti «non configurata», altrimenti niente", () => {
	const errore = 'Cartella delle IA locali di Vox non trovata';
	assert.deepEqual(detectionNotice(errore, false, [null, null]), { tipo: 'errore', testo: errore });
	assert.deepEqual(detectionNotice(errore, false, [undefined, 'altro']), { tipo: 'errore', testo: errore });
	// stesso testo dell'errore della libreria o di quello di lettura: si vede già, niente doppione
	assert.equal(detectionNotice(errore, false, [errore, null]), null);
	assert.equal(detectionNotice(errore, false, [null, errore]), null);
	assert.equal(detectionNotice(errore, true, [errore, null]), null, 'un errore già mostrato non lascia il posto a «non configurata»');
	assert.deepEqual(detectionNotice(null, true, [null, null]), { tipo: 'nonConfigurata' });
	assert.deepEqual(detectionNotice('', true, ['', null]), { tipo: 'nonConfigurata' }, 'un errore vuoto non conta');
	assert.equal(detectionNotice(null, false, ['errore della libreria', null]), null);
	assert.equal(detectionNotice(null, false, []), null);
});

test('shownDetectionNotice: mentre la chat rilegge resta la riga di prima, senza ricalcolarla con gli errori nuovi della libreria', () => {
	const X = 'Unable to read local model manifest';
	const errore = { tipo: 'errore', testo: X };
	// fuori dal rilevamento vale sempre la riga di adesso
	assert.deepEqual(shownDetectionNotice(errore, { notice: null, senzaCartella: false }, false, false, [null, null]), errore);
	assert.equal(shownDetectionNotice(null, { notice: errore, senzaCartella: false }, false, false, [null, null]), null);
	// (a) modelli.json non valido: la riga era tolta come doppione; la libreria rilegge senza errore mentre la chat rilegge
	// con l'errore vecchio. Il doppione tolto non torna a vedersi
	const fresca = detectionNotice(X, false, [null, null]);
	assert.deepEqual(fresca, errore, 'ricalcolata con gli errori nuovi, la riga tornerebbe');
	assert.equal(shownDetectionNotice(fresca, { notice: null, senzaCartella: false }, true, false, [null, null]), null);
	// (b) la libreria ha appena trovato la cartella: «non trovata» di prima non vale più
	const nonTrovata = { tipo: 'errore', testo: 'Vox local AI folder not found' };
	assert.equal(shownDetectionNotice(nonTrovata, { notice: nonTrovata, senzaCartella: true }, true, false, [null, null]), null);
	assert.equal(shownDetectionNotice(null, { notice: { tipo: 'nonConfigurata' }, senzaCartella: true }, true, false, [null, null]), null);
	// stessa cartella di prima: la riga resta, anche «non configurata»
	assert.deepEqual(shownDetectionNotice(null, { notice: errore, senzaCartella: false }, true, false, [null, null]), errore);
	assert.deepEqual(shownDetectionNotice(null, { notice: { tipo: 'nonConfigurata' }, senzaCartella: true }, true, true, [null, null]), { tipo: 'nonConfigurata' });
	// la riga di prima ripete un errore che la libreria ora mostra: niente doppione
	assert.equal(shownDetectionNotice(null, { notice: errore, senzaCartella: false }, true, false, [X, null]), null);
	assert.equal(shownDetectionNotice(null, { notice: errore, senzaCartella: false }, true, false, [null, X]), null);
	// riga salvata quando la libreria non aveva ancora uno stato (cartella non nota): arrivato lo stato, la riga resta
	assert.deepEqual(shownDetectionNotice(null, { notice: nonTrovata, senzaCartella: null }, true, true, [null, null]), nonTrovata);
	assert.deepEqual(shownDetectionNotice(null, { notice: nonTrovata, senzaCartella: null }, true, false, [null, null]), nonTrovata);
	assert.deepEqual(shownDetectionNotice(null, { notice: errore, senzaCartella: false }, true, null, [null, null]), errore);
	// nessuna riga ricordata (pagina aperta durante un rilevamento): quella di adesso
	assert.deepEqual(shownDetectionNotice(errore, null, true, false, [null, null]), errore);
});

test('featuresUsingLocalModel elenca solo le funzioni che usano quel modello locale', () => {
	const selection = {
		Chat: { providerName: 'voxLocal', modelName: 'qwen' },
		'Ctrl+K': { providerName: 'cliAgent', modelName: 'qwen' },
		Autocomplete: { providerName: 'voxLocal', modelName: 'coder' },
		Apply: { providerName: 'voxLocal', modelName: 'qwen' },
		SCM: null,
	};
	assert.deepEqual(
		featuresUsingLocalModel('qwen', selection, ['Chat', 'Ctrl+K', 'Autocomplete', 'Apply', 'SCM']),
		['Chat', 'Apply'],
	);
});

test('validateCustomModelForm accetta dati validi e segnala gli errori accanto ai singoli campi', () => {
	const installati = [{ nome: 'gia-presente', file: 'Presente.gguf' }];
	const valid = validateCustomModelForm({
		url: ' https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b.gguf ',
		nome: ' mio_modello.1 ',
		contestoText: '32768',
	}, installati);
	assert.deepEqual(valid, {
		ok: true,
		url: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b.gguf',
		nome: 'mio_modello.1',
		contesto: 32768,
	});

	// limiti esatti del contesto
	assert.equal(validateCustomModelForm({ url: 'https://huggingface.co/a/b/resolve/main/c.gguf', nome: 'm1', contestoText: '512' }, installati).ok, true);
	assert.equal(validateCustomModelForm({ url: 'https://huggingface.co/a/b/resolve/main/c.GGUF', nome: 'm2', contestoText: '1048576' }, installati).ok, true);

	// gli indirizzi che si copiano davvero da Hugging Face: il pulsante di scarico (`?download=true`) e la pagina del file (`/blob/`)
	for (const url of [
		'https://huggingface.co/a/b/resolve/main/c.gguf?download=true',
		'https://huggingface.co/a/b/blob/main/c.gguf',
		'https://huggingface.co/a/b/resolve/main/cartella/c.gguf',
	]) assert.equal(validateCustomModelForm({ url, nome: 'm3', contestoText: '4096' }, installati).ok, true, url);

	// errori specifici per ciascun campo
	const bad = validateCustomModelForm({
		url: 'https://hf.co/a/b/c.gguf',
		nome: 'gia-presente',
		contestoText: '100',
	}, installati);
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.url);
	assert.ok(bad.errors.nome);
	assert.ok(bad.errors.contesto);

	// url su huggingface.co ma non .gguf, oppure con nome file vuoto o credenziali
	for (const url of [
		'https://huggingface.co/a/b/resolve/main/c.bin',
		'https://huggingface.co/a/b/resolve/main/.gguf',
		'https://huggingface.co/a/b/resolve/main/..gguf',
		'https://utente:segreto@huggingface.co/a/b/resolve/main/c.gguf',
		'https://huggingface.co:8443/a/b/resolve/main/c.gguf',
		'http://huggingface.co/a/b/resolve/main/c.gguf',
		// non è l'indirizzo di un file di un modello: il processo principale lo rifiuterebbe (prima il modulo lo accettava)
		'https://huggingface.co/a/b/c.gguf',
		'https://huggingface.co/a/b/tree/main/c.gguf',
		// conta il percorso, non la parte dopo `?` o `#`, e un segmento codificato non può nascondere una barra
		'https://huggingface.co/a/b/resolve/main/c.bin#.gguf',
		'https://huggingface.co/a/b/resolve/main/c.bin?x=.gguf',
		'https://huggingface.co/a/b/resolve/main/a%2Fb.gguf',
		// pezzi vuoti e nomi che Windows rifiuta o tratta come dispositivi (`NUL.gguf` scriverebbe nel nulla)
		'https://huggingface.co///resolve//c.gguf',
		'https://huggingface.co/a/b/resolve//c.gguf',
		'https://huggingface.co/a/b/resolve/main/NUL.gguf',
		'https://huggingface.co/a/b/resolve/main/com1.Q4.gguf',
		'https://huggingface.co/a/b/resolve/main/a%3Fb.gguf',
		'https://huggingface.co/a/b/resolve/main/a%00b.gguf',
		// stesso file di un modello già installato, anche con maiuscole diverse: non si riusa in silenzio
		'https://huggingface.co/altro/repo/resolve/main/presente.gguf',
	]) {
		const res = validateCustomModelForm({ url, nome: 'valido', contestoText: '32768' }, installati);
		assert.equal(res.ok, false, url);
		assert.ok(res.errors.url, url);
		assert.equal(res.errors.nome, undefined);
		assert.equal(res.errors.contesto, undefined);
	}

	// nome non valido o vuoto, contesto decimale o non numerico
	const badNameAndContext = validateCustomModelForm({
		url: 'https://huggingface.co/a/b/resolve/main/c.gguf',
		nome: 'con spazi',
		contestoText: '32768.5',
	}, installati);
	assert.equal(badNameAndContext.ok, false);
	assert.equal(badNameAndContext.errors.url, undefined);
	assert.ok(badNameAndContext.errors.nome);
	assert.ok(badNameAndContext.errors.contesto);

	// un nome che cambia solo per le maiuscole è lo stesso modello; `.` e `..` non sono nomi
	for (const nome of ['GIA-PRESENTE', '.', '..']) {
		const res = validateCustomModelForm({ url: 'https://huggingface.co/a/b/resolve/main/c.gguf', nome, contestoText: '4096' }, installati);
		assert.ok(res.ok === false && res.errors.nome, nome);
	}
});

test('la cancellazione definitiva parte solo dal suo passo e col pulsante già acceso', () => {
	assert.equal(canDeletePermanently('permanent', true), true);
	assert.equal(canDeletePermanently('permanent', false), false, 'subito dopo il primo passo il pulsante è ancora spento');
	assert.equal(canDeletePermanently('trash', true), false, 'la prima conferma non cancella mai per sempre');
	assert.equal(canDeletePermanently(null, true), false);
	assert.equal(canDeletePermanently('permanent', 'true'), false, 'solo il valore vero, non una stringa');
	assert.ok(PERMANENT_DELETE_DELAY_MS >= 500, 'un doppio clic sulla prima conferma non deve arrivare al secondo passo');
});

test('il componente tiene distinti i due passi della rimozione e chiede conferma prima di annullare uno scarico', async () => {
	const ui = (await readFile(new URL('./LocalModelLibrary.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	// l'unica chiamata con `true` è nel riquadro del passo definitivo, dopo il controllo di `canDeletePermanently`
	assert.equal(ui.match(/handleConfirmRemove\(true\)/g)?.length, 1);
	assert.equal(ui.match(/handleConfirmRemove\(false\)/g)?.length, 1);
	// vale anche per la copia riformattata da `buildreact` in `src2`, dove la riga va a capo e perde la parentesi
	const permanentStart = ui.search(/confirmRemove && confirmRemove\.step === 'permanent'\s*\?/);
	assert.ok(permanentStart > 0, 'manca il riquadro del passo definitivo');
	const permanentBlock = ui.slice(permanentStart);
	assert.ok(permanentBlock.indexOf('handleConfirmRemove(true)') > 0);
	assert.match(permanentBlock, /disabled=\{removing \|\| inDownload \|\| !permanentArmed\}/);
	assert.match(permanentBlock, /role="alertdialog"/);
	assert.match(permanentBlock, /ref=\{keepFileRef\}/, 'il fuoco va su «Tieni il file», non sul pulsante che cancella');
	assert.match(ui, /if \(definitiva && !canDeletePermanently\(confirmRemove\.step, permanentArmed\)\) return;/);
	// «Annulla» apre la conferma; solo «Annulla lo scarico» cancella il parziale
	assert.equal(ui.match(/handleCancelDownload\(false\)/g)?.length, 1);
	assert.match(ui, /onClick=\{\(\) => setConfirmCancel\(true\)\}/);
	// dopo una rimozione le IA locali spente dall'utente restano spente
	assert.equal(/enableProviderOnSuccess: true, doNotFire: false \}\);\n\t+\}\n\t+\} catch \(err\) \{\n\t+setRemoveError/.test(ui), false);
	assert.match(ui, /enableProviderOnSuccess: false/);
});

test('lo spazio libero è solo un avviso, con la riserva che lo scarico tiene libera', () => {
	const mb = 1024 ** 2;
	assert.equal(LOCAL_MODEL_RESERVED_BYTES, 512 * mb);
	assert.equal(mayNotFitOnDisk(100 * mb, null), false, 'senza il dato non si avvisa');
	assert.equal(mayNotFitOnDisk(100 * mb, 612 * mb), false);
	assert.equal(mayNotFitOnDisk(100 * mb, 612 * mb - 1), true);
	assert.equal(mayNotFitOnDisk(Number.NaN, 0), false);
});

test('describeError toglie il prefisso tecnico del canale e non resta mai vuoto', () => {
	assert.equal(describeError(new Error("Error invoking remote method 'x': Error: Spazio esaurito")), 'Spazio esaurito');
	assert.equal(describeError(new Error("Error invoking remote method 'x': TypeError: rotto")), 'rotto');
	assert.equal(describeError('semplice'), 'semplice');
	assert.equal(describeError(new Error('')), 'Errore sconosciuto');
	assert.equal(describeError(undefined), 'Errore sconosciuto');
});

test('un modello consigliato è già installato anche se il nome differisce solo per le maiuscole', () => {
	// come il processo principale, che rifiuterebbe lo scarico con «esiste già un modello chiamato…»
	assert.equal(isCatalogEntryInstalled({ nome: 'qwen3.5-9b', file: 'q.gguf' }, [{ nome: 'Qwen3.5-9B', file: 'mio.gguf' }]), true);
	assert.equal(isCatalogEntryInstalled({ nome: 'qwen3.5-9b', file: 'q.gguf' }, [{ nome: 'altro', file: 'Q.GGUF' }]), true);
	assert.equal(isCatalogEntryInstalled({ nome: 'qwen3.5-9b', file: 'q.gguf' }, [{ nome: 'altro', file: 'altro.gguf' }]), false);
});

test('il controllo di un file già presente si ferma con un pulsante solo, senza l\'avviso che cancella', async () => {
	const ui = (await readFile(new URL('./LocalModelLibrary.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	// indipendente dagli a capo, così vale anche per la copia riformattata in `src2`
	const start = ui.search(/scarico\.stato === 'controllo' && scarico\.giaPresente\s*\?/);
	assert.ok(start > 0, 'manca il ramo del file già presente');
	const branch = ui.slice(start, ui.indexOf('Stop checking', start) + 20);
	assert.ok(branch.length < 400, 'il pulsante «Stop checking» è nel ramo del file già presente');
	assert.match(branch, /onClick=\{\(\) => handleCancelDownload\(true\)\}/);
	assert.doesNotMatch(branch, /handleCancelDownload\(false\)|setConfirmCancel/);
});

test('contesto scritto dall\'utente: solo cifre, entro i limiti di modelli.json, spazi ai lati ammessi', () => {
	const limits = 'Il contesto deve essere un numero intero fra 512 e 1048576.';
	assert.deepEqual(parseContextText(' 65536 '), { ok: true, contesto: 65536 });
	assert.deepEqual(parseContextText('512'), { ok: true, contesto: 512 });
	assert.deepEqual(parseContextText('1048576'), { ok: true, contesto: 1048576 });
	for (const text of ['', '511', '1048577', '32k', '32.768', '8192.5', '-4096', '1e4', 'abc', undefined, null]) {
		assert.deepEqual(parseContextText(text), { ok: false, error: limits }, String(text));
	}
	// il modulo «Altri modelli» usa la stessa regola
	assert.deepEqual(validateCustomModelForm({ url: 'https://huggingface.co/u/r/resolve/main/m.gguf', nome: 'm', contestoText: '32k' }, []), { ok: false, errors: { contesto: limits } });
});

test('contesto in forma breve e valori proposti dentro i limiti', () => {
	assert.equal(formatContextTokens(32768), '32K');
	assert.equal(formatContextTokens(131072), '128K');
	assert.equal(formatContextTokens(1000), '1000');
	assert.equal(formatContextTokens(0), '0');
	assert.equal(formatContextTokens(Number.NaN), '0');
	assert.ok(LOCAL_MODEL_CONTEXT_PRESETS.length > 0);
	for (const value of LOCAL_MODEL_CONTEXT_PRESETS) assert.ok(Number.isInteger(value) && value >= LOCAL_MODEL_MIN_CONTEXT && value <= LOCAL_MODEL_MAX_CONTEXT, String(value));
});

test('il cambio di contesto passa dal servizio, rilegge i modelli senza riaccendere le IA locali spente e chiede conferma con Salva', async () => {
	const ui = (await readFile(new URL('./LocalModelLibrary.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	assert.match(ui, /libraryService\.setContext\(readFolderRef\.current, \{ nome, contesto \}\)/);
	const handler = ui.slice(ui.indexOf('const handleSetContext'), ui.indexOf('const handleCatalogDownload'));
	assert.match(handler, /enableProviderOnSuccess: false/);
	assert.doesNotMatch(handler, /enableProviderOnSuccess: true/);
	// i valori proposti riempiono il campo e basta: si salva solo con il pulsante del modulo
	const control = ui.slice(ui.indexOf('const ModelContextControl'), ui.indexOf('export const LocalModelLibrary'));
	assert.match(control, /onClick=\{\(\) => \{ setText\(String\(value\)\); setError\(null\); \}\}/);
	assert.match(control, /type="submit"/);
	// durante la conferma di rimozione del modello il contesto non si cambia
	assert.match(ui, /disabled=\{removing \|\| isConfirming\}/);
});

test('filtro dell\'elenco: tutte le parole devono comparire, senza distinguere le maiuscole; vuoto lascia passare tutto', () => {
	const fields = ['qwen2.5-coder-7b', 'Completamento del codice (4,7 GB)', 'Qwen2.5-Coder-7B.Q4_K_M.gguf', 'Completamento'];
	assert.equal(matchesModelFilter('', fields), true);
	assert.equal(matchesModelFilter('   ', fields), true);
	assert.equal(matchesModelFilter('CODER', fields), true);
	assert.equal(matchesModelFilter('qwen  completamento', fields), true);
	assert.equal(matchesModelFilter('qwen chat', fields), false);
	assert.equal(matchesModelFilter('gguf', [null, undefined, 'x.GGUF']), true);
	assert.equal(matchesModelFilter('x', []), false);
	assert.equal(matchesModelFilter(undefined, fields), true);
});

test('proposte per un file trovato dalla ricerca: nome valido e non usato, contesto entro 32K, uso dal nome', () => {
	assert.equal(suggestLocalModelName('Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', []), 'qwen2.5-coder-7b-instruct-q4_k_m');
	assert.equal(suggestLocalModelName('Modello (prova) v2.GGUF', []), 'modello-prova-v2');
	assert.equal(suggestLocalModelName('a.gguf', [{ nome: 'A' }, { nome: 'a-2' }]), 'a-3');
	assert.equal(suggestLocalModelName('....gguf', []), 'modello');
	for (const file of ['Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', 'x'.repeat(150) + '.gguf', '..gguf', 'è à.gguf']) {
		const nome = suggestLocalModelName(file, [{ nome: suggestLocalModelName(file, []) }]);
		assert.ok(LOCAL_MODEL_NAME_PATTERN.test(nome) && !/^\.+$/.test(nome), nome);
	}
	assert.equal(suggestContext(131072), 32768);
	assert.equal(suggestContext(8192), 8192);
	assert.equal(suggestContext(null), 32768);
	assert.equal(suggestContext(100), 32768);
	assert.equal(suggestContext(4096.5), 32768);
	assert.equal(suggestLocalModelUse('nomic-ai/nomic-embed-text-v1.5-GGUF', 'nomic-embed-text-v1.5.Q8_0.gguf'), 'embedding');
	assert.equal(suggestLocalModelUse('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'x.gguf'), 'chat');
});

test('numeri in forma breve e forma del nome di un repository', () => {
	assert.equal(formatCount(950), '950');
	assert.equal(formatCount(1234), '1.2K');
	assert.equal(formatCount(3400000), '3.4M');
	assert.equal(formatCount(-1), '0');
	assert.equal(formatCount(Number.NaN), '0');
	for (const repo of ['bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'a/b']) assert.equal(LOCAL_MODEL_REPO_PATTERN.test(repo), true, repo);
	for (const repo of ['a', 'a/b/c', '../a/b', 'a/..', 'a/b?x', 'a b/c', '/a/b', 'a/']) assert.equal(LOCAL_MODEL_REPO_PATTERN.test(repo), false, repo);
});

test('la ricerca parte solo col pulsante o con Invio, e un file scelto compila il modulo senza scaricare', async () => {
	const ui = (await readFile(new URL('./LocalModelLibrary.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	// una sola chiamata alla ricerca, dentro il gestore dell'invio del modulo: scrivere nella casella non manda niente
	assert.equal(ui.match(/libraryService\.searchModels\(/g)?.length, 1);
	const search = ui.slice(ui.indexOf('const handleSearch'), ui.indexOf('const handleOpenRepo'));
	assert.match(search, /libraryService\.searchModels\(searchText\)/);
	assert.match(ui, /onSubmit=\{handleSearch\}/);
	assert.doesNotMatch(ui, /onChangeValue=\{[^}]*searchModels/);
	// il filtro dell'elenco non passa dal servizio
	assert.match(ui, /onChangeValue=\{setFilter\}/);
	// «Usa questo file» compila il modulo: nessuno scarico parte da lì
	const use = ui.slice(ui.indexOf('const handleUseRepoFile'), ui.indexOf('const handleCancelDownload'));
	assert.match(use, /const fileUrl = urlOfLocalModelRepoFile\(repository\.repo, repository\.revisione, file\.file\);\n\t\tsetUrl\(fileUrl\);/);
	assert.doesNotMatch(use, /startDownload/);
	assert.match(ui, /The search sends only the text you write here to huggingface\.co/);
});

test('un file scelto dalla ricerca porta allo scarico dimensione e SHA-256 dichiarati, solo finché l\'indirizzo resta quello', async () => {
	const ui = (await readFile(new URL('./LocalModelLibrary.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	const use = ui.slice(ui.indexOf('const handleUseRepoFile'), ui.indexOf('const handleCancelDownload'));
	assert.match(use, /setDeclared\(\{ url: fileUrl, bytes: file\.bytes, sha256: file\.sha256 \}\)/);
	// i valori valgono solo per l'indirizzo per cui sono stati letti: cambiato l'indirizzo, non si mandano più
	assert.match(ui, /const declaredForUrl = declared !== null && declared\.url === url\.trim\(\) \? declared : null;/);
	const submit = ui.slice(ui.indexOf('const handleCustomSubmit'), ui.indexOf('const handleSearch'));
	assert.match(submit, /\.\.\.\(declaredForUrl \? \{ bytes: declaredForUrl\.bytes, sha256: declaredForUrl\.sha256 \} : \{\}\)/);
	// l'unico altro punto che li imposta è l'azzeramento a scarico finito
	assert.deepEqual(ui.match(/setDeclared\([^)]*\)/g), ['setDeclared(null)', 'setDeclared({ url: fileUrl, bytes: file.bytes, sha256: file.sha256 })']);
	// il modulo dice quale controllo verrà fatto
	assert.match(ui, /After the download Vox checks the size and the SHA-256 declared by Hugging Face\./);
	assert.match(ui, /Hugging Face declares no SHA-256 for this file: after the download Vox checks only the size\./);
});

test('«Scarica un modello» mostra solo i consigliati non installati e sparisce quando ci sono tutti', async () => {
	const ui = (await readFile(new URL('./LocalModelLibrary.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	assert.match(ui, /const missingCatalog = catalog\.filter\(entry => !isCatalogEntryInstalled\(entry, state\.installati\)\);/);
	assert.match(ui, /const shownCatalog = missingCatalog\.filter\(/);
	assert.match(ui, /\{missingCatalog\.length > 0 \? \(\n\t\t\t\t<section className="space-y-2">\n\t\t\t\t\t<h4 [^\n]*\{t\("Download a model"\)\}<\/h4>/);
	// nella sezione non resta nessuna riga «Già installato»: l'unica è quella dei file trovati dalla ricerca
	assert.equal(ui.match(/t\("Already installed"\)/g)?.length, 1);
	const section = ui.slice(ui.indexOf('{/* 3. Scarica un modello */}'), ui.indexOf('{/* Ricerca su Hugging Face */}'));
	assert.doesNotMatch(section, /Already installed/);
	assert.match(section, /onClick=\{\(\) => handleCatalogDownload\(entry\.id\)\}/);
});

test('senza cartella restano avanzamento ed esito dello scarico; un modello consigliato senza file si riscarica dalla sua scheda', async () => {
	const ui = (await readFile(new URL('./LocalModelLibrary.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	// la sezione dello scarico (con Pausa e Annulla) si costruisce una volta e si mostra in tutti e due i casi
	const section = ui.indexOf('const downloadSection = (');
	const noFolder = ui.indexOf('if (state.cartella === null) {');
	assert.ok(section > 0 && noFolder > section, 'il ramo senza cartella viene dopo la sezione dello scarico');
	assert.equal(ui.match(/\{downloadSection\}/g)?.length, 2);
	assert.equal(ui.match(/if \(state\.cartella === null\)/g)?.length, 1);
	const branch = ui.slice(noFolder, ui.indexOf('const cartella = state.cartella;'));
	assert.match(branch, /\{downloadSection\}/);
	// il ramo non restituisce mai niente (la riga di «Ancora non trovata» è una costante, non un ritorno)
	assert.doesNotMatch(branch.replace(/const missedLine = [^;]*;\n/, ''), /return null|: null;\n/);
	// senza cartella si vedono anche gli errori di lettura, e «Controlla di nuovo» rilegge la libreria cercando di nuovo
	// la cartella sul disco (non con l'esito «assente» degli ultimi secondi); le altre letture no
	assert.match(branch, /\{loadError \? <div role="alert"/);
	// e parte subito, con il pulsante spento (e «Controllo…») finché la lettura non finisce (bene o male)
	assert.match(ui, /const startRecheck = \(\) => \{ recheckRef\.current = true; setRechecking\(true\); setRecheckCount\(count => count \+ 1\) \};/);
	assert.match(ui, /disabled=\{rechecking \|\| detection\.busy\} aria-busy=\{rechecking\} onClick=\{startRecheck\}>\n\t+\{rechecking \? t\("Checking…"\) : t\("Check again"\)\}/);
	assert.equal(ui.match(/recheckRef\.current = true/g)?.length, 1);
	assert.equal(ui.match(/onClick=\{startRecheck\}/g)?.length, 1);
	// il pulsante sta nella riga dei pulsanti, che si mostra in tre posti: senza stato (solo dopo un errore di lettura),
	// senza cartella (sempre) e nel riquadro della cartella (solo con un errore)
	assert.equal(ui.match(/\brecheckButton\b/g)?.length, 2);
	assert.match(ui, /const search = withSearch \? searchButton : null;/);
	assert.match(ui, /\{withRecheck \? recheckButton : null\}\n\t+\{search\}/);
	assert.match(branch, /\{recheckRow\(true, true\)\}/);
	// con la cartella trovata ma illeggibile (modelli.json non valido) o con il rilevamento della chat fallito i pulsanti stanno
	// sotto l'errore, e restano mentre si rilegge (il pulsante premuto non sparisce e non perde il fuoco). Senza la ricerca nei
	// posti predefiniti, che svuoterebbe il campo e porterebbe a un'altra cartella: lì il rimedio è sistemare quella trovata
	const folderBox = ui.slice(ui.indexOf('const cartella = state.cartella;'), ui.indexOf('{/* Filtro dell\'elenco'));
	assert.match(folderBox, /\{state\.errore \|\| loadError \|\| detectionText \|\| rechecking \? <div className="pt-1">\{recheckRow\(true, false\)\}<\/div> : null\}/);
	assert.match(folderBox, /\{detectionText \? <div className="pt-1">\{detectionLine\}<\/div> : null\}/);
	assert.doesNotMatch(folderBox, /searchButton|recheckRow\(true, true\)/);
	assert.equal(ui.match(/recheckRow\(/g)?.length, 3);
	assert.match(ui, /const ricontrolla = recheckRef\.current;\n\t+recheckRef\.current = false;\n\t+const recheck = ricontrolla \|\| fromRecheck;/);
	assert.match(ui, /libraryService\.getState\(folder, ricontrolla\)\.then\(/);
	// il ricontrollo lo chiude l'ultima lettura: anche la seconda, partita perché nel frattempo è arrivato un evento
	// (durante uno scarico ne arriva uno ogni 250 ms), e anche una lettura annullata o fallita
	assert.match(ui, /if \(cancelled\) \{ if \(recheck\) finishRecheck\(null\); return; \}/);
	assert.match(ui, /if \(!isRetry\) fetchState\(true, recheck\);\n\t+else if \(recheck\) finishRecheck\(next\);\n\t+return;/);
	assert.match(ui, /if \(recheck\) finishRecheck\(next\);\n\t+else setRecheckMissed\(false\);/);
	assert.match(ui, /err => \{\n\t+if \(recheck\) finishRecheck\(null\);/);
	assert.equal(ui.match(/finishRecheck\(/g)?.length, 4);
	assert.equal(ui.match(/setRechecking\(false\)/g)?.length, 1);
	assert.match(ui, /if \(firstReadRef\.current \|\| recheckRef\.current\) \{ firstReadRef\.current = false; read\(\);/);
	// se la trova, anche la chat rilegge i modelli locali; se non la trova, lo dice (solo nel ramo senza cartella)
	assert.match(ui, /const finishRecheck = \(next: LocalModelLibraryState \| null\) => \{\n\t+setRechecking\(false\);\n.*\n\t+setRecheckMissed\(false\);\n\t+if \(!next\) return;\n\t+setRecheckMissed\(next\.cartella === null && !next\.errore\);\n\t+if \(next\.cartella !== null\) refreshModelService\.startRefreshingModels\('voxLocal', \{ enableProviderOnSuccess: true, doNotFire: false \}\);/);
	assert.match(branch, /const missedLine = recheckMissed && !rechecking\n\t+\? <div role="status"/);
	assert.equal(ui.match(/recheckMissed &&/g)?.length, 1);
	// un evento con la cartella toglie «Ancora non trovata» di un ricontrollo di prima
	const events = ui.slice(ui.indexOf('libraryService.onDidChangeState(next => {'), ui.indexOf('if (next.scarico.stato === \'finito\' && next.scarico.nome === submittedNameRef.current)'));
	assert.match(events, /if \(next\.cartella !== null\) setRecheckMissed\(false\);/);
	assert.match(ui, /\}, \[libraryService, refreshModelService, configuredFolder, recheckCount\]\);/);
	assert.match(ui.slice(section, noFolder), /handleCancelDownload\(true\)/);
	// «Scarica di nuovo»: dalla voce consigliata corrispondente, con l'errore accanto ai modelli installati
	assert.match(ui, /const redownloadEntry = catalogEntryForMissingModel\(model, catalog\);/);
	assert.match(ui, /onClick=\{\(\) => handleCatalogDownload\(redownloadEntry\.id, 'installati'\)\}/);
	// con il modello acceso il processo principale rifiuterebbe il riscarico: pulsante spento, e si dice perché
	assert.match(ui, /disabled=\{isDownloading \|\| startingDownload \|\| removing \|\| isConfirming \|\| model\.acceso\}\n\t+aria-label=\{t\("Download \{0\} again", model\.nome\)\}/);
	assert.match(ui, /\{model\.acceso \? <span className="block text-vox-warning">\{t\("The model \{0\} is running without its file: close and reopen Vox, then try again\.", model\.nome\)\}<\/span> : null\}/);
	assert.equal(ui.match(/actionErrorBox\('installati'\)/g)?.length, 1);
	// «Elimina» del modello in scarico: il processo principale la rifiuterebbe dopo la conferma, quindi è spento e si dice perché
	assert.match(ui, /const inDownload = isModelInDownload\(model, state\.scarico\);/);
	assert.match(ui, /disabled=\{removing \|\| inDownload\}\n\t+aria-describedby=\{inDownload \? inDownloadId : undefined\}\n\t+aria-label=\{t\("Delete \{0\}", model\.nome\)\}/);
	assert.match(ui, /\{inDownload \? <div id=\{inDownloadId\} className="text-xs text-vox-fg-3">\{t\("This model is being downloaded or checked: stop it first\."\)\}<\/div> : null\}/);
	// id senza spazi (aria-describedby è un elenco separato da spazi, e i nomi dei modelli possono averne)
	assert.match(ui, /const inDownloadId = `\$\{baseId\}-in-download-\$\{index\}`;/);
	// anche una richiesta di conferma già aperta quando lo scarico parte non può più confermare
	// (anche loro con la riga che dice perché)
	assert.match(ui, /disabled=\{removing \|\| inDownload\}\n\t+aria-describedby=\{inDownload \? inDownloadId : undefined\}\n\t+className=\{dangerButtonClass\}\n\t+onClick=\{\(\) => handleConfirmRemove\(false\)\}/);
	assert.match(ui, /disabled=\{removing \|\| inDownload \|\| !permanentArmed\}\n\t+aria-describedby=\{inDownload \? inDownloadId : undefined\}\n\t+className=\{dangerButtonClass\}\n\t+onClick=\{\(\) => handleConfirmRemove\(true\)\}/);
	assert.equal(ui.match(/aria-describedby=\{inDownload \? inDownloadId : undefined\}/g)?.length, 3);
});

test('scheda «IA locali»: un blocco solo per la cartella non trovata, con l\'esito del rilevamento della chat e i due pulsanti', async () => {
	const ui = (await readFile(new URL('./LocalModelLibrary.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	const settings = (await readFile(new URL('./Settings.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
	const provider = settings.slice(settings.indexOf('export const SettingsForProvider'), settings.indexOf('export const VoxProviderSettings'));
	assert.ok(provider.length > 0);
	// le Impostazioni passano alla libreria errore, «non configurata», ricerca in corso e il gestore della ricerca
	assert.match(provider, /const libraryShown = providerName === 'voxLocal' && !!showLocalModelLibrary/);
	assert.match(provider, /\{libraryShown && <LocalModelLibrary detection=\{\{\n\t+detectionError: voxLocalError,\n\t+notConfigured: voxLocalNotConfigured,\n\t+stale: voxLocalRefreshing,\n(\t+\/\/.*\n)?\t+busy: voxLocalBusy,\n\t+searchStarted: searchInFlight,\n\t+onSearchDefaultPlaces: canSearchDefaultPlaces \|\| searchInFlight \? \(\) => \{ void searchDefaultPlaces\(\) \} : undefined,\n\t+\}\} \/>\}/);
	assert.match(provider, /const voxLocalBusy = isSearchingAgain \|\| voxLocalManualRefreshing/);
	// durante un rilevamento (stato 'refreshing', senza esito) la libreria tiene la sua riga; qui resta l'ultimo errore solo
	// per offrire ancora la ricerca, così il pulsante non sparisce
	assert.match(provider, /const voxLocalRefreshing = voxLocalRefreshState\?\.state === 'refreshing'/);
	assert.match(provider, /if \(!voxLocalRefreshing\) lastErrorRef\.current = voxLocalError/);
	assert.match(provider, /const shownError = voxLocalRefreshing \? lastErrorRef\.current : voxLocalError/);
	// il pulsante della ricerca resta finché la ricerca che ha fatto partire non finisce (intanto il campo si svuota)
	assert.match(provider, /useEffect\(\(\) => \{ if \(!voxLocalBusy\) setSearchInFlight\(false\) \}, \[voxLocalBusy\]\)/);
	assert.match(provider, /const searchDefaultPlaces = async \(\) => \{\n\t+setSearchInFlight\(true\)\n\t+setIsSearchingAgain\(true\)/);
	// la ricerca guarda davvero le unità: prima si dimentica la cache delle cartelle (anche l'esito «assente» delle unità),
	// poi si svuota il campo e parte il rilevamento
	const search = provider.slice(provider.indexOf('const searchDefaultPlaces = async'), provider.indexOf('// const { enabled }'));
	assert.match(search, /try \{ await localModelLibraryService\.getState\('', true\) \}/);
	assert.ok(search.indexOf("getState('', true)") > 0 && search.indexOf("getState('', true)") < search.indexOf("setSettingOfProvider('voxLocal', 'folder', '')"));
	assert.ok(search.indexOf("setSettingOfProvider('voxLocal', 'folder', '')") < search.indexOf("startRefreshingModels('voxLocal'"));
	assert.match(provider, /const localModelLibraryService = accessor\.get\('ILocalModelLibraryService'\)/);
	// e con la libreria non mostrano più il proprio avviso, né la riga «non configurata»; nel primo avvio (senza libreria) restano
	assert.match(provider, /\{!libraryShown && voxLocalNotConfigured \?/);
	assert.match(provider, /\{!libraryShown && voxLocalError \? <>/);
	assert.equal(provider.match(/voxLocalError \?/g)?.length, 1);
	assert.equal(provider.match(/<LocalModelLibrary\b/g)?.length, 1);
	assert.match(provider, /const canSearchDefaultPlaces = !!shownError && !!voxSettingsState\.settingsOfProvider\.voxLocal\.folder\?\.trim\(\)/);
	assert.match(provider, /disabled=\{isSearchingAgain \|\| voxLocalManualRefreshing\} onClick=\{searchDefaultPlaces\}>\{t\("Search the default places"\)\}/);
	assert.equal(provider.match(/setSettingOfProvider\('voxLocal', 'folder', ''\)/g)?.length, 1);
	// l'avviso non bloccante (per esempio un modello senza file) resta nelle Impostazioni
	assert.match(provider, /\{voxLocalWarning \? <WarningBox/);
	// la libreria: errore del rilevamento senza doppioni con i suoi (che dicono già la stessa cosa)
	assert.match(ui, /export const LocalModelLibrary = \(\{ detection = noDetection \}: \{ detection\?: LocalModelDetection \}\) => \{/);
	// (la scelta della riga è detectionNotice, provata a parte; qui si controlla che la pagina la usi così)
	assert.match(ui, /const libraryErrors = \[state\?\.errore, loadError\];/);
	assert.match(ui, /const freshNotice = detectionNotice\(detection\.detectionError, detection\.notConfigured, libraryErrors\);/);
	// mentre la chat rilegge resta la riga già calcolata (shownDetectionNotice, provata a parte), con la cartella di allora
	assert.match(ui, /const senzaCartella = state \? state\.cartella === null : null;/);
	assert.match(ui, /if \(!detection\.stale\) rememberedNoticeRef\.current = \{ notice: freshNotice, senzaCartella \};/);
	assert.match(ui, /const notice = shownDetectionNotice\(freshNotice, rememberedNoticeRef\.current, detection\.stale, senzaCartella, libraryErrors\);/);
	assert.ok(ui.indexOf('const rememberedNoticeRef = useRef') < ui.indexOf('if (!state) {'), 'il ref sta prima di ogni ritorno');
	assert.match(ui, /const detectionText = notice\?\.tipo === 'errore' \? notice\.testo : null;/);
	assert.match(ui, /const renderDetectionLine = \(announce: boolean\) => detectionText\n\t+\? <div role=\{announce \? 'alert' : 'status'\}[^\n]*\{detectionText\}<\/div>\n\t+: notice\?\.tipo === 'nonConfigurata'\n\t+\? <div role="status"[^\n]*\{t\("Local AI is not configured: no ia-locali folder was found\./);
	assert.match(ui, /const detectionLine = renderDetectionLine\(true\);/);
	// i due pulsanti si spengono a vicenda durante ogni rilevamento manuale; «Ricerca…» solo per la ricerca partita dal pulsante
	assert.doesNotMatch(ui, /detectionBusy|detection\.searching\b/);
	assert.match(ui, /disabled=\{rechecking \|\| detection\.busy\} aria-busy=\{detection\.searchStarted\} onClick=\{detection\.onSearchDefaultPlaces\}>\n\t+\{detection\.searchStarted \? t\("Searching…"\) : t\("Search the default places"\)\}/);
	assert.match(ui, /\{withRecheck && search \? <div className="text-xs text-vox-fg-3">\{t\("Check again rereads the folder written above\./);
	// senza stato (lettura in corso o fallita) l'esito del rilevamento e la ricerca non spariscono
	const noState = ui.slice(ui.indexOf('if (!state) {'), ui.indexOf('const isDownloading ='));
	// (senza annunciarla: la riga si rimonta subito nel ramo che segue, che la annuncia una volta sola)
	assert.match(noState, /\{renderDetectionLine\(false\)\}/);
	assert.doesNotMatch(noState, /\{detectionLine\}/);
	assert.match(noState, /\{loadError \|\| searchButton \? recheckRow\(!!loadError, true\) : null\}/);
	assert.ok(ui.indexOf('const detectionLine =') < ui.indexOf('if (!state) {'));
	// senza cartella una riga sola: l'esito dell'ultimo «Controlla di nuovo» (il più recente), altrimenti quello del
	// rilevamento, altrimenti il testo di sempre; con lo scarico in corso, l'avviso dello scarico più una di quelle righe
	const noFolder = ui.slice(ui.indexOf('if (state.cartella === null) {'), ui.indexOf('const cartella = state.cartella;'));
	assert.match(noFolder, /\{missedLine \?\? \(detectionText \? detectionLine : null\)\}/);
	assert.match(noFolder, /: missedLine \?\? detectionLine \?\? <div role="status" className="text-xs text-vox-fg-3">\{t\("The model library will appear here when the local AI folder is ready\."\)\}<\/div>\}/);
	assert.equal(noFolder.match(/missedLine/g)?.length, 3);
});
