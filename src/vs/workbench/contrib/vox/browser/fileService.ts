import { t } from '../common/voxI18n.js';
import { localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { messageOfSelection } from '../common/prompt/prompts.js';
import { IVoxModelService } from '../common/voxModelService.js';



class FilePromptActionService extends Action2 {
	private static readonly VOX_COPY_FILE_PROMPT_ID = 'vox.copyfileprompt'

	constructor() {
		super({
			id: FilePromptActionService.VOX_COPY_FILE_PROMPT_ID,
			title: ({ ...localize2('voxCopyPrompt', "Vox: Copy Prompt"), value: t("Vox: Copy Prompt") }),
			menu: [{
				id: MenuId.ExplorerContext,
				group: '8_vox',
				order: 1,
			}]
		});
	}

	async run(accessor: ServicesAccessor, uri: URI): Promise<void> {
		try {
			const fileService = accessor.get(IFileService);
			const clipboardService = accessor.get(IClipboardService)
			const directoryStrService = accessor.get(IDirectoryStrService)
			const voxModelService = accessor.get(IVoxModelService)

			const stat = await fileService.stat(uri)

			const folderOpts = {
				maxChildren: 1000,
				maxCharsPerFile: 2_000_000,
			} as const

			let m: string = t("No contents detected")
			if (stat.isFile) {
				m = await messageOfSelection({
					type: 'File',
					uri,
					language: (await voxModelService.getModelSafe(uri)).model?.getLanguageId() || '',
					state: { wasAddedAsCurrentFile: false, },
				}, {
					folderOpts,
					directoryStrService,
					fileService,
				})
			}

			if (stat.isDirectory) {
				m = await messageOfSelection({
					type: 'Folder',
					uri,
				}, {
					folderOpts,
					fileService,
					directoryStrService,
				})
			}

			await clipboardService.writeText(m)

		} catch (error) {
			const notificationService = accessor.get(INotificationService)
			notificationService.error(error + '')
		}
	}

}

registerAction2(FilePromptActionService)
