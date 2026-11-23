/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import '../styles.css'
import { Tooltip } from 'react-tooltip';
import 'react-tooltip/dist/react-tooltip.css';
import { useIsDark } from '../util/services.js';

/**
 * Creates a configured global tooltip component with consistent styling
 * To use:
 * 1. Mount a Tooltip with some id eg id='vox-tooltip'
 * 2. Add data-tooltip-id="vox-tooltip" and data-tooltip-content="Your tooltip text" to any element
 */
export const VoxTooltip = () => {


	const isDark = useIsDark()

	return (

		// use native colors so we don't have to worry about @@vox-scope styles
		// --vox-bg-1: var(--vscode-input-background);
		// --vox-bg-1-alt: var(--vscode-badge-background);
		// --vox-bg-2: var(--vscode-sideBar-background);
		// --vox-bg-2-alt: color-mix(in srgb, var(--vscode-sideBar-background) 30%, var(--vscode-editor-background) 70%);
		// --vox-bg-3: var(--vscode-editor-background);

		// --vox-fg-0: color-mix(in srgb, var(--vscode-tab-activeForeground) 90%, black 10%);
		// --vox-fg-1: var(--vscode-editor-foreground);
		// --vox-fg-2: var(--vscode-input-foreground);
		// --vox-fg-3: var(--vscode-input-placeholderForeground);
		// /* --vox-fg-4: var(--vscode-tab-inactiveForeground); */
		// --vox-fg-4: var(--vscode-list-deemphasizedForeground);

		// --vox-warning: var(--vscode-charts-yellow);

		// --vox-border-1: var(--vscode-commandCenter-activeBorder);
		// --vox-border-2: var(--vscode-commandCenter-border);
		// --vox-border-3: var(--vscode-commandCenter-inactiveBorder);
		// --vox-border-4: var(--vscode-editorGroup-border);

		<>
			<style>
				{`
				#vox-tooltip, #vox-tooltip-orange, #vox-tooltip-green {
					font-size: 12px;
					line-height: 1.45;
					padding: 4px 9px;
					border-radius: 8px;
					z-index: 999999;
					max-width: 300px;
					word-wrap: break-word;
					box-shadow: 0 8px 24px -8px rgba(0, 0, 0, .45), 0 1px 3px rgba(0, 0, 0, .14);
				}

				#vox-tooltip {
					background-color: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
					color: var(--vscode-editorHoverWidget-foreground, var(--vscode-input-foreground));
				}

				/* coppia sfondo e testo degli avvisi che ogni tema definisce insieme (anche i temi a contrasto elevato) */
				#vox-tooltip-orange {
					background-color: var(--vscode-inputValidation-warningBackground, #352A05);
					color: var(--vscode-inputValidation-warningForeground, var(--vscode-editorHoverWidget-foreground, var(--vscode-input-foreground)));
				}

				#vox-tooltip-green {
					background-color: var(--vscode-button-background, #2EC4B0);
					color: var(--vscode-button-foreground, #04211D);
				}

				.react-tooltip-arrow {
					z-index: -1 !important; /* Keep arrow behind content (somehow this isnt done automatically) */
				}
				`}
			</style>


			<Tooltip
				id="vox-tooltip"
				border='1px solid color-mix(in srgb, var(--vscode-editor-foreground) 16%, transparent)'
				opacity={1}
				delayShow={50}
			/>
			<Tooltip
				id="vox-tooltip-orange"
				// il bordo lo mette react-tooltip come stile in linea: qui, non nel CSS
				border='1px solid var(--vscode-inputValidation-warningBorder, #B89500)'
				opacity={1}
				delayShow={50}
			/>
			<Tooltip
				id="vox-tooltip-green"
				border='1px solid rgba(200,200,200,.3)'
				opacity={1}
				delayShow={50}
			/>
		</>
	);
};
