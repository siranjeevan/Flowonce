import type { WorkflowTemplate } from './template-types';
import type { Workflow, WorkflowStep } from '../../shared/types/workflow';
import { STORAGE_KEYS } from '../storage/storage-keys';

export const BUILTIN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'template-form-filling',
    name: 'Form Filling & Verification',
    description: 'Fills user registration/contact forms, handles text inputs, checkboxes, and verifies successful submission.',
    category: 'form',
    version: '1.0.0',
    tags: ['form', 'input', 'verification'],
    isBuiltin: true,
    variables: [
      { name: 'fullName', type: 'string', defaultValue: 'Alex Developer', required: true },
      { name: 'userEmail', type: 'string', defaultValue: 'alex@example.com', required: true },
      { name: 'acceptTerms', type: 'boolean', defaultValue: true, required: false },
    ],
    steps: [
      {
        id: 'tpl_step_nav',
        type: 'navigate',
        timestamp: 1000,
        url: 'https://example.com/register',
        sequence: 0,
        description: 'Navigate to registration form',
        layout: { x: 100, y: 100 },
      },
      {
        id: 'tpl_step_name',
        type: 'input',
        timestamp: 2000,
        url: 'https://example.com/register',
        sequence: 1,
        target: {
          selector: 'input[name="name"]',
          tag: 'input',
          ariaLabel: 'Full Name',
        },
        value: '{{fullName}}',
        description: 'Enter user full name',
        layout: { x: 100, y: 220 },
      },
      {
        id: 'tpl_step_email',
        type: 'input',
        timestamp: 3000,
        url: 'https://example.com/register',
        sequence: 2,
        target: {
          selector: 'input[name="email"]',
          tag: 'input',
          ariaLabel: 'Email Address',
        },
        value: '{{userEmail}}',
        description: 'Enter user email address',
        layout: { x: 100, y: 340 },
      },
      {
        id: 'tpl_step_submit',
        type: 'click',
        timestamp: 4000,
        url: 'https://example.com/register',
        sequence: 3,
        target: {
          selector: 'button[type="submit"]',
          tag: 'button',
          text: 'Submit',
          ariaLabel: 'Submit Form',
        },
        verification: {
          enabled: true,
          strategy: 'element_visible',
          timeoutMs: 5000,
          pauseOnFailure: false,
        },
        description: 'Submit registration and verify confirmation',
        layout: { x: 100, y: 460 },
      },
    ],
  },
  {
    id: 'template-data-extraction',
    name: 'Structured Data Extraction',
    description: 'Navigates to a target catalog/product page, waits for content to render, and extracts DOM values to runtime variables.',
    category: 'extraction',
    version: '1.0.0',
    tags: ['scraper', 'data', 'extraction'],
    isBuiltin: true,
    variables: [
      { name: 'targetUrl', type: 'string', defaultValue: 'https://example.com/products', required: true },
      { name: 'extractedTitle', type: 'string', defaultValue: '', required: false },
      { name: 'extractedPrice', type: 'string', defaultValue: '', required: false },
    ],
    steps: [
      {
        id: 'tpl_step_ext_nav',
        type: 'navigate',
        timestamp: 1000,
        url: '{{targetUrl}}',
        sequence: 0,
        description: 'Navigate to target product page',
        layout: { x: 100, y: 100 },
      },
      {
        id: 'tpl_step_ext_wait',
        type: 'wait',
        timestamp: 2000,
        url: '{{targetUrl}}',
        sequence: 1,
        value: '2000',
        description: 'Wait for page elements to settle',
        layout: { x: 100, y: 220 },
      },
      {
        id: 'tpl_step_ext_title',
        type: 'extract',
        timestamp: 3000,
        url: '{{targetUrl}}',
        sequence: 2,
        target: {
          selector: 'h1.product-title',
          tag: 'h1',
        },
        extraction: {
          id: 'ext_title_cfg',
          type: 'inner_text',
          variableName: 'extractedTitle',
          onFailure: 'continue',
        },
        description: 'Extract product title to variable',
        layout: { x: 100, y: 340 },
      },
      {
        id: 'tpl_step_ext_price',
        type: 'extract',
        timestamp: 4000,
        url: '{{targetUrl}}',
        sequence: 3,
        target: {
          selector: '.product-price',
          tag: 'span',
        },
        extraction: {
          id: 'ext_price_cfg',
          type: 'inner_text',
          variableName: 'extractedPrice',
          onFailure: 'continue',
        },
        description: 'Extract product price to variable',
        layout: { x: 100, y: 460 },
      },
    ],
  },
  {
    id: 'template-conditional-flow',
    name: 'Conditional Page Flow',
    description: 'Evaluates runtime state or page elements and branches execution paths conditionally.',
    category: 'navigation',
    version: '1.0.0',
    tags: ['logic', 'condition', 'branching'],
    isBuiltin: true,
    variables: [
      { name: 'userTier', type: 'string', defaultValue: 'premium', required: true },
    ],
    steps: [
      {
        id: 'tpl_step_cond_nav',
        type: 'navigate',
        timestamp: 1000,
        url: 'https://example.com/dashboard',
        sequence: 0,
        description: 'Navigate to dashboard',
        layout: { x: 200, y: 100 },
      },
      {
        id: 'tpl_step_cond_check',
        type: 'condition',
        timestamp: 2000,
        url: 'https://example.com/dashboard',
        sequence: 1,
        condition: {
          source: 'variable',
          name: 'userTier',
          operator: 'equals',
          value: 'premium',
          onTrue: 'tpl_step_cond_premium',
          onFalse: 'tpl_step_cond_standard',
        },
        description: 'Check if user is premium tier',
        layout: { x: 200, y: 220 },
      },
      {
        id: 'tpl_step_cond_premium',
        type: 'click',
        timestamp: 3000,
        url: 'https://example.com/dashboard',
        sequence: 2,
        target: {
          selector: '#premium-portal-btn',
          tag: 'button',
          text: 'VIP Lounge',
        },
        description: 'Access VIP Portal',
        layout: { x: 80, y: 360 },
      },
      {
        id: 'tpl_step_cond_standard',
        type: 'click',
        timestamp: 4000,
        url: 'https://example.com/dashboard',
        sequence: 3,
        target: {
          selector: '#standard-portal-btn',
          tag: 'button',
          text: 'Standard Lounge',
        },
        description: 'Access Standard Portal',
        layout: { x: 320, y: 360 },
      },
    ],
  },
];

