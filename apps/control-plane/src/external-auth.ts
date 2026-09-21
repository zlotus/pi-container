export interface ExternalIdentityProfile {
  subject: string;
  usernameSnapshot: string | null;
  emailSnapshot: string | null;
  displayNameSnapshot: string | null;
}

export interface ExternalProvisioningPolicy {
  autoProvision: boolean;
  allowedDomains: readonly string[];
}
