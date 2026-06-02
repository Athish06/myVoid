const fs = require('fs');
const path = 'n:/void-1/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx';
let c = fs.readFileSync(path, 'utf8');

// deduplicate checkpoints in previousMessagesHTML
let before = c.slice(0, c.indexOf('const previousMessagesHTML = useMemo(() => {'));
let endStr = '}, [previousMessages, threadId, currCheckpointIdx, isRunning])';
let after = c.slice(c.indexOf(endStr) + endStr.length);
let newMemo = `const previousMessagesHTML = useMemo(() => {
		let lastVisibleRole = null;
		let html = [];
		for (let i = 0; i < previousMessages.length; i++) {
			let message = previousMessages[i];
			let isVisible = true;
			if (message.role === 'user' && (!message.displayContent || message.displayContent.trim() === '')) {
				isVisible = false;
			} else if (message.role === 'checkpoint') {
				if (lastVisibleRole === 'checkpoint' || lastVisibleRole === null) {
					isVisible = false;
				}
			}
			
			if (isVisible) lastVisibleRole = message.role;
			
			if (!isVisible) continue;
			
			html.push(<ChatBubble
				key={i}
				currCheckpointIdx={currCheckpointIdx}
				chatMessage={message}
				messageIdx={i}
				isCommitted={true}
				chatIsRunning={isRunning}
				threadId={threadId}
				_scrollToBottom={() => scrollToBottom(scrollContainerRef)}
			/>);
		}
		return html;
	}, [previousMessages, threadId, currCheckpointIdx, isRunning])`;

c = before + newMemo + after;
fs.writeFileSync(path, c);
