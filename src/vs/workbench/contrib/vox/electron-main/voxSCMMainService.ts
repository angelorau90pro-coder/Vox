/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { execFile } from 'child_process'
import { IVoxSCMService } from '../common/voxSCMTypes.js'

interface NumStat {
	file: string
	added: number
	removed: number
}

//8000 and 10 were chosen after some experimentation on small-to-moderately sized changes
const MAX_DIFF_LENGTH = 8000
const MAX_DIFF_FILES = 10

// VOX: git si avvia senza shell, con gli argomenti separati: un nome di file con «"», «$(…)» o «`» (in un repository
// scaricato) non diventa un comando. Gli avvisi che git scrive su stderr (per esempio «LF will be replaced by CRLF» su
// Windows) non sono errori: conta solo il codice di uscita. Il buffer è più grande dei 1 MB predefiniti perché un diff
// grande non faccia fallire tutta la generazione (si taglia comunque a MAX_DIFF_LENGTH).
const gitRaw = (args: string[], path: string): Promise<string> => new Promise((resolve, reject) => {
	execFile('git', args, { cwd: path, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
		if (error) reject(new Error(String(stderr).trim() || error.message))
		else resolve(String(stdout))
	})
})
const git = async (args: string[], path: string): Promise<string> => (await gitRaw(args, path)).trim()

// VOX: `git diff --numstat -z`: con -z i nomi arrivano così come sono (senza virgolette né escape per i caratteri
// speciali) e senza rinomine (`--no-renames`) ogni voce è «aggiunte\trimosse\tpercorso». I file binari hanno «-».
export const parseNumStatZ = (output: string): NumStat[] => output
	.split('\0')
	.filter(entry => entry !== '')
	.flatMap(entry => {
		const [added, removed, ...rest] = entry.split('\t')
		const file = rest.join('\t')
		if (!file) return []
		return [{ file, added: parseInt(added, 10) || 0, removed: parseInt(removed, 10) || 0 }]
	})

const stagedArgs = (useStagedChanges: boolean) => useStagedChanges ? ['--staged'] : []

const getNumStat = async (path: string, useStagedChanges: boolean): Promise<NumStat[]> => {
	// senza trim: un nome può cominciare o finire con uno spazio
	return parseNumStatZ(await gitRaw(['diff', '--numstat', '-z', '--no-renames', ...stagedArgs(useStagedChanges)], path))
}

const getSampledDiff = async (file: string, path: string, useStagedChanges: boolean): Promise<string> => {
	const diff = await git(['diff', '--unified=0', '--no-color', '--no-renames', ...stagedArgs(useStagedChanges), '--', file], path)
	return diff.slice(0, MAX_DIFF_LENGTH)
}

const hasStagedChanges = async (path: string): Promise<boolean> => {
	const output = await git(['diff', '--staged', '--name-only'], path)
	return output.length > 0
}

export class VoxSCMService implements IVoxSCMService {
	readonly _serviceBrand: undefined

	async gitStat(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		return git(['diff', '--stat', ...stagedArgs(useStagedChanges)], path)
	}

	async gitSampledDiffs(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path)
		const numStatList = await getNumStat(path, useStagedChanges)
		const topFiles = numStatList
			.sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
			.slice(0, MAX_DIFF_FILES)
		const diffs = await Promise.all(topFiles.map(async ({ file }) => ({ file, diff: await getSampledDiff(file, path, useStagedChanges) })))
		return diffs.map(({ file, diff }) => `==== ${file} ====\n${diff}`).join('\n\n')
	}

	gitBranch(path: string): Promise<string> {
		return git(['branch', '--show-current'], path)
	}

	gitLog(path: string): Promise<string> {
		// VOX: un repository senza commit non ha cronologia: non è un errore che deve fermare la generazione
		return git(['log', '--pretty=format:%h|%s|%ad', '--date=short', '--no-merges', '-n', '5'], path).catch(() => '')
	}
}
