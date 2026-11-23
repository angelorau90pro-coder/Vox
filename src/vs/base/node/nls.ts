/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import * as perf from '../common/performance.js';
import type { ILanguagePack, ILanguagePacks, INLSConfiguration } from '../../nls.js';

export interface IResolveNLSConfigurationContext {

	/**
	 * Location where `nls.messages.json` and `nls.keys.json` are stored.
	 */
	readonly nlsMetadataPath: string;

	/**
	 * Path to the user data directory. Used as a cache for
	 * language packs converted to the format we need.
	 */
	readonly userDataPath: string;

	/**
	 * Commit of the running application. Can be `undefined`
	 * when not built.
	 */
	readonly commit: string | undefined;

	/**
	 * Locale as defined in `argv.json` or `app.getLocale()`.
	 */
	readonly userLocale: string;

	/**
	 * Locale as defined by the OS (e.g. `app.getPreferredSystemLanguages()`).
	 */
	readonly osLocale: string;
}

export async function resolveNLSConfiguration({ userLocale, osLocale, userDataPath, commit, nlsMetadataPath }: IResolveNLSConfigurationContext): Promise<INLSConfiguration> {
	perf.mark('code/willGenerateNls');

	if (
		process.env['VSCODE_DEV'] ||
		userLocale === 'pseudo' ||
		userLocale.startsWith('en') ||
		!commit ||
		!userDataPath
	) {
		return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
	}

	try {
		// VOX: `languagepacks.json` viene scritto solo dopo il primo avvio e può puntare a una copia dell'app
		// spostata o rimossa: in quei casi si usa il pacchetto di lingua incluso nell'app, così l'interfaccia
		// è tradotta già dal primo avvio.
		const resolved = await resolveInstalledLanguagePack(userDataPath, userLocale) ?? await resolveBuiltinLanguagePack(nlsMetadataPath, userLocale);
		if (!resolved) {
			return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
		}
		const { resolvedLanguage, languagePack, mainLanguagePackPath } = resolved;

		const languagePackId = `${languagePack.hash}.${resolvedLanguage}`;
		const globalLanguagePackCachePath = path.join(userDataPath, 'clp', languagePackId);
		const commitLanguagePackCachePath = path.join(globalLanguagePackCachePath, commit);
		const languagePackMessagesFile = path.join(commitLanguagePackCachePath, 'nls.messages.json');
		const translationsConfigFile = path.join(globalLanguagePackCachePath, 'tcf.json');
		const languagePackCorruptMarkerFile = path.join(globalLanguagePackCachePath, 'corrupted.info');

		if (await exists(languagePackCorruptMarkerFile)) {
			await fs.promises.rm(globalLanguagePackCachePath, { recursive: true, force: true, maxRetries: 3 }); // delete corrupted cache folder
		}

		const result: INLSConfiguration = {
			userLocale,
			osLocale,
			resolvedLanguage,
			defaultMessagesFile: path.join(nlsMetadataPath, 'nls.messages.json'),
			languagePack: {
				translationsConfigFile,
				messagesFile: languagePackMessagesFile,
				corruptMarkerFile: languagePackCorruptMarkerFile
			},

			// NLS: below properties are a relic from old times only used by vscode-nls and deprecated
			locale: userLocale,
			availableLanguages: { '*': resolvedLanguage },
			_languagePackId: languagePackId,
			_languagePackSupport: true,
			_translationsConfigFile: translationsConfigFile,
			_cacheRoot: globalLanguagePackCachePath,
			_resolvedLanguagePackCoreLocation: commitLanguagePackCachePath,
			_corruptedFile: languagePackCorruptMarkerFile
		};

		if (await exists(commitLanguagePackCachePath)) {
			touch(commitLanguagePackCachePath).catch(() => { }); // We don't wait for this. No big harm if we can't touch
			// VOX: la cache può essere stata creata da un'altra copia dell'app: si aggiornano i percorsi
			// delle traduzioni delle estensioni se non sono più quelli di questa copia.
			await refreshTranslationsConfig(translationsConfigFile, languagePack.translations);
			perf.mark('code/didGenerateNls');
			return result;
		}

		const [
			,
			nlsDefaultKeys,
			nlsDefaultMessages,
			nlsPackdata
		]:
			[unknown, Array<[string, string[]]>, string[], { contents: Record<string, Record<string, string>> }]
			//               ^moduleId ^nlsKeys                               ^moduleId      ^nlsKey ^nlsValue
			= await Promise.all([
				fs.promises.mkdir(commitLanguagePackCachePath, { recursive: true }),
				JSON.parse(await fs.promises.readFile(path.join(nlsMetadataPath, 'nls.keys.json'), 'utf-8')),
				JSON.parse(await fs.promises.readFile(path.join(nlsMetadataPath, 'nls.messages.json'), 'utf-8')),
				JSON.parse(await fs.promises.readFile(mainLanguagePackPath, 'utf-8'))
			]);

		const nlsResult: string[] = [];

		// We expect NLS messages to be in a flat array in sorted order as they
		// where produced during build time. We use `nls.keys.json` to know the
		// right order and then lookup the related message from the translation.
		// If a translation does not exist, we fallback to the default message.

		let nlsIndex = 0;
		for (const [moduleId, nlsKeys] of nlsDefaultKeys) {
			const moduleTranslations = nlsPackdata.contents[moduleId];
			for (const nlsKey of nlsKeys) {
				nlsResult.push(moduleTranslations?.[nlsKey] || nlsDefaultMessages[nlsIndex]);
				nlsIndex++;
			}
		}

		await Promise.all([
			fs.promises.writeFile(languagePackMessagesFile, JSON.stringify(nlsResult), 'utf-8'),
			fs.promises.writeFile(translationsConfigFile, JSON.stringify(languagePack.translations), 'utf-8')
		]);

		perf.mark('code/didGenerateNls');

		return result;
	} catch (error) {
		console.error('Generating translation files failed.', error);
	}

	return defaultNLSConfiguration(userLocale, osLocale, nlsMetadataPath);
}

