/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../../../common/voxI18n.js';
import { useEffect, useRef, useState } from 'react';
import { useAccessor, useIsDark, useSettingsState } from '../util/services.js';
import { Bot, Check, ChevronRight, Cpu, MessagesSquare, ShieldCheck, SquareTerminal } from 'lucide-react';
import { FeatureName, isFeatureNameDisabled } from '../../../../common/voxSettingsTypes.js';
import { CliAgentDiscovery, SettingsForProvider, ModelDump } from '../vox-settings-tsx/Settings.js';
import { ColorScheme } from '../../../../../../../platform/theme/common/theme.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { isLinux } from '../../../../../../../base/common/platform.js';

const OVERRIDE_VALUE = false

export const VoxOnboarding = () => {

	const voxSettingsState = useSettingsState()
	const isOnboardingComplete = voxSettingsState.globalSettings.isOnboardingComplete || OVERRIDE_VALUE

	const isDark = useIsDark()

	// chiuso il benvenuto, il focus non resta su un suo pulsante durante la dissolvenza (il contenitore è già aria-hidden)
	const overlayRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const active = document.activeElement
		if (isOnboardingComplete && active instanceof HTMLElement && overlayRef.current?.contains(active)) {
			active.blur()
		}
	}, [isOnboardingComplete])

	return (
		<div className={`@@vox-scope ${isDark ? 'dark' : ''}`}>
			<div
				ref={overlayRef}
				className={`
					bg-vox-bg-3 fixed top-0 right-0 bottom-0 left-0 w-full z-[99999] overflow-auto
					transition-all duration-1000 ${isOnboardingComplete ? 'opacity-0 pointer-events-none invisible' : 'opacity-100 pointer-events-auto visible'}
				`}
				aria-hidden={isOnboardingComplete || undefined}
				style={{
					height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
					// alone discreto dell'accento in alto: dà profondità senza immagini
					backgroundImage: 'radial-gradient(ellipse 70% 45% at 50% -5%, var(--vox-accent-soft), transparent 70%)',
				}}
			>
				<ErrorBoundary>
					<VoxOnboardingContent />
				</ErrorBoundary>
			</div>
		</div>
	)
}

const VoxIcon = () => {
	const accessor = useAccessor()
	const themeService = accessor.get('IThemeService')

	const divRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		// vox icon style
		const updateTheme = () => {
			const theme = themeService.getColorTheme().type
			const isDark = theme === ColorScheme.DARK || theme === ColorScheme.HIGH_CONTRAST_DARK
			if (divRef.current) {
				divRef.current.style.maxWidth = '160px'
				divRef.current.style.opacity = '85%'
				// hue-rotate riporta il verde acqua del marchio al suo colore dopo l'inversione (senza diventa rosa)
				divRef.current.style.filter = isDark ? '' : 'invert(1) hue-rotate(180deg)'
			}
		}
		updateTheme()
		const d = themeService.onDidColorThemeChange(updateTheme)
		return () => d.dispose()
	}, [])

	return <div ref={divRef} className='@@vox-vox-icon' />
}

const FADE_DURATION_MS = 2000

const FadeIn = ({ children, className, delayMs = 0, durationMs, ...props }: { children: React.ReactNode, delayMs?: number, durationMs?: number, className?: string } & React.HTMLAttributes<HTMLDivElement>) => {

	const [opacity, setOpacity] = useState(0)

	const effectiveDurationMs = durationMs ?? FADE_DURATION_MS

	useEffect(() => {

		const timeout = setTimeout(() => {
			setOpacity(1)
		}, delayMs)

		return () => clearTimeout(timeout)
	}, [setOpacity, delayMs])


	return (
		<div className={className} style={{ opacity, transition: `opacity ${effectiveDurationMs}ms ease-in-out` }} {...props}>
			{children}
		</div>
	)
}

// Onboarding

// =============================================
//  New AddProvidersPage Component and helpers
// =============================================

const tabNames = ['CLI AI', 'Local AI'] as const;

type TabName = typeof tabNames[number];

const descriptionOfTab: Record<TabName, string> = {
	'CLI AI': t("Use your installed CLIs. Detection checks commands, not login or model availability."),
	'Local AI': t("Vox finds its local AI folder (ia-locali) automatically. The models found appear below."),
};


const featureNameMap: { display: string, featureName: FeatureName }[] = [
	{ display: t("Chat"), featureName: 'Chat' },
	{ display: t("Quick Edit"), featureName: 'Ctrl+K' },
	{ display: t("Autocomplete"), featureName: 'Autocomplete' },
	{ display: t("Fast Apply"), featureName: 'Apply' },
	{ display: t("Source Control"), featureName: 'SCM' },
];

