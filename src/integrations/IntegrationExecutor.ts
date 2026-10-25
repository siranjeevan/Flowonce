import type { IntegrationConfig, IntegrationExecutionResult } from './integration-types';
import { IntegrationRegistry } from './IntegrationRegistry';

export class IntegrationExecutor {
  /**
   * Executes a configured integration with input validation, timeout, bounded response, and idempotency
   */
  static async execute(
    config: IntegrationConfig,
    inputData: Record<string, any> = {}
  ): Promise<IntegrationExecutionResult> {
    const definition = IntegrationRegistry.getDefinition(config.integrationId);
    if (!definition) {
      return {
        success: false,
        durationMs: 0,
        error: `Integration definition "${config.integrationId}" not found`,
      };
    }

    // Input validation
    for (const [fieldName, schema] of Object.entries(definition.inputSchema)) {
      if (schema.required && (inputData[fieldName] === undefined || inputData[fieldName] === null)) {
        return {
          success: false,
          durationMs: 0,
          error: `Required input field "${fieldName}" is missing`,
        };
      }
    }

    const timeoutMs = config.timeoutMs || definition.defaultTimeoutMs;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      ...(config.headers || {}),
    };

    if (config.authHeader) {
      headers['Authorization'] = config.authHeader;
    }

    let idempotencyKey: string | undefined;
    if (definition.supportsIdempotency && config.idempotencyHeaderKey) {
      idempotencyKey = `flowonce_idem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      headers[config.idempotencyHeaderKey] = idempotencyKey;
    }

    const startTime = Date.now();
    try {
      let url = config.endpointUrl;
      let body: string | undefined;

      if (config.method === 'GET') {
        if (inputData.resource) {
          const separator = url.includes('?') ? '&' : '?';
          url = `${url}${separator}${typeof inputData.resource === 'string' ? inputData.resource : new URLSearchParams(inputData.resource).toString()}`;
        }
      } else {
        body = JSON.stringify(inputData.payload !== undefined ? inputData.payload : inputData);
      }

      const response = await fetch(url, {
        method: config.method,
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startTime;

      // Enforce bounded response size
      const contentLengthHeader = response.headers?.get ? response.headers.get('content-length') : null;
      if (contentLengthHeader && parseInt(contentLengthHeader, 10) > definition.maxResponseBytes) {
        return {
          success: false,
          statusCode: response.status,
          durationMs,
          error: `Response size exceeds allowed limit of ${definition.maxResponseBytes} bytes`,
          idempotencyKey,
        };
      }

      const text = await response.text();
      if (text.length > definition.maxResponseBytes) {
        return {
          success: false,
          statusCode: response.status,
          durationMs,
          error: `Response body exceeds allowed limit of ${definition.maxResponseBytes} bytes`,
          idempotencyKey,
        };
      }

      let parsedData: any = text;
      try {
        parsedData = JSON.parse(text);
      } catch {
        // Plain text fallback
      }

      if (!response.ok) {
        return {
          success: false,
          statusCode: response.status,
          durationMs,
          data: parsedData,
          error: `HTTP ${response.status}: ${response.statusText}`,
          idempotencyKey,
        };
      }

      return {
        success: true,
        statusCode: response.status,
        durationMs,
        data: parsedData,
        idempotencyKey,
      };
    } catch (err: any) {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startTime;
      const isAbort = err.name === 'AbortError' || controller.signal.aborted;
      const rawMsg = isAbort ? `Request timed out after ${timeoutMs}ms` : err.message || 'Network request failed';
      const errorMsg = rawMsg
        .replace(/authorization:\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [REDACTED]')
        .replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/(token|secret|key|password)[:=\s]+([^\s,;]+)/gi, '$1=[REDACTED]');

      return {
        success: false,
        durationMs,
        error: errorMsg,
        idempotencyKey,
      };
    }
  }
}