/**
 * The `languagepacks.json` file is a JSON file that contains all metadata
 * about installed language extensions per language. Specifically, for
 * core (`vscode`) and all extensions it supports, it points to the related
 * translation files.
 *
 * The file is updated whenever a new language pack is installed or removed.
 */
async function getLanguagePackConfigurations(userDataPath: string): Promise<ILanguagePacks | undefined> {
	const configFile = path.join(userDataPath, 'languagepacks.json');
	try {
		return JSON.parse(await fs.promises.readFile(configFile, 'utf-8'));
	} catch (err) {
		return undefined; // Do nothing. If we can't read the file we have no language pack config.
	}
}

interface IResolvedLanguagePack {
	readonly resolvedLanguage: string;
	readonly languagePack: ILanguagePack;
	readonly mainLanguagePackPath: string;
}

async function resolveInstalledLanguagePack(userDataPath: string, userLocale: string): Promise<IResolvedLanguagePack | undefined> {
	const languagePacks = await getLanguagePackConfigurations(userDataPath);
	if (!languagePacks) {
		return undefined;
	}

	const resolvedLanguage = resolveLanguagePackLanguage(languagePacks, userLocale);
	if (!resolvedLanguage) {
		return undefined;
	}

	const languagePack = languagePacks[resolvedLanguage];
	const mainLanguagePackPath = languagePack?.translations?.['vscode'];
	if (
		!languagePack ||
		typeof languagePack.hash !== 'string' ||
		!languagePack.translations ||
		typeof mainLanguagePackPath !== 'string' ||
		!(await exists(mainLanguagePackPath))
	) {
		return undefined;
	}

	return { resolvedLanguage, languagePack, mainLanguagePackPath };
}

/**
 * VOX: the language pack shipped with the app (`extensions/vscode-language-pack-<lang>`, next to `out`).
 * The hash is computed like `LanguagePacksCache` does for a built-in extension, so the cache folder
 * (`clp/<hash>.<lang>`) is the same one used once `languagepacks.json` has been written.
 */
