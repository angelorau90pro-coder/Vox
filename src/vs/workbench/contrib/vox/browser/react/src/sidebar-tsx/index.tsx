/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js'
import { Sidebar } from './Sidebar.js'
import { ChatContextPage } from './ChatContext.js'

export const mountSidebar = mountFnGenerator(Sidebar)
// VOX: la scheda «Contesto della chat» nell'area centrale; sta in questo bundle per condividere bozza e misure con la chat
export const mountChatContext = mountFnGenerator(ChatContextPage)


