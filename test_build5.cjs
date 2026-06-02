const fs = require('fs');
const { execSync } = require('child_process');

const path = 'n:/void-1/src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarChat.tsx';
const originalC = fs.readFileSync(path, 'utf8');

let c = originalC;
let errStart = c.indexOf(`\t\t{/* error message */}`);
let errEnd = c.indexOf(`\t</ScrollToBottomContainer>`);
if (errStart !== -1 && errEnd !== -1) {
	c = c.slice(0, errStart) + '\t\t{/* error message removed */}\n' + c.slice(errEnd);
}
fs.writeFileSync(path, c);

try {
	execSync('npx scope-tailwind ./src -o src2/ -s void-scope -c styles.css -p "void-"', { cwd: 'n:/void-1/src/vs/workbench/contrib/void/browser/react', stdio: 'inherit' });
	console.log('SUCCESS');
} catch (e) {
	console.log('FAILED');
}
// restore
fs.writeFileSync(path, originalC);
