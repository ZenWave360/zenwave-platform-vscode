import type * as vscode from 'vscode';
import { activate as activateShared, deactivate as deactivateShared } from '../activate.js';
import { DESKTOP_CAPABILITIES } from '../host/capabilities.js';

/**
 * Desktop (Node extension host) entry point.
 *
 * This file is the only place allowed to reach for Node APIs. Keep it thin:
 * construct host-specific services, hand them to the shared activation, and let
 * feature code stay host-agnostic.
 */
export function activate(context: vscode.ExtensionContext): void {
  activateShared(context, DESKTOP_CAPABILITIES);
}

export function deactivate(): void {
  deactivateShared();
}
