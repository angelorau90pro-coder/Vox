/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { t } from '../../../../common/voxI18n.js';
import React, { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useSettingsState } from '../util/services.js';
import { errorDetails } from '../../../../common/sendLLMMessageTypes.js';


export const ErrorDisplay = ({
	message: message_,
	fullError,
	onDismiss,
	showDismiss,
}: {
	message: string,
	fullError: Error | null,
	onDismiss: (() => void) | null,
	showDismiss?: boolean,
}) => {
	const [isExpanded, setIsExpanded] = useState(false);

	const details = errorDetails(fullError)
	const isExpandable = !!details

	const message = message_ + ''

	return (
		<div role='alert' aria-atomic='true' className={`rounded-vox-lg border border-vscode-input-validation-error-border bg-vscode-input-validation-error-bg px-3.5 py-3 overflow-auto @@vox-fade-up`}>
			{/* Header */}
			<div className='flex items-start justify-between gap-2'>
				<div className='flex gap-2.5 min-w-0'>
					<AlertCircle className='h-4 w-4 text-vscode-error-fg mt-0.5 flex-shrink-0' aria-hidden='true' />
					<div className='flex-1 min-w-0'>
						<h3 className='font-semibold text-[13px] text-vscode-error-fg'>
							{/* eg Error */}
							{t("Error")}</h3>
						<p className='text-vscode-error-fg text-[12.5px] leading-snug mt-1 break-words'>
							{/* eg Something went wrong */}
							{message}
						</p>
					</div>
				</div>

				<div className='flex gap-2'>
					{isExpandable && (
						<button
							type='button'
							aria-expanded={isExpanded}
							aria-label={isExpanded ? t("Hide error details") : t("Show error details")}
							className='text-vscode-error-fg opacity-80 hover:opacity-100 hover:bg-vox-surface-hover p-1 rounded-vox-sm transition-colors'
							onClick={() => setIsExpanded(!isExpanded)}
						>
							{isExpanded ? (
								<ChevronUp className='h-4 w-4' aria-hidden='true' />
							) : (
								<ChevronDown className='h-4 w-4' aria-hidden='true' />
							)}
						</button>
					)}
					{showDismiss && onDismiss && (
						<button
							type='button'
							aria-label={t("Dismiss error")}
							className='text-vscode-error-fg opacity-80 hover:opacity-100 hover:bg-vox-surface-hover p-1 rounded-vox-sm transition-colors'
							onClick={onDismiss}
						>
							<X className='h-4 w-4' aria-hidden='true' />
						</button>
					)}
				</div>
			</div>

			{/* Expandable Details */}
			{isExpanded && details && (
				<div className='mt-4 space-y-3 border-t border-vscode-input-validation-error-border pt-3 overflow-auto'>
					<div>
						<span className='font-semibold text-vscode-error-fg'>{t("Full Error:")} </span>
						<pre className='text-vscode-error-fg whitespace-pre-wrap break-words'>{details}</pre>
					</div>
				</div>
			)}
		</div>
	);
};
