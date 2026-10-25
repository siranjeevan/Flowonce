import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentRegistry } from '../src/workflow/components/ComponentRegistry';
import { TemplateRegistry } from '../src/workflow/templates/TemplateRegistry';
import type { ReusableComponent } from '../src/workflow/components/component-types';

// Mock chrome.storage.local for tests
let mockStorage: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (key?: string | string[] | Record<string, unknown> | null) => {
        if (!key) return { ...mockStorage };
        if (typeof key === 'string') return { [key]: mockStorage[key] };
        if (Array.isArray(key)) {
          const res: Record<string, unknown> = {};
          for (const k of key) res[k] = mockStorage[k];
          return res;
        }
        return { ...mockStorage };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(mockStorage, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete mockStorage[k];
      }),
      clear: vi.fn(async () => {
        mockStorage = {};
      }),
    },
  },
};

(globalThis as any).chrome = chromeMock;

describe('Phase 11: Reusable Workflow Components & Templates', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  describe('Reusable Component Registry', () => {
    const sampleComponent: ReusableComponent = {
      id: 'comp_login_seq',
      name: 'Standard OAuth Login Sequence',
      version: 1,
      description: 'Enters credentials and submits login form',
      category: 'authentication',
      inputs: [
        { name: 'username', type: 'string', required: true, description: 'User login email' },
        { name: 'password', type: 'string', required: true, sensitive: true, description: 'User login password' },
      ],
      outputs: [
        { name: 'sessionToken', type: 'string', description: 'Extracted authentication token' },
      ],
      steps: [
        {
          id: 'step_user',
          type: 'input',
          timestamp: 100,
          url: 'https://auth.example.com',
          value: '{{username}}',
          sequence: 0,
        },
        {
          id: 'step_pass',
          type: 'input',
          timestamp: 200,
          url: 'https://auth.example.com',
          value: '{{password}}',
          sequence: 1,
          sensitive: true,
        },
        {
          id: 'step_sub',
          type: 'click',
          timestamp: 300,
          url: 'https://auth.example.com',
          sequence: 2,
        },
      ],
    };

    it('registers and retrieves a reusable component successfully', async () => {
      await ComponentRegistry.registerComponent(sampleComponent);
      const retrieved = await ComponentRegistry.getComponent('comp_login_seq');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('comp_login_seq');
      expect(retrieved?.name).toBe('Standard OAuth Login Sequence');
      expect(retrieved?.steps).toHaveLength(3);
    });

    it('validates provided inputs against declared component schema', () => {
      const validRes = ComponentRegistry.validateInputs(sampleComponent, {
        username: 'alice@example.com',
        password: 'SuperSecretPassword123!',
      });
      expect(validRes.valid).toBe(true);
      expect(validRes.errors).toHaveLength(0);

      const invalidRes = ComponentRegistry.validateInputs(sampleComponent, {
        username: 'alice@example.com',
        // missing required password
      });
      expect(invalidRes.valid).toBe(false);
      expect(invalidRes.errors.some((e) => e.includes('password'))).toBe(true);
    });

    it('detects circular / recursive component invocations and rejects registration', async () => {
      const recursiveComp: ReusableComponent = {
        id: 'comp_recursive',
        name: 'Recursive Self Invocator',
        version: 1,
        description: 'Attempts to call itself directly or indirectly',
        category: 'navigation',
        inputs: [],
        outputs: [],
        steps: [
          {
            id: 'step_rec',
            type: 'click',
            timestamp: 100,
            url: 'https://example.com',
            sequence: 0,
            componentId: 'comp_recursive', // Circular self reference
          },
        ],
      };

      await expect(ComponentRegistry.registerComponent(recursiveComp)).rejects.toThrow(
        /recursion|circular/i
      );
    });

    it('maps component outputs into caller execution context', () => {
      const rawExtracted = { sessionToken: 'JWT_ABC_123', internalState: 'ignore_me' };
      const mapped = ComponentRegistry.mapOutputs(sampleComponent, rawExtracted, {
        sessionToken: 'auth_jwt',
      });
      expect(mapped).toEqual({
        auth_jwt: 'JWT_ABC_123',
      });
    });
  });

  describe('Workflow Template Registry & Instantiation', () => {
    it('provides standard pre-built workflow templates', async () => {
      const templates = await TemplateRegistry.getAllTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(3);

      const ids = templates.map((t) => t.id);
      expect(ids).toContain('template-form-filling');
      expect(ids).toContain('template-data-extraction');
      expect(ids).toContain('template-conditional-flow');
    });

    it('instantiates a valid workflow from a template with unique step IDs and preserved layout', async () => {
      const workflow = await TemplateRegistry.instantiateTemplate('template-form-filling', {
        workflowName: 'My Custom Registration',
        variableOverrides: {
          userEmail: 'testuser@example.com',
        },
      });

      expect(workflow.name).toBe('My Custom Registration');
      expect(workflow.steps.length).toBe(4);
      expect(workflow.templateId).toBe('template-form-filling');

      // Verify each step has unique fresh ID and layout
      const ids = workflow.steps.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);

      // Verify layout is preserved
      expect(workflow.steps[0].layout).toBeDefined();
      expect(typeof workflow.steps[0].layout?.x).toBe('number');
      expect(typeof workflow.steps[0].layout?.y).toBe('number');

      // Verify overridden variable default
      const emailVar = workflow.variables?.find((v) => v.name === 'userEmail');
      expect(emailVar?.defaultValue).toBe('testuser@example.com');
    });

    it('instantiates conditional branching template preserving branch connections', async () => {
      const workflow = await TemplateRegistry.instantiateTemplate('template-conditional-flow', {
        workflowName: 'Branching Flow Instance',
      });

      expect(workflow.name).toBe('Branching Flow Instance');
      const condStep = workflow.steps.find((s) => s.type === 'condition');
      expect(condStep).toBeDefined();
      expect(condStep?.condition?.source).toBe('variable');
      expect(condStep?.condition?.name).toBe('userTier');

      // Branch targets should reference the freshly generated step IDs
      const targetStepIds = new Set(workflow.steps.map((s) => s.id));
      expect(targetStepIds.has(condStep!.condition!.onTrue!)).toBe(true);
      expect(targetStepIds.has(condStep!.condition!.onFalse!)).toBe(true);
    });

    it('throws error when attempting to instantiate a non-existent template', async () => {
      await expect(
        TemplateRegistry.instantiateTemplate('non_existent_template_xyz')
      ).rejects.toThrow(/not found/i);
    });
  });
});