const AddProvidersPage = ({ pageIndex, setPageIndex, detectedCli, onDetected, onFinish, isOnboardingComplete }: { pageIndex: number, setPageIndex: (index: number) => void, onFinish: () => void, isOnboardingComplete: boolean, detectedCli: string[], onDetected: (agents: string[]) => void }) => {
	const [currentTab, setCurrentTab] = useState<TabName>('CLI AI');
	const settingsState = useSettingsState();
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Clear error message after 5 seconds
	useEffect(() => {
		let timeoutId: NodeJS.Timeout | null = null;

		if (errorMessage) {
			timeoutId = setTimeout(() => {
				setErrorMessage(null);
			}, 5000);
		}

		// Cleanup function to clear the timeout if component unmounts or error changes
		return () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
	}, [errorMessage]);

	return (<div className="flex flex-col md:flex-row w-full h-[80vh] min-h-0 gap-6 md:gap-10 max-w-[980px] mx-auto relative px-4 overflow-y-auto md:overflow-visible">
		{/* Left Column: sotto md sta sopra, alta quanto il suo contenuto; da md è una colonna fissa che scorre da sola */}
		<div className="md:w-64 w-full flex flex-col gap-6 pt-6 md:pt-10 md:h-full md:overflow-y-auto shrink-0">
			<div>
				<div className="@@vox-eyebrow mb-1.5">{t("Step {0} of {1}", 2, 2)}</div>
				<div className="text-[22px] font-semibold tracking-tight text-vox-fg-1 leading-tight">{t("Choose your AI")}</div>
				<div className="text-[13px] text-vox-fg-3 mt-1.5 leading-snug">{t("You can change this at any time in Vox's Settings.")}</div>
			</div>

			{/* Tab Selector */}
			{/* due pulsanti a scelta (aria-pressed): il riquadro a destra non è un pannello di schede, quindi niente ruoli tab */}
			<div className="flex md:flex-col gap-2" role='group' aria-label={t("Choose your AI")}>
				{tabNames.map(tab => {
					const TabIcon = tab === 'CLI AI' ? SquareTerminal : Cpu
					const isActive = currentTab === tab
					return <button
						type='button'
						aria-pressed={isActive}
						key={tab}
						className={`flex items-start gap-3 py-3 px-3.5 rounded-vox-lg text-left border transition-colors duration-150 flex-1 md:flex-none ${isActive
							? 'bg-vox-accent-softer border-vox-accent-border'
							: 'bg-vox-surface border-vox-hairline hover:bg-vox-surface-hover hover:border-vox-hairline-strong'
							}`}
						onClick={() => {
							setCurrentTab(tab);
							setErrorMessage(null); // Reset error message when changing tabs
						}}
					>
						<span aria-hidden='true' className={`flex-shrink-0 size-8 rounded-vox-md flex items-center justify-center ${isActive ? 'bg-vox-accent text-vox-accent-fg' : 'bg-vox-surface-hover text-vox-fg-3'}`}>
							<TabIcon size={16} />
						</span>
						<span className='min-w-0'>
							<span className={`block text-[13.5px] font-medium ${isActive ? 'text-vox-fg-1' : 'text-vox-fg-2'}`}>{t(tab)}</span>
							<span className='hidden md:block text-[11.5px] text-vox-fg-3 leading-snug mt-0.5'>{tab === 'CLI AI' ? t("AI command-line tools installed on this PC") : t("Models running on this PC")}</span>
						</span>
					</button>
				})}
			</div>

			{/* Feature Checklist */}
			<div className="@@vox-card p-3.5 text-[12.5px]">
				<div className="@@vox-eyebrow mb-2.5">{t("Features ready")}</div>
				<div className="flex flex-col gap-2">
					{featureNameMap.map(({ display, featureName }) => {
						const hasModel = settingsState.modelSelectionOfFeature[featureName] !== null
							&& (featureName !== 'Autocomplete' || settingsState.globalSettings.enableAutocomplete);
						return (
							<div key={featureName} className="flex items-center gap-2.5">
								{hasModel ? (
									<span className="size-4 rounded-full bg-vox-accent text-vox-accent-fg flex items-center justify-center flex-shrink-0"><Check size={10} strokeWidth={3.5} /></span>
								) : (
									<span className="size-4 rounded-full border-[1.5px] border-vox-hairline-strong flex-shrink-0" />
								)}
								<span className={hasModel ? 'text-vox-fg-1' : 'text-vox-fg-3'}>{display}</span>
							</div>
						);
					})}
				</div>
			</div>
		</div>

		{/* Right Column */}
		{/* sotto md scorre tutta la pagina (le due colonne una sotto l'altra); da md scorre solo questa colonna */}
		<div className="shrink-0 md:shrink md:flex-1 min-w-0 md:min-h-0 flex flex-col items-stretch justify-start md:pt-10 md:h-full md:overflow-y-auto">
			<div className="w-full max-w-xl mb-6 @@vox-fade-up" key={currentTab}>
				<div className="text-[18px] font-semibold text-vox-fg-1 w-full">{t(currentTab)}</div>
				<div className="text-[13px] text-vox-fg-3 mt-1.5 w-full leading-snug">{descriptionOfTab[currentTab]}</div>
			</div>

			{currentTab === 'CLI AI' && <div className="w-full max-w-xl mb-10">
				<CliAgentDiscovery autoDetect onDetected={onDetected} />
				<ModelDump filteredProviders={['cliAgent']} />
			</div>}

			{currentTab === 'Local AI' && <>
				<div className="w-full max-w-xl mb-6">
					<SettingsForProvider providerName='voxLocal' showProviderTitle={false} showProviderSuggestions={true} />
				</div>
				<div className="w-full max-w-xl">
					<div className="@@vox-eyebrow mb-2">{t("Models")}</div>
					<ModelDump filteredProviders={['voxLocal']} />
				</div>
			</>}



			{/* Navigation buttons in right column */}
			<div className="flex flex-col items-end w-full max-w-xl mt-auto pt-8 pb-2">
				{errorMessage && (
					<div role='alert' className="text-vox-fg-1 bg-vox-warning-soft border border-vox-warning-border rounded-vox-md px-3 py-2 mb-3 text-[12.5px] @@vox-fade-up">{errorMessage}</div>
				)}
				<div className="flex items-center gap-2">
					<PreviousButton onClick={() => setPageIndex(pageIndex - 1)} />
					{/* ultima pagina del primo avvio: con un motore pronto si entra in Vox */}
					<PrimaryActionButton
						ringSize={isOnboardingComplete ? 'screen' : undefined}
						onClick={() => {
							const isDisabled = isFeatureNameDisabled('Chat', settingsState)

							if (!isDisabled || settingsState.settingsOfProvider.cliAgent.models.some(m => !m.isHidden && detectedCli.includes(m.modelName))) {
								setErrorMessage(null);
								onFinish();
							} else {
								// Show error message
								setErrorMessage(t("Detect an installed CLI or set up the local AI before continuing."));
							}
						}}
					>{t("Enter Vox")}</PrimaryActionButton>
				</div>
			</div>
		</div>
	</div>);
};