export class TemplateRegistry {
  /**
   * Retrieves all templates (built-in and custom)
   */
  static async getAllTemplates(): Promise<WorkflowTemplate[]> {
    let custom: WorkflowTemplate[] = [];
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(STORAGE_KEYS.TEMPLATES);
      if (Array.isArray(res[STORAGE_KEYS.TEMPLATES])) {
        custom = res[STORAGE_KEYS.TEMPLATES] as WorkflowTemplate[];
      }
    }
    return [...BUILTIN_TEMPLATES, ...custom];
  }

  /**
   * Finds a template by its ID
   */
  static async getTemplateById(id: string): Promise<WorkflowTemplate | null> {
    const all = await this.getAllTemplates();
    return all.find((t) => t.id === id) || null;
  }

  /**
   * Validates a template definition
   */
  static validateTemplate(template: Partial<WorkflowTemplate>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!template.id || typeof template.id !== 'string') errors.push('Template id is required');
    if (!template.name || typeof template.name !== 'string') errors.push('Template name is required');
    if (!Array.isArray(template.steps) || template.steps.length === 0) {
      errors.push('Template must have at least one step');
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Instantiates a template into a fresh, completely standalone, editable Workflow
   */
  static async instantiateTemplate(
    templateId: string,
    options?: { workflowName?: string; ownerId?: string; variableOverrides?: Record<string, any> }
  ): Promise<Workflow> {
    return this.createWorkflowFromTemplate(templateId, {
      name: options?.workflowName,
      ownerId: options?.ownerId,
      variableOverrides: options?.variableOverrides,
    });
  }

  /**
   * Instantiates a template into a fresh, completely standalone, editable Workflow
   */
  static async createWorkflowFromTemplate(
    templateId: string,
    options?: { name?: string; ownerId?: string; variableOverrides?: Record<string, any> }
  ): Promise<Workflow> {
    const template = await this.getTemplateById(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    const uniqueSuffix = Date.now().toString(36).toUpperCase();
    const workflowId = `WF_TPL_${uniqueSuffix}`;

    // Map old step IDs to new unique step IDs
    const idMap = new Map<string, string>();
    template.steps.forEach((s, idx) => {
      idMap.set(s.id, `step_${uniqueSuffix}_${idx}`);
    });

    const newSteps: WorkflowStep[] = template.steps.map((s, idx) => {
      const cloned: WorkflowStep = JSON.parse(JSON.stringify(s));
      cloned.id = idMap.get(s.id) || `step_${uniqueSuffix}_${idx}`;
      cloned.sequence = idx;

      // Update condition branching targets to map to new step IDs
      if (cloned.condition) {
        if (cloned.condition.onTrue && cloned.condition.onTrue !== 'next' && cloned.condition.onTrue !== 'end') {
          cloned.condition.onTrue = idMap.get(cloned.condition.onTrue) || cloned.condition.onTrue;
        }
        if (cloned.condition.onFalse && cloned.condition.onFalse !== 'next' && cloned.condition.onFalse !== 'end') {
          cloned.condition.onFalse = idMap.get(cloned.condition.onFalse) || cloned.condition.onFalse;
        }
      }
      return cloned;
    });

    const variables = (template.variables || []).map((v) => ({
      ...v,
      defaultValue: options?.variableOverrides?.[v.name] !== undefined
        ? options.variableOverrides[v.name]
        : v.defaultValue,
    }));

    const now = new Date().toISOString();
    return {
      id: workflowId,
      name: options?.name || `${template.name} (${new Date().toLocaleDateString()})`,
      description: template.description,
      ownerId: options?.ownerId || 'local_user',
      version: 1,
      schemaVersion: 2,
      steps: newSteps,
      variables,
      templateId: template.id,
      createdAt: now,
      updatedAt: now,
    };
  }
}