async function resolveBuiltinLanguagePack(nlsMetadataPath: string, userLocale: string): Promise<IResolvedLanguagePack | undefined> {
	const extensionsPath = path.join(nlsMetadataPath, '..', 'extensions');
	let locale: string | undefined = userLocale.toLowerCase();
	while (locale) {
		const extensionPath = path.join(extensionsPath, `vscode-language-pack-${locale}`);
		let manifest: { publisher?: unknown; name?: unknown; version?: unknown; contributes?: { localizations?: unknown } } | undefined;
		try {
			manifest = JSON.parse(await fs.promises.readFile(path.join(extensionPath, 'package.json'), 'utf-8'));
		} catch {
			manifest = undefined; // no shipped language pack for this locale
		}

		const localizations = Array.isArray(manifest?.contributes?.localizations) ? manifest.contributes.localizations as { languageId?: unknown; languageName?: unknown; localizedLanguageName?: unknown; translations?: unknown }[] : [];
		const localization = localizations.find(candidate => typeof candidate?.languageId === 'string' && candidate.languageId.toLowerCase() === locale);
		if (manifest && typeof manifest.publisher === 'string' && typeof manifest.name === 'string' && typeof manifest.version === 'string' && localization && Array.isArray(localization.translations)) {
			const translations: Record<string, string> = {};
			for (const translation of localization.translations as { id?: unknown; path?: unknown }[]) {
				if (typeof translation?.id === 'string' && typeof translation.path === 'string') {
					translations[translation.id] = path.join(extensionPath, translation.path);
				}
			}

			const mainLanguagePackPath = translations['vscode'];
			if (mainLanguagePackPath && await exists(mainLanguagePackPath)) {
				const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
				const label = typeof localization.localizedLanguageName === 'string' ? localization.localizedLanguageName : typeof localization.languageName === 'string' ? localization.languageName : undefined;
				return {
					resolvedLanguage: locale,
					mainLanguagePackPath,
					languagePack: {
						hash: createHash('md5').update(id).update(manifest.version).digest('hex'), // CodeQL [SM04514] same non-security hash as LanguagePacksCache
						label,
						extensions: [{ extensionIdentifier: { id }, version: manifest.version }],
						translations
					}
				};
			}
		}

		const index = locale.lastIndexOf('-');
		locale = index > 0 ? locale.substring(0, index) : undefined;
	}

	return undefined;
}

async function refreshTranslationsConfig(translationsConfigFile: string, translations: ILanguagePack['translations']): Promise<void> {
	try {
		const expected = JSON.stringify(translations);
		let current: string | undefined;
		try {
			current = await fs.promises.readFile(translationsConfigFile, 'utf-8');
		} catch {
			current = undefined;
		}
		if (current !== expected) {
			await fs.promises.writeFile(translationsConfigFile, expected, 'utf-8');
		}
	} catch (error) {
		console.error('Updating the translations config failed.', error);
	}
}

function resolveLanguagePackLanguage(languagePacks: ILanguagePacks, locale: string | undefined): string | undefined {
	try {
		while (locale) {
			if (languagePacks[locale]) {
				return locale;
			}

			const index = locale.lastIndexOf('-');
			if (index > 0) {
				locale = locale.substring(0, index);
			} else {
				return undefined;
			}
		}
	} catch (error) {
		console.error('Resolving language pack configuration failed.', error);
	}

	return undefined;
}

function defaultNLSConfiguration(userLocale: string, osLocale: string, nlsMetadataPath: string): INLSConfiguration {
	perf.mark('code/didGenerateNls');

	return {
		userLocale,
		osLocale,
		resolvedLanguage: 'en',
		defaultMessagesFile: path.join(nlsMetadataPath, 'nls.messages.json'),

		// NLS: below 2 are a relic from old times only used by vscode-nls and deprecated
		locale: userLocale,
		availableLanguages: {}
	};
}

//#region fs helpers

async function exists(path: string): Promise<boolean> {
	try {
		await fs.promises.access(path);

		return true;
	} catch {
		return false;
	}
}

function touch(path: string): Promise<void> {
	const date = new Date();

	return fs.promises.utimes(path, date, date);
}

//#endregion
