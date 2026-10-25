import type { IntegrationDefinition, IntegrationConfig } from './integration-types';
import { STORAGE_KEYS } from '../workflow/storage/storage-keys';

export const BUILTIN_INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: 'webhook-dispatcher',
    name: 'Webhook Dispatcher',
    version: '1.0.0',
    description: 'Safely posts workflow execution outcomes, extracted variables, or alerts to external endpoints (Slack, Zapier, Make, custom webhooks).',
    allowedMethods: ['POST'],
    inputSchema: {
      payload: { type: 'object', required: true, description: 'JSON payload to transmit' },
      event: { type: 'string', required: false, description: 'Event identifier' },
    },
    outputSchema: {
      status: { type: 'string', description: 'HTTP response status' },
      body: { type: 'object', description: 'Response JSON if available' },
    },
    defaultTimeoutMs: 10000,
    maxResponseBytes: 512 * 1024, // 512 KB
    requiresAuth: false,
    supportsIdempotency: true,
  },
  {
    id: 'rest-collector',
    name: 'REST Data Collector',
    version: '1.0.0',
    description: 'Queries a secured REST API to retrieve external data for runtime variables or dataset feeding.',
    allowedMethods: ['GET'],
    inputSchema: {
      resource: { type: 'string', required: false, description: 'Resource path or query parameters' },
    },
    outputSchema: {
      data: { type: 'object', description: 'Fetched data object or array' },
    },
    defaultTimeoutMs: 10000,
    maxResponseBytes: 512 * 1024,
    requiresAuth: true,
    supportsIdempotency: false,
  },
];

export class IntegrationRegistry {
  /**
   * Retrieves all supported integration definitions
   */
  static getDefinitions(): IntegrationDefinition[] {
    return BUILTIN_INTEGRATIONS;
  }

  /**
   * Finds an integration definition by ID
   */
  static getDefinition(id: string): IntegrationDefinition | null {
    return BUILTIN_INTEGRATIONS.find((d) => d.id === id) || null;
  }

  /**
   * Retrieves all configured integration instances
   */
  static async getAllConfigs(): Promise<IntegrationConfig[]> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return [];
    }
    const res = await chrome.storage.local.get(STORAGE_KEYS.INTEGRATIONS);
    const raw = res[STORAGE_KEYS.INTEGRATIONS];
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Retrieves a specific integration config by ID
   */
  static async getConfig(id: string): Promise<IntegrationConfig | null> {
    const all = await this.getAllConfigs();
    return all.find((c) => c.id === id) || null;
  }

  /**
   * Validates integration configuration
   */
  static validateConfig(config: Partial<IntegrationConfig>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.id || typeof config.id !== 'string') errors.push('Config id is required');
    if (!config.name || typeof config.name !== 'string') errors.push('Config name is required');
    if (!config.integrationId || !this.getDefinition(config.integrationId)) {
      errors.push(`Unknown integration type "${config.integrationId}"`);
    }

    if (!config.endpointUrl || typeof config.endpointUrl !== 'string') {
      errors.push('Endpoint URL is required');
    } else {
      try {
        const parsed = new URL(config.endpointUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          errors.push('Endpoint URL must use http or https scheme');
        }
      } catch {
        errors.push('Endpoint URL is not a valid URL');
      }
    }

    if (!config.method || (config.method !== 'GET' && config.method !== 'POST' && config.method !== 'PUT')) {
      errors.push('Method must be GET, POST, or PUT');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Saves or updates an integration config
   */
  static async saveConfig(config: IntegrationConfig): Promise<IntegrationConfig> {
    const validation = this.validateConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid integration config: ${validation.errors.join('; ')}`);
    }

    const all = await this.getAllConfigs();
    const existingIndex = all.findIndex((c) => c.id === config.id);

    const now = new Date().toISOString();
    const toSave: IntegrationConfig = {
      ...config,
      createdAt: config.createdAt || now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      all[existingIndex] = toSave;
    } else {
      all.push(toSave);
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEYS.INTEGRATIONS]: all });
    }

    return toSave;
  }

  /**
   * Deletes an integration config
   */
  static async deleteConfig(id: string): Promise<boolean> {
    const all = await this.getAllConfigs();
    const filtered = all.filter((c) => c.id !== id);
    if (filtered.length === all.length) return false;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEYS.INTEGRATIONS]: filtered });
    }
    return true;
  }
}
