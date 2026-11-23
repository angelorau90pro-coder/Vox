import { Disposable, IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { Schemas } from '../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';

type VoxModelType = {
	model: ITextModel | null;
	editorModel: IResolvedTextEditorModel | null;
};

export interface IVoxModelService {
	readonly _serviceBrand: undefined;
	// restituisce il motivo se il file non si apre (file binario, permessi…), altrimenti undefined
	initializeModel(uri: URI): Promise<string | undefined>;
	getModel(uri: URI): VoxModelType;
	getModelFromFsPath(fsPath: string): VoxModelType;
	getModelSafe(uri: URI): Promise<VoxModelType>;
	// true se il file risulta salvato; false se il salvataggio non è avvenuto (file in sola lettura, modello non trovato, errore)
	saveModel(uri: URI, options?: { force?: boolean }): Promise<boolean>;

}

export const IVoxModelService = createDecorator<IVoxModelService>('voxModelService');

class VoxModelService extends Disposable implements IVoxModelService {
	_serviceBrand: undefined;
	static readonly ID = 'voxModelService';
	private readonly _modelRefOfURI: Record<string, IReference<IResolvedTextEditorModel>> = {};

	constructor(
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
	) {
		super();
	}

	saveModel = async (uri: URI, options?: { force?: boolean }) => {
		const saved = await this._textFileService.save(uri, { // we want [our change] -> [save] so it's all treated as one change.
			force: options?.force, // anche senza modifiche: serve a riscrivere un file cancellato dal disco
			skipSaveParticipants: true // avoid triggering extensions etc (if they reformat the page, it will add another item to the undo stack)
		})
		return saved !== undefined
	}

	// I riferimenti stanno per percorso del disco, ma con lo stesso percorso ci possono essere modelli diversi: il lato git
	// di un confronto, le celle di un notebook. Il file del progetto (sul disco locale o su quello remoto) prende il posto
	// di uno di quelli (che altrimenti, tenuto vivo da questo riferimento, lo occuperebbe fino alla chiusura della
	// finestra); il contrario no.
	private _keeps = (ref: IReference<IResolvedTextEditorModel>, uri: URI) => {
		const model = ref.object.textEditorModel
		if (!model || model.isDisposed() || ref.object.isDisposed()) return false
		return extUriBiasedIgnorePathCase.isEqual(model.uri, uri) || (uri.scheme !== Schemas.file && uri.scheme !== Schemas.vscodeRemote)
	}

	initializeModel = async (uri: URI): Promise<string | undefined> => {
		try {
			const existing = this._modelRefOfURI[uri.fsPath];
			if (existing) {
				if (this._keeps(existing, uri)) return;
				// riferimento a un modello ormai chiuso, o a un modello che non è il file (git, notebook): si rilascia e si
				// riapre, altrimenti il file resterebbe «non apribile» o aperto in un'altra forma
				existing.dispose();
				delete this._modelRefOfURI[uri.fsPath];
			}
			const editorModelRef = await this._textModelService.createModelReference(uri);
			// un'altra chiamata per lo stesso file (per esempio da onModelAdded, durante l'attesa) può averlo già aperto:
			// si tiene quel riferimento e si rilascia questo, altrimenti resterebbe un riferimento in più mai rilasciato
			const current = this._modelRefOfURI[uri.fsPath];
			if (current && this._keeps(current, uri)) {
				editorModelRef.dispose();
				return undefined;
			}
			// un riferimento rimasto a un modello ormai chiuso, o a un modello che non è il file, si rilascia prima di sostituirlo
			if (current) current.dispose();
			// Keep a strong reference to prevent disposal
			this._modelRefOfURI[uri.fsPath] = editorModelRef;
			return undefined;
		}
		catch (e) {
			console.log('InitializeModel error:', e)
			return e instanceof Error ? e.message : String(e)
		}
	};

	getModelFromFsPath = (fsPath: string): VoxModelType => {
		const editorModelRef = this._modelRefOfURI[fsPath];
		if (!editorModelRef) {
			return { model: null, editorModel: null };
		}

		// un modello ormai chiuso non si restituisce: chi chiama lo crederebbe aperto (getModelSafe lo riapre)
		if (editorModelRef.object.isDisposed() || editorModelRef.object.textEditorModel?.isDisposed()) {
			return { model: null, editorModel: null };
		}

		const model = editorModelRef.object.textEditorModel;

		if (!model) {
			return { model: null, editorModel: editorModelRef.object };
		}

		return { model, editorModel: editorModelRef.object };
	};

	getModel = (uri: URI) => {
		return this.getModelFromFsPath(uri.fsPath)
	}


	getModelSafe = async (uri: URI): Promise<VoxModelType> => {
		// sempre: initializeModel non fa niente con un modello valido e riapre un riferimento ormai chiuso
		await this.initializeModel(uri);
		return this.getModel(uri);

	};

	override dispose() {
		super.dispose();
		for (const ref of Object.values(this._modelRefOfURI)) {
			ref.dispose(); // release reference to allow disposal
		}
	}
}

registerSingleton(IVoxModelService, VoxModelService, InstantiationType.Eager);
