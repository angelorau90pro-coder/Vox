/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../common/voxI18n.js';
import { ThemeIcon } from '../../../../base/common/themables.js'
import { localize2 } from '../../../../nls.js'
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js'
import { ContextKeyExpr, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js'
import { ISCMService } from '../../scm/common/scm.js'
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js'
import { IVoxSCMService } from '../common/voxSCMTypes.js'
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js'
import { IVoxSettingsService } from '../common/voxSettingsService.js'
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js'
import { ILLMMessageService } from '../common/sendLLMMessageService.js'
import { ModelSelection, OverridesOfModel, ModelSelectionOptions } from '../common/voxSettingsTypes.js'
import { gitCommitMessage_systemMessage, gitCommitMessage_userMessage } from '../common/prompt/prompts.js'
import { LLMChatMessage } from '../common/sendLLMMessageTypes.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { ThrottledDelayer } from '../../../../base/common/async.js'
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js'
import { Disposable } from '../../../../base/common/lifecycle.js'
import { INotificationService } from '../../../../platform/notification/common/notification.js'

interface ModelOptions {
	modelSelection: ModelSelection | null
	modelSelectionOptions?: ModelSelectionOptions
	overridesOfModel: OverridesOfModel
}

export interface IGenerateCommitMessageService {
	readonly _serviceBrand: undefined
	generateCommitMessage(): Promise<void>
	abort(): void
}

export const IGenerateCommitMessageService = createDecorator<IGenerateCommitMessageService>('voxGenerateCommitMessageService');

const loadingContextKey = 'voxSCMGenerateCommitMessageLoading'

class GenerateCommitMessageService extends Disposable implements IGenerateCommitMessageService {
	readonly _serviceBrand: undefined;
	private readonly execute = new ThrottledDelayer(300)
	private llmRequestId: string | null = null
	private currentRequestId: string | null = null
	private voxSCM: IVoxSCMService
	private loadingContextKey: IContextKey<boolean>

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IVoxSettingsService private readonly voxSettingsService: IVoxSettingsService,
		@IConvertToLLMMessageService private readonly convertToLLMMessageService: IConvertToLLMMessageService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super()
		this.loadingContextKey = this.contextKeyService.createKey(loadingContextKey, false)
		this.voxSCM = ProxyChannel.toService<IVoxSCMService>(mainProcessService.getChannel('vox-channel-scm'))
	}

	override dispose() {
		this.execute.dispose()
		super.dispose()
	}

	async generateCommitMessage() {
		this.loadingContextKey.set(true)
		this.execute.trigger(async () => {
			const requestId = generateUuid()
			this.currentRequestId = requestId


			try {
				const { path, repo } = this.gitRepoInfo()
				const [stat, sampledDiffs, branch, log] = await Promise.all([
					this.voxSCM.gitStat(path),
					this.voxSCM.gitSampledDiffs(path),
					this.voxSCM.gitBranch(path),
					this.voxSCM.gitLog(path)
				])

				if (!this.isCurrentRequest(requestId)) { throw new CancellationError() }

				const modelSelection = this.voxSettingsService.state.modelSelectionOfFeature['SCM'] ?? null
				const modelSelectionOptions = modelSelection ? this.voxSettingsService.state.optionsOfModelSelection['SCM'][modelSelection?.providerName]?.[modelSelection.modelName] : undefined
				const overridesOfModel = this.voxSettingsService.state.overridesOfModel

				const modelOptions: ModelOptions = { modelSelection, modelSelectionOptions, overridesOfModel }

				const prompt = gitCommitMessage_userMessage(stat, sampledDiffs, branch, log)

				const simpleMessages = [{ role: 'user', content: prompt } as const]
				const { messages, separateSystemMessage } = this.convertToLLMMessageService.prepareLLMSimpleMessages({
					simpleMessages,
					systemMessage: gitCommitMessage_systemMessage,
					modelSelection: modelOptions.modelSelection,
					featureName: 'SCM',
				})

				const commitMessage = await this.sendLLMMessage(messages, separateSystemMessage!, modelOptions)

				if (!this.isCurrentRequest(requestId)) { throw new CancellationError() }

				repo.input.setValue(commitMessage, false)
			} catch (error) {
				this.onError(error)
			} finally {
				if (this.isCurrentRequest(requestId)) {
					this.loadingContextKey.set(false)
				}
			}
		})
	}

	abort() {
		if (this.llmRequestId) {
			this.llmMessageService.abort(this.llmRequestId)
		}
		this.execute.cancel()
		this.loadingContextKey.set(false)
		this.currentRequestId = null
	}

	private gitRepoInfo() {
		const repo = Array.from(this.scmService.repositories || []).find((r: any) => r.provider.contextValue === 'git')
		if (!repo) { throw new Error(t("No git repository found")) }
		if (!repo.provider.rootUri?.fsPath) { throw new Error(t("No git repository root path found")) }
		return { path: repo.provider.rootUri.fsPath, repo }
	}

	/** LLM Functions */

	private sendLLMMessage(messages: LLMChatMessage[], separateSystemMessage: string, modelOptions: ModelOptions): Promise<string> {
		return new Promise((resolve, reject) => {

			this.llmRequestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				chatMode: null,
				modelSelection: modelOptions.modelSelection,
				modelSelectionOptions: modelOptions.modelSelectionOptions,
				overridesOfModel: modelOptions.overridesOfModel,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					const match = params.fullText.match(/<output>([\s\S]*?)<\/output>/i)
					// VOX: senza i tag <output> (succede con i modelli piccoli) si usa tutta la risposta; prima il messaggio
					// diventava vuoto e cancellava quello che l'utente aveva già scritto
					const commitMessage = (match ? match[1] : params.fullText).trim()
					if (!commitMessage) { reject(new Error(t("The model did not return a commit message."))); return }
					resolve(commitMessage)
				},
				onError: (error) => {
					console.error(error)
					reject(error)
				},
				onAbort: () => {
					reject(new CancellationError())
				},
			})
		})
	}


	/** Request Helpers */

	private isCurrentRequest(requestId: string) {
		return requestId === this.currentRequestId
	}


	/** UI Functions */

	private onError(error: any) {
		if (!isCancellationError(error)) {
			console.error(error)
			// VOX: anche il motivo (per esempio nessun modello scelto per i commit), non solo «non riuscito»
			const reason = typeof error?.message === 'string' ? error.message : ''
			this.notificationService.error(reason ? t("Failed to generate commit message: {0}", reason) : ({ ...localize2('voxFailedToGenerateCommitMessage', "Failed to generate commit message."), value: t("Failed to generate commit message.") }).value)
		}
	}
}

