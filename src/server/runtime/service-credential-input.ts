import type { AssistantMessage } from '@earendil-works/pi-ai';

export const SERVICE_ACCOUNT_TOOL = 'manage_service_account';
export const MAX_SERVICE_CREDENTIAL_LENGTH = 16_384;
export const SERVICE_CREDENTIAL_REDACTED = '[Agent Loom: service credential omitted]';
const MAX_CREDENTIAL_INPUTS = 40;
const INVALID_CREDENTIAL =
  'The service credential must be text of at most 16384 characters. Its value was omitted.';
const UNAVAILABLE_CREDENTIAL =
  'This service credential is no longer available to the current execution. Supply it again in the dedicated credential field, or omit that field to keep an existing credential. A redacted placeholder cannot be saved.';
const INVALID_ARGUMENTS =
  'The service account arguments were not valid JSON. Their raw text was omitted because it may contain a credential. Supply the complete arguments again.';

type CredentialInput =
  { state: 'available'; value: string } | { state: 'invalid' | 'consumed' | 'duplicate' };

/** Only the requested action belongs in public activities, never its supplied value. */
export function serviceToolPublicArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== SERVICE_ACCOUNT_TOOL || !Object.hasOwn(args, 'credential')) return args;
  const { credential, ...publicArgs } = args;
  return { ...publicArgs, credentialAction: credential === '' ? 'clear' : 'set' };
}

/** Redact before a diagnostic is truncated or serialized into another record. */
export function redactServiceCredentialText(text: string, credentials: readonly string[]): string {
  const values = credentials
    .filter(Boolean)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
    .sort((left, right) => right.length - left.length);
  for (const value of values) text = text.split(value).join('[redacted]');
  return text;
}

/**
 * Pi persists an assistant message before validating or executing its tool calls.
 * Replace the dedicated input in that message, retaining the original only for
 * its one live tool-call ID. A restart/resume cannot turn the placeholder into
 * a password, and duplicate IDs cannot borrow another call's input.
 */
export class ServiceCredentialInputs {
  private readonly inputs = new Map<string, CredentialInput>();
  private readonly secrets = new Set<string>();
  private disposed = false;

  protectAssistantMessage(message: AssistantMessage): void {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      if (seen.has(block.id)) duplicates.add(block.id);
      seen.add(block.id);
    }
    for (const block of message.content) {
      if (block.type !== 'toolCall' || block.name !== SERVICE_ACCOUNT_TOOL) continue;
      if (block.argumentsError) {
        // Pi's parse error contains the complete malformed raw argument text.
        block.argumentsError = INVALID_ARGUMENTS;
        block.arguments = {};
        continue;
      }
      if (!block.arguments || !Object.hasOwn(block.arguments, 'credential')) continue;
      const value = block.arguments.credential;
      block.arguments.credential = SERVICE_CREDENTIAL_REDACTED;
      if (this.disposed) continue;
      if (this.inputs.has(block.id) || duplicates.has(block.id)) {
        if (this.inputs.has(block.id) || this.inputs.size < MAX_CREDENTIAL_INPUTS)
          this.inputs.set(block.id, { state: 'duplicate' });
        continue;
      }
      if (this.inputs.size >= MAX_CREDENTIAL_INPUTS) continue;
      if (value === SERVICE_CREDENTIAL_REDACTED) {
        this.inputs.set(block.id, { state: 'consumed' });
        continue;
      }
      if (typeof value !== 'string' || value.length > MAX_SERVICE_CREDENTIAL_LENGTH) {
        this.inputs.set(block.id, { state: 'invalid' });
        continue;
      }
      if (!this.remember(value)) continue;
      this.inputs.set(block.id, { state: 'available', value });
    }
  }

  restore(toolCallId: string | undefined, args: Record<string, unknown>): Record<string, unknown> {
    if (!Object.hasOwn(args, 'credential')) return args;
    if (this.disposed) throw new Error(UNAVAILABLE_CREDENTIAL);
    const value = args.credential;
    if (value !== SERVICE_CREDENTIAL_REDACTED) {
      // Direct invoke() is used by the demo and deterministic tool tests. Real
      // Pi calls arrive with a protected value and their exact call ID below.
      if (toolCallId && this.inputs.has(toolCallId)) throw new Error(UNAVAILABLE_CREDENTIAL);
      if (typeof value !== 'string' || value.length > MAX_SERVICE_CREDENTIAL_LENGTH)
        throw new Error(INVALID_CREDENTIAL);
      if (!this.remember(value))
        throw new Error('This execution reached its service credential input limit.');
      return args;
    }
    const input = toolCallId ? this.inputs.get(toolCallId) : undefined;
    if (input?.state === 'invalid') throw new Error(INVALID_CREDENTIAL);
    if (!input || input.state !== 'available' || !toolCallId)
      throw new Error(UNAVAILABLE_CREDENTIAL);
    this.inputs.set(toolCallId, { state: 'consumed' });
    return { ...args, credential: input.value };
  }

  /** Cover both raw values and their escaped form in JSON validation diagnostics. */
  redactText(text: string): string {
    return redactServiceCredentialText(text, [...this.secrets]);
  }

  dispose(): void {
    this.disposed = true;
    this.inputs.clear();
    this.secrets.clear();
  }

  private remember(value: string): boolean {
    if (!value || this.secrets.has(value)) return true;
    if (this.secrets.size >= MAX_CREDENTIAL_INPUTS) return false;
    this.secrets.add(value);
    return true;
  }
}
