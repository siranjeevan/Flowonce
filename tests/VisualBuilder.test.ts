import { describe, it, expect } from 'vitest';
import {
  validateWorkflowGraph,
  validateWorkflowStep,
  normalizeWorkflow,
} from '../src/workflow/storage/schema';
import type { Workflow, WorkflowStep } from '../src/shared/types/workflow';

describe('Phase 10: Visual Workflow Builder & Graph Validation', () => {
  const createBaseWorkflow = (steps: WorkflowStep[] = []): Workflow => ({
    id: 'wf_visual_test',
    name: 'Visual Builder Test Workflow',
    description: 'Testing visual builder graph validation and preview',
    version: 1,
    createdAt: 1000,
    updatedAt: 1000,
    steps,
    variables: [
      { name: 'authToken', type: 'string', sensitive: true },
      { name: 'userRole', type: 'string', defaultValue: 'admin' },
    ],
  });

  describe('Graph Structure and Layout Coordinates', () => {
    it('validates node layout coordinates x and y successfully', () => {
      const step: WorkflowStep = {
        id: 'step_1',
        type: 'click',
        timestamp: 100,
        url: 'https://example.com',
        sequence: 0,
        layout: { x: 120, y: 250 },
      };
      const errors = validateWorkflowStep(step, 0);
      expect(errors).toHaveLength(0);
    });

    it('rejects invalid layout coordinates with non-numeric values', () => {
      const step: any = {
        id: 'step_1',
        type: 'click',
        timestamp: 100,
        url: 'https://example.com',
        sequence: 0,
        layout: { x: 'invalid', y: 250 },
      };
      const errors = validateWorkflowStep(step, 0);
      expect(errors.some((e: any) => e.field === 'steps[0].layout')).toBe(true);
    });

    it('normalizes workflow and preserves visual layout coordinates intact', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_1',
          type: 'navigate',
          timestamp: 100,
          url: 'https://example.com',
          sequence: 0,
          layout: { x: 50, y: 100 },
        },
        {
          id: 'step_2',
          type: 'click',
          timestamp: 200,
          url: 'https://example.com',
          sequence: 1,
          layout: { x: 50, y: 250 },
        },
      ]);

      const normalized = normalizeWorkflow(wf);
      expect(normalized.steps[0].layout).toEqual({ x: 50, y: 100 });
      expect(normalized.steps[1].layout).toEqual({ x: 50, y: 250 });
    });
  });

  describe('Branch Target and Reachability Validation', () => {
    it('accepts valid conditional branch pointing to existing steps and "end"', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_cond',
          type: 'condition',
          timestamp: 100,
          url: 'https://example.com',
          sequence: 0,
          condition: {
            source: 'variable',
            name: 'userRole',
            operator: 'equals',
            value: 'admin',
            onTrue: 'step_target',
            onFalse: 'end',
          },
        },
        {
          id: 'step_target',
          type: 'click',
          timestamp: 200,
          url: 'https://example.com',
          sequence: 1,
        },
      ]);

      const res = validateWorkflowGraph(wf);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it('detects missing branch targets in onTrue and onFalse connections', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_cond',
          type: 'condition',
          timestamp: 100,
          url: 'https://example.com',
          sequence: 0,
          condition: {
            source: 'variable',
            name: 'userRole',
            operator: 'equals',
            value: 'admin',
            onTrue: 'non_existent_true_step',
            onFalse: 'non_existent_false_step',
          },
        },
      ]);

      const res = validateWorkflowGraph(wf);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.message.includes('non_existent_true_step'))).toBe(true);
      expect(res.errors.some((e) => e.message.includes('non_existent_false_step'))).toBe(true);
    });

    it('identifies unreachable disconnected steps as warnings', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_1',
          type: 'condition',
          timestamp: 100,
          url: 'https://example.com',
          sequence: 0,
          condition: {
            source: 'variable',
            name: 'userRole',
            operator: 'equals',
            value: 'admin',
            onTrue: 'step_3',
            onFalse: 'end',
          },
        },
        {
          id: 'step_2', // Unreachable because step_1 jumps to step_3 or ends
          type: 'click',
          timestamp: 200,
          url: 'https://example.com',
          sequence: 1,
        },
        {
          id: 'step_3',
          type: 'click',
          timestamp: 300,
          url: 'https://example.com',
          sequence: 2,
        },
      ]);

      const res = validateWorkflowGraph(wf);
      expect(res.unreachableStepIds).toContain('step_2');
      expect(res.warnings.some((w) => w.includes('step_2'))).toBe(true);
    });
  });

  describe('Cycle Detection in Control Flow', () => {
    it('detects infinite backward loop cycles', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_1',
          type: 'click',
          timestamp: 100,
          url: 'https://example.com',
          sequence: 0,
          condition: {
            source: 'variable',
            name: 'userRole',
            operator: 'equals',
            onTrue: 'step_2',
            onFalse: 'next',
          },
        },
        {
          id: 'step_2',
          type: 'click',
          timestamp: 200,
          url: 'https://example.com',
          sequence: 1,
          condition: {
            source: 'variable',
            name: 'userRole',
            operator: 'equals',
            onTrue: 'step_1', // Creates direct loop back to step_1
            onFalse: 'end',
          },
        },
      ]);

      const res = validateWorkflowGraph(wf);
      expect(res.hasCycle).toBe(true);
      expect(res.errors.some((e) => e.message.includes('cycle') || e.message.includes('Loop'))).toBe(true);
    });
  });

  describe('Template Variable Reference Validation', () => {
    it('validates declared variable interpolations in URLs and input values', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_1',
          type: 'navigate',
          timestamp: 100,
          url: 'https://example.com/login?token={{authToken}}',
          sequence: 0,
        },
        {
          id: 'step_2',
          type: 'input',
          timestamp: 200,
          url: 'https://example.com/form',
          value: 'Hello {{userRole}}',
          sequence: 1,
        },
      ]);

      const res = validateWorkflowGraph(wf);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it('rejects references to undeclared variables in step values', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_1',
          type: 'input',
          timestamp: 100,
          url: 'https://example.com/form',
          value: 'Hello {{undeclaredVariableXYZ}}',
          sequence: 0,
        },
      ]);

      const res = validateWorkflowGraph(wf);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.message.includes('undeclaredVariableXYZ'))).toBe(true);
    });

    it('rejects condition checking undeclared variable', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_1',
          type: 'condition',
          timestamp: 100,
          url: 'https://example.com',
          sequence: 0,
          condition: {
            source: 'variable',
            name: 'missingVar',
            operator: 'equals',
            value: 'foo',
          },
        },
      ]);

      const res = validateWorkflowGraph(wf);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.message.includes('missingVar'))).toBe(true);
    });
  });

  describe('URL Scheme Safety in Graph Validation', () => {
    it('flags dangerous javascript: and data: URLs', () => {
      const wf = createBaseWorkflow([
        {
          id: 'step_1',
          type: 'navigate',
          timestamp: 100,
          url: 'javascript:alert(1)',
          sequence: 0,
        },
      ]);

      const res = validateWorkflowGraph(wf);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.message.includes('unsupported URL scheme'))).toBe(true);
    });
  });
});
