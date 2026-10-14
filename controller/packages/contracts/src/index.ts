import { z } from 'zod';
export { Fault } from './fault.ts';

export const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
  );
export const credentialsSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(128),
});
export const claimSchema = credentialsSchema.extend({ bootstrapToken: z.string().min(32).max(256) });
export const policySchema = z.object({
  intervalSeconds: z.number().int().min(2).max(300).default(15),
  timeoutSeconds: z.number().int().min(1).max(15).default(5),
  failureThreshold: z.number().int().min(2).max(10).default(3),
  readinessSuccesses: z.number().int().min(2).max(10).default(2),
  bootDeadlineSeconds: z.number().int().min(5).max(600).default(180),
  objectiveSeconds: z.number().int().min(10).max(900).default(300),
  cooldownSeconds: z.number().int().min(0).max(86400).default(300),
  failbackHealthySeconds: z.number().int().min(5).max(3600).default(60),
  confirmation: z.enum(['operator', 'single-vantage']).default('operator'),
  maintenance: z.boolean().default(false),
});
export type Policy = z.infer<typeof policySchema>;
export const originSchema = z.object({
  role: z.enum(['primary', 'backup']),
  providerConnectionId: z.string().nullable().default(null),
  resourceId: z.string().max(128).default(''),
  address: z.string().min(1).max(253),
  ipv4: z.ipv4().optional(),
  ipv6: z.ipv6().optional(),
  tlsHostname: hostname,
  protocol: z.enum(['http', 'https']).default('https'),
  port: z.number().int().min(1).max(65535).default(443),
  readinessPath: z
    .string()
    .max(256)
    .regex(/^\/(?!\/)[^\s?#]*$/)
    .default('/ready'),
  expectedStatus: z.number().int().min(200).max(299).default(200),
  expectedIdentity: z.string().max(128).default(''),
  releasePolicy: z.enum(['exact', 'any']).default('exact'),
  startOnFailure: z.boolean().default(false),
  approvedPrivateCidrs: z.array(z.string().max(64)).max(8).default([]),
  assertions: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).default({}),
});
export type OriginConfig = z.infer<typeof originSchema>;
export type Origin = OriginConfig & {
  id: string;
  applicationId: string;
  observation: Probe | null;
  power: string;
  healthySince: number | null;
};
export const sshConfigSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  port: z.number().int().min(1).max(65535).default(22),
  hostFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
});
export const sshUploadSchema = sshConfigSchema.extend({
  revision: z.number().int().min(1),
  privateKey: z.string().min(1).max(32768).optional(),
  passphrase: z.string().max(1024).optional(),
});
export type SshConfig = z.infer<typeof sshConfigSchema>;
export type SshView = SshConfig & {
  configured: true;
  keyConfigured: true;
  passphraseConfigured: boolean;
  lastTested: number | null;
  validationState: 'Unknown' | 'Valid' | 'Failed';
};
export const applicationSchema = z.object({
  name: z.string().min(1).max(80),
  publicHostname: hostname,
  desiredRelease: z.string().max(128).default(''),
  demo: z.boolean().default(false),
});
export type Application = z.infer<typeof applicationSchema> & {
  id: string;
  activeOriginId: string | null;
  operationalState: string;
  automationEnabled: boolean;
  configurationRevision: number;
  policy: Policy;
  origins: Origin[];
  routing: RoutingConfig | null;
};
export const providerSchema = z.object({
  type: z.enum(['generic', 'aws', 'hostinger', 'cloudflare']),
  label: z.string().min(1).max(80),
  secret: z.record(z.string(), z.string().max(4096)).default({}),
  config: z
    .object({
      region: z.string().max(40).optional(),
      resourceIds: z.array(z.string().max(128)).max(100).default([]),
    })
    .default({ resourceIds: [] }),
});
export type ProviderInput = z.infer<typeof providerSchema>;
export type ProviderView = Omit<ProviderInput, 'secret'> & {
  id: string;
  secretConfigured: boolean;
  lastValidated: number | null;
  validationState: string;
};
export type RecordSnapshot = {
  id: string;
  type: 'A' | 'AAAA';
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  modified_on?: string;
};
export const routingSchema = z.object({
  type: z.enum(['demo', 'cloudflare']),
  providerConnectionId: z.string().nullable().default(null),
  zoneId: z.string().max(64).default(''),
  recordIds: z.array(z.string().min(1).max(64)).max(8).default([]),
  dnsOnlyAcknowledged: z.boolean().default(false),
});
export type RoutingConfig = z.infer<typeof routingSchema> & { snapshot: RecordSnapshot[]; revision: number };
export type Probe = {
  at: number;
  success: boolean;
  status: number | null;
  latency: number;
  reason: string | null;
  identity: string | null;
  release: string | null;
};
export type Resource = {
  id: string;
  name: string;
  power: 'running' | 'stopped' | 'pending' | 'unknown';
  addresses: string[];
};
export interface ServerProvider {
  capabilities(): { inspect: boolean; start: boolean };
  validateCredentials(): Promise<void>;
  listResources(): Promise<Resource[]>;
  inspectResource(id: string): Promise<Resource>;
  startResource(id: string): Promise<{ requestId?: string }>;
}
export interface TrafficRouter {
  validateConfiguration(): Promise<RecordSnapshot[]>;
  readRoute(): Promise<RecordSnapshot[]>;
  planSwitch(target: Origin, approved: RecordSnapshot[]): Promise<RecordSnapshot[]>;
  applySwitch(plan: RecordSnapshot[], beforeWrite: () => void): Promise<void>;
  inspectConvergence(plan: RecordSnapshot[]): Promise<boolean>;
}
export type Incident = {
  id: string;
  applicationId: string;
  trigger: string;
  actor: string;
  phase: string;
  outcome: string | null;
  targetOriginId: string;
  previousOriginId: string | null;
  startedAt: number;
  deadlineAt: number;
  completedAt: number | null;
  objectiveMet: boolean | null;
  correlationId: string;
  error: string | null;
  cancelRequested: boolean;
};
export type Step = {
  id: number;
  incidentId: string;
  sequence: number;
  phase: string;
  action: string;
  intent: unknown;
  attempts: number;
  startedAt: number;
  completedAt: number | null;
  result: string;
  error: string | null;
};
export type Overview = {
  applications: Application[];
  monitored: number;
  unhealthy: number;
  openIncidents: number;
  lastRecoveryMs: number | null;
  incidents: Incident[];
};
export type ControllerStatus = {
  demo: boolean;
  heartbeat: number | null;
  healthy: boolean;
  replica: 'single';
  location: string;
  version: string;
};
export type ApiError = {
  code: string;
  message: string;
  fieldErrors?: unknown;
  correlationId: string;
  retryable: boolean;
};
