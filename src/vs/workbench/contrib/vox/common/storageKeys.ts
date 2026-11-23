/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Chiavi di salvataggio di Vox (ambito APPLICATION).
export const VOX_SETTINGS_STORAGE_KEY = 'vox.settingsServiceStorageII'
export const THREAD_STORAGE_KEY = 'vox.chatThreadStorageII'
export const DELETED_BLACKLIST_KEY = 'vox-deleted-blacklist-2'

// Dati dei modelli delle IA locali salvati per averli già all'avvio, prima del primo rilevamento:
// finestre di contesto (nome -> token) e nomi dei modelli di completamento.
export const VOX_LOCAL_CONTEXT_WINDOWS_KEY = 'vox.voxLocal.contextWindows'
export const VOX_LOCAL_COMPLETION_MODELS_KEY = 'vox.voxLocal.completionModels'

// Avviso da mostrare una volta dopo la pulizia dei fornitori tolti (nomi di fornitori e di modelli, nessun segreto):
// resta salvato finché una finestra non lo mostra, così non si perde se Vox viene chiuso subito.
export const VOX_REMOVED_PROVIDERS_NOTICE_KEY = 'vox.removedProvidersNotice'

// File di regole per l'IA nella radice di ogni cartella del progetto.
export const RULES_FILE_NAMES: readonly string[] = ['.voxrules']

// Nome del terminale dell'agente.
export const AGENT_TERMINAL_NAMES: readonly string[] = ['Vox Agent']

/**
 * L'ID del terminale dell'agente dal suo nome: "Vox Agent" e' '1',
 * "Vox Agent (N)" e' 'N' (N >= 1); null se il nome non e' di un terminale
 * dell'agente.
 */
export function idOfAgentTerminalName(name: string): string | null {
	for (const base of AGENT_TERMINAL_NAMES) {
		if (name === base) return '1'
		const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		const match = name.match(new RegExp(`${escaped} \\((\\d+)\\)`))
		if (match && Number(match[1]) >= 1) return match[1]
	}
	return null
}
