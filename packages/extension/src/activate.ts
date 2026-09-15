import * as vscode from 'vscode';
import {
  CONTEXT_KEYS,
  describeCapabilities,
  type HostCapabilities,
} from './host/capabilities.js';
import { Logger } from './host/logger.js';
import { registerSdkFeature } from './sdk/feature.js';
import type { SdkProcessService } from './sdk/host.js';

declare const __ZENWAVE_BUILD_COMMIT__: string;

/**
 * Host-agnostic activation.
 *
 * Both entry points funnel here. Nothing in this file, or anything it imports,
 * may touch a Node API — see `esbuild.mjs` for why that boundary matters.
 */
export function activate(
  context: vscode.ExtensionContext,
  capabilities: HostCapabilities,
  sdkProcess?: SdkProcessService,
): void {
  const logger = new Logger();
  context.subscriptions.push(logger);

  logger.info(
    `ZenWave Platform activated\n  build commit:    ${__ZENWAVE_BUILD_COMMIT__}\n  ${describeCapabilities(capabilities)}`,
  );

  void publishContextKeys(capabilities);

  context.subscriptions.push(
    vscode.commands.registerCommand('zenwave.showOutput', () => logger.show()),
  );

  registerSdkFeature(context, capabilities, logger, sdkProcess);
}

/**
 * Mirrors capabilities into context keys so `package.json` `when` clauses can
 * hide controls that cannot work here.
 */
async function publishContextKeys(capabilities: HostCapabilities): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    CONTEXT_KEYS.canRunSdk,
    capabilities.canRunProcesses,
  );
  await vscode.commands.executeCommand(
    'setContext',
    CONTEXT_KEYS.canUseTerminal,
    capabilities.canUseTerminal,
  );
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}
