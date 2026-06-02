import * as path from '../../../../base/common/path.js';
import { ToolName } from './toolsServiceTypes.js';

export type OperationCategory =
	| 'edit_existing'
	| 'edit_sensitive'
	| 'create_new'
	| 'delete'
	| 'terminal'
	| 'read_only';

export interface OperationClassification {
	category: OperationCategory;
	requiresApproval: boolean;
	approvalReason?: string;
	dangerLevel: 'safe' | 'caution' | 'danger';
}

// Sensitive file patterns — matched against filename and full path
export const SENSITIVE_FILE_PATTERNS: RegExp[] = [
	/^\.env(\..+)?$/i,                              // .env, .env.local, .env.production
	/\.(key|pem|cert|crt|p12|pfx|jks)$/i,          // crypto/TLS files
	/^(secrets?|credentials?|auth)\.(json|yaml|yml|toml|ini)$/i,
	/^\.secrets?$/i,
	/^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i,      // SSH keys
	/^\.npmrc$/i,
	/^\.yarnrc(\.yml)?$/i,
	/^\.pypirc$/i,
	/^\.gitconfig$/i,
	/^\.docker\/config\.json$/i,
	/^(database|db)\.(json|yaml|yml|toml|config\.js|config\.ts)$/i,
	/^(kubeconfig|kube\.config)$/i,
	/\-secret(s)?\.(yaml|yml|json)$/i,
	/^(firebase|gcp|aws)\.(json|config|credentials)$/i,
	/^\.aws\/(credentials|config)$/i,
	/^service[_-]?account.*\.json$/i,
	/^config\.(production|prod|staging|live)\.(js|ts|json|yaml|yml)$/i,
];

export function isSensitiveFile(filePath: string): boolean {
	const filename = path.basename(filePath);
	return SENSITIVE_FILE_PATTERNS.some(p => p.test(filename) || p.test(filePath));
}

function classifyCommandDanger(cmd: string): 'safe' | 'caution' | 'danger' {
	const c = cmd.trim().toLowerCase();

	// Red: definitely destructive or escalation
	const dangerPatterns = [
		/\brm\b/, /\brmdir\b/, /\bdel\b/, /\brd\b/,
		/\bformat\b/, /\bfdisk\b/, /\bdd\b/,
		/\bsudo\b/,
		/curl.+\|\s*(sh|bash)/, /wget.+\|\s*(sh|bash)/,
		/\bgit\s+reset\s+--hard\b/,
		/\bgit\s+push.+--force\b/,
		/\bnpm\s+publish\b/, /\byarn\s+publish\b/,
		/\bdrop\s+table\b/,
		/\bkill\b/, /\bpkill\b/, /\bkillall\b/,
		/\bchmod\s+[0-7]*7[0-7]*7/,
	];
	if (dangerPatterns.some(p => p.test(c))) return 'danger';

	// Yellow: side effects possible
	const cautionPatterns = [
		/\bmv\b/, /\bcp\b/, /\bchmod\b/, /\bchown\b/,
		/\bgit\s+(push|merge|rebase)\b/,
		/\bnpm\s+install\b/, /\byarn\s+add\b/, /\bpip\s+install\b/,
		/\bdocker\b/, /\bkubectl\b/,
	];
	if (cautionPatterns.some(p => p.test(c))) return 'caution';

	return 'safe';
}

// Maps Void tool names to classification.
export function classifyVoidToolCall(
	toolName: ToolName,
	toolInput: Record<string, unknown>
): OperationClassification {

	switch (toolName) {

		case 'read_file':
		case 'ls_dir':
		case 'get_dir_tree':
		case 'search_pathnames_only':
		case 'search_for_files':
		case 'search_in_file':
		case 'read_lint_errors':
			return { category: 'read_only', requiresApproval: false, dangerLevel: 'safe' };

		case 'create_file':
		case 'create_folder': {
			const uriObj = toolInput.uri as any;
			const filePath = String(uriObj?.path ?? uriObj?.fsPath ?? '');
			if (isSensitiveFile(filePath)) {
				return {
					category: 'edit_sensitive', requiresApproval: true,
					approvalReason: `Creating sensitive file: ${path.basename(filePath)}`,
					dangerLevel: 'caution'
				};
			}
			return {
				category: 'create_new', requiresApproval: false,
				approvalReason: `Creating new file or folder: ${path.basename(filePath)}`,
				dangerLevel: 'safe'
			};
		}

		case 'edit_file':
		case 'rewrite_file': {
			const uriObj = toolInput.uri as any;
			const filePath = String(uriObj?.path ?? uriObj?.fsPath ?? '');
			if (isSensitiveFile(filePath)) {
				return {
					category: 'edit_sensitive', requiresApproval: true,
					approvalReason: `Editing sensitive file: ${path.basename(filePath)}`,
					dangerLevel: 'caution'
				};
			}
			return { category: 'edit_existing', requiresApproval: false, dangerLevel: 'safe' };
		}

		case 'delete_file_or_folder': {
			const uriObj = toolInput.uri as any;
			const filePath = String(uriObj?.path ?? uriObj?.fsPath ?? '');
			return {
				category: 'delete', requiresApproval: true,
				approvalReason: `Permanently deleting: ${path.basename(filePath)}`,
				dangerLevel: 'danger'
			};
		}

		case 'run_command':
		case 'run_persistent_command':
		case 'open_persistent_terminal':
		case 'kill_persistent_terminal': {
			const command = String(toolInput.command ?? '');
			const danger = classifyCommandDanger(command);
			return {
				category: 'terminal', 
				requiresApproval: danger !== 'safe',
				approvalReason: `Run terminal command: ${command}`,
				dangerLevel: danger
			};
		}

		default:
			// Unknown tool (e.g. MCP tools) — always ask. Never auto-approve the unknown.
			return {
				category: 'terminal', requiresApproval: true,
				approvalReason: `Unknown or external tool call: ${toolName}`,
				dangerLevel: 'caution'
			};
	}
}
