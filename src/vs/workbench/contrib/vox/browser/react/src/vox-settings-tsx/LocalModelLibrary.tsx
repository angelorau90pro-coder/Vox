/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../../../common/voxI18n.js';
import { displayInfoOfFeatureName, featureNames } from '../../../../common/voxSettingsTypes.js';
import { InstalledLocalModel, LOCAL_MODEL_CONTEXT_PRESETS, LocalModelCatalogEntry, LocalModelContextResult, LocalModelDownloadState, LocalModelLibraryState, LocalModelRepoFile, LocalModelRepoFiles, LocalModelSearchResult, LocalModelUse, urlOfLocalModelRepoFile } from '../../../../common/localModelLibraryTypes.js';
import { useAccessor, useSettingsState } from '../util/services.js';
import { VoxCustomDropdownBox, VoxSimpleInputBox } from '../util/inputs.js';
import {
	canDeletePermanently,
	catalogEntryForMissingModel,
	CustomModelFormErrors,
	describeError,
	downloadPercent,
	featuresUsingLocalModel,
	formatContextTokens,
	formatCount,
	formatGigabytes,
	formatLocalModelUse,
	formatRemainingTime,
	formatSpeedMBps,
	isCatalogEntryInstalled,
	isModelInDownload,
	detectionNotice,
	shownDetectionNotice,
	RememberedDetectionNotice,
	matchesModelFilter,
	mayNotFitOnDisk,
	parseContextText,
	PERMANENT_DELETE_DELAY_MS,
	suggestContext,
	suggestLocalModelName,
	suggestLocalModelUse,
	validateCustomModelForm,
} from './localModelLibraryFormat.js';

const LOCAL_MODEL_USES: LocalModelUse[] = ['chat', 'completamento', 'embedding'];
const DEFAULT_CONTEXT = '32768';

// costanti lette così come sono (scope-tailwind non le trasforma): solo classi del sistema grafico, senza prefisso
const secondaryButtonClass = 'vox-btn vox-btn-secondary vox-btn-sm';
const primaryButtonClass = 'vox-btn vox-btn-primary vox-btn-sm';
const dangerButtonClass = 'vox-btn vox-btn-danger vox-btn-sm';
// La cartella delle Impostazioni si salva a ogni tasto: la libreria la rilegge solo quando smette di cambiare.
const FOLDER_READ_DELAY_MS = 400;

