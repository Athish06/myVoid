const fs = require('fs');
const { execSync } = require('child_process');

const path = 'n:/void-1/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx';
const originalC = fs.readFileSync(path, 'utf8');

function checkCompile(name, modifyFn) {
	let c = modifyFn(originalC);
	fs.writeFileSync(path, c);
	try {
		execSync('npx scope-tailwind ./src -o src2/ -s void-scope -c styles.css -p "void-"', { cwd: 'n:/void-1/src/vs/workbench/contrib/void/browser/react', stdio: 'ignore' });
		console.log(name + ': SUCCESS');
	} catch (e) {
		console.log(name + ': FAILED');
	}
}

checkCompile('3. debugMsg (fixed)', (c) => {
	c = c.replace(/const \[debugMsg.*?;/g, '');
	c = c.replace(/setDebugMsg\(.*?\);?/g, '');
	c = c.replace(/\{debugMsg && \([\s\S]*?<\/div>\s*\)\}/g, '');
	return c;
});

checkCompile('4. Checkpoint', (c) => c.replace(`return previousMessages.map((message, i) => {`, `let lastVisibleRole = null;\n\t\treturn previousMessages.map((message, i) => {\n\t\t\tlet isVisible = true;\n\t\t\tif (message.role === 'user' && (!message.displayContent || message.displayContent.trim() === '')) isVisible = false;\n\t\t\telse if (message.role === 'checkpoint') {\n\t\t\t\tif (lastVisibleRole === 'checkpoint' || lastVisibleRole === null) isVisible = false;\n\t\t\t}\n\t\t\tif (isVisible) lastVisibleRole = message.role;\n\t\t\tif (!isVisible) return null;`));

checkCompile('5. ErrorDisplay', (c) => {
	let errStart = c.indexOf(`\t\t{/* error message */}`);
	let errEnd = c.indexOf(`\t</ScrollToBottomContainer>`);
	if (errStart !== -1 && errEnd !== -1) {
		c = c.slice(0, errStart) + '\t\t{/* error message removed */}\n' + c.slice(errEnd);
	}
	return c;
});

// restore
fs.writeFileSync(path, originalC);
