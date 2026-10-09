import type { TargetDescriptor } from '../shared/types/workflow';

export interface ResolutionResult {
  element: Element | null;
  score: number;
  reason?: string;
}

export class TargetResolver {
  
  static resolve(descriptor: TargetDescriptor): ResolutionResult {
    const candidates = Array.from(document.querySelectorAll(descriptor.tag || '*'));
    
    let bestElement: Element | null = null;
    let bestScore = -1;

    for (const el of candidates) {
      const score = this.calculateScore(el, descriptor);
      if (score > bestScore) {
        bestScore = score;
        bestElement = el;
      }
    }

    if (bestScore < 30) {
      return { element: null, score: bestScore, reason: 'TARGET_NOT_FOUND' };
    }

    return { element: bestElement, score: bestScore };
  }

  private static calculateScore(el: Element, descriptor: TargetDescriptor): number {
    let score = 0;

    // High confidence attributes
    if (descriptor.testId && el.getAttribute('data-testid') === descriptor.testId) score += 100;
    if (descriptor.id && el.id === descriptor.id) score += 80;
    if (descriptor.name && el.getAttribute('name') === descriptor.name) score += 70;
    
    // Accessibility / text
    if (descriptor.ariaLabel && el.getAttribute('aria-label') === descriptor.ariaLabel) score += 60;
    if (descriptor.placeholder && el.getAttribute('placeholder') === descriptor.placeholder) score += 50;
    if (descriptor.text && el.textContent?.trim() === descriptor.text) score += 40;
    
    // Lower confidence attributes
    if (descriptor.role && el.getAttribute('role') === descriptor.role) score += 20;
    if (descriptor.tag && el.tagName.toLowerCase() === descriptor.tag) score += 10;
    
    // CSS Selector
    if (descriptor.selector) {
      try {
        if (el.matches(descriptor.selector)) {
          score += 50;
        }
      } catch {
        // invalid selector, ignore
      }
    }

    return score;
  }
}
