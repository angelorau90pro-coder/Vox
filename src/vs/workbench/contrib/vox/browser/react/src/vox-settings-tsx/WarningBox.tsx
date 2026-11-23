import { IconWarning } from '../sidebar-tsx/SidebarChat.js';


export const WarningBox = ({ text, onClick, className }: { text: string; onClick?: () => void; className?: string }) => {

	return <div
		className={`
			text-vox-warning w-fit
			text-xs text-ellipsis
			${onClick ? `hover:underline underline-offset-2 cursor-pointer` : ''}
			flex items-center flex-nowrap gap-1.5
			${className ?? ''}
		`}
		onClick={onClick}
	>
		<IconWarning
			size={13}
			className='flex-shrink-0'
		/>
		<span>{text}</span>
	</div>
	// return <VoxSelectBox
	// 	options={[{ text: 'Please add a model!', value: null }]}
	// 	onChangeSelection={() => { }}
	// />
}
