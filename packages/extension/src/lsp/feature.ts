import * as vscode from 'vscode';
import type { HostCapabilities } from '../host/capabilities.js';
import type { Logger } from '../host/logger.js';
import {
  languageClientTransport,
  sharedClientOptions,
  type LanguageServerHost,
  type LanguageServerTransport,
} from './client.js';
import { CREDENTIAL_REQUEST, CredentialBroker } from './credentials.js';
import type { CredentialAnswer } from './credential-policy.js';
import {
  documentSelector,
  isManifest,
  MANIFEST_SETTING,
  manifestWatchers,
  resolveWorkspaceManifest,
} from './manifest.js';
import {
  describeManifest,
  initializationOptions,
  sameInitialization,
  type ResolvedManifest,
} from './manifest-resolution.js';
import { loadPluginCatalogue, shippedCatalogueSource, type PluginCatalogueSource } from './plugin-catalogue.js';
import { ZenwaveRequests } from './requests.js';
import { languageServerStatus, presentStatus, type LanguageServerStatus } from './status.js';
import { LspSupervisor, type LspState, type RequestResult } from './supervisor.js';

/** Context keys for `when` clauses. */
export const LSP_CONTEXT_KEYS = {
  /** A language server is connected. */
  languageServerAvailable: 'zenwave.languageServerAvailable',
  /** The `zenwave/*` requests the connected server advertised (`'zenwave/preview' in zenwave.languageServerRequests`). */
  languageServerRequests: 'zenwave.languageServerRequests',
  /** An architecture manifest was resolved for the workspace. */
  manifestAvailable: 'zenwave.manifestAvailable',
} as const;

export const LSP_COMMANDS = {
  restart: 'zenwave.lsp.restart',
  showStatus: 'zenwave.lsp.showStatus',
  recordCredential: 'zenwave.credentials.record',
  clearCredential: 'zenwave.credentials.clear',
} as const;

/**
 * The one connection every server-backed feature uses. Later changes (004–007)
 * take this object and nothing else: requests through `requests`, availability
 * through `status` and `onDidChange`, the manifest through `manifest`.
 */
export interface LanguageServerApi {
  readonly transport: LanguageServerTransport;
  readonly status: LanguageServerStatus;
  readonly state: LspState;
  readonly manifest: ResolvedManifest;
  /** `zenwave/*` requests the connected server advertised; empty when none is connected. */
  readonly advertisedRequests: readonly string[];
  readonly serverInfo: { readonly name: string; readonly version?: string } | undefined;
  readonly requests: ZenwaveRequests;
  /** Issue any `zenwave/*` request; answers with the four-way result, never throws. */
  request(method: string, params: unknown): Promise<RequestResult>;
  /** Fires when the server connects, disconnects or reconnects, or the manifest changes. */
  readonly onDidChange: vscode.Event<void>;
  /** Resolves once the current start, stop or restart has settled. */
  settled(): Promise<void>;
  restart(): Promise<void>;
  /** The `zenwave/credential` handler, exposed for tests. */
  answerCredential(params: unknown): Promise<CredentialAnswer | null>;
  /** A test seam: the source the next start takes the plugin catalogue from instead of the shipped one; `undefined` restores it. */
  overridePluginCatalogue(source: PluginCatalogueSource | undefined): void;
}

interface LspSettings {
  readonly enabled: boolean;
  readonly serverPath: string | undefined;
}

function readSettings(): LspSettings {
  const settings = vscode.workspace.getConfiguration('zenwave.lsp');
  const serverPath = settings.get<string>('serverPath', '').trim();
  return { enabled: settings.get<boolean>('enabled', true), serverPath: serverPath || undefined };
}

const MODEL_LANGUAGES = new Set(['zdl', 'zw', 'zfl']);

