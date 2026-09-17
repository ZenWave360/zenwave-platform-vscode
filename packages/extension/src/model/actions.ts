import * as vscode from 'vscode';
import type { Logger } from '../host/logger.js';
import type { LanguageServerApi } from '../lsp/feature.js';
import { ZENWAVE_REQUESTS, type NavigationTarget } from '../lsp/requests.js';
import type { RequestResult } from '../lsp/supervisor.js';
import { commandAvailability } from './availability.js';
import { presentLocations, toLocation, type PresentedLocations } from './navigation.js';
import { minimalReplacement, withLineEnding } from './text-replacement.js';

export const MODEL_ACTION_COMMANDS = {
  forwardReferences: 'zenwave.model.forwardReferences',
  reverseReferences: 'zenwave.model.reverseReferences',
  organizeServices: 'zenwave.zfl.organizeServices',
} as const;

const MODEL_LANGUAGES = new Set(['zdl', 'zfl']);

/**
 * What a model action did. Returned to programmatic callers (and the smoke test);
 * the user is told the same thing through the editor.
 */
export type ReferencesOutcome =
  | { readonly kind: PresentedLocations; readonly targets: readonly NavigationTarget[] }
  | { readonly kind: 'no-symbol' }
  | { readonly kind: 'no-document' | 'no-server' | 'unsupported' | 'failed'; readonly message: string };

export type OrganizeOutcome =
  | { readonly kind: 'organized' | 'unchanged' }
  | { readonly kind: 'not-organizable' | 'no-document' | 'no-server' | 'unsupported' | 'failed'; readonly message: string };

type Direction = 'forwardReferences' | 'reverseReferences';

const FEATURE: Record<Direction | 'organizeServices', string> = {
  forwardReferences: 'Go to what this references',
  reverseReferences: 'Go to what references this',
  organizeServices: 'Organize ZFL services',
};

export function registerModelActions(context: vscode.ExtensionContext, server: LanguageServerApi, logger: Logger): void {
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

  async function followReferences(direction: Direction, uriArgument?: unknown, positionArgument?: unknown): Promise<ReferencesOutcome> {
    const feature = FEATURE[direction];
    const uri = uriArgument instanceof vscode.Uri ? uriArgument : undefined;
    const editor = editorFor(uri);
    const document = editor?.document ?? (uri ? await vscode.workspace.openTextDocument(uri) : undefined);
    if (!document || !MODEL_LANGUAGES.has(document.languageId)) {
      return report('no-document', `${feature} works on a ZDL or ZFL document.`, 'info');
    }
    const position = isPosition(positionArgument)
      ? new vscode.Position(positionArgument.line, positionArgument.character)
      : editor?.selection.active;
    if (!position) return report('no-document', `${feature} needs a position in the document.`, 'info');

    const problem = unavailable(feature, [ZENWAVE_REQUESTS.symbolAt, ZENWAVE_REQUESTS[direction]]);
    if (problem) return problem;

    const symbol = await server.requests.symbolAt(document.uri.toString(), { line: position.line, character: position.character });
    if (symbol.kind !== 'ok') return requestProblem(feature, symbol);
    if (symbol.value === null) {
      // Whitespace, a comment, nothing declared or referenced: nothing to follow, and not an error.
      logger.debug(`${feature}: no symbol at ${document.uri.toString()}:${position.line + 1}:${position.character + 1}`);
      return { kind: 'no-symbol' };
    }
    const references = await server.requests[direction](symbol.value.uri, symbol.value.semanticId);
    if (references.kind !== 'ok') return requestProblem(feature, references);

    const anchor = toLocation({ uri: symbol.value.uri, ...(symbol.value.range ? { range: symbol.value.range } : {}) });
    const where = `line ${anchor.range.start.line + 1}`;
    const none = direction === 'forwardReferences'
      ? `The ZenWave language server reports nothing that the symbol at ${where} references.`
      : `The ZenWave language server reports nothing that references the symbol at ${where}.`;
    const kind = await presentLocations(anchor, references.value.map(toLocation), none);
    logger.debug(`${feature}: ${symbol.value.semanticId} → ${references.value.length} target(s)`);
    return { kind, targets: references.value };
  }

  async function organizeServices(uriArgument?: unknown): Promise<OrganizeOutcome> {
    const feature = FEATURE.organizeServices;
    const uri = uriArgument instanceof vscode.Uri ? uriArgument : undefined;
    const document = editorFor(uri)?.document ?? (uri ? await vscode.workspace.openTextDocument(uri) : undefined);
    if (!document || document.languageId !== 'zfl') {
      return report('no-document', `${feature} works on a ZFL document.`, 'info');
    }
    const problem = unavailable(feature, [ZENWAVE_REQUESTS.organizeZflServices]);
    if (problem) return problem;

    const name = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1) || document.uri.toString();
    const version = document.version;
    // The request runs in the server; nothing is applied until its answer is in.
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Organizing services in ${name}` },
      () => server.requests.organizeZflServices(document.uri.toString()),
    );
    if (result.kind !== 'ok') return requestProblem(feature, result);
    if (result.value === null) {
      const errors = vscode.languages.getDiagnostics(document.uri)
        .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length;
      const message = `Could not organize services in ${name}: the ZenWave language server could not process it` +
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
      logger.info(`${feature}: ${name} is already organized; nothing changed`);
      void vscode.window.setStatusBarMessage(`ZenWave: services in ${name} are already organized`, 4000);
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

  context.subscriptions.push(
    vscode.commands.registerCommand(MODEL_ACTION_COMMANDS.forwardReferences,
      (uri?: unknown, position?: unknown) => followReferences('forwardReferences', uri, position)),
    vscode.commands.registerCommand(MODEL_ACTION_COMMANDS.reverseReferences,
      (uri?: unknown, position?: unknown) => followReferences('reverseReferences', uri, position)),
    vscode.commands.registerCommand(MODEL_ACTION_COMMANDS.organizeServices,
      (uri?: unknown) => organizeServices(uri)),
  );
}

function isPosition(value: unknown): value is { line: number; character: number } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { line?: unknown }).line === 'number' && typeof (value as { character?: unknown }).character === 'number';
}
