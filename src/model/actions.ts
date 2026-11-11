import * as vscode from 'vscode';
import type { Logger } from '../host/logger.js';
import type { LanguageServerApi } from '../lsp/feature.js';
import { ZENWAVE_REQUESTS, type ConceptsAt, type NavigationTarget } from '../lsp/requests.js';
import type { RequestResult } from '../lsp/supervisor.js';
import { commandAvailability } from './availability.js';
import { NO_ARCHITECTURE_MESSAGE, presentConceptsAt } from './concepts-at.js';
import { presentLocations, toLocation, type PresentedLocations } from './navigation.js';
import { organizeLenses, resolveOrganize, type AskWarning, type OrganizeAction } from './organize.js';
import { minimalReplacement, withLineEnding } from './text-replacement.js';

export const MODEL_ACTION_COMMANDS = {
  forwardReferences: 'zenwave.model.forwardReferences',
  reverseReferences: 'zenwave.model.reverseReferences',
  conceptsAt: 'zenwave.model.conceptsAt',
  /** Full organise. Confirms first; an older server is sent no mode. */
  organizeServices: 'zenwave.zfl.organizeServices',
  /** Add missing. Offered only when the server advertises organize modes. */
  addMissingServices: 'zenwave.zfl.addMissingServices',
} as const;

const MODEL_LANGUAGES = new Set(['zdl', 'zw', 'zfl']);

/**
 * What a model action did. Returned to programmatic callers (and the smoke test);
 * the user is told the same thing through the editor.
 */
export type ReferencesOutcome =
  | { readonly kind: PresentedLocations; readonly targets: readonly NavigationTarget[] }
  | { readonly kind: 'no-symbol' }
  | { readonly kind: 'no-document' | 'no-server' | 'unsupported' | 'failed'; readonly message: string };

export type OrganizeOutcome =
  | { readonly kind: 'organized' | 'unchanged' | 'cancelled' }
  | { readonly kind: 'not-organizable' | 'no-document' | 'no-server' | 'unsupported' | 'failed'; readonly message: string };

export type ConceptsAtOutcome =
  | { readonly kind: 'shown' | 'empty' | 'no-architecture'; readonly concepts?: ConceptsAt['concepts'] }
  | { readonly kind: 'no-document' | 'no-server' | 'unsupported' | 'failed'; readonly message: string };

type Direction = 'forwardReferences' | 'reverseReferences';

const FEATURE: Record<Direction | OrganizeAction, string> = {
  forwardReferences: 'Go to what this references',
  reverseReferences: 'Go to what references this',
  full: 'Organize ZFL services',
  additive: 'Add missing ZFL services',
};

const CONCEPTS_FEATURE = 'Show concepts at this position';

/** CodeLens above a ZFL `systems` block. Empty until a server that organises services is connected. */
class OrganizeCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly server: LanguageServerApi) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (this.server.status.kind !== 'connected') return [];
    if (!this.server.advertisedRequests.includes(ZENWAVE_REQUESTS.organizeZflServices)) return [];
    return organizeLenses(document.getText(), this.server.organizeModes).map((lens) => new vscode.CodeLens(
      new vscode.Range(document.positionAt(lens.start), document.positionAt(lens.end)),
      {
        title: lens.title,
        command: lens.action === 'additive' ? MODEL_ACTION_COMMANDS.addMissingServices : MODEL_ACTION_COMMANDS.organizeServices,
        arguments: [document.uri],
      },
    ));
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** One confirmation the organize command asked for, as it was asked. */
export interface ConfirmationRequest {
  readonly message: string;
  readonly modal: boolean;
  readonly buttons: readonly string[];
}

/** A stand-in for the person at the Full organize confirmation. `dispose` puts the real dialog back. */
export interface ConfirmationAnswer extends vscode.Disposable {
  readonly requests: readonly ConfirmationRequest[];
}

/**
 * What the smoke test drives. An installed extension has its own `vscode` API object, so a test cannot patch
 * `vscode.window` for it: the answer is given through here, and the production path is unchanged without it.
 */
export interface ModelActionsApi {
  /** Answers every Full organize confirmation with `answer` (the button, or `undefined` for Cancel or Escape) and records it. */
  answerFullOrganize(answer: string | undefined): ConfirmationAnswer;
}

