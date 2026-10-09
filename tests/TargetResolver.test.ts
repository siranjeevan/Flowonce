import { describe, it, expect, beforeEach } from 'vitest';
import { TargetResolver } from '../src/replay/TargetResolver';
import type { TargetDescriptor } from '../src/shared/types/workflow';

describe('TargetResolver', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves an element by data-testid with high score', () => {
    const el = document.createElement('button');
    el.setAttribute('data-testid', 'submit-btn');
    document.body.appendChild(el);

    const descriptor: TargetDescriptor = {
      tag: 'button',
      testId: 'submit-btn'
    };

    const result = TargetResolver.resolve(descriptor);
    expect(result.element).toBe(el);
    expect(result.score).toBeGreaterThan(90);
  });

  it('fails to resolve if score is too low', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const descriptor: TargetDescriptor = {
      tag: 'span',
      id: 'missing-id'
    };

    const result = TargetResolver.resolve(descriptor);
    expect(result.element).toBeNull();
    expect(result.reason).toBe('TARGET_NOT_FOUND');
  });

  it('picks the correct element among siblings', () => {
    const btn1 = document.createElement('button');
    btn1.setAttribute('aria-label', 'Cancel');
    document.body.appendChild(btn1);

    const btn2 = document.createElement('button');
    btn2.setAttribute('aria-label', 'Submit');
    document.body.appendChild(btn2);

    const descriptor: TargetDescriptor = {
      tag: 'button',
      ariaLabel: 'Submit'
    };

    const result = TargetResolver.resolve(descriptor);
    expect(result.element).toBe(btn2);
  });
});
