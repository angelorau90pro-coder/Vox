/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { defineConfig } from 'tsup'

export default defineConfig(options => ({
	entry: [
		'./src2/vox-editor-widgets-tsx/index.tsx',
		'./src2/sidebar-tsx/index.tsx',
		'./src2/vox-settings-tsx/index.tsx',
		'./src2/vox-tooltip/index.tsx',
		'./src2/vox-onboarding/index.tsx',
		'./src2/quick-edit-tsx/index.tsx',
		'./src2/diff/index.tsx',
	],
	outDir: './out',
	format: ['esm'],
	splitting: false,

	// dts: true,
	// sourcemap: true,

	clean: false,
	platform: 'browser', // 'node'
	// VOX: senza questo esbuild lascia NODE_ENV a "development" e nel pacchetto finisce il React di sviluppo,
	// molto più lento a ogni ridisegno. In `--watch` (sviluppo) restano gli avvisi di React.
	env: { NODE_ENV: options.watch ? 'development' : 'production' },
	target: 'esnext',
	injectStyle: true, // bundle css into the output file
	outExtension: () => ({ js: '.js' }),
	// default behavior is to take local files and make them internal (bundle them) and take imports like 'react' and leave them external (don't bundle them), we want the opposite in many ways
	noExternal: [ // noExternal means we should take these things and make them not external (bundle them into the output file) - anything that doesn't start with a "." needs to be force-flagged as not external
		/^(?!\.).*$/
	],
	external: [ // these imports should be kept external ../../../ are external (this is just an optimization so the output file doesn't re-implement functions)
		new RegExp('../../../*.js'
			.replaceAll('.', '\\.')
			.replaceAll('*', '.*'))
	],
	treeshake: true,
	esbuildOptions(options) {
		options.outbase = 'src2'  // tries copying the folder hierarchy starting at src2
	}
}))
