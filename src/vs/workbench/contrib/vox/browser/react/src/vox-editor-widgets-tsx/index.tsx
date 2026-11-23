/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { mountFnGenerator } from '../util/mountFnGenerator.js'
import { VoxCommandBarMain } from './VoxCommandBar.js'
import { VoxSelectionHelperMain } from './VoxSelectionHelper.js'

export const mountVoxCommandBar = mountFnGenerator(VoxCommandBarMain)

export const mountVoxSelectionHelper = mountFnGenerator(VoxSelectionHelperMain)

