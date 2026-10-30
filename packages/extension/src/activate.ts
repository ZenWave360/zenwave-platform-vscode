import * as vscode from 'vscode';
import {
  CONTEXT_KEYS,
  describeCapabilities,
  type HostCapabilities,
} from './host/capabilities.js';
import { Logger } from './host/logger.js';
import type { LanguageServerHost } from './lsp/client.js';
import { registerEventFlowEditor, type EventFlowApi } from './eventflow/feature.js';
import { registerModelExplorer, type ModelExplorerApi } from './explorer/feature.js';
import { registerLanguageServer, type LanguageServerApi } from './lsp/feature.js';
import { registerModelActions } from './model/actions.js';
import { registerPreviewEditor, type PreviewApi } from './preview/feature.js';
import { registerSdkFeature } from './sdk/feature.js';
import type { SdkProcessService } from './sdk/host.js';

declare const __ZENWAVE_BUILD_COMMIT__: string;

/** What the extension returns from `activate`: the shared language server connection, the explorer trees, the diagram editors and the previews. */
export interface ZenwaveExtensionApi {
  readonly languageServer: LanguageServerApi;
  readonly explorer: ModelExplorerApi;
  readonly eventflow: EventFlowApi;
  readonly preview: PreviewApi;
}

export interface HostServices {
  readonly sdkProcess?: SdkProcessService;
  readonly languageServer?: LanguageServerHost;
}

/**
 * Host-agnostic activation.
 *
 * Both entry points funnel here. Nothing in this file, or anything it imports,
 * may touch a Node API — see `esbuild.mjs` for why that boundary matters.
 */
export function activate(
  context: vscode.ExtensionContext,
  capabilities: HostCapabilities,
  services: HostServices = {},
): ZenwaveExtensionApi {
  const logger = new Logger();
  context.subscriptions.push(logger);

  logger.info(
    `ZenWave Platform activated\n  build commit:    ${__ZENWAVE_BUILD_COMMIT__}\n  ${describeCapabilities(capabilities)}`,
  );

  void publishContextKeys(capabilities);

  context.subscriptions.push(
    vscode.commands.registerCommand('zenwave.showOutput', () => logger.show()),
  );

  registerSdkFeature(context, capabilities, logger, services.sdkProcess);
  const languageServer = registerLanguageServer(
    context,
    capabilities,
    logger,
    capabilities.languageServer === 'none' ? undefined : services.languageServer,
  );
  registerModelActions(context, languageServer, logger);
  const explorer = registerModelExplorer(context, languageServer, logger);
  const eventflow = registerEventFlowEditor(context, languageServer, logger, explorer.diagramPanels);
  const preview = registerPreviewEditor(context, languageServer, logger);
  return { languageServer, explorer, eventflow, preview };
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
