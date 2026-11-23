/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoxModelService } from '../common/voxModelService.js';
import { RULES_FILE_NAMES } from '../common/storageKeys.js';

class ConvertContribWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vox.convertcontrib'
	_serviceBrand: undefined;

	constructor(
		@IVoxModelService private readonly voxModelService: IVoxModelService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
	) {
		super()

		const initializeURI = (uri: URI) => {
			this.workspaceContext.getWorkspace()
			for (const fileName of RULES_FILE_NAMES) {
				this.voxModelService.initializeModel(URI.joinPath(uri, fileName))
			}
		}

		// call
		this._register(this.workspaceContext.onDidChangeWorkspaceFolders((e) => {
			[...e.changed, ...e.added].forEach(w => { initializeURI(w.uri) })
		}))
		this.workspaceContext.getWorkspace().folders.forEach(w => { initializeURI(w.uri) })
	}
}


registerWorkbenchContribution2(ConvertContribWorkbenchContribution.ID, ConvertContribWorkbenchContribution, WorkbenchPhase.BlockRestore);
