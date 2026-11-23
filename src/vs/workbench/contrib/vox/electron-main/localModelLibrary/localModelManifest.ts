import { access, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSameLocalModelFile } from '../../common/localModelLibraryTypes.js';
import type { InstalledLocalModel, LocalModelUse } from '../../common/localModelLibraryTypes.js';
import { t } from '../../common/voxI18n.js';
import { invalidateLocalModelsManifestCache, validateLocalModelManifest } from '../llmMessage/localModels.js';

type ManifestRuntime = Partial<{ access: typeof access, readFile: typeof readFile, rename: typeof rename, rm: typeof rm, stat: typeof stat, writeFile: typeof writeFile, setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, platform: string, readTimeout: number, renameDelay: (ms: number) => Promise<void> }>;
type NewLocalModel = { nome: string, descrizione: string, file: string, contesto: number, porta: number, uso: LocalModelUse, opzioni?: string[] };
const runtime: Required<ManifestRuntime> = { access, readFile, rename, rm, stat, writeFile, setTimeout, clearTimeout, platform: process.platform, readTimeout: 10000, renameDelay: ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)) };
const queues = new Map<string, Promise<unknown>>();

async function serialized<T>(folder: string, work: () => Promise<T>): Promise<T> {
	const key = resolve(folder), previous = queues.get(key) ?? Promise.resolve();
	let unlock!: () => void;
	const current = new Promise<void>(resolveUnlock => unlock = resolveUnlock);
	const queued = previous.then(() => current);
	queues.set(key, queued);
	await previous.catch(() => { });
	try { return await work() }
	finally { unlock(); if (queues.get(key) === queued) queues.delete(key) }
}

async function loadRaw(folder: string, rt: Required<ManifestRuntime>): Promise<{ raw: any, models: ReturnType<typeof validateLocalModelManifest>['modelli'] }> {
	const file = join(resolve(folder), 'modelli.json');
	let raw: any;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const pending = rt.readFile(file, 'utf8');
		void pending.catch(() => { });
		const text = await Promise.race([pending, new Promise<never>((_, reject) => {
			timer = rt.setTimeout(() => reject(Object.assign(new Error(t('Timed out while reading local model manifest: {0}', file)), { name: 'TimeoutError' })), rt.readTimeout);
		})]);
		raw = JSON.parse(String(text));
	}
	catch (error) {
		const cause = error instanceof SyntaxError ? error.message : (error as NodeJS.ErrnoException)?.code ?? String(error);
		if (error instanceof Error && error.name === 'TimeoutError') throw error;
		throw new Error(t('Unable to read local model manifest: {0} ({1})', file, cause));
	} finally { if (timer !== undefined) rt.clearTimeout(timer) }
	return { raw, models: validateLocalModelManifest(raw, folder).modelli };
}

async function writeRaw(folder: string, raw: any, rt: Required<ManifestRuntime>): Promise<void> {
	// Temporaneo con un nome solo suo, creato in modo esclusivo ('wx'): prima era sempre `modelli.json.nuovo` e un
	// file dell'utente con quel nome veniva sovrascritto e poi tolto.
	const file = join(resolve(folder), 'modelli.json');
	const temporary = `${file}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.nuovo`;
	let ours = true;
	try {
		try { await rt.writeFile(temporary, `${JSON.stringify(raw, null, '\t')}\n`, { encoding: 'utf8', flag: 'wx' }) }
		catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') ours = false; throw error }
		for (let attempt = 0; ; attempt++) {
			try { await rt.rename(temporary, file); break }
			catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				if (rt.platform !== 'win32' || attempt >= 2 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw new Error(t('Unable to update local model manifest: {0} ({1})', file, code ?? String(error)));
				await rt.renameDelay(40);
			}
		}
		invalidateLocalModelsManifestCache(folder);
	} catch (error) {
		// si toglie solo il temporaneo creato da questa chiamata
		if (ours) await rt.rm(temporary, { force: true }).catch(() => { });
		throw error;
	}
}

function withRuntime(rt?: ManifestRuntime): Required<ManifestRuntime> { return { ...runtime, ...rt } }

