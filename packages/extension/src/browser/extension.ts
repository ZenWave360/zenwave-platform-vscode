import type * as vscode from 'vscode';
import { activate as activateShared, deactivate as deactivateShared } from '../activate.js';
import { WEB_CAPABILITIES } from '../host/capabilities.js';

/**
 * Web (Web Worker extension host) entry point — vscode.dev, github.dev and
 * browser-based Codespaces.
 *
 * Nothing reachable from here may import a Node API.
 */
export function activate(context: vscode.ExtensionContext): void {
  activateShared(context, WEB_CAPABILITIES);
}

export function deactivate(): void {
  deactivateShared();
}
