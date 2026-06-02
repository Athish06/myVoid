const fs = require('fs');
const path = 'n:/void-1/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx';
let c = fs.readFileSync(path, 'utf8');
let matches = c.match(/\{debugMsg && \([\s\S]*?<\/div>\s*\)\}/g);
console.log('Number of matches:', matches ? matches.length : 0);
if (matches) {
	console.log('Match lengths:', matches.map(m => m.length));
	console.log('Match 0 text:', matches[0]);
}
