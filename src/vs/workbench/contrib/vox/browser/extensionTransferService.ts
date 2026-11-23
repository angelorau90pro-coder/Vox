/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { env } from '../../../../base/common/process.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';


export interface IExtensionTransferService {
	readonly _serviceBrand: undefined; // services need this, just leave it undefined
	deleteBlacklistExtensions(os: 'mac' | 'windows' | 'linux' | null): Promise<void>

}

export const IExtensionTransferService = createDecorator<IExtensionTransferService>('ExtensionTransferService');





// Estensioni in conflitto con Vox: la pulizia all'avvio le toglie dalla cartella delle estensioni
const extensionBlacklist = [
	// ignore extensions
	'ms-vscode-remote.remote', // ms-vscode-remote.remote-ssh, ms-vscode-remote.remote-wsl
	'ms-vscode.remote', // ms-vscode.remote-explorer
	// ignore other AI copilots that could conflict with Vox keybindings
	'sourcegraph.cody-ai',
	'continue.continue',
	'codeium.codeium',
	'saoudrizwan.claude-dev', // cline
	'rooveterinaryinc.roo-cline', // roo
	'supermaven.supermaven' // supermaven
	// 'github.copilot',
];


const isBlacklisted = (fsPath: string | undefined) => {
	return extensionBlacklist.find(bItem => fsPath?.includes(bItem))
}

class ExtensionTransferService extends Disposable implements IExtensionTransferService {
	_serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
	) {
		super()
	}

	async deleteBlacklistExtensions(os: 'mac' | 'windows' | 'linux' | null) {
		const fileService = this._fileService
		const extensionsURI = getExtensionsFolder(os)
		if (!extensionsURI) return
		const eURI = await fileService.resolve(extensionsURI)
		for (const child of eURI.children ?? []) {


			try {
				if (child.isDirectory) {
					// if is blacklisted
					if (isBlacklisted(child.resource.fsPath)) {
						console.log('Deleting extension', child.resource.fsPath)
						await fileService.del(child.resource, { recursive: true, useTrash: true })
					}
				}
				else if (child.isFile) {
					// if is extensions.json

					if (child.name === 'extensions.json') {
						console.log('Updating extensions.json', child.resource.fsPath)
						try {
							const contentsStr = await fileService.readFile(child.resource)
							const json: any = JSON.parse(contentsStr.value.toString())
							const j2 = json.filter((entry: { identifier?: { id?: string } }) => !isBlacklisted(entry?.identifier?.id))
							const jsonStr = JSON.stringify(j2)
							await fileService.writeFile(child.resource, VSBuffer.fromString(jsonStr))
						}
						catch {
							console.log('Error copying extensions.json, skipping')
						}
					}
				}
			}
			catch (e) {
				console.error('Could not delete extension', child.resource.fsPath, e)
			}
		}
	}
}


registerSingleton(IExtensionTransferService, ExtensionTransferService, InstantiationType.Eager); // lazily loaded, even if Eager









// Cartella delle estensioni di Vox nel profilo dell'utente (`~/.vox/extensions`). Il trasferimento delle impostazioni
// dagli altri editor non c'è più: di quel codice resta solo questa cartella, che serve alla pulizia qui sopra.
const getExtensionsFolder = (os: 'mac' | 'windows' | 'linux' | null) => {
	if (os === null)
		throw new Error(`os not recognized`)
	if (os === 'mac' || os === 'linux') {
		const homeDir = env['HOME']
		if (!homeDir) throw new Error(`$HOME not found`)
		return URI.joinPath(URI.from({ scheme: 'file' }), homeDir, '.vox', 'extensions')
	}
	const userprofile = env['USERPROFILE']
	if (!userprofile) throw new Error(`variable for %USERPROFILE% location not found`)
	return URI.joinPath(URI.from({ scheme: 'file' }), userprofile, '.vox', 'extensions')
}
