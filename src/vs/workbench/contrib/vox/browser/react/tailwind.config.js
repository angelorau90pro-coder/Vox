/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** @type {import('tailwindcss').Config} */
module.exports = {
	darkMode: 'selector', // '{prefix-}dark' className is used to identify `dark:`
	content: ['./src2/**/*.{jsx,tsx}'], // uses these files to decide how to transform the css file
	theme: {
		extend: {
			typography: theme => ({
				DEFAULT: {
					css: {
						'--tw-prose-body': 'var(--vox-fg-1)',
						'--tw-prose-headings': 'var(--vox-fg-1)',
						'--tw-prose-lead': 'var(--vox-fg-2)',
						'--tw-prose-links': 'var(--vox-link-color)',
						'--tw-prose-bold': 'var(--vox-fg-1)',
						'--tw-prose-counters': 'var(--vox-fg-3)',
						'--tw-prose-bullets': 'var(--vox-fg-3)',
						'--tw-prose-hr': 'var(--vox-border-4)',
						'--tw-prose-quotes': 'var(--vox-fg-1)',
						'--tw-prose-quote-borders': 'var(--vox-border-2)',
						'--tw-prose-captions': 'var(--vox-fg-3)',
						'--tw-prose-code': 'var(--vox-fg-0)',
						'--tw-prose-pre-code': 'var(--vox-fg-0)',
						'--tw-prose-pre-bg': 'var(--vox-bg-1)',
						'--tw-prose-th-borders': 'var(--vox-border-4)',
						'--tw-prose-td-borders': 'var(--vox-border-4)',
					},
				},
			}),
			fontSize: {
				xs: '10px',
				sm: '11px',
				root: '13px',
				lg: '14px',
				xl: '16px',
				'2xl': '18px',
				'3xl': '20px',
				'4xl': '24px',
				'5xl': '30px',
				'6xl': '36px',
				'7xl': '48px',
				'8xl': '64px',
				'9xl': '72px',
			},
			borderRadius: {
				'vox-sm': 'var(--vox-radius-sm)',
				'vox-md': 'var(--vox-radius-md)',
				'vox-lg': 'var(--vox-radius-lg)',
				'vox-xl': 'var(--vox-radius-xl)',
			},
			boxShadow: {
				'vox-sm': 'var(--vox-shadow-sm)',
				'vox-md': 'var(--vox-shadow-md)',
				'vox-lg': 'var(--vox-shadow-lg)',
			},
			// common colors to use, ordered light to dark

			colors: {
				'vox-bg-1': 'var(--vox-bg-1)',
				'vox-bg-1-alt': 'var(--vox-bg-1-alt)',
				'vox-bg-2': 'var(--vox-bg-2)',
				'vox-bg-2-alt': 'var(--vox-bg-2-alt)',
				'vox-bg-2-hover': 'var(--vox-bg-2-hover)',
				'vox-bg-3': 'var(--vox-bg-3)',


				'vox-fg-0': 'var(--vox-fg-0)',
				'vox-fg-1': 'var(--vox-fg-1)',
				'vox-fg-2': 'var(--vox-fg-2)',
				'vox-fg-3': 'var(--vox-fg-3)',
				// 'vox-fg-4': 'var(--vscode-tab-inactiveForeground)',
				'vox-fg-4': 'var(--vox-fg-4)',

				'vox-warning': 'var(--vox-warning)',
				'vox-warning-soft': 'var(--vox-warning-soft)',
				'vox-warning-border': 'var(--vox-warning-border)',

				'vox-border-1': 'var(--vox-border-1)',
				'vox-border-2': 'var(--vox-border-2)',
				'vox-border-3': 'var(--vox-border-3)',
				'vox-border-4': 'var(--vox-border-4)',

				'vox-ring-color': 'var(--vox-ring-color)',
				'vox-link-color': 'var(--vox-link-color)',

				// Vox: sistema grafico (vedi styles.css)
				'vox-accent': 'var(--vox-accent)',
				'vox-accent-fg': 'var(--vox-accent-fg)',
				'vox-accent-hover': 'var(--vox-accent-hover)',
				'vox-accent-soft': 'var(--vox-accent-soft)',
				'vox-accent-softer': 'var(--vox-accent-softer)',
				'vox-accent-border': 'var(--vox-accent-border)',
				'vox-accent-text': 'var(--vox-accent-text)',
				'vox-surface': 'var(--vox-surface)',
				'vox-surface-hover': 'var(--vox-surface-hover)',
				'vox-surface-raised': 'var(--vox-surface-raised)',
				'vox-hairline': 'var(--vox-hairline)',
				'vox-hairline-strong': 'var(--vox-hairline-strong)',
				'vox-success': 'var(--vox-success)',
				'vox-danger': 'var(--vox-danger)',
				'vox-danger-soft': 'var(--vox-danger-soft)',
				'vox-danger-border': 'var(--vox-danger-border)',
				'vox-info': 'var(--vox-info)',

				vscode: {
					// see: https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content

					// base colors
					'fg': 'var(--vscode-foreground)',
					'focus-border': 'var(--vscode-focusBorder)',
					'disabled-fg': 'var(--vscode-disabledForeground)',
					'widget-border': 'var(--vscode-widget-border)',
					'widget-shadow': 'var(--vscode-widget-shadow)',
					'selection-bg': 'var(--vscode-selection-background)',
					'description-fg': 'var(--vscode-descriptionForeground)',
					'error-fg': 'var(--vscode-errorForeground)',
					'icon-fg': 'var(--vscode-icon-foreground)',
					'sash-hover-border': 'var(--vscode-sash-hoverBorder)',

					// text colors
					'text-blockquote-bg': 'var(--vscode-textBlockQuote-background)',
					'text-blockquote-border': 'var(--vscode-textBlockQuote-border)',
					'text-codeblock-bg': 'var(--vscode-textCodeBlock-background)',
					'text-link-active-fg': 'var(--vscode-textLink-activeForeground)',
					'text-link-fg': 'var(--vscode-textLink-foreground)',
					'text-preformat-fg': 'var(--vscode-textPreformat-foreground)',
					'text-preformat-bg': 'var(--vscode-textPreformat-background)',
					'text-separator-fg': 'var(--vscode-textSeparator-foreground)',

					// input colors
					'input-bg': 'var(--vscode-input-background)',
					'input-border': 'var(--vscode-input-border)',
					'input-fg': 'var(--vscode-input-foreground)',
					'input-placeholder-fg': 'var(--vscode-input-placeholderForeground)',
					'input-active-bg': 'var(--vscode-input-activeBackground)',
					'input-option-active-border': 'var(--vscode-inputOption-activeBorder)',
					'input-option-active-fg': 'var(--vscode-inputOption-activeForeground)',
					'input-option-hover-bg': 'var(--vscode-inputOption-hoverBackground)',
					'input-validation-error-bg': 'var(--vscode-inputValidation-errorBackground)',
					'input-validation-error-fg': 'var(--vscode-inputValidation-errorForeground)',
					'input-validation-error-border': 'var(--vscode-inputValidation-errorBorder)',
					'input-validation-info-bg': 'var(--vscode-inputValidation-infoBackground)',
					'input-validation-info-fg': 'var(--vscode-inputValidation-infoForeground)',
					'input-validation-info-border': 'var(--vscode-inputValidation-infoBorder)',
					'input-validation-warning-bg': 'var(--vscode-inputValidation-warningBackground)',
					'input-validation-warning-fg': 'var(--vscode-inputValidation-warningForeground)',
					'input-validation-warning-border': 'var(--vscode-inputValidation-warningBorder)',

					// command center colors (the top bar)
					'commandcenter-fg': 'var(--vscode-commandCenter-foreground)',
					'commandcenter-active-fg': 'var(--vscode-commandCenter-activeForeground)',
					'commandcenter-bg': 'var(--vscode-commandCenter-background)',
					'commandcenter-active-bg': 'var(--vscode-commandCenter-activeBackground)',
					'commandcenter-border': 'var(--vscode-commandCenter-border)',
					'commandcenter-inactive-fg': 'var(--vscode-commandCenter-inactiveForeground)',
					'commandcenter-inactive-border': 'var(--vscode-commandCenter-inactiveBorder)',
					'commandcenter-active-border': 'var(--vscode-commandCenter-activeBorder)',
					'commandcenter-debugging-bg': 'var(--vscode-commandCenter-debuggingBackground)',

					// badge colors
					'badge-fg': 'var(--vscode-badge-foreground)',
					'badge-bg': 'var(--vscode-badge-background)',

					// button colors
					'button-bg': 'var(--vscode-button-background)',
					'button-fg': 'var(--vscode-button-foreground)',
					'button-border': 'var(--vscode-button-border)',
					'button-separator': 'var(--vscode-button-separator)',
					'button-hover-bg': 'var(--vscode-button-hoverBackground)',
					'button-secondary-fg': 'var(--vscode-button-secondaryForeground)',
					'button-secondary-bg': 'var(--vscode-button-secondaryBackground)',
					'button-secondary-hover-bg': 'var(--vscode-button-secondaryHoverBackground)',

					// checkbox colors
					'checkbox-bg': 'var(--vscode-checkbox-background)',
					'checkbox-fg': 'var(--vscode-checkbox-foreground)',
					'checkbox-border': 'var(--vscode-checkbox-border)',
					'checkbox-select-bg': 'var(--vscode-checkbox-selectBackground)',

					// sidebar colors
					'sidebar-bg': 'var(--vscode-sideBar-background)',
					'sidebar-fg': 'var(--vscode-sideBar-foreground)',
					'sidebar-border': 'var(--vscode-sideBar-border)',
					'sidebar-drop-bg': 'var(--vscode-sideBar-dropBackground)',
					'sidebar-title-fg': 'var(--vscode-sideBarTitle-foreground)',
					'sidebar-header-bg': 'var(--vscode-sideBarSectionHeader-background)',
					'sidebar-header-fg': 'var(--vscode-sideBarSectionHeader-foreground)',
					'sidebar-header-border': 'var(--vscode-sideBarSectionHeader-border)',
					'sidebar-activitybartop-border': 'var(--vscode-sideBarActivityBarTop-border)',
					'sidebar-title-bg': 'var(--vscode-sideBarTitle-background)',
					'sidebar-title-border': 'var(--vscode-sideBarTitle-border)',
					'sidebar-stickyscroll-bg': 'var(--vscode-sideBarStickyScroll-background)',
					'sidebar-stickyscroll-border': 'var(--vscode-sideBarStickyScroll-border)',
					'sidebar-stickyscroll-shadow': 'var(--vscode-sideBarStickyScroll-shadow)',

					// other colors (these are partially complete)

					// text formatting
					'text-preformat-bg': 'var(--vscode-textPreformat-background)',
					'text-preformat-fg': 'var(--vscode-textPreformat-foreground)',

					// editor colors
					'editor-bg': 'var(--vscode-editor-background)',
					'editor-fg': 'var(--vscode-editor-foreground)',



					// other
					'editorwidget-bg': 'var(--vscode-editorWidget-background)',
					'toolbar-hover-bg': 'var(--vscode-toolbar-hoverBackground)',
					'toolbar-foreground': 'var(--vscode-editorActionList-foreground)',

					'editorwidget-fg': 'var(--vscode-editorWidget-foreground)',
					'editorwidget-border': 'var(--vscode-editorWidget-border)',

					'charts-orange': 'var(--vscode-charts-orange)',
					'charts-yellow': 'var(--vscode-charts-yellow)',
				},
			},
		},
	},
	plugins: [
		require('@tailwindcss/typography')
	],
	prefix: 'vox-'
}

