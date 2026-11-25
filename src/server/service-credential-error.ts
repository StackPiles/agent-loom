/** Fixed diagnostics for saved-password use. Never populate these from a page or raw exception. */
export type ServiceCredentialErrorCode =
  | 'credential_reference_invalid'
  | 'credential_access_denied'
  | 'credential_missing'
  | 'credential_unavailable'
  | 'service_disabled'
  | 'service_revision_stale'
  | 'service_login_invalid'
  | 'credential_origin_mismatch'
  | 'credential_target_rejected'
  | 'credential_input_uncertain'
  | 'browser_state_stale';

export interface ServiceCredentialDiagnostic {
  code: ServiceCredentialErrorCode;
  message: string;
  actionIssued: boolean;
  nextAction:
    | 'refresh_services'
    | 'configure_credential'
    | 'configure_service_login'
    | 'inspect_registered_login'
    | 'refresh_snapshot'
    | 'inspect_page_before_retry';
  credentialStored?: boolean;
  expectedOrigin?: string;
  observedOrigin?: string;
}

/**
 * Tool errors cross SDK boundaries as text. JSON keeps the code and execution
 * state available there without forwarding stacks, private transport arguments,
 * page text, full URLs, or the credential itself.
 */
export class ServiceCredentialUseError extends Error {
  readonly diagnostic: Readonly<ServiceCredentialDiagnostic>;

  constructor(diagnostic: ServiceCredentialDiagnostic) {
    const safe = {
      ...diagnostic,
      ...(diagnostic.expectedOrigin
        ? { expectedOrigin: originOnly(diagnostic.expectedOrigin) }
        : {}),
      ...(diagnostic.observedOrigin
        ? { observedOrigin: originOnly(diagnostic.observedOrigin) }
        : {}),
    };
    super(JSON.stringify({ ...safe, credentialReadableByModel: false }));
    this.name = 'ServiceCredentialUseError';
    this.diagnostic = Object.freeze(safe);
  }
}

function originOnly(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
