/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Color, RGBA } from '../../../../../base/common/color.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';

// editCodeService colors
const sweepBG = new Color(new RGBA(100, 100, 100, .2));
const highlightBG = new Color(new RGBA(100, 100, 100, .1));
const sweepIdxBG = new Color(new RGBA(100, 100, 100, .5));

const acceptBG = new Color(new RGBA(155, 185, 85, .1)); // default is RGBA(155, 185, 85, .2)
const rejectBG = new Color(new RGBA(255, 0, 0, .1)); // default is RGBA(255, 0, 0, .2)

// Widget colors (Vox: verde e rosso più morbidi, intonati all'accento verde acqua dei temi Vox)
export const acceptAllBg = 'rgb(28, 138, 96)'
export const acceptBg = 'rgb(24, 122, 85)'
export const acceptBorder = '1px solid rgb(18, 98, 68)'

export const rejectAllBg = 'rgb(200, 64, 78)'
export const rejectBg = 'rgb(178, 52, 66)'
export const rejectBorder = '1px solid rgb(140, 40, 52)'

export const buttonFontSize = '11px'
export const buttonTextColor = 'white'



const configOfBG = (color: Color) => {
	return { dark: color, light: color, hcDark: color, hcLight: color, }
}

// gets converted to --vscode-vox-greenBG, see vox.css, asCssVariable
registerColor('vox.greenBG', configOfBG(acceptBG), '', true);
registerColor('vox.redBG', configOfBG(rejectBG), '', true);
registerColor('vox.sweepBG', configOfBG(sweepBG), '', true);
registerColor('vox.highlightBG', configOfBG(highlightBG), '', true);
registerColor('vox.sweepIdxBG', configOfBG(sweepIdxBG), '', true);