const PreviousButton = ({ onClick, ...props }: { onClick: () => void } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
	return (
		<button
			type='button'
			onClick={onClick}
			className="@@vox-btn @@vox-btn-ghost @@vox-btn-lg"
			{...props}
		>
			{t("Back")}</button>
	)
}



const OnboardingPageShell = ({ top, bottom, content, hasMaxWidth = true, className = '', }: {
	top?: React.ReactNode,
	bottom?: React.ReactNode,
	content?: React.ReactNode,
	hasMaxWidth?: boolean,
	className?: string,
}) => {
	return (
		<div className={`h-[80vh] text-lg flex flex-col gap-4 w-full mx-auto ${hasMaxWidth ? 'max-w-[600px]' : ''} ${className}`}>
			{top && <FadeIn className='w-full mb-auto pt-16'>{top}</FadeIn>}
			{content && <FadeIn className='w-full my-auto'>{content}</FadeIn>}
			{bottom && <div className='w-full pb-8'>{bottom}</div>}
		</div>
	)
}

const YesNoText = ({ val }: { val: boolean | null }) => {

	return <div
		className={
			val === true ? "text text-emerald-500"
				: val === false ? 'text-rose-600'
					: "text text-amber-300"
		}
	>
		{
			val === true ? t("Yes")
				: val === false ? t("No")
					: t("Yes*")
		}
	</div>

}



const abbreviateNumber = (num: number): string => {
	if (num >= 1000000) {
		// For millions
		return Math.floor(num / 1000000) + 'M';
	} else if (num >= 1000) {
		// For thousands
		return Math.floor(num / 1000) + 'K';
	} else {
		// For numbers less than 1000
		return num.toString();
	}
}