export function registerModelActions(context: vscode.ExtensionContext, server: LanguageServerApi, logger: Logger): ModelActionsApi {
  let answering: { readonly answer: string | undefined; readonly requests: ConfirmationRequest[] } | undefined;
  const askWarning: AskWarning = (message, options, accept) => {
    if (!answering) return vscode.window.showWarningMessage(message, options, accept);
    answering.requests.push({ message, modal: options.modal, buttons: [accept] });
    return Promise.resolve(answering.answer);
  };

  /** Re-checked on every execution: a `when` clause hides a command, it does not stop a programmatic call. */
  function unavailable(feature: string, methods: readonly string[]): { kind: 'no-server' | 'unsupported'; message: string } | undefined {
    const availability = commandAvailability(feature, methods, {
      status: server.status,
      advertisedRequests: server.advertisedRequests,
      ...(server.serverInfo?.version ? { serverVersion: server.serverInfo.version } : {}),
    });
    if (availability.kind === 'available') return undefined;
    return report(availability.kind, availability.message, 'warn');
  }

  function report<K extends string>(kind: K, message: string, level: 'info' | 'warn' | 'error'): { kind: K; message: string } {
    if (level === 'info') {
      logger.info(message);
      void vscode.window.showInformationMessage(message);
    } else {
      logger.warn(message);
      const shown = level === 'warn'
        ? vscode.window.showWarningMessage(message, 'Show Output')
        : vscode.window.showErrorMessage(message, 'Show Output');
      void shown.then((choice) => { if (choice === 'Show Output') logger.show(); });
    }
    return { kind, message };
  }

  /** A request that did not answer: the same two availability reasons, or a failure with the server's reason. */
  function requestProblem(feature: string, result: Exclude<RequestResult, { kind: 'ok' }>): { kind: 'no-server' | 'unsupported' | 'failed'; message: string } {
    switch (result.kind) {
      case 'no-server': return report('no-server', `${feature} needs the ZenWave language server, which is not available here: ${result.reason}.`, 'warn');
      case 'unsupported': return report('unsupported', `${feature} is not supported by the connected ZenWave language server: it does not offer ${result.method}.`, 'warn');
      case 'failed': return report('failed', `${feature} failed: ${result.reason}`, 'error');
    }
  }

  function editorFor(uri: vscode.Uri | undefined): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (!uri) return active;
    if (active?.document.uri.toString() === uri.toString()) return active;
    return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString());
  }

  async function followReferences(direction: Direction, uriArgument?: unknown, positionArgument?: unknown, semanticIdArgument?: unknown): Promise<ReferencesOutcome> {
    const feature = FEATURE[direction];
    // A hierarchy id (`documentUri#path`) is already the symbol the reference requests take.
    const semanticId = typeof semanticIdArgument === 'string' && semanticIdArgument.includes('#') ? semanticIdArgument : undefined;
    const uri = uriArgument instanceof vscode.Uri ? uriArgument : undefined;
    const editor = editorFor(uri);
    const document = editor?.document ?? (uri ? await vscode.workspace.openTextDocument(uri) : undefined);
    if (!document || !MODEL_LANGUAGES.has(document.languageId)) {
      return report('no-document', `${feature} works on a ZDL or ZFL document.`, 'info');
    }
    const position = isPosition(positionArgument)
      ? new vscode.Position(positionArgument.line, positionArgument.character)
      : semanticId ? undefined : editor?.selection.active;
    if (!semanticId && !position) return report('no-document', `${feature} needs a position in the document.`, 'info');

    const problem = unavailable(feature, semanticId
      ? [ZENWAVE_REQUESTS[direction]]
      : [ZENWAVE_REQUESTS.symbolAt, ZENWAVE_REQUESTS[direction]]);
    if (problem) return problem;

    let symbolUri: string;
    let symbolSemanticId: string;
    let anchor: vscode.Location;
    if (semanticId) {
      symbolUri = semanticId.slice(0, semanticId.lastIndexOf('#'));
      symbolSemanticId = semanticId;
      // The position, when one was passed, is only where the peek view anchors. It is not looked up.
      anchor = toLocation({
        uri: document.uri.toString(),
        ...(position ? { range: { start: { line: position.line, character: position.character }, end: { line: position.line, character: position.character } } } : {}),
      });
    } else if (position) {
      const symbol = await server.requests.symbolAt(document.uri.toString(), { line: position.line, character: position.character });
      if (symbol.kind !== 'ok') return requestProblem(feature, symbol);
      if (symbol.value === null) {
        // Whitespace, a comment, nothing declared or referenced: nothing to follow, and not an error.
        logger.debug(`${feature}: no symbol at ${document.uri.toString()}:${position.line + 1}:${position.character + 1}`);
        return { kind: 'no-symbol' };
      }
      symbolUri = symbol.value.uri;
      symbolSemanticId = symbol.value.semanticId;
      anchor = toLocation({ uri: symbol.value.uri, ...(symbol.value.range ? { range: symbol.value.range } : {}) });
    } else {
      return report('no-document', `${feature} needs a position in the document.`, 'info');
    }
    const references = await server.requests[direction](symbolUri, symbolSemanticId);
    if (references.kind !== 'ok') return requestProblem(feature, references);

    const where = `line ${anchor.range.start.line + 1}`;
    const none = direction === 'forwardReferences'
      ? `The ZenWave language server reports nothing that the symbol at ${where} references.`
      : `The ZenWave language server reports nothing that references the symbol at ${where}.`;
    const kind = await presentLocations(anchor, references.value.map(toLocation), none);
    logger.debug(`${feature}: ${symbolSemanticId} → ${references.value.length} target(s)`);
    return { kind, targets: references.value };
  }

  async function organizeServices(action: OrganizeAction, uriArgument?: unknown): Promise<OrganizeOutcome> {
    const feature = FEATURE[action];
    const uri = uriArgument instanceof vscode.Uri ? uriArgument : undefined;
    const document = editorFor(uri)?.document ?? (uri ? await vscode.workspace.openTextDocument(uri) : undefined);
    if (!document || document.languageId !== 'zfl') {
      return report('no-document', `${feature} works on a ZFL document.`, 'info');
    }
    const problem = unavailable(feature, [ZENWAVE_REQUESTS.organizeZflServices]);
    if (problem) return problem;

    const decision = await resolveOrganize(action, server.organizeModes, askWarning);
    if (decision.kind === 'cancelled') {
      logger.debug(`${feature}: cancelled, nothing changed`);
      return { kind: 'cancelled' };
    }
    if (decision.kind === 'unsupported') return unsupportedMode(feature);
    if (decision.kind !== 'send') {
      return report('failed', `${feature} could not be started.`, 'error');
    }
    const mode = decision.mode;
    const still = unavailable(feature, [ZENWAVE_REQUESTS.organizeZflServices]);
    if (still) return still;

    const name = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1) || document.uri.toString();
    const version = document.version;
    const progress = action === 'additive' ? `Adding missing services in ${name}` : `Organizing services in ${name}`;
    // The request runs in the server; nothing is applied until its answer is in.
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: progress },
      () => mode === undefined
        ? server.requests.organizeZflServices(document.uri.toString())
        : server.requests.organizeZflServices(document.uri.toString(), mode),
    );
    if (result.kind !== 'ok') return requestProblem(feature, result);
    if (result.value === null) {
      const errors = vscode.languages.getDiagnostics(document.uri)
        .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length;
      const attempt = action === 'additive' ? 'add missing services' : 'organize services';
      const message = `Could not ${attempt} in ${name}: the ZenWave language server could not process it` +
        (errors > 0 ? ` (${errors} error${errors === 1 ? '' : 's'} reported in Problems).` : '.') +
        ' The document was left unchanged.';
      logger.warn(message);
      void vscode.window.showWarningMessage(message, 'Show Problems').then((choice) => {
        if (choice === 'Show Problems') void vscode.commands.executeCommand('workbench.actions.view.problems');
      });
      return { kind: 'not-organizable', message };
    }
    if (document.version !== version) {
      return report('failed', `${feature}: ${name} changed while the server was organizing it, so nothing was applied. Run it again.`, 'warn');
    }
    const current = document.getText();
    const organized = withLineEnding(result.value, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const replacement = minimalReplacement(current, organized);
    if (!replacement) {
      const already = action === 'additive'
        ? `${name} has nothing missing to add`
        : `services in ${name} are already organized`;
      logger.info(`${feature}: ${already}`);
      void vscode.window.setStatusBarMessage(`ZenWave: ${already}`, 4000);
      return { kind: 'unchanged' };
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri,
      new vscode.Range(document.positionAt(replacement.start), document.positionAt(replacement.end)), replacement.text);
    if (!(await vscode.workspace.applyEdit(edit))) {
      return report('failed', `${feature}: the editor did not accept the change to ${name}; it was left unchanged.`, 'error');
    }
    logger.info(`${feature}: organized ${name}`);
    return { kind: 'organized' };
  }

  async function conceptsAt(uriArgument?: unknown, positionArgument?: unknown): Promise<ConceptsAtOutcome> {
    const uri = uriArgument instanceof vscode.Uri ? uriArgument : undefined;
    const editor = editorFor(uri);
    const document = editor?.document ?? (uri ? await vscode.workspace.openTextDocument(uri) : undefined);
    if (!document || !MODEL_LANGUAGES.has(document.languageId)) {
      return report('no-document', `${CONCEPTS_FEATURE} works on a ZDL or ZFL document.`, 'info');
    }
    const position = isPosition(positionArgument)
      ? new vscode.Position(positionArgument.line, positionArgument.character)
      : editor?.selection.active;
    if (!position) return report('no-document', `${CONCEPTS_FEATURE} needs a position in the document.`, 'info');
    const problem = unavailable(CONCEPTS_FEATURE, [ZENWAVE_REQUESTS.conceptAt]);
    if (problem) return problem;
    // The client starts the server with this resolved manifest, so this is the
    // distinguishable no-architecture case before an empty server answer.
    if (!server.manifest.manifestUri) {
      logger.info(NO_ARCHITECTURE_MESSAGE);
      void vscode.window.showInformationMessage(NO_ARCHITECTURE_MESSAGE);
      return { kind: 'no-architecture' };
    }
    const result = await server.requests.conceptAt(document.uri.toString(), { line: position.line, character: position.character });
    if (result.kind !== 'ok') return requestProblem(CONCEPTS_FEATURE, result);
    const presentation = presentConceptsAt(server.manifest.manifestUri, result.value);
    if (presentation.kind === 'no-architecture') {
      logger.info(presentation.message);
      void vscode.window.showInformationMessage(presentation.message);
      return { kind: 'no-architecture' };
    }
    if (presentation.kind === 'empty') {
      logger.info(presentation.message);
      void vscode.window.showInformationMessage(presentation.message);
      return { kind: 'empty', concepts: result.value.concepts };
    }
    await vscode.window.showQuickPick(presentation.concepts.map((concept) => ({
      label: concept.name,
      description: concept.kind,
    })), {
      title: 'ZenWave Concepts at Position',
      ...(presentation.truncated ? { placeHolder: 'More matching concepts exist; this list is incomplete.' } : {}),
    });
    logger.debug(`${CONCEPTS_FEATURE}: ${result.value.concepts.length} concept(s)${result.value.truncated ? ' (truncated)' : ''}`);
    return { kind: 'shown', concepts: result.value.concepts };
  }

  function unsupportedMode(feature: string): { kind: 'unsupported'; message: string } {
    const version = server.serverInfo?.version;
    const connected = version ? `ZenWave language server (${version})` : 'ZenWave language server';
    return report('unsupported',
      `${feature} is not supported by the connected ${connected}: it does not advertise organize modes.`, 'warn');
  }

  const codeLenses = new OrganizeCodeLensProvider(server);
  context.subscriptions.push(
    codeLenses,
    vscode.languages.registerCodeLensProvider({ language: 'zfl' }, codeLenses),
    server.onDidChange(() => codeLenses.refresh()),
    vscode.commands.registerCommand(MODEL_ACTION_COMMANDS.forwardReferences,
      (uri?: unknown, position?: unknown) => followReferences('forwardReferences', uri, position)),
    vscode.commands.registerCommand(MODEL_ACTION_COMMANDS.reverseReferences,
      (uri?: unknown, position?: unknown, semanticId?: unknown) => followReferences('reverseReferences', uri, position, semanticId)),
    vscode.commands.registerCommand(MODEL_ACTION_COMMANDS.conceptsAt,
      (uri?: unknown, position?: unknown) => conceptsAt(uri, position)),
    vscode.commands.registerCommand(MODEL_ACTION_COMMANDS.organizeServices,
      (uri?: unknown) => organizeServices('full', uri)),
    vscode.commands.registerCommand(MODEL_ACTION_COMMANDS.addMissingServices,
      (uri?: unknown) => organizeServices('additive', uri)),
  );

  return {
    answerFullOrganize(answer) {
      const current = { answer, requests: [] as ConfirmationRequest[] };
      answering = current;
      return { requests: current.requests, dispose: () => { if (answering === current) answering = undefined; } };
    },
  };
}

function isPosition(value: unknown): value is { line: number; character: number } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { line?: unknown }).line === 'number' && typeof (value as { character?: unknown }).character === 'number';
}