// Contesto di un modello installato: si legge sempre, si cambia con «Cambia» (valori proposti o numero scritto a mano).
// Il valore va in `modelli.json`; un modello acceso si riavvia alla prossima richiesta, senza interrompere una risposta.
const ModelContextControl = ({ model, disabled, onSave }: {
	model: InstalledLocalModel;
	disabled: boolean;
	onSave: (contesto: number) => Promise<LocalModelContextResult>;
}) => {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(String(model.contesto));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const baseId = useId();
	const inputId = `${baseId}-context`;
	const errId = `${baseId}-context-err`;
	const hintId = `${baseId}-context-hint`;

	useEffect(() => { if (editing) (document.getElementById(inputId) as HTMLInputElement | null)?.focus(); }, [editing, inputId]);
	// il valore può cambiare da fuori (un'altra finestra, `modelli.json` scritto a mano): fuori dalla modifica si allinea
	useEffect(() => { if (!editing) setText(String(model.contesto)); }, [model.contesto, editing]);

	const save = async (value: string) => {
		if (saving) return;
		const parsed = parseContextText(value);
		if (!parsed.ok) { setError(parsed.error); return; }
		if (parsed.contesto === model.contesto) { setEditing(false); setError(null); return; }
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const res = await onSave(parsed.contesto);
			if (res.esito === 'errore') { setError(res.messaggio); return; }
			setEditing(false);
			setNotice(res.riavvio
				? t("Context changed from {0} to {1} tokens. The model will restart with the new value on the next request.", res.prima, parsed.contesto)
				: t("Context changed from {0} to {1} tokens.", res.prima, parsed.contesto));
		} catch (err) {
			setError(describeError(err));
		} finally {
			setSaving(false);
		}
	};

	if (!editing) {
		return (
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
				<span className="text-vox-fg-3">{t("Context:")}</span>
				<span className="text-vox-fg-1" title={t("{0} tokens", model.contesto)}>{t("{0} tokens", formatContextTokens(model.contesto))}</span>
				<button
					type="button"
					disabled={disabled}
					aria-label={t("Change the context of {0}", model.nome)}
					className={secondaryButtonClass}
					onClick={() => { setText(String(model.contesto)); setError(null); setNotice(null); setEditing(true); }}
				>
					{t("Change")}
				</button>
				{notice ? <span role="status" className="basis-full text-vox-fg-3">{notice}</span> : null}
			</div>
		);
	}

	return (
		<form
			className="border-t border-vox-hairline pt-2 space-y-1.5 text-xs"
			noValidate
			onSubmit={e => { e.preventDefault(); void save(text); }}
			onKeyDown={e => { if (e.key === 'Escape' && !saving) { e.stopPropagation(); setEditing(false); setError(null); } }}
		>
			<label htmlFor={inputId} className="block font-medium text-vox-fg-1">{t("Context of {0} (tokens)", model.nome)}</label>
			<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Suggested values")}>
				{LOCAL_MODEL_CONTEXT_PRESETS.map(value => (
					<button
						key={value}
						type="button"
						disabled={saving}
						aria-pressed={text.trim() === String(value)}
						className={text.trim() === String(value) ? primaryButtonClass : secondaryButtonClass}
						onClick={() => { setText(String(value)); setError(null); }}
					>
						{formatContextTokens(value)}
					</button>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<div className="w-32">
					<VoxSimpleInputBox
						id={inputId}
						compact={true}
						inputMode="numeric"
						value={text}
						placeholder={String(model.contesto)}
						onChangeValue={val => { setText(val); if (error) setError(null); }}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? `${errId} ${hintId}` : hintId}
					/>
				</div>
				<button type="button" disabled={saving} className={secondaryButtonClass} onClick={() => { setEditing(false); setError(null); }}>
					{t("Cancel")}
				</button>
				<button type="submit" disabled={saving} className={primaryButtonClass}>
					{saving ? t("Saving…") : t("Save")}
				</button>
			</div>
			<div id={hintId} className="text-vox-fg-3">
				{t("More context lets the model read longer chats and files, but uses more video card memory: if it does not fit, the model will not start and its log says why. Lower it if the model is slow or fails to start.")}
				{model.acceso ? ` ${t("The model is running: it will restart with the new value on the next request.")}` : ''}
			</div>
			{error ? <div id={errId} role="alert" className="text-vox-danger">{error}</div> : null}
		</form>
	);
};

/**
 * Esito del rilevamento dei modelli della chat, che le Impostazioni passano alla libreria: così la scheda «IA locali»
 * mostra un solo blocco quando la cartella manca o non si legge, invece di due avvisi quasi uguali.
 * - `detectionError`: errore del rilevamento (null se non c'è);
 * - `notConfigured`: il rilevamento è finito senza cartella né modelli (non è un errore);
 * - `stale`: il rilevamento è in corso e non ha un esito: la libreria tiene la riga che mostrava prima;
 * - `busy`: è in corso un rilevamento manuale (la ricerca qui sotto, la rilettura dopo «Controlla di nuovo» o dopo uno scarico);
 * - `searchStarted`: è in corso la ricerca nei posti predefiniti partita dal pulsante qui sotto;
 * - `onSearchDefaultPlaces`: svuota il campo della cartella e cerca nei posti predefiniti. C'è solo con un errore e il campo pieno.
 */
export type LocalModelDetection = {
	detectionError: string | null;
	notConfigured: boolean;
	stale: boolean;
	busy: boolean;
	searchStarted: boolean;
	onSearchDefaultPlaces?: () => void;
};

const noDetection: LocalModelDetection = { detectionError: null, notConfigured: false, stale: false, busy: false, searchStarted: false };

export const LocalModelLibrary = ({ detection = noDetection }: { detection?: LocalModelDetection }) => {
	const accessor = useAccessor();
	const libraryService = accessor.get('ILocalModelLibraryService');
	const refreshModelService = accessor.get('IRefreshModelService');
	const voxSettingsState = useSettingsState();
	const configuredFolder = voxSettingsState.settingsOfProvider.voxLocal.folder ?? '';

	const [state, setState] = useState<LocalModelLibraryState | null>(null);
	// cartella da cui è stato letto l'elenco mostrato: mentre si scrive una cartella nuova (rilettura ritardata)
	// rimozione e scarico agiscono ancora su quello che l'utente vede
	const readFolderRef = useRef(configuredFolder);
	const [catalog, setCatalog] = useState<LocalModelCatalogEntry[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	// «Controlla di nuovo» senza cartella: la libreria si rilegge anche se la cartella scritta nelle Impostazioni non cambia
	// (per esempio dopo aver creato `ia-locali` con questa pagina aperta)
	const [recheckCount, setRecheckCount] = useState(0);
	// la lettura chiesta da «Controlla di nuovo» non usa l'esito «cartella assente» degli ultimi secondi
	const recheckRef = useRef(false);
	// mentre «Controlla di nuovo» cerca la cartella (con la ricerca automatica anche su tutte le unità) il pulsante è spento
	const [rechecking, setRechecking] = useState(false);
	// l'ultimo «Controlla di nuovo» non ha trovato la cartella
	const [recheckMissed, setRecheckMissed] = useState(false);
	// riga del rilevamento dell'ultima volta che c'era un esito (vedi shownDetectionNotice)
	const rememberedNoticeRef = useRef<RememberedDetectionNotice | null>(null);
	// «Controlla di nuovo» (senza cartella, o con la cartella che dà un errore): la lettura parte subito e il pulsante
	// resta spento finché non finisce
	const startRecheck = () => { recheckRef.current = true; setRechecking(true); setRecheckCount(count => count + 1) };
	// rilevamento manuale dei modelli della chat in corso (la ricerca nei posti predefiniti, la rilettura dopo un
	// ricontrollo, ma anche quella dopo uno scarico): i due pulsanti si spengono a vicenda, perché un ricontrollo
	// durante la ricerca ne farebbe partire una seconda. «Ricerca…» però solo per la ricerca partita dal pulsante.
	const recheckButton = (
		<button type="button" className={secondaryButtonClass} disabled={rechecking || detection.busy} aria-busy={rechecking} onClick={startRecheck}>
			{rechecking ? t("Checking…") : t("Check again")}
		</button>
	);
	const searchButton = detection.onSearchDefaultPlaces ? (
		<button type="button" className={secondaryButtonClass} disabled={rechecking || detection.busy} aria-busy={detection.searchStarted} onClick={detection.onSearchDefaultPlaces}>
			{detection.searchStarted ? t("Searching…") : t("Search the default places")}
		</button>
	) : null;
	// riga dei pulsanti: la ricerca nei posti predefiniti (che svuota il campo) solo dove la cartella non c'è, perché
	// con la cartella trovata ma illeggibile il rimedio è sistemarla, non cercarne un'altra; con tutti e due si spiega la differenza
	const recheckRow = (withRecheck: boolean, withSearch: boolean) => {
		const search = withSearch ? searchButton : null;
		return (
			<div className="space-y-1">
				<div className="flex flex-wrap items-center gap-2">
					{withRecheck ? recheckButton : null}
					{search}
				</div>
				{withRecheck && search ? <div className="text-xs text-vox-fg-3">{t("Check again rereads the folder written above. Search the default places empties the field and looks for ia-locali next to Vox, in .vox in your user folder and in \\Vox\\ia-locali on every drive.")}</div> : null}
			</div>
		);
	};
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [startingDownload, setStartingDownload] = useState(false);
	const [actionErrorSource, setActionErrorSource] = useState<'catalogo' | 'installati' | 'indirizzo' | 'scarico'>('catalogo');
	const [canceling, setCanceling] = useState(false);
	// conferma dell'annullo (che cancella il file parziale); la pausa invece non chiede niente
	const [confirmCancel, setConfirmCancel] = useState(false);
	// messaggio di esito chiuso dall'utente, per stato e modello: il messaggio di uno scarico nuovo si vede di nuovo
	const [dismissedStatus, setDismissedStatus] = useState<string | null>(null);
	const downloadRunning = state?.scarico.stato === 'scarico' || state?.scarico.stato === 'controllo';
	useEffect(() => { if (downloadRunning) setDismissedStatus(null); }, [downloadRunning]);

	// Conferma dentro la pagina per l'eliminazione di un modello. `permanent` è un secondo passo distinto, con un altro
	// pulsante che si accende solo dopo un attimo (`permanentArmed`).
	const [confirmRemove, setConfirmRemove] = useState<{ model: InstalledLocalModel; step: 'trash' | 'permanent' } | null>(null);
	const [permanentArmed, setPermanentArmed] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [removeError, setRemoveError] = useState<string | null>(null);

	// Campi del modulo "Altri modelli"
	const [url, setUrl] = useState('');
	const [nome, setNome] = useState('');
	const [uso, setUso] = useState<LocalModelUse>('chat');
	const [contestoText, setContestoText] = useState(DEFAULT_CONTEXT);
	const [descrizione, setDescrizione] = useState('');
	const [fieldErrors, setFieldErrors] = useState<CustomModelFormErrors>({});
	// «Altri modelli» si apre da solo quando si sceglie un file dalla ricerca
	const [customOpen, setCustomOpen] = useState(false);
	// Dimensione e SHA-256 dichiarati da Hugging Face per il file scelto dalla ricerca: valgono solo finché l'indirizzo
	// nel modulo resta quello (se l'utente lo cambia, il file è un altro e questi valori non lo riguardano più).
	const [declared, setDeclared] = useState<{ url: string, bytes: number, sha256: string | null } | null>(null);
	const customFormRef = useRef<HTMLDetailsElement | null>(null);

	// Filtro dell'elenco (modelli installati e consigliati): resta su questo PC
	const [filter, setFilter] = useState('');
	// Ricerca su Hugging Face: parte solo con Invio o col pulsante, mai mentre si scrive
	const [searchText, setSearchText] = useState('');
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [searchResults, setSearchResults] = useState<LocalModelSearchResult[] | null>(null);
	const [openRepo, setOpenRepo] = useState<string | null>(null);
	const [repoFiles, setRepoFiles] = useState<LocalModelRepoFiles | null>(null);
	const [repoError, setRepoError] = useState<string | null>(null);
	const [loadingRepo, setLoadingRepo] = useState(false);

	const lastScaricoRef = useRef<LocalModelDownloadState | null>(null);
	// numero degli eventi arrivati: una risposta di `getState` partita prima dell'ultimo evento è vecchia e si scarta
	const eventCountRef = useRef(0);
	// nome dell'ultimo modello chiesto dal modulo «Altri modelli»: il modulo si svuota solo quando quello scarico finisce
	const submittedNameRef = useRef<string | null>(null);
	// la prima lettura è subito; le seguenti (cambio della cartella) aspettano che si smetta di scrivere
	const firstReadRef = useRef(true);
	const keepFileRef = useRef<HTMLButtonElement | null>(null);
	const keepDownloadingRef = useRef<HTMLButtonElement | null>(null);

	const baseId = useId();
	const urlId = `${baseId}-url`;
	const urlErrId = `${baseId}-url-err`;
	const nameId = `${baseId}-name`;
	const nameErrId = `${baseId}-name-err`;
	const contextId = `${baseId}-context`;
	const contextErrId = `${baseId}-context-err`;
	const descId = `${baseId}-desc`;
	const filterId = `${baseId}-filter`;
	const searchId = `${baseId}-search`;

	useEffect(() => {
		let cancelled = false;
		// `fromRecheck`: seconda lettura nata da «Controlla di nuovo». Non cerca di nuovo sul disco (la prima l'ha già fatto),
		// ma è lei a chiudere il ricontrollo: riaccende il pulsante e dice se la cartella c'è.
		const fetchState = (isRetry: boolean, fromRecheck = false) => {
			const eventsBefore = eventCountRef.current;
			const folder = configuredFolder;
			const ricontrolla = recheckRef.current;
			recheckRef.current = false;
			const recheck = ricontrolla || fromRecheck;
			// Fine di «Controlla di nuovo»: il pulsante torna attivo. Se ha trovato la cartella anche la chat rilegge i modelli
			// locali (altrimenti lo fa solo all'avvio o quando cambia la cartella scritta), e con la cartella vuota la salva
			// nelle Impostazioni. Se non l'ha trovata lo dice, salvo un errore della cartella, che si vede già e dice la causa.
			const finishRecheck = (next: LocalModelLibraryState | null) => {
				setRechecking(false);
				// una lettura fallita o annullata non dice niente sulla cartella: il messaggio di un ricontrollo di prima si toglie
				setRecheckMissed(false);
				if (!next) return;
				setRecheckMissed(next.cartella === null && !next.errore);
				if (next.cartella !== null) refreshModelService.startRefreshingModels('voxLocal', { enableProviderOnSuccess: true, doNotFire: false });
			};
			libraryService.getState(folder, ricontrolla).then(
				next => {
					if (cancelled) { if (recheck) finishRecheck(null); return; }
					// da qui il processo principale descrive questa cartella anche negli eventi
					readFolderRef.current = folder;
					setLoadError(null);
					// una risposta partita prima dell'ultimo evento è vecchia: non cambia niente, nemmeno i modelli sceglibili.
					// Quell'evento però può essere partito prima della lettura e descrivere ancora la cartella di prima:
					// una seconda lettura riallinea elenco e cartella delle azioni (gli eventi successivi descrivono già questa)
					if (eventCountRef.current !== eventsBefore) {
						if (!isRetry) fetchState(true, recheck);
						else if (recheck) finishRecheck(next);
						return;
					}
					if (recheck) finishRecheck(next);
					else setRecheckMissed(false);
					// uno scarico finito mentre questa pagina era chiusa: i modelli sceglibili si rileggono adesso
					if (next.scarico.stato === 'finito' && lastScaricoRef.current?.stato !== 'finito') refreshModelService.startRefreshingModels('voxLocal', { enableProviderOnSuccess: true, doNotFire: false });
					lastScaricoRef.current = next.scarico;
					setState(next);
				},
				err => {
					if (recheck) finishRecheck(null);
					if (!cancelled) setLoadError(t("The model library is not available: {0}", describeError(err)));
				},
			);
		};
		const read = () => {
			if (cancelled) return;
			setConfirmRemove(null);
			setRemoveError(null);
			fetchState(false);
		};
		// la prima lettura e quella di «Controlla di nuovo» partono subito; l'attesa serve solo mentre si scrive la cartella
		if (firstReadRef.current || recheckRef.current) { firstReadRef.current = false; read(); return () => { cancelled = true; }; }
		const timer = setTimeout(read, FOLDER_READ_DELAY_MS);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [libraryService, refreshModelService, configuredFolder, recheckCount]);

	useEffect(() => {
		let cancelled = false;
		libraryService.getCatalog().then(
			entries => {
				if (cancelled) return;
				setCatalog(entries);
				setCatalogError(null);
			},
			err => { if (!cancelled) setCatalogError(t("The recommended list is not available: {0}", describeError(err))); },
		);
		return () => { cancelled = true; };
	}, [libraryService]);

	useEffect(() => {
		const disposable = libraryService.onDidChangeState(next => {
			const prevScarico = lastScaricoRef.current;
			eventCountRef.current++;
			lastScaricoRef.current = next.scarico;
			setState(next);
			// la cartella è comparsa (per esempio a fine scarico): «Ancora non trovata» di un ricontrollo di prima non vale più
			if (next.cartella !== null) setRecheckMissed(false);
			if (next.scarico.stato === 'finito' && next.scarico.nome === submittedNameRef.current) {
				submittedNameRef.current = null;
				setUrl('');
				setDeclared(null);
				setNome('');
				setUso('chat');
				setContestoText(DEFAULT_CONTEXT);
				setDescrizione('');
			}
			if (next.scarico.stato !== 'scarico' && next.scarico.stato !== 'controllo') setConfirmCancel(false);
			if (next.scarico.stato === 'finito' && prevScarico?.stato !== 'finito') {
				refreshModelService.startRefreshingModels('voxLocal', { enableProviderOnSuccess: true, doNotFire: false });
			}
		});
		return () => { disposable.dispose(); };
	}, [libraryService, refreshModelService]);

	const permanentStep = confirmRemove?.step === 'permanent';
	useEffect(() => {
		setPermanentArmed(false);
		if (!permanentStep) return;
		keepFileRef.current?.focus();
		const timer = setTimeout(() => setPermanentArmed(true), PERMANENT_DELETE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [permanentStep, confirmRemove?.model.nome]);

	useEffect(() => { if (confirmCancel) keepDownloadingRef.current?.focus(); }, [confirmCancel]);

	// esito del rilevamento della chat: l'errore, se non dice la stessa cosa di quelli della libreria (che si vedono già),
	// oppure «non configurata». Mentre la chat rilegge resta la riga di prima (vedi shownDetectionNotice)
	const libraryErrors = [state?.errore, loadError];
	// null: la libreria non ha ancora uno stato, quindi non si sa se la cartella c'è
	const senzaCartella = state ? state.cartella === null : null;
	const freshNotice = detectionNotice(detection.detectionError, detection.notConfigured, libraryErrors);
	// scrittura durante il disegno: è idempotente (stessi valori, stesso risultato) e la pagina non usa transizioni né Suspense
	if (!detection.stale) rememberedNoticeRef.current = { notice: freshNotice, senzaCartella };
	const notice = shownDetectionNotice(freshNotice, rememberedNoticeRef.current, detection.stale, senzaCartella, libraryErrors);
	const detectionText = notice?.tipo === 'errore' ? notice.testo : null;
	// `announce` falso nel ramo senza stato: lì la riga dura poco e si rimonta subito nel ramo che segue, dove si annuncia
	const renderDetectionLine = (announce: boolean) => detectionText
		? <div role={announce ? 'alert' : 'status'} className="text-xs text-vox-warning">{detectionText}</div>
		: notice?.tipo === 'nonConfigurata'
			? <div role="status" className="text-xs text-vox-fg-3">{t("Local AI is not configured: no ia-locali folder was found. You can use the CLI AI in the meantime, or set it up as described below.")}</div>
			: null;
	const detectionLine = renderDetectionLine(true);

	// libreria ancora senza stato (lettura in corso o fallita): l'esito del rilevamento e la ricerca restano visibili
	if (!state) {
		return (
			<div className="px-3 py-2 space-y-2 text-xs">
				{loadError
					? <div role="alert" className="text-vox-danger">{loadError}</div>
					: <div role="status" className="text-vox-fg-3">{t("Loading the model library…")}</div>}
				{renderDetectionLine(false)}
				{loadError || searchButton ? recheckRow(!!loadError, true) : null}
			</div>
		);
	}

	const isDownloading = state.scarico.stato === 'scarico' || state.scarico.stato === 'controllo';

	const handleConfirmRemove = async (definitiva: boolean) => {
		if (!confirmRemove || removing) return;
		// la cancellazione definitiva parte solo dal suo passo, col suo pulsante già acceso
		if (definitiva && !canDeletePermanently(confirmRemove.step, permanentArmed)) return;
		setRemoving(true);
		setRemoveError(null);
		try {
			const res = await libraryService.removeModel(readFolderRef.current, { nome: confirmRemove.model.nome, definitiva });
			if (res.esito === 'cestinoAssente') {
				setConfirmRemove({ model: confirmRemove.model, step: 'permanent' });
			} else if (res.esito === 'errore') {
				setRemoveError(res.messaggio);
			} else {
				setConfirmRemove(null);
				// si rileggono i modelli sceglibili, ma le IA locali spente dall'utente restano spente
				refreshModelService.startRefreshingModels('voxLocal', { enableProviderOnSuccess: false, doNotFire: false });
			}
		} catch (err) {
			setRemoveError(describeError(err));
		} finally {
			setRemoving(false);
		}
	};

	// Il nuovo contesto va in `modelli.json`; poi si rileggono i modelli, così la chat usa subito la finestra nuova
	// (le IA locali spente dall'utente restano spente).
	const handleSetContext = (nome: string) => async (contesto: number): Promise<LocalModelContextResult> => {
		const res = await libraryService.setContext(readFolderRef.current, { nome, contesto });
		if (res.esito === 'fatto') refreshModelService.startRefreshingModels('voxLocal', { enableProviderOnSuccess: false, doNotFire: false });
		return res;
	};

	const handleCatalogDownload = async (id: string, source: 'catalogo' | 'installati' = 'catalogo') => {
		if (isDownloading || startingDownload) return;
		setActionError(null);
		setDismissedStatus(null);
		setStartingDownload(true);
		try {
			await libraryService.startDownload(readFolderRef.current, { tipo: 'catalogo', id });
		} catch (err) {
			setActionErrorSource(source);
			setActionError(describeError(err));
		} finally {
			setStartingDownload(false);
		}
	};

	const declaredForUrl = declared !== null && declared.url === url.trim() ? declared : null;

	const handleCustomSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (isDownloading || startingDownload) return;
		const validation = validateCustomModelForm({ url, nome, contestoText }, state.installati);
		if (!validation.ok) {
			setFieldErrors(validation.errors);
			return;
		}
		setFieldErrors({});
		setActionError(null);
		setDismissedStatus(null);
		setStartingDownload(true);
		try {
			// il modulo resta compilato finché lo scarico non finisce: dopo una pausa basta premere di nuovo «Scarica»
			submittedNameRef.current = validation.nome;
			await libraryService.startDownload(readFolderRef.current, {
				tipo: 'indirizzo',
				url: validation.url,
				nome: validation.nome,
				uso,
				contesto: validation.contesto,
				descrizione: descrizione.trim(),
				...(declaredForUrl ? { bytes: declaredForUrl.bytes, sha256: declaredForUrl.sha256 } : {}),
			});
		} catch (err) {
			setActionErrorSource('indirizzo');
			setActionError(describeError(err));
		} finally {
			setStartingDownload(false);
		}
	};

	const handleSearch = async (e: React.FormEvent) => {
		e.preventDefault();
		if (searching) return;
		setSearching(true);
		setSearchError(null);
		setOpenRepo(null);
		setRepoFiles(null);
		setRepoError(null);
		try {
			const res = await libraryService.searchModels(searchText);
			if (res.esito === 'fatto') setSearchResults(res.risultati);
			else if (res.esito === 'errore') { setSearchResults(null); setSearchError(res.messaggio); }
		} catch (err) {
			setSearchResults(null);
			setSearchError(describeError(err));
		} finally {
			setSearching(false);
		}
	};

	const handleOpenRepo = async (repo: string) => {
		if (openRepo === repo) { setOpenRepo(null); return; }
		setOpenRepo(repo);
		setRepoFiles(null);
		setRepoError(null);
		setLoadingRepo(true);
		try {
			const res = await libraryService.getRepoFiles(repo);
			// una risposta annullata è di un repository aperto prima: la sostituisce quella nuova
			if (res.esito === 'fatto') setRepoFiles(res.repository);
			else if (res.esito === 'errore') setRepoError(res.messaggio);
			if (res.esito !== 'annullato') setLoadingRepo(false);
		} catch (err) {
			setRepoError(describeError(err));
			setLoadingRepo(false);
		}
	};

	// Un file scelto dalla ricerca riempie il modulo «Altri modelli» (indirizzo alla revisione letta, nome, uso e
	// contesto proposti): lo scarico parte solo quando l'utente preme «Scarica» lì.
	const handleUseRepoFile = (repository: LocalModelRepoFiles, file: LocalModelRepoFile) => {
		const fileUrl = urlOfLocalModelRepoFile(repository.repo, repository.revisione, file.file);
		setUrl(fileUrl);
		setDeclared({ url: fileUrl, bytes: file.bytes, sha256: file.sha256 });
		setNome(suggestLocalModelName(file.file, state.installati));
		setUso(suggestLocalModelUse(repository.repo, file.file));
		setContestoText(String(suggestContext(repository.contestoMassimo)));
		setDescrizione(repository.repo);
		setFieldErrors({});
		setActionError(null);
		setCustomOpen(true);
		setTimeout(() => {
			customFormRef.current?.scrollIntoView({ block: 'center' });
			(document.getElementById(nameId) as HTMLInputElement | null)?.focus();
		}, 0);
	};

	const handleCancelDownload = async (tieniParziale: boolean) => {
		if (canceling) return;
		setActionError(null);
		setCanceling(true);
		try {
			await libraryService.cancelDownload(tieniParziale);
		} catch (err) {
			setActionErrorSource('scarico');
			setActionError(describeError(err));
		} finally {
			setCanceling(false);
			setConfirmCancel(false);
		}
	};

	const scarico = state.scarico;
	const percent = scarico.stato === 'scarico' || scarico.stato === 'controllo'
		? downloadPercent(scarico.ricevuti, scarico.totale)
		: null;
	const remaining = scarico.stato === 'scarico'
		? formatRemainingTime(scarico.ricevuti, scarico.totale, scarico.bytesAlSecondo)
		: null;
	// durante il controllo il file parziale è già tutto sul disco
	const partialBytes = scarico.stato === 'controllo' ? (scarico.totale ?? scarico.ricevuti) : scarico.stato === 'scarico' ? scarico.ricevuti : 0;
	const statusKey = scarico.stato === 'fermo' ? null : `${scarico.stato}:${scarico.nome}`;
	const statusVisible = statusKey !== null && statusKey !== dismissedStatus;
	// un errore di rimozione resta visibile anche se il modello nel frattempo è sparito dall'elenco
	const orphanRemoveError = removeError && !state.installati.some(m => m.nome === confirmRemove?.model.nome) ? removeError : null;
	const shownInstalled = state.installati.filter(m => matchesModelFilter(filter, [m.nome, m.descrizione, m.file, formatLocalModelUse(m.uso)]));
	// «Scarica un modello» elenca solo i consigliati che mancano: quelli installati stanno già in «Modelli installati»,
	// e quando ci sono tutti la sezione sparisce (torna da sola se se ne toglie uno).
	const missingCatalog = catalog.filter(entry => !isCatalogEntryInstalled(entry, state.installati));
	const shownCatalog = missingCatalog.filter(entry => matchesModelFilter(filter, [entry.nome, entry.descrizione, entry.file, formatLocalModelUse(entry.uso)]));
	const actionErrorBox = (source: typeof actionErrorSource) => actionError && actionErrorSource === source
		? <div role="alert" className="text-xs text-vox-danger">{actionError}</div>
		: null;

	// Avanzamento ed esito dello scarico: si vedono anche quando la cartella non si trova più (cambiata nelle Impostazioni,
	// tolta, su un disco staccato), così uno scarico partito si può sempre mettere in pausa o annullare.
	const downloadSection = (
		<>
			{/* 5. Avanzamento */}
			{scarico.stato === 'scarico' || scarico.stato === 'controllo' ? (
				<section className="border border-vox-hairline bg-vox-surface rounded-vox-lg p-2.5 space-y-2 text-xs">
					<div className="flex items-center justify-between gap-2 min-w-0">
						<span className="font-medium text-vox-fg-1 break-all">{scarico.stato === 'controllo' ? t("Checking {0}", scarico.nome) : t("Downloading {0}", scarico.nome)}</span>
						<span className="font-mono text-vox-fg-3 truncate min-w-0">{scarico.file}</span>
					</div>

					<div
						role="progressbar"
						aria-label={scarico.stato === 'controllo' ? t("Checking {0}", scarico.nome) : t("Downloading {0}", scarico.nome)}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent !== null ? percent : undefined}
						className="w-full h-1.5 bg-vox-hairline rounded-full overflow-hidden"
					>
						<div
							className={`h-full rounded-full bg-vox-accent transition-all duration-150 ${percent === null ? 'w-1/3 motion-safe:animate-pulse' : ''}`}
							style={percent !== null ? { width: `${percent}%` } : undefined}
						/>
					</div>

					<div className="flex flex-wrap items-center justify-between gap-2 text-vox-fg-3">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span>
								{scarico.totale !== null
									? `${formatGigabytes(scarico.ricevuti)} / ${formatGigabytes(scarico.totale)}`
									: formatGigabytes(scarico.ricevuti)}
							</span>
							{percent !== null ? <span>{`${percent}%`}</span> : null}
							{scarico.stato === 'controllo' ? (
								<span className="text-vox-fg-1">{t("Checking file…")}</span>
							) : (
								<>
									<span>{formatSpeedMBps(scarico.bytesAlSecondo)}</span>
									{remaining ? <span>{t("Remaining: {0}", remaining)}</span> : null}
								</>
							)}
						</div>

						{confirmCancel ? null : scarico.stato === 'controllo' && scarico.giaPresente ? (
							<button type="button" disabled={canceling} className={secondaryButtonClass} onClick={() => handleCancelDownload(true)}>
								{t("Stop checking")}
							</button>
						) : (
							<div className="flex items-center gap-2">
								<button
									type="button"
									disabled={canceling}
									className={secondaryButtonClass}
									onClick={() => handleCancelDownload(true)}
								>
									{t("Pause")}
								</button>
								<button
									type="button"
									disabled={canceling}
									className={secondaryButtonClass}
									onClick={() => setConfirmCancel(true)}
								>
									{t("Cancel")}
								</button>
							</div>
						)}
					</div>

					{confirmCancel ? (
						<div role="alertdialog" aria-labelledby={`${baseId}-cancel-title`} className="border-t border-vox-hairline pt-2 space-y-1.5">
							<div id={`${baseId}-cancel-title`} className="text-vox-warning font-medium">
								{t("Cancel the download of {0}? The {1} already downloaded will be deleted. To stop and resume later, use Pause.", scarico.nome, formatGigabytes(partialBytes))}
							</div>
							<div className="flex items-center justify-between gap-2">
								<button ref={keepDownloadingRef} type="button" disabled={canceling} className={secondaryButtonClass} onClick={() => setConfirmCancel(false)}>
									{t("Keep downloading")}
								</button>
								<button type="button" disabled={canceling} className={dangerButtonClass} onClick={() => handleCancelDownload(false)}>
									{t("Discard the download")}
								</button>
							</div>
						</div>
					) : null}
					{actionErrorBox('scarico')}
				</section>
			) : null}

			{statusVisible && (scarico.stato === 'errore' || scarico.stato === 'annullato' || scarico.stato === 'finito') ? (
				<div
					role={scarico.stato === 'errore' ? 'alert' : 'status'}
					className={`rounded-vox-lg p-2.5 flex items-start justify-between gap-2 text-xs ${scarico.stato === 'errore' ? 'border border-vox-danger-border bg-vox-danger-soft text-vox-danger' : 'border border-vox-hairline bg-vox-surface text-vox-fg-3'}`}
				>
					<span className="min-w-0 break-words">
						{scarico.stato === 'errore' ? t("Download failed for {0}: {1}", scarico.nome, scarico.messaggio)
							: scarico.stato === 'finito' ? t("Downloaded {0}.", scarico.nome)
								: scarico.parziale ? t("Download of {0} paused. Download it again to resume from where it stopped.", scarico.nome)
									: t("Download of {0} canceled.", scarico.nome)}
					</span>
					<button type="button" className={secondaryButtonClass} onClick={() => setDismissedStatus(statusKey)}>
						{t("Close")}
					</button>
				</div>
			) : null}
			{scarico.stato !== 'scarico' && scarico.stato !== 'controllo' ? actionErrorBox('scarico') : null}
		</>
	);

	// Senza cartella le Impostazioni spiegano qui sotto come crearla. La libreria mostra un blocco solo: l'errore di lettura,
	// una riga che dice com'è andato il rilevamento (o lo scarico in corso, che può fallire), e i pulsanti per cercare ancora.
	if (state.cartella === null) {
		// l'esito dell'ultimo «Controlla di nuovo» è il più recente: prende il posto della riga del rilevamento, che direbbe
		// quasi la stessa cosa
		const missedLine = recheckMissed && !rechecking
			? <div role="status" className="text-xs text-vox-fg-3">{t("Still not found: check that the folder exists and has modelli.json inside, then try again.")}</div>
			: null;
		return (
			<div className="px-3 py-2 space-y-4 text-sm">
				{state.errore ? <div role="alert" className="text-xs text-vox-danger">{state.errore}</div> : null}
				{loadError ? <div role="alert" className="text-xs text-vox-danger">{loadError}</div> : null}
				<div className="space-y-2">
					{isDownloading
						? <>
							<div role="status" className="text-xs text-vox-warning">{t("The local AI folder is not found right now: the download in progress may fail. You can still pause or cancel it here.")}</div>
							{missedLine ?? (detectionText ? detectionLine : null)}
						</>
						: missedLine ?? detectionLine ?? <div role="status" className="text-xs text-vox-fg-3">{t("The model library will appear here when the local AI folder is ready.")}</div>}
					{recheckRow(true, true)}
				</div>
				{downloadSection}
			</div>
		);
	}
	const cartella = state.cartella;

	return (
		<div className="px-3 py-2 space-y-4 text-sm">
			{/* 1. Cartella e spazio */}
			<div className="border border-vox-hairline bg-vox-surface rounded-vox-lg p-2.5 space-y-1 text-xs">
				<div className="flex flex-wrap items-baseline gap-x-2">
					<span className="text-vox-fg-3">{t("Folder:")}</span>
					<span className="font-mono text-vox-fg-1 select-text break-all">{cartella}</span>
				</div>
				<div className="flex flex-wrap items-baseline gap-x-2">
					<span className="text-vox-fg-3">{t("Free space:")}</span>
					<span className="text-vox-fg-1">
						{state.liberi !== null ? formatGigabytes(state.liberi) : t("unavailable")}
					</span>
				</div>
				{state.errore ? <div role="alert" className="text-vox-danger pt-1">{state.errore}</div> : null}
				{loadError ? <div role="alert" className="text-vox-danger pt-1">{loadError}</div> : null}
				{detectionText ? <div className="pt-1">{detectionLine}</div> : null}
				{/* cartella trovata ma illeggibile (per esempio modelli.json non valido), o rilevamento della chat fallito:
				    dopo averla sistemata si rilegge da qui (anche la chat). Il pulsante resta mentre si rilegge, così non perde il fuoco */}
				{state.errore || loadError || detectionText || rechecking ? <div className="pt-1">{recheckRow(true, false)}</div> : null}
			</div>

			{/* Filtro dell'elenco: installati e consigliati */}
			<div className="text-xs">
				<label htmlFor={filterId} className="block text-vox-fg-3 mb-1">{t("Filter the models in this list")}</label>
				<VoxSimpleInputBox
					id={filterId}
					compact={true}
					value={filter}
					onChangeValue={setFilter}
					placeholder={t("Name, description or use")}
				/>
			</div>

			{/* 2. Modelli installati */}
			<section className="space-y-2">
				<h4 className="text-sm font-medium text-vox-fg-1">{t("Installed models")}</h4>
				{orphanRemoveError ? <div role="alert" className="text-xs text-vox-danger">{orphanRemoveError}</div> : null}
				{actionErrorBox('installati')}
				{state.installati.length === 0 ? (
					<div className="text-xs text-vox-fg-3">{t("No local models installed yet.")}</div>
				) : shownInstalled.length === 0 ? (
					<div role="status" className="text-xs text-vox-fg-3">{t("No installed model matches the filter.")}</div>
				) : (
					<div className="space-y-2">
						{shownInstalled.map((model, index) => {
							const isConfirming = confirmRemove?.model.nome === model.nome;
							const usedInFeatures = isConfirming
								? featuresUsingLocalModel(model.nome, voxSettingsState.modelSelectionOfFeature, featureNames).map(displayInfoOfFeatureName)
								: [];
							// voce dell'elenco consigliato rimasta senza file: si riscarica solo il file, la voce resta com'è
							const redownloadEntry = catalogEntryForMissingModel(model, catalog);
							// il processo principale rifiuta la rimozione di un modello in scarico: pulsante spento, e si dice perché
							const inDownload = isModelInDownload(model, state.scarico);
							const inDownloadId = `${baseId}-in-download-${index}`;

							return (
								<div key={model.nome} className="border border-vox-hairline bg-vox-surface rounded-vox-lg p-2.5 space-y-2">
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0 space-y-0.5">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium text-vox-fg-1 break-all">{model.nome}</span>
												<span className="@@vox-chip">
													{formatLocalModelUse(model.uso)}
												</span>
												<span className={`text-xs ${model.bytes === null ? 'text-vox-warning' : 'text-vox-fg-3'}`}>
													{model.bytes !== null ? formatGigabytes(model.bytes) : t("missing file")}
												</span>
												{model.acceso ? (
													<span className="inline-flex items-center gap-1 text-xs text-vox-success">
														<span aria-hidden="true" className="size-1.5 rounded-full bg-vox-success" />
														{t("running")}
													</span>
												) : null}
											</div>
											{model.descrizione ? (
												<div className="text-xs text-vox-fg-3">{model.descrizione}</div>
											) : null}
										</div>
										<div className="flex items-center gap-2 shrink-0">
											{redownloadEntry ? (
												<button
													type="button"
													disabled={isDownloading || startingDownload || removing || isConfirming || model.acceso}
													aria-label={t("Download {0} again", model.nome)}
													className={primaryButtonClass}
													onClick={() => handleCatalogDownload(redownloadEntry.id, 'installati')}
												>
													{t("Download again")}
												</button>
											) : null}
											<button
												type="button"
												disabled={removing || inDownload}
												aria-describedby={inDownload ? inDownloadId : undefined}
												aria-label={t("Delete {0}", model.nome)}
												className={secondaryButtonClass}
												onClick={() => {
													setRemoveError(null);
													setConfirmRemove({ model, step: 'trash' });
												}}
											>
												{t("Delete")}
											</button>
										</div>
									</div>
									{redownloadEntry ? (
										<div className="text-xs text-vox-fg-3">
											{t("The model file is missing from the models folder. Download again gets only the file ({0}) and keeps this entry with its settings.", formatGigabytes(redownloadEntry.bytes))}
											{mayNotFitOnDisk(redownloadEntry.bytes, state.liberi) ? <span className="block text-vox-warning">{t("Free space may not be enough (needs {0} plus 512 MB kept free). Vox checks again when the download starts.", formatGigabytes(redownloadEntry.bytes))}</span> : null}
											{/* acceso: il processo principale rifiuterebbe il riscarico, quindi il pulsante è spento e si dice perché */}
											{model.acceso ? <span className="block text-vox-warning">{t("The model {0} is running without its file: close and reopen Vox, then try again.", model.nome)}</span> : null}
										</div>
									) : null}
									{inDownload ? <div id={inDownloadId} className="text-xs text-vox-fg-3">{t("This model is being downloaded or checked: stop it first.")}</div> : null}

									<ModelContextControl
										model={model}
										disabled={removing || isConfirming}
										onSave={handleSetContext(model.nome)}
									/>

									{isConfirming && confirmRemove && confirmRemove.step === 'trash' ? (
										<div key="cestino" className="border-t border-vox-hairline pt-2 space-y-1.5 text-xs">
											<div className="font-medium text-vox-fg-1">{t("Delete {0}?", model.nome)}</div>
											{model.condivisoCon.length === 0 && model.bytes !== null ? (
												<div className="text-vox-fg-3">{t("Frees {0} on disk.", formatGigabytes(model.bytes))}</div>
											) : null}
											{model.acceso ? (
												<div className="text-vox-warning">{t("This model is currently running and will be stopped.")}</div>
											) : null}
											{usedInFeatures.length > 0 ? (
												<div className="text-vox-warning">
													{t("Used by: {0}. Those features will switch to another local model or have no model selected.", usedInFeatures.join(', '))}
												</div>
											) : null}
											{model.condivisoCon.length > 0 ? (
												<div className="text-vox-fg-3">
													{t("The file is also used by {0}: only this entry will be removed.", model.condivisoCon.join(', '))}
												</div>
											) : null}
											{removeError ? <div role="alert" className="text-vox-danger">{removeError}</div> : null}

											<div className="flex items-center gap-2 pt-1">
												<button
													type="button"
													disabled={removing}
													className={secondaryButtonClass}
													onClick={() => {
														setConfirmRemove(null);
														setRemoveError(null);
													}}
												>
													{t("Cancel")}
												</button>
												<button
													type="button"
													disabled={removing || inDownload}
													aria-describedby={inDownload ? inDownloadId : undefined}
													className={dangerButtonClass}
													onClick={() => handleConfirmRemove(false)}
												>
													{model.condivisoCon.length === 0 && model.bytes !== null ? t("Move to Recycle Bin") : t("Confirm")}
												</button>
											</div>
										</div>
									) : null}

									{isConfirming && confirmRemove && confirmRemove.step === 'permanent' ? (
										<div
											key="definitiva"
											role="alertdialog"
											aria-labelledby={`${baseId}-permanent-title`}
											aria-describedby={`${baseId}-permanent-desc`}
											className="border-t border-vox-danger-border pt-2 space-y-1.5 text-xs"
										>
											<div id={`${baseId}-permanent-title`} className="text-vox-danger font-medium">
												{t("Delete {0} permanently? This cannot be undone.", model.nome)}
											</div>
											<div id={`${baseId}-permanent-desc`} className="text-vox-fg-3">
												{t("The file was not moved to the Recycle Bin: this drive has no Recycle Bin, or another program is using the file. Nothing has been deleted yet.")}
												{confirmRemove.model.acceso ? ` ${t("The model has already been stopped.")}` : ''}
											</div>

											{removeError ? <div role="alert" className="text-vox-danger">{removeError}</div> : null}

											<div className="flex items-center justify-between gap-2 pt-1">
												<button
													ref={keepFileRef}
													type="button"
													disabled={removing}
													className={secondaryButtonClass}
													onClick={() => {
														setConfirmRemove(null);
														setRemoveError(null);
													}}
												>
													{t("Keep the file")}
												</button>
												<button
													type="button"
													disabled={removing || inDownload || !permanentArmed}
													aria-describedby={inDownload ? inDownloadId : undefined}
													className={dangerButtonClass}
													onClick={() => handleConfirmRemove(true)}
												>
													{t("Delete permanently")}
												</button>
											</div>
										</div>
									) : null}
								</div>
							);
						})}
					</div>
				)}
			</section>

			{/* 3. Scarica un modello */}
			{catalogError ? <div role="alert" className="text-xs text-vox-danger">{catalogError}</div> : null}
			{actionErrorBox('catalogo')}
			{missingCatalog.length > 0 ? (
				<section className="space-y-2">
					<h4 className="text-sm font-medium text-vox-fg-1">{t("Download a model")}</h4>
					{shownCatalog.length === 0 ? <div role="status" className="text-xs text-vox-fg-3">{t("No recommended model matches the filter.")}</div> : null}
					<div className="space-y-2">
						{shownCatalog.map(entry => {
							const notEnoughSpace = mayNotFitOnDisk(entry.bytes, state.liberi);

							return (
								<div key={entry.id} className="border border-vox-hairline bg-vox-surface rounded-vox-lg p-2.5 flex items-start justify-between gap-3">
									<div className="min-w-0 space-y-0.5">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium text-vox-fg-1 break-all">{entry.nome}</span>
											<span className="@@vox-chip">
												{formatLocalModelUse(entry.uso)}
											</span>
											<span className="text-xs text-vox-fg-3">{formatGigabytes(entry.bytes)}</span>
										</div>
										{entry.descrizione ? (
											<div className="text-xs text-vox-fg-3">{entry.descrizione}</div>
										) : null}
										{notEnoughSpace ? (
											<div className="text-xs text-vox-warning">
												{t("Free space may not be enough (needs {0} plus 512 MB kept free). Vox checks again when the download starts.", formatGigabytes(entry.bytes))}
											</div>
										) : null}
									</div>
									<button
										type="button"
										disabled={isDownloading || startingDownload}
										aria-label={t("Download {0}", entry.nome)}
										className={primaryButtonClass}
										onClick={() => handleCatalogDownload(entry.id)}
									>
										{t("Download")}
									</button>
								</div>
							);
						})}
					</div>
				</section>
			) : null}

			{/* Ricerca su Hugging Face */}
			<section className="space-y-2">
				<h4 className="text-sm font-medium text-vox-fg-1">{t("Search on Hugging Face")}</h4>
				<form className="flex flex-wrap items-end gap-2 text-xs" onSubmit={handleSearch} noValidate>
					<div className="flex-1 min-w-[12rem]">
						<label htmlFor={searchId} className="block text-vox-fg-3 mb-1">{t("Model to search for")}</label>
						<VoxSimpleInputBox
							id={searchId}
							compact={true}
							value={searchText}
							onChangeValue={val => { setSearchText(val); if (searchError) setSearchError(null); }}
							placeholder="qwen2.5-7b"
						/>
					</div>
					<button type="submit" disabled={searching || searchText.trim().length < 2} className={primaryButtonClass}>
						{searching ? t("Searching…") : t("Search")}
					</button>
				</form>
				<div className="text-xs text-vox-fg-3">{t("The search sends only the text you write here to huggingface.co: never your chats, code or settings.")}</div>
				{searchError ? <div role="alert" className="text-xs text-vox-danger">{searchError}</div> : null}
				{searchResults !== null && searchResults.length === 0 ? <div role="status" className="text-xs text-vox-fg-3">{t("No model found. Try fewer or different words.")}</div> : null}
				{searchResults !== null && searchResults.length > 0 ? (
					<div className="space-y-2">
						{searchResults.map(result => {
							const isOpen = openRepo === result.repo;
							return (
								<div key={result.repo} className="border border-vox-hairline bg-vox-surface rounded-vox-lg p-2.5 space-y-2">
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0 space-y-0.5">
											<div className="font-medium text-vox-fg-1 break-all select-text">{result.repo}</div>
											<div className="text-xs text-vox-fg-3">{t("{0} downloads · {1} likes", formatCount(result.scaricamenti), formatCount(result.preferenze))}</div>
										</div>
										<button type="button" aria-expanded={isOpen} aria-label={t("Show the files of {0}", result.repo)} className={secondaryButtonClass} onClick={() => handleOpenRepo(result.repo)}>
											{isOpen ? t("Hide files") : t("Show files")}
										</button>
									</div>
									{isOpen ? (
										<div className="border-t border-vox-hairline pt-2 space-y-1.5 text-xs">
											{loadingRepo ? <div role="status" className="text-vox-fg-3">{t("Reading the files…")}</div> : null}
											{repoError ? <div role="alert" className="text-vox-danger">{repoError}</div> : null}
											{repoFiles && repoFiles.repo === result.repo ? (
												repoFiles.file.length === 0 ? (
													<div role="status" className="text-vox-fg-3">{t("This repository has no single .gguf file that Vox can use.")}</div>
												) : (
													<>
														{repoFiles.contestoMassimo !== null ? <div className="text-vox-fg-3">{t("Context declared by the model: {0} tokens", formatContextTokens(repoFiles.contestoMassimo))}</div> : null}
														{repoFiles.file.map(item => {
															const present = state.installati.some(m => m.file.toLowerCase() === item.file.toLowerCase());
															return (
																<div key={item.file} className="flex items-center justify-between gap-3">
																	<div className="min-w-0">
																		<span className="font-mono text-vox-fg-1 break-all select-text">{item.file}</span>
																		<span className={`ml-2 whitespace-nowrap ${mayNotFitOnDisk(item.bytes, state.liberi) ? 'text-vox-warning' : 'text-vox-fg-3'}`}>{formatGigabytes(item.bytes)}</span>
																	</div>
																	{present ? (
																		<span className="text-vox-fg-3 whitespace-nowrap">{t("Already installed")}</span>
																	) : (
																		<button type="button" aria-label={t("Use {0}", item.file)} className={secondaryButtonClass} onClick={() => handleUseRepoFile(repoFiles, item)}>
																			{t("Use this file")}
																		</button>
																	)}
																</div>
															);
														})}
														<div className="text-vox-fg-3">{t("Larger files answer better but need more video card memory. Choosing a file fills the form below: check name, use and context, then press Download.")}</div>
													</>
												)
											) : null}
										</div>
									) : null}
								</div>
							);
						})}
					</div>
				) : null}
			</section>

			{/* 4. Altri modelli (chiuso all'inizio) */}
			<details ref={customFormRef} open={customOpen} onToggle={e => setCustomOpen((e.currentTarget as HTMLDetailsElement).open)} className="border border-vox-hairline bg-vox-surface rounded-vox-lg p-2.5">
				<summary className="cursor-pointer text-sm font-medium text-vox-fg-1">{t("Other models")}</summary>
				<form className="mt-3 space-y-2.5 text-xs" onSubmit={handleCustomSubmit} noValidate>
					<div>
						<label htmlFor={urlId} className="block text-vox-fg-3 mb-1">{t("Hugging Face .gguf URL")}</label>
						<VoxSimpleInputBox
							id={urlId}
							compact={true}
							value={url}
							onChangeValue={val => {
								setUrl(val);
								if (fieldErrors.url) setFieldErrors(prev => ({ ...prev, url: undefined }));
							}}
							placeholder="https://huggingface.co/.../model.gguf"
							aria-invalid={fieldErrors.url ? true : undefined}
							aria-describedby={fieldErrors.url ? urlErrId : undefined}
						/>
						{fieldErrors.url ? <div id={urlErrId} role="alert" className="text-vox-danger mt-1">{fieldErrors.url}</div> : null}
						{declaredForUrl ? (
							<div className="text-vox-fg-3 mt-1">
								{declaredForUrl.sha256 !== null
									? t("After the download Vox checks the size and the SHA-256 declared by Hugging Face.")
									: t("Hugging Face declares no SHA-256 for this file: after the download Vox checks only the size.")}
							</div>
						) : null}
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
						<div>
							<label htmlFor={nameId} className="block text-vox-fg-3 mb-1">{t("Model name")}</label>
							<VoxSimpleInputBox
								id={nameId}
								compact={true}
								value={nome}
								onChangeValue={val => {
									setNome(val);
									if (fieldErrors.nome) setFieldErrors(prev => ({ ...prev, nome: undefined }));
								}}
								placeholder="qwen2.5-7b"
								aria-invalid={fieldErrors.nome ? true : undefined}
								aria-describedby={fieldErrors.nome ? nameErrId : undefined}
							/>
							{fieldErrors.nome ? <div id={nameErrId} role="alert" className="text-vox-danger mt-1">{fieldErrors.nome}</div> : null}
						</div>

						<div>
							<div className="text-vox-fg-3 mb-1">{t("Use")}</div>
							<VoxCustomDropdownBox
								options={LOCAL_MODEL_USES}
								selectedOption={uso}
								onChangeOption={setUso}
								getOptionDisplayName={formatLocalModelUse}
								getOptionDropdownName={formatLocalModelUse}
								getOptionsEqual={(a, b) => a === b}
								ariaLabel={t("Use")}
								arrowTouchesText={false}
								className="w-full bg-vox-bg-1 text-vox-fg-1 border border-vox-hairline-strong focus-within:border-vox-accent py-1 px-2 rounded-vox-md transition-colors"
							/>
						</div>

						<div>
							<label htmlFor={contextId} className="block text-vox-fg-3 mb-1">{t("Context window")}</label>
							<VoxSimpleInputBox
								id={contextId}
								compact={true}
								inputMode="numeric"
								value={contestoText}
								onChangeValue={val => {
									setContestoText(val);
									if (fieldErrors.contesto) setFieldErrors(prev => ({ ...prev, contesto: undefined }));
								}}
								placeholder={DEFAULT_CONTEXT}
								aria-invalid={fieldErrors.contesto ? true : undefined}
								aria-describedby={fieldErrors.contesto ? contextErrId : undefined}
							/>
							{fieldErrors.contesto ? <div id={contextErrId} role="alert" className="text-vox-danger mt-1">{fieldErrors.contesto}</div> : null}
						</div>
					</div>

					<div>
						<label htmlFor={descId} className="block text-vox-fg-3 mb-1">{t("Description (optional)")}</label>
						<VoxSimpleInputBox
							id={descId}
							compact={true}
							value={descrizione}
							onChangeValue={setDescrizione}
							placeholder={t("Short description")}
						/>
					</div>

					<div className="pt-1">
						<button type="submit" disabled={isDownloading || startingDownload} className={primaryButtonClass}>
							{t("Download")}
						</button>
					</div>
					{actionErrorBox('indirizzo')}
				</form>
			</details>

			{downloadSection}
		</div>
	);
};
