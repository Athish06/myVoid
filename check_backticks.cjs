const fs = require('fs');
const path = 'n:/void-1/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx';
let c = fs.readFileSync(path, 'utf8');
let idx = c.indexOf('messagesHTML = <ScrollToBottomContainer');
let textBefore = c.slice(0, idx);
console.log('Number of backticks before messagesHTML:', textBefore.split('`').length);
