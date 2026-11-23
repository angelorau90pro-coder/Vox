/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../common/voxI18n.js';
import { SendLLMMessageParams, OnText, OnFinalMessage, OnError } from '../../common/sendLLMMessageTypes.js';
import { sendLLMMessageToProviderImplementation } from './sendLLMMessage.impl.js';
import { isAllowedProviderName } from './providerGuard.js';


export const sendLLMMessage = async ({
	messagesType,
	messages: messages_,
	onText: onText_,
	onFinalMessage: onFinalMessage_,
	onError: onError_,
	abortRef: abortRef_,
	settingsOfProvider,
	modelSelection,
	modelSelectionOptions,
	overridesOfModel,
	chatMode,
	separateSystemMessage,
	mcpTools,
	workspaceFolder,
	cliAllowWrite,
}: SendLLMMessageParams) => {


	const { providerName, modelName } = modelSelection

	// Solo IA locali e IA in CLI: un fornitore diverso (impostazioni di una versione precedente, un file importato, una
	// chiamata sbagliata) si rifiuta qui, prima di leggere impostazioni o cercare un'implementazione.
	if (!isAllowedProviderName(providerName)) {
		onError_({ message: t("Vox only uses local AI and CLI AI: the provider \"{0}\" is no longer available. Choose another model.", String(providerName)), fullError: null, noRetry: true })
		return
	}


	let _aborter: (() => void) | null = null
	let _didAbort = false
	let _setAborter = (fn: () => void) => { if (_didAbort) fn(); else _aborter = fn }

	const onText: OnText = (params) => {
		if (_didAbort) return
		onText_(params)
	}

	const onFinalMessage: OnFinalMessage = (params) => {
		if (_didAbort) return
		onFinalMessage_(params)
	}

	const onError: OnError = ({ message: errorMessage, fullError, noRetry }) => {
		if (_didAbort) return
		console.error('sendLLMMessage onError:', errorMessage)

		// handle failed to fetch errors, which give 0 information by design
		if (errorMessage === 'TypeError: fetch failed')
			errorMessage = t("The local model did not answer: it may have stopped. Try again, or check the local AI folder in Vox's Settings.")

		onError_({ message: errorMessage, fullError, ...(noRetry ? { noRetry } : {}) })
	}

	// we should NEVER call onAbort internally, only from the outside
	const onAbort = () => {
		try { _aborter?.() } // aborter sometimes automatically throws an error
		catch (e) { }
		_didAbort = true
	}
	abortRef_.current = onAbort


	try {
		const { sendFIM, sendChat } = sendLLMMessageToProviderImplementation[providerName]
		if (messagesType === 'chatMessages') {
			await sendChat({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage, chatMode, mcpTools, workspaceFolder, cliAllowWrite })
			return
		}
		if (messagesType === 'FIMMessage') {
			if (sendFIM) {
				await sendFIM({ messages: messages_, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName, _setAborter, providerName, separateSystemMessage })
				return
			}
			onError({ message: t("Autocomplete only works with the completion model of the local AI: {0} cannot be used.", modelName), fullError: null, noRetry: true })
			return
		}
		onError({ message: t("Error: Message type \"{0}\" not recognized.", messagesType), fullError: null })
		return
	}

	catch (error) {
		if (error instanceof Error) { onError({ message: error + '', fullError: error }) }
		else { onError({ message: t("Unexpected Error in sendLLMMessage: {0}", error), fullError: error }); }
		// ; (_aborter as any)?.()
		// _didAbort = true
	}



}