export async function listInstalledLocalModels(folder: string, isRunning: (nome: string) => boolean, rt?: ManifestRuntime): Promise<InstalledLocalModel[]> {
	const fs = withRuntime(rt), { models } = await loadRaw(folder, fs);
	return Promise.all(models.map(async model => {
		let bytes: number | null = null;
		try { bytes = (await fs.stat(join(resolve(folder), 'modelli', model.file))).size }
		catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && (error as NodeJS.ErrnoException)?.code !== 'ENOTDIR') throw error }
		return { nome: model.nome, descrizione: model.descrizione, uso: model.uso, file: model.file, contesto: model.contesto, bytes, acceso: isRunning(model.nome), condivisoCon: models.filter(other => other.nome !== model.nome && isSameLocalModelFile(other.file, model.file)).map(other => other.nome) };
	}));
}

export async function addLocalModelToManifest(folder: string, entry: NewLocalModel, rt?: ManifestRuntime): Promise<void> {
	const fs = withRuntime(rt);
	await serialized(folder, async () => {
		const { raw } = await loadRaw(folder, fs);
		// su Windows `avvia/<nome>.log` è lo stesso file per «Qwen» e «qwen»: i nomi si confrontano senza maiuscole
		if (raw.modelli.some((model: any) => typeof model?.nome === 'string' && model.nome.toLowerCase() === entry.nome.toLowerCase())) throw new Error(t('Local model {0} is already in the manifest.', entry.nome));
		const saved = { nome: entry.nome, descrizione: entry.descrizione, file: entry.file, contesto: entry.contesto, porta: entry.porta, uso: entry.uso, opzioni: entry.opzioni ?? [] };
		validateLocalModelManifest({ ...raw, modelli: [...raw.modelli, saved] }, folder);
		for (const option of saved.opzioni) {
			// Ogni opzione è un argomento a sé, senza shell: se comincia con `{cartella}` il resto è tutto il percorso, spazi compresi.
			for (const match of option.startsWith('{cartella}') && option.lastIndexOf('{cartella}') === 0 ? [[option, option.slice('{cartella}'.length)]] : option.matchAll(/\{cartella\}(\/?[^\s"']+)/g)) {
				const path = resolve(folder, match[1].replace(/^[/\\]/, ''));
				const rel = relative(resolve(folder), path);
				if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(t('Local model option path is outside its folder: {0}', path));
				try { await fs.access(path) } catch (error) {
					if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw new Error(t('Local model option file not found: {0}', path));
					throw error;
				}
			}
		}
		raw.modelli.push(saved);
		await writeRaw(folder, raw, fs);
	});
}

// Cambia il contesto (token) di un modello. Il resto della voce e del file resta com'è, anche i campi che Vox non
// conosce. Un modello acceso con il contesto vecchio non si tocca qui: la sua firma non coincide più col manifesto,
// quindi `LocalModelManager` lo chiude appena è libero e la richiesta successiva lo riavvia con il valore nuovo.
// Restituisce il contesto che c'era prima.
export async function setLocalModelContextInManifest(folder: string, nome: string, contesto: number, rt?: ManifestRuntime): Promise<{ prima: number }> {
	const fs = withRuntime(rt);
	return serialized(folder, async () => {
		const { raw } = await loadRaw(folder, fs), index = raw.modelli.findIndex((model: any) => model?.nome === nome);
		if (index < 0) throw new Error(t('Local model {0} was not found in the manifest.', nome));
		const prima = raw.modelli[index].contesto;
		if (prima === contesto) return { prima };
		const modelli = raw.modelli.map((model: any, i: number) => i === index ? { ...model, contesto } : model);
		// stesso controllo della lettura: un valore fuori dai limiti non arriva mai sul disco
		validateLocalModelManifest({ ...raw, modelli }, folder);
		raw.modelli = modelli;
		await writeRaw(folder, raw, fs);
		return { prima };
	});
}

export async function removeLocalModelFromManifest(folder: string, nome: string, rt?: ManifestRuntime): Promise<{ file: string, condivisoCon: string[] }> {
	const fs = withRuntime(rt);
	return serialized(folder, async () => {
		const { raw } = await loadRaw(folder, fs), index = raw.modelli.findIndex((model: any) => model?.nome === nome);
		if (index < 0) throw new Error(t('Local model {0} was not found in the manifest.', nome));
		const [removed] = raw.modelli.splice(index, 1);
		const condivisoCon = raw.modelli.filter((model: any) => typeof model?.file === 'string' && isSameLocalModelFile(model.file, removed.file)).map((model: any) => model.nome);
		await writeRaw(folder, raw, fs);
		return { file: removed.file, condivisoCon };
	});
}
