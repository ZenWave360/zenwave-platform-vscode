import type { ConceptsAt } from '../lsp/requests.js';

export const NO_ARCHITECTURE_MESSAGE = 'ZenWave cannot identify concepts here because no architecture is resolved for this workspace. Set zenwave.workspace.manifest, or add project-manifest to .zenwave/config.yml.';

export type ConceptsAtPresentation =
  | { readonly kind: 'no-architecture'; readonly message: string }
  | { readonly kind: 'empty'; readonly message: string }
  | { readonly kind: 'shown'; readonly concepts: ConceptsAt['concepts']; readonly truncated: boolean };

/** Keeps an empty position answer distinct from the client-known absence of an architecture. */
export function presentConceptsAt(manifestUri: string | undefined, result: ConceptsAt): ConceptsAtPresentation {
  if (!manifestUri) return { kind: 'no-architecture', message: NO_ARCHITECTURE_MESSAGE };
  if (result.concepts.length === 0) {
    return { kind: 'empty', message: 'The ZenWave language server identifies no architectural concept at this position.' };
  }
  return { kind: 'shown', concepts: result.concepts, truncated: result.truncated };
}
