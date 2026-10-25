import { STORAGE_KEYS } from '../storage/storage-keys';
import type { WorkflowComponent, ComponentInvocationStep } from './component-types';

export class ComponentRegistry {
  /**
   * Retrieves all registered components from storage
   */
  static async getAllComponents(): Promise<WorkflowComponent[]> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return [];
    }

    const result = await chrome.storage.local.get(STORAGE_KEYS.COMPONENTS);
    const raw = result[STORAGE_KEYS.COMPONENTS];
    if (!Array.isArray(raw)) return [];
    return raw;
  }

  /**
   * Retrieves a single component by its ID
   */
  static async getComponent(id: string): Promise<WorkflowComponent | null> {
    const all = await this.getAllComponents();
    return all.find((c) => c.id === id) || null;
  }

  /**
   * Validates a workflow component contract
   */
  static validateComponent(component: Partial<WorkflowComponent>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!component.id || typeof component.id !== 'string' || !component.id.trim()) {
      errors.push('Component id is required and must be a non-empty string');
    }
    if (!component.name || typeof component.name !== 'string' || !component.name.trim()) {
      errors.push('Component name is required');
    }
    if (!component.version || (typeof component.version !== 'string' && typeof component.version !== 'number')) {
      errors.push('Component version is required');
    }
    if (!Array.isArray(component.inputs)) {
      errors.push('Component inputs must be an array');
    } else {
      for (const input of component.inputs) {
        if (!input.name || typeof input.name !== 'string') {
          errors.push('Each component input must have a valid name');
        }
      }
    }
    if (!Array.isArray(component.outputs)) {
      errors.push('Component outputs must be an array');
    } else {
      for (const output of component.outputs) {
        if (!output.name || typeof output.name !== 'string') {
          errors.push('Each component output must have a valid name');
        }
      }
    }
    if (!Array.isArray(component.steps) || component.steps.length === 0) {
      errors.push('Component must have at least one step');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates provided inputs against a component's declared input contracts
   */
  static validateInputs(component: WorkflowComponent, inputs: Record<string, any>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const input of component.inputs || []) {
      if (input.required && (inputs[input.name] === undefined || inputs[input.name] === '')) {
        errors.push(`Missing required input "${input.name}"`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Maps output variables from component extraction to workflow variables
   */
  static mapOutputs(
    component: WorkflowComponent,
    rawOutputs: Record<string, any>,
    bindings: Record<string, string>
  ): Record<string, any> {
    const result: Record<string, any> = {};
    for (const output of component.outputs || []) {
      const targetVar = bindings[output.name];
      if (targetVar && rawOutputs[output.name] !== undefined) {
        result[targetVar] = rawOutputs[output.name];
      }
    }
    return result;
  }

  /**
   * Registers or updates a workflow component
   */
  static async registerComponent(component: WorkflowComponent): Promise<WorkflowComponent> {
    const validation = this.validateComponent(component);
    if (!validation.valid) {
      throw new Error(`Invalid component: ${validation.errors.join('; ')}`);
    }

    // Check for direct self recursion
    for (const s of component.steps) {
      if ((s as ComponentInvocationStep).componentId === component.id) {
        throw new Error(`Circular recursion detected: component "${component.id}" cannot invoke itself`);
      }
    }

    const all = await this.getAllComponents();
    const existingIndex = all.findIndex((c) => c.id === component.id);

    const now = new Date().toISOString();
    const toSave: WorkflowComponent = {
      ...component,
      createdAt: component.createdAt || now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      all[existingIndex] = toSave;
    } else {
      all.push(toSave);
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEYS.COMPONENTS]: all });
    }

    return toSave;
  }

  /**
   * Deletes a component from the registry
   */
  static async deleteComponent(id: string): Promise<boolean> {
    const all = await this.getAllComponents();
    const filtered = all.filter((c) => c.id !== id);
    if (filtered.length === all.length) return false;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEYS.COMPONENTS]: filtered });
    }
    return true;
  }

  /**
   * Checks whether invoking componentId directly or transitively creates an infinite recursion cycle
   */
  static async detectCycle(
    rootComponentId: string,
    currentStepComponentId: string,
    visited = new Set<string>()
  ): Promise<boolean> {
    if (currentStepComponentId === rootComponentId || visited.has(currentStepComponentId)) {
      return true;
    }

    visited.add(currentStepComponentId);
    const comp = await this.getComponent(currentStepComponentId);
    if (!comp) return false;

    for (const step of comp.steps) {
      const subCompId = (step as ComponentInvocationStep).componentId;
      if (subCompId) {
        const hasCycle = await this.detectCycle(rootComponentId, subCompId, new Set(visited));
        if (hasCycle) return true;
      }
    }

    return false;
  }

  /**
   * Validates a component invocation step in a workflow against declared component inputs and detects recursion
   */
  static async validateInvocation(
    step: ComponentInvocationStep,
    callingWorkflowId?: string
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    if (!step.componentId) {
      errors.push('Component step is missing componentId');
      return { valid: false, errors };
    }

    const component = await this.getComponent(step.componentId);
    if (!component) {
      errors.push(`Referenced component "${step.componentId}" does not exist`);
      return { valid: false, errors };
    }

    // Check required inputs
    const bindings = step.inputBindings || {};
    for (const input of component.inputs) {
      if (input.required && (bindings[input.name] === undefined || bindings[input.name] === '')) {
        errors.push(`Missing required input binding "${input.name}" for component "${component.name}"`);
      }
    }

    // Recursion check if this is inside a component
    if (callingWorkflowId && (await this.detectCycle(callingWorkflowId, step.componentId))) {
      errors.push(`Cyclic component dependency detected between "${callingWorkflowId}" and "${step.componentId}"`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