export function registerLanguageServer(
  context: vscode.ExtensionContext,
  capabilities: HostCapabilities,
  logger: Logger,
  host: LanguageServerHost | undefined,
): LanguageServerApi {
  const changed = new vscode.EventEmitter<void>();
  const credentials = new CredentialBroker(context.secrets, context.globalState, logger);
  let manifest: ResolvedManifest = { route: 'none', notes: [] };
  let settings = readSettings();
  let absentReason: string | undefined = host ? undefined : 'no language server transport is available in this host';
  let pending: Promise<void> = Promise.resolve();
  let watchers: vscode.FileSystemWatcher[] = [];
  let lastState: LspState['kind'] = 'unavailable';
  let transport: ReturnType<typeof languageClientTransport> | undefined;
  let startError = 'language server was not located';
  let catalogueSource: PluginCatalogueSource = shippedCatalogueSource;

  const supervisor = new LspSupervisor(host ? () => {
    if (!transport) throw new Error(startError);
    return transport;
  } : undefined, logger, 60000);
  const status = (): LanguageServerStatus => languageServerStatus({
    enabled: settings.enabled,
    trusted: vscode.workspace.isTrusted,
    transport: capabilities.languageServer,
    ...(absentReason ? { absentReason } : {}),
    state: supervisor.state,
  });

  const request = async (method: string, params: unknown): Promise<RequestResult> => {
    const current = status();
    if (current.kind !== 'connected' && 'reason' in current) return { kind: 'no-server', reason: current.reason };
    return supervisor.request(method, params);
  };
  const requests = new ZenwaveRequests({ request });

  const item = vscode.window.createStatusBarItem('zenwave.languageServer', vscode.StatusBarAlignment.Right, 100);
  item.name = 'ZenWave';
  item.command = LSP_COMMANDS.showStatus;
  context.subscriptions.push(item, changed);

  function serverInfo(): LanguageServerApi['serverInfo'] {
    const info = (supervisor.initializeResult as { serverInfo?: { name?: unknown; version?: unknown } } | undefined)?.serverInfo;
    return typeof info?.name === 'string'
      ? { name: info.name, ...(typeof info.version === 'string' ? { version: info.version } : {}) }
      : undefined;
  }

  function relevantEditor(): boolean {
    const document = vscode.window.activeTextEditor?.document;
    return document !== undefined && (MODEL_LANGUAGES.has(document.languageId) || isManifest(manifest, document));
  }

  function refresh(): void {
    const current = status();
    const presentation = presentStatus(current, capabilities.hostKind, manifest, serverInfo()?.version);
    item.text = presentation.text;
    item.tooltip = presentation.tooltip;
    item.backgroundColor = presentation.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (relevantEditor()) item.show(); else item.hide();
    const advertised = [...supervisor.advertisedRequests].sort();
    void vscode.commands.executeCommand('setContext', LSP_CONTEXT_KEYS.languageServerAvailable, current.kind === 'connected');
    void vscode.commands.executeCommand('setContext', LSP_CONTEXT_KEYS.languageServerRequests, current.kind === 'connected' ? advertised : []);
    void vscode.commands.executeCommand('setContext', LSP_CONTEXT_KEYS.manifestAvailable, manifest.manifestUri !== undefined);
    changed.fire();
  }

  context.subscriptions.push(supervisor.onDidChangeState((state) => {
    if (state.kind === 'failed' && lastState === 'connected') {
      // An unexpected exit, not a failure to start: offer the way back once per exit.
      void vscode.window.showWarningMessage(`The ZenWave language server stopped: ${state.reason}`, 'Restart', 'Show Output')
        .then((choice) => {
          if (choice === 'Restart') void vscode.commands.executeCommand(LSP_COMMANDS.restart);
          if (choice === 'Show Output') logger.show();
        });
    }
    if (state.kind === 'connected') {
      const info = serverInfo();
      logger.info(`Language server connected${info ? `: ${info.name} ${info.version ?? ''}`.trimEnd() : ''}\n  custom requests: ${[...supervisor.advertisedRequests].join(', ') || 'none'}`);
    }
    lastState = state.kind;
    refresh();
  }));

  function queue(action: () => Promise<void>): Promise<void> {
    pending = pending.then(action).catch((error: unknown) => {
      logger.error('Language server lifecycle', error);
    });
    return pending;
  }

  async function prepare(): Promise<boolean> {
    manifest = await resolveWorkspaceManifest();
    logger.info(describeManifest(manifest));
    for (const watcher of watchers) watcher.dispose();
    watchers = [];
    transport = undefined;
    if (!host) return false;
    const location = await host.locateServer(settings.serverPath);
    if (location.kind === 'absent') {
      absentReason = location.reason;
      logger.warn(`Language server: none (${location.reason}); syntax highlighting and editing continue without it`);
      return false;
    }
    absentReason = undefined;
    if (location.kind === 'invalid') {
      startError = location.reason;
      return true; // the supervisor records the failure once
    }
    logger.info(`Language server: ${host.transport} transport, ${location.description}`);
    watchers = manifestWatchers(manifest);
    const pluginCatalogue = await loadPluginCatalogue(catalogueSource, logger);
    const options = sharedClientOptions(
      documentSelector(manifest),
      initializationOptions(manifest, true, pluginCatalogue),
      logger.outputChannel,
      watchers,
    );
    transport = languageClientTransport(host, location.location, options, [
      { method: CREDENTIAL_REQUEST, handle: (params) => credentials.answer(params) },
    ]);
    return true;
  }

  function start(reason: string): Promise<void> {
    return queue(async () => {
      await supervisor.stop();
      if (!settings.enabled) {
        logger.info(`Language server not started (${reason}): zenwave.lsp.enabled is off`);
      } else if (!vscode.workspace.isTrusted) {
        logger.info(`Language server not started (${reason}): the workspace is not trusted. Trusting it enables language features without a reload.`);
      } else if (await prepare()) {
        await supervisor.start();
      }
      refresh();
    });
  }

  function stop(reason: string): Promise<void> {
    return queue(async () => {
      logger.info(`Language server stopping: ${reason}`);
      await supervisor.stop();
      refresh();
    });
  }

  /** Re-resolves; restarts only when the server would be initialised differently. */
  function reconsiderManifest(trigger: string): Promise<void> {
    return queue(async () => {
      if (!settings.enabled || !vscode.workspace.isTrusted) return;
      const next = await resolveWorkspaceManifest();
      if (sameInitialization(manifest, next)) {
        manifest = next;
        refresh();
        return;
      }
      logger.info(`Resolved configuration changed (${trigger}); restarting the language server with it`);
      void start('configuration changed');
    });
  }

  const configWatchers = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.zenwave/config.yml')));
  for (const watcher of configWatchers) {
    context.subscriptions.push(watcher,
      watcher.onDidCreate((uri) => void reconsiderManifest(`${uri.toString()} created`)),
      watcher.onDidChange((uri) => void reconsiderManifest(`${uri.toString()} changed`)),
      watcher.onDidDelete((uri) => void reconsiderManifest(`${uri.toString()} deleted`)));
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('zenwave.lsp.enabled') || event.affectsConfiguration('zenwave.lsp.serverPath')) {
        const previous = settings;
        settings = readSettings();
        if (!settings.enabled) void stop('zenwave.lsp.enabled was turned off');
        else if (!previous.enabled || previous.serverPath !== settings.serverPath) void start('server settings changed');
      } else if (event.affectsConfiguration(MANIFEST_SETTING)) {
        void reconsiderManifest(`${MANIFEST_SETTING} changed`);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void reconsiderManifest('workspace folders changed')),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void start('workspace trust granted')),
    vscode.window.onDidChangeActiveTextEditor(() => refresh()),
    vscode.commands.registerCommand(LSP_COMMANDS.restart, () => start('restart requested')),
    vscode.commands.registerCommand(LSP_COMMANDS.showStatus, () => showStatus()),
    vscode.commands.registerCommand(LSP_COMMANDS.recordCredential, () => credentials.record()),
    vscode.commands.registerCommand(LSP_COMMANDS.clearCredential, () => credentials.clear()),
    { dispose: () => { for (const watcher of watchers) watcher.dispose(); void supervisor.stop(); } },
  );

  async function showStatus(): Promise<void> {
    const current = status();
    const presentation = presentStatus(current, capabilities.hostKind, manifest, serverInfo()?.version);
    const actions: string[] = [];
    if (current.kind === 'untrusted') actions.push('Manage Workspace Trust');
    if (current.kind === 'disabled') actions.push('Open Settings');
    if (current.kind === 'failed' || current.kind === 'connected' || current.kind === 'no-server') actions.push('Restart');
    actions.push('Show Output');
    const detail = presentation.tooltip.split('\n').slice(0, -1).join('\n');
    const choice = await vscode.window.showInformationMessage(detail.split('\n')[0]!, { modal: false, detail }, ...actions);
    logger.info(detail);
    if (choice === 'Manage Workspace Trust') await vscode.commands.executeCommand('workbench.trust.manage');
    if (choice === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'zenwave.lsp');
    if (choice === 'Restart') await vscode.commands.executeCommand(LSP_COMMANDS.restart);
    if (choice === 'Show Output') logger.show();
  }

  refresh();
  void start('activation');

  return {
    transport: capabilities.languageServer,
    get status() { return status(); },
    get state() { return supervisor.state; },
    get manifest() { return manifest; },
    get advertisedRequests() { return [...supervisor.advertisedRequests]; },
    get serverInfo() { return serverInfo(); },
    requests,
    request,
    onDidChange: changed.event,
    settled: async () => { let seen: Promise<void> | undefined; while (seen !== pending) { seen = pending; await seen; } },
    restart: () => start('restart requested'),
    answerCredential: (params) => credentials.answer(params),
    overridePluginCatalogue: (source) => { catalogueSource = source ?? shippedCatalogueSource; },
  };
}
