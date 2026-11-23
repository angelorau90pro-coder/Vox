// Scrittura dei file che Vox porta con sé nella cartella `ia-locali` (per esempio il modello di conversazione di
// `qwen3.5-9b`), separata dal servizio così i test la provano su una cartella vera, senza Electron.
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

type FileOps = { mkdir: typeof mkdir, open: typeof open, unlink: typeof unlink };

// Crea il file, e le cartelle che mancano, solo se non c'è. 'wx' è una creazione esclusiva: un file già presente
// (anche creato un attimo prima da altri) non si scrive mai. Una cartella con quel nome resta com'è: il controllo che
// segue nel nucleo (`sizeOf`, che vale solo per i file) la tratta come un file che manca.
// Se la scrittura si ferma a metà (disco pieno, chiavetta tolta) il file l'ha creato Vox e si toglie: un file troncato
// resterebbe per sempre, perché un file presente non si sovrascrive. Se fallisce già l'apertura non si toglie niente.
export async function createLocalModelFileIfMissing(file: string, content: string, ops: FileOps = { mkdir, open, unlink }): Promise<void> {
	await ops.mkdir(dirname(file), { recursive: true });
	let handle: Awaited<ReturnType<typeof open>>;
	try { handle = await ops.open(file, 'wx') }
	catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return; throw error }
	try {
		await handle.writeFile(content, 'utf8');
		await handle.close();
	} catch (error) {
		try { await handle.close() } catch { /* già chiuso o non chiudibile: conta togliere il file */ }
		try { await ops.unlink(file) } catch { /* resta l'errore di scrittura, che è quello da mostrare */ }
		throw error;
	}
}
