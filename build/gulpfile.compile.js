/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const gulp = require('gulp');
const util = require('./lib/util');
const date = require('./lib/date');
const task = require('./lib/task');
const compilation = require('./lib/compilation');
const cp = require('child_process');
const path = require('path');

// Vox: l'interfaccia React (browser/react/out, ignorata da git) si compila prima del pacchetto. Senza questo passo,
// da un clone pulito la compilazione si ferma (out non c'è) e su una copia già usata entra nel pacchetto
// un'interfaccia vecchia. Con VOX_SKIP_BUILDREACT=1 si salta (bundle appena compilato con `npm run buildreact`).
const buildVoxReactTask = task.define('vox-buildreact', () => {
	if (process.env.VOX_SKIP_BUILDREACT === '1') {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const cwd = path.join(__dirname, '..', 'src', 'vs', 'workbench', 'contrib', 'vox', 'browser', 'react');
		const child = cp.spawn(process.execPath, ['build.js'], { cwd, stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', code => code === 0 ? resolve(undefined) : reject(new Error(`vox-buildreact: build.js exited with code ${code}`)));
	});
});
gulp.task(buildVoxReactTask);
exports.buildVoxReactTask = buildVoxReactTask;

/**
 * @param {boolean} disableMangle
 */
function makeCompileBuildTask(disableMangle) {
	return task.series(
		buildVoxReactTask,
		util.rimraf('out-build'),
		date.writeISODate('out-build'),
		compilation.compileApiProposalNamesTask,
		compilation.compileTask('src', 'out-build', true, { disableMangle })
	);
}

// Local/PR compile, including nls and inline sources in sourcemaps, minification, no mangling
const compileBuildWithoutManglingTask = task.define('compile-build-without-mangling', makeCompileBuildTask(true));
gulp.task(compileBuildWithoutManglingTask);
exports.compileBuildWithoutManglingTask = compileBuildWithoutManglingTask;

// CI compile, including nls and inline sources in sourcemaps, mangling, minification, for build
const compileBuildWithManglingTask = task.define('compile-build-with-mangling', makeCompileBuildTask(false));
gulp.task(compileBuildWithManglingTask);
exports.compileBuildWithManglingTask = compileBuildWithManglingTask;
