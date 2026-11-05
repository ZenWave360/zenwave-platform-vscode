import * as vscode from 'vscode';
import type { Logger } from '../host/logger.js';
import {
  configuredOrigin,
  decideCredential,
  readCredentialOrigins,
  readCredentialRequest,
  redact,
  secretKey,
  type CredentialAnswer,
  type CredentialOrigin,
} from './credential-policy.js';

export const CREDENTIAL_REQUEST = 'zenwave/credential';
const ORIGINS_SETTING = 'origins';
const STORED_INDEX = 'zenwave.credentials.storedOrigins';
/** Scope asked of the GitHub provider: reading private repository content. */
const GITHUB_SCOPES = ['repo'];

/**
 * Answers the server's `zenwave/credential` request (decision 1.4, pending
 * review) and owns the commands that record and clear a stored credential.
 *
 * Only `zenwave.credentials.origins` from the user's own settings authorises an
 * origin — the setting is application-scoped, so a repository cannot authorise
 * a host for itself through `.vscode/settings.json`. Secrets live in
 * `SecretStorage` or come from `vscode.authentication`; never from settings.
 */
export class CredentialBroker {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento,
    private readonly logger: Logger,
  ) {}

  private origins(): CredentialOrigin[] {
    const inspected = vscode.workspace.getConfiguration('zenwave.credentials').inspect(ORIGINS_SETTING);
    // globalValue only: workspace values of an application setting are ignored by VS Code, and
    // this makes that explicit rather than relying on it.
    const { origins, problems } = readCredentialOrigins(inspected?.globalValue ?? inspected?.defaultValue);
    for (const problem of problems) this.logger.warn(problem);
    return origins;
  }

  /** The handler for `zenwave/credential`. Never throws; declining is `null`. */
  async answer(params: unknown): Promise<CredentialAnswer | null> {
    if (!vscode.workspace.isTrusted) {
      this.logger.warn('Credential request refused: the workspace is not trusted');
      return null;
    }
    const request = readCredentialRequest(params);
    if (!request) {
      this.logger.warn('Credential request refused: malformed request');
      return null;
    }
    const decision = decideCredential(request, this.origins());
    if (!decision.release) {
      this.logger.warn(`Credential request for ${redact(request.uri)} refused: ${decision.reason}`);
      return null;
    }
    const { entry } = decision;
    try {
      const secret = entry.source === 'github'
        ? await this.githubToken(request.attempt === 'rejected')
        : await this.secrets.get(secretKey(entry.origin));
      if (!secret) {
        this.logger.info(`No credential available for ${entry.origin}; ${entry.source === 'github'
          ? 'sign in to GitHub from the Accounts menu'
          : 'run "ZenWave: Record Credential"'} to provide one`);
        return null;
      }
      if (request.attempt === 'rejected' && entry.source === 'stored') {
        // A stored secret that was just refused is not offered again; the user replaces it.
        this.logger.warn(`The stored credential for ${entry.origin} was rejected; run "ZenWave: Record Credential" to replace it`);
        return null;
      }
      this.logger.info(`Credential released for ${redact(request.uri)} (${entry.origin}, ${entry.source})`);
      return { type: entry.type, key: entry.key, value: `${entry.valuePrefix}${secret}` };
    } catch (error: unknown) {
      this.logger.warn(`No credential for ${entry.origin}: ${error instanceof Error ? error.message : 'declined'}`);
      return null;
    }
  }

  private async githubToken(rejected: boolean): Promise<string | undefined> {
    if (rejected) {
      // The previous token was refused: ask for a fresh session instead of repeating it.
      const session = await vscode.authentication.getSession('github', GITHUB_SCOPES, {
        forceNewSession: { detail: 'ZenWave was refused access to repository content with the current GitHub session.' },
      });
      return session?.accessToken;
    }
    const silent = await vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true });
    if (silent) return silent.accessToken;
    // Adds a sign-in request to the Accounts menu without a modal prompt per fetch.
    await vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: false });
    return undefined;
  }

  private storedOrigins(): string[] {
    return this.state.get<string[]>(STORED_INDEX, []);
  }

  async record(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Trust this workspace to record credentials for ZenWave.');
      return;
    }
    const configured = this.origins().filter((entry) => entry.source === 'stored').map((entry) => entry.origin);
    const picked = configured.length > 0
      ? await vscode.window.showQuickPick([...configured, 'Another origin…'], { title: 'Record a credential for' })
      : 'Another origin…';
    if (!picked) return;
    let origin = picked;
    if (picked === 'Another origin…') {
      const typed = await vscode.window.showInputBox({
        title: 'Origin the credential is for',
        prompt: 'scheme://host[:port] — the credential is released only to this exact origin',
        validateInput: (value) => configuredOrigin(value) ? undefined : 'Enter an http(s) origin with nothing after the host and port',
      });
      if (!typed) return;
      origin = configuredOrigin(typed)!;
    }
    const secret = await vscode.window.showInputBox({ title: `Credential for ${origin}`, password: true, ignoreFocusOut: true });
    if (!secret) return;
    await this.secrets.store(secretKey(origin), secret);
    await this.state.update(STORED_INDEX, [...new Set([...this.storedOrigins(), origin])]);
    if (!configured.includes(origin)) {
      const settings = vscode.workspace.getConfiguration('zenwave.credentials');
      const current = settings.inspect<unknown[]>(ORIGINS_SETTING)?.globalValue ?? [];
      // User settings, never workspace settings: this is the authorisation, and it is not the secret.
      await settings.update(ORIGINS_SETTING, [...current, { origin, source: 'stored', type: 'HEADER', key: 'Authorization' }],
        vscode.ConfigurationTarget.Global);
      this.logger.info(`Authorised ${origin} in user settings (zenwave.credentials.origins); header and type can be edited there`);
    }
    this.logger.info(`Stored a credential for ${origin}`);
  }

  async clear(): Promise<void> {
    const stored = this.storedOrigins();
    if (stored.length === 0) {
      void vscode.window.showInformationMessage('ZenWave holds no stored credentials.');
      return;
    }
    const origin = await vscode.window.showQuickPick(stored, { title: 'Clear the stored credential for' });
    if (!origin) return;
    await this.secrets.delete(secretKey(origin));
    await this.state.update(STORED_INDEX, stored.filter((value) => value !== origin));
    this.logger.info(`Cleared the stored credential for ${origin}`);
  }
}
