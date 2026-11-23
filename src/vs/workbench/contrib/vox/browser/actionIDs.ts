// Normally you'd want to put these exports in the files that register them, but if you do that you'll get an import order error if you import them in certain cases.
// (importing them runs the whole file to get the ID, causing an import error). I guess it's best practice to separate out IDs, pretty annoying...

export const VOX_CTRL_L_ACTION_ID = 'vox.ctrlLAction'

// VOX: apre (o porta in primo piano) la scheda «Contesto della chat» nell'area centrale
export const VOX_OPEN_CHAT_CONTEXT_ACTION_ID = 'workbench.action.vox.openChatContext'

export const VOX_CTRL_K_ACTION_ID = 'vox.ctrlKAction'

export const VOX_ACCEPT_DIFF_ACTION_ID = 'vox.acceptDiff'

export const VOX_REJECT_DIFF_ACTION_ID = 'vox.rejectDiff'

export const VOX_GOTO_NEXT_DIFF_ACTION_ID = 'vox.goToNextDiff'

export const VOX_GOTO_PREV_DIFF_ACTION_ID = 'vox.goToPrevDiff'

export const VOX_GOTO_NEXT_URI_ACTION_ID = 'vox.goToNextUri'

export const VOX_GOTO_PREV_URI_ACTION_ID = 'vox.goToPrevUri'

export const VOX_ACCEPT_FILE_ACTION_ID = 'vox.acceptFile'

export const VOX_REJECT_FILE_ACTION_ID = 'vox.rejectFile'

export const VOX_ACCEPT_ALL_DIFFS_ACTION_ID = 'vox.acceptAllDiffs'

export const VOX_REJECT_ALL_DIFFS_ACTION_ID = 'vox.rejectAllDiffs'
