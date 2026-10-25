export type HttpMethod = 'GET' | 'POST' | 'PUT';

export interface IntegrationSchemaField {
  type: 'string' | 'number' | 'boolean' | 'object';
  required?: boolean;
  description?: string;
}

export interface IntegrationDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  allowedMethods: HttpMethod[];
  inputSchema: Record<string, IntegrationSchemaField>;
  outputSchema: Record<string, IntegrationSchemaField>;
  defaultTimeoutMs: number;
  maxResponseBytes: number;
  requiresAuth: boolean;
  supportsIdempotency: boolean;
}

export interface IntegrationConfig {
  id: string;
  integrationId: string;
  name: string;
  endpointUrl: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  authHeader?: string; // Stored securely/masked
  idempotencyHeaderKey?: string;
  timeoutMs?: number;
  retryCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationExecutionResult {
  success: boolean;
  statusCode?: number;
  durationMs: number;
  data?: any;
  error?: string;
  idempotencyKey?: string;
}
