// Il pacchetto dell'app compila l'interfaccia React (browser/react/out, ignorata da git) prima del resto:
// senza, da un clone pulito la compilazione si ferma e su una copia già usata entra un'interfaccia vecchia.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../../../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('compile-build esegue prima vox-buildreact (build.js della cartella react)', () => {
	const gulpfile = read('build/gulpfile.compile.js');
	assert.match(gulpfile, /function makeCompileBuildTask\(disableMangle\) \{\n\treturn task\.series\(\n\t\tbuildVoxReactTask,\n\t\tutil\.rimraf\('out-build'\)/);
	assert.match(gulpfile, /path\.join\(__dirname, '\.\.', 'src', 'vs', 'workbench', 'contrib', 'vox', 'browser', 'react'\)/);
	assert.match(gulpfile, /cp\.spawn\(process\.execPath, \['build\.js'\]/);
	assert.ok(existsSync(new URL('src/vs/workbench/contrib/vox/browser/react/build.js', root)));
	// i pacchetti (vscode-win32-x64 e gli altri) passano da compile-build
	assert.match(read('build/gulpfile.vscode.js'), /minified \? compileBuildWithManglingTask : compileBuildWithoutManglingTask/);
});

test('lo script buildreact di package.json punta alla cartella di build.js', () => {
	const { scripts } = JSON.parse(read('package.json'));
	assert.match(scripts.buildreact, /^cd \.\/src\/vs\/workbench\/contrib\/vox\/browser\/react\/ && node build\.js/);
});
