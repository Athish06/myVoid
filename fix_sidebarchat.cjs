const fs = require('fs');
const path = 'n:/void-1/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx';
let c = fs.readFileSync(path, 'utf8');

// 1. apply dangerLevel
c = c.replace(/(const componentParams: ToolHeaderParams = \{.+?\};?)/g, '$1\n\t\t\tcomponentParams.dangerLevel = toolMessage ? classifyVoidToolCall(toolMessage.name as ToolName, toolMessage.params).dangerLevel : \'safe\';');

// 2. Hide displayContent empty messages
c = c.replace(
	`if (role === 'user') {\n\t\treturn <UserMessageComponent`,
	`if (role === 'user') {\n\t\tif (!chatMessage.displayContent || chatMessage.displayContent.trim() === '') return null;\n\t\treturn <UserMessageComponent`
);

// 3. Remove debugMsg blocks
c = c.replace(/const \[debugMsg.*?;/g, '');
c = c.replace(/setDebugMsg\(.*?\);?/g, '');
c = c.replace(/\{debugMsg && \([\s\S]*?<\/div>\s*\)\}/g, '');

// 4. Deduplicate checkpoints
c = c.replace(
	`return previousMessages.map((message, i) => {`,
	`let lastVisibleRole = null;\n\t\treturn previousMessages.map((message, i) => {\n\t\t\tlet isVisible = true;\n\t\t\tif (message.role === 'user' && (!message.displayContent || message.displayContent.trim() === '')) isVisible = false;\n\t\t\telse if (message.role === 'checkpoint') {\n\t\t\t\tif (lastVisibleRole === 'checkpoint' || lastVisibleRole === null) isVisible = false;\n\t\t\t}\n\t\t\tif (isVisible) lastVisibleRole = message.role;\n\t\t\tif (!isVisible) return null;`
);

// 5. Remove ErrorDisplay
let errStart = c.indexOf(`\t\t{/* error message */}`);
let errEnd = c.indexOf(`\t</ScrollToBottomContainer>`);
if (errStart !== -1 && errEnd !== -1) {
	c = c.slice(0, errStart) + '\t\t{/* error message removed */}\n' + c.slice(errEnd);
}

fs.writeFileSync(path, c);
console.log('Script ran successfully!');