const PrimaryActionButton = ({ children, className, ringSize, ...props }: { children: React.ReactNode, ringSize?: undefined | 'xl' | 'screen' } & React.ButtonHTMLAttributes<HTMLButtonElement>) => {


	return (
		<button
			type='button'
			className={`
				flex items-center justify-center

				text-vox-accent-fg font-medium
				bg-vox-accent hover:bg-vox-accent-hover
				shadow-vox-md

				${ringSize === 'xl' ? `
					gap-2 px-16 py-8
					transition-all duration-300 ease-in-out
					`
					: ringSize === 'screen' ? `
					gap-2 px-16 py-8
					transition-all duration-1000 ease-in-out
					`: ringSize === undefined ? `
					gap-1.5 pl-5 pr-4 py-2.5 text-[14px]
					transition-all duration-200 ease-in-out
				`: ''}

				rounded-vox-lg
				group
				${className ?? ''}
			`}
			{...props}
		>
			{children}
			<ChevronRight
				size={17}
				aria-hidden='true'
				className={`
					transition-transform duration-200 ease-in-out

					transform
					group-hover:translate-x-0.5
					group-active:translate-x-1
				`}
			/>
		</button>
	)
}


const VoxOnboardingContent = () => {


	const accessor = useAccessor()
	const voxSettingsService = accessor.get('IVoxSettingsService')

	const voxSettingsState = useSettingsState()

	const [pageIndex, setPageIndex] = useState(0)
	const [detectedCli, setDetectedCli] = useState<string[]>([])

	const finishOnboarding = async () => {
		const state = voxSettingsService.state
		const firstCli = detectedCli.find(agent => state.settingsOfProvider.cliAgent.models.some(m => !m.isHidden && m.modelName === agent))
		if (!state.modelSelectionOfFeature.Chat && firstCli) {
			for (const feature of ['Chat', 'Ctrl+K', 'Apply', 'SCM'] as const) {
				if (!voxSettingsService.state.modelSelectionOfFeature[feature]) {
					await voxSettingsService.setModelSelectionOfFeature(feature, { providerName: 'cliAgent', modelName: firstCli })
				}
			}
		}
		await voxSettingsService.setGlobalSetting('isOnboardingComplete', true)
	}

	// reset the page to page 0 if the user redos onboarding
	useEffect(() => {
		if (!voxSettingsState.globalSettings.isOnboardingComplete) {
			setPageIndex(0)
		}
	}, [setPageIndex, voxSettingsState.globalSettings.isOnboardingComplete])


	const contentOfIdx: { [pageIndex: number]: React.ReactNode } = {
		0: <OnboardingPageShell
			content={
				<div className='flex flex-col items-center gap-7 px-4'>
					{/* Slice of Vox image */}
					<div className='w-full h-[22vh] min-h-[120px] mx-auto flex items-center justify-center'>
						{!isLinux && <VoxIcon />}
					</div>

					<div className='text-center'>
						<div className="text-[34px] font-semibold tracking-tight text-vox-fg-1 leading-tight">{t("Welcome to Vox")}</div>
						<div className="text-[14.5px] text-vox-fg-3 mt-3 max-w-[460px] mx-auto leading-relaxed">{t("The code editor that works with the AI on your PC: local models and the command-line tools you already use.")}</div>
					</div>

					<div className='grid grid-cols-1 sm:grid-cols-3 gap-2.5 w-full max-w-[560px]'>
						{([
							[MessagesSquare, t("Chat"), t("Ask about your code")],
							[Bot, t("Agent"), t("Edits files and runs commands")],
							[ShieldCheck, t("Local AI"), t("With local models, the AI runs on your PC")],
						] as const).map(([Icon, title, desc]) => <div key={title} className='@@vox-card px-3.5 py-3 text-left'>
							<Icon size={16} aria-hidden='true' className='text-vox-accent-text mb-2' />
							<div className='text-[13px] font-medium text-vox-fg-1'>{title}</div>
							<div className='text-[11.5px] text-vox-fg-3 leading-snug mt-0.5'>{desc}</div>
						</div>)}
					</div>

					<FadeIn
						delayMs={500}
						durationMs={800}
					>
						<PrimaryActionButton
							onClick={() => { setPageIndex(1) }}
						>
							{t("Get Started")}</PrimaryActionButton>
					</FadeIn>

				</div>
			}
		/>,

		1: <OnboardingPageShell hasMaxWidth={false}
			content={
				<AddProvidersPage pageIndex={pageIndex} setPageIndex={setPageIndex} detectedCli={detectedCli} onDetected={setDetectedCli}
					onFinish={finishOnboarding} isOnboardingComplete={voxSettingsState.globalSettings.isOnboardingComplete} />
			}
		/>,
	}


	return <div key={pageIndex} className="w-full h-[80vh] text-left mx-auto flex flex-col items-center justify-center">
		<ErrorBoundary>
			{contentOfIdx[pageIndex]}
		</ErrorBoundary>
	</div>

}
