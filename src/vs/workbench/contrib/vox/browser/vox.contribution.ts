/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/


// register inline diffs
import './editCodeService.js'

// register Sidebar pane, state, actions (keybinds, menus) (Ctrl+L)
import './sidebarActions.js'
import './sidebarPane.js'

// register quick edit (Ctrl+K)
import './quickEditActions.js'


// register Autocomplete
import './autocompleteService.js'

// settings pane
import './voxSettingsPane.js'

// scheda «Contesto della chat» nell'area centrale
import './chatContextPane.js'

// register css
import './media/vox.css'

import './convertToLLMMessageWorkbenchContrib.js'

// tools
import './toolsService.js'

// contesto di progetto (.vox/): istruzioni, memoria e conoscenza
import './projectContextService.js'
import './terminalToolService.js'

// register Thread History
import './chatThreadService.js'

// helper services
import './helperServices/consistentItemService.js'

// register selection helper
import './voxSelectionHelperWidget.js'

// register tooltip service
import './tooltipService.js'

// register onboarding service
import './voxOnboardingService.js'

// register misc service
import './miscWokrbenchContrib.js'
import './removedProvidersNoticeContrib.js'

// register file service (for explorer context menu)
import './fileService.js'

// register source control management
import './voxSCMService.js'

// ---------- common (unclear if these actually need to be imported, because they're already imported wherever they're used) ----------

// llmMessage
import '../common/sendLLMMessageService.js'

// voxSettings
import '../common/voxSettingsService.js'

// refreshModel
import '../common/refreshModelService.js'

// libreria dei modelli locali (scarico e rimozione)
import '../common/localModelLibraryService.js'

// informazioni di debug (comando "Vox: Log Debug Info")
import '../common/voxDebugInfoService.js'

// model service
import '../common/voxModelService.js'