class GenerateCommitMessageAction extends Action2 {
	constructor() {
		super({
			id: 'vox.generateCommitMessageAction',
			title: ({ ...localize2('voxCommitMessagePrompt', "Vox: Generate Commit Message"), value: t("Vox: Generate Commit Message") }),
			icon: ThemeIcon.fromId('sparkle'),
			tooltip: ({ ...localize2('voxCommitMessagePromptTooltip', "Vox: Generate Commit Message"), value: t("Vox: Generate Commit Message") }),
			f1: true,
			menu: [{
				id: MenuId.SCMInputBox,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals(loadingContextKey, false)),
				group: 'inline'
			}]
		})
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const generateCommitMessageService = accessor.get(IGenerateCommitMessageService)
		generateCommitMessageService.generateCommitMessage()
	}
}

class LoadingGenerateCommitMessageAction extends Action2 {
	constructor() {
		super({
			id: 'vox.loadingGenerateCommitMessageAction',
			title: ({ ...localize2('voxCommitMessagePromptCancel', "Vox: Cancel Commit Message Generation"), value: t("Vox: Cancel Commit Message Generation") }),
			icon: ThemeIcon.fromId('stop-circle'),
			tooltip: ({ ...localize2('voxCommitMessagePromptCancelTooltip', "Vox: Cancel Commit Message Generation"), value: t("Vox: Cancel Commit Message Generation") }),
			f1: false, //Having a cancel command in the command palette is more confusing than useful.
			menu: [{
				id: MenuId.SCMInputBox,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals(loadingContextKey, true)),
				group: 'inline'
			}]
		})
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const generateCommitMessageService = accessor.get(IGenerateCommitMessageService)
		generateCommitMessageService.abort()
	}
}

registerAction2(GenerateCommitMessageAction)
registerAction2(LoadingGenerateCommitMessageAction)
registerSingleton(IGenerateCommitMessageService, GenerateCommitMessageService, InstantiationType.Delayed)
