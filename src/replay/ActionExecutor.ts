import type { WorkflowStep } from '../shared/types/workflow';
import { TargetResolver } from './TargetResolver';

export class ActionExecutor {
  
  static async execute(step: WorkflowStep, speedMultiplier: number = 1): Promise<boolean> {
    
    // Video/Wait special cases without DOM targets
    if (step.type === 'wait') {
      const waitMs = parseInt(step.value || '1000') / speedMultiplier;
      await new Promise(res => setTimeout(res, waitMs));
      return true;
    }

    if (!step.target) return false;

    let resolution = TargetResolver.resolve(step.target);
    let el = resolution.element as HTMLElement;
    let attempts = 0;

    // Poll for the element to appear (up to 5 seconds)
    while (!el && attempts < 25) {
      await new Promise(res => setTimeout(res, 200));
      resolution = TargetResolver.resolve(step.target);
      el = resolution.element as HTMLElement;
      attempts++;
    }

    if (!el) {
      if (step.type === 'scroll') {
        console.warn(`TARGET_NOT_FOUND for scroll. Falling back to window scroll.`);
        el = document.documentElement;
      } else {
        throw new Error(`TARGET_NOT_FOUND: ${resolution.reason || 'Element did not appear in time'}`);
      }
    }

    // Ensure it's in view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // Wait for scrolling to settle
    await new Promise(res => setTimeout(res, 300 / speedMultiplier));

    switch (step.type) {
      case 'click':
        return this.executeClick(el);
      case 'input':
        return this.executeInput(el, step.value || '');
      case 'keypress':
      case 'keydown':
        return this.executeKeypress(el, step.key || '');
      case 'checkbox':
        return this.executeCheckbox(el, step.value === 'true');
      case 'scroll':
        return await this.executeScroll(el, step.position, speedMultiplier);
      default:
        console.warn('Action not implemented yet:', step.type);
        return true;
    }
  }

  private static executeClick(el: HTMLElement): boolean {
    el.focus();
    
    // Dispatch a sequence of events to simulate a real click
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    
    for (const eventType of events) {
      const event = new MouseEvent(eventType, {
        view: window,
        bubbles: true,
        cancelable: true,
        buttons: eventType === 'pointerdown' || eventType === 'mousedown' ? 1 : 0
      });
      el.dispatchEvent(event);
    }
    
    return true;
  }

  private static executeInput(el: HTMLElement, value: string): boolean {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  private static executeKeypress(el: HTMLElement, key: string): boolean {
    el.focus();
    const eventParams = {
      key: key,
      code: key === 'Enter' ? 'Enter' : key,
      keyCode: key === 'Enter' ? 13 : undefined,
      which: key === 'Enter' ? 13 : undefined,
      bubbles: true,
      cancelable: true
    };
    
    el.dispatchEvent(new KeyboardEvent('keydown', eventParams));
    el.dispatchEvent(new KeyboardEvent('keypress', eventParams));
    el.dispatchEvent(new KeyboardEvent('keyup', eventParams));

    // Synthetic events don't trigger native form submission, so we do it manually
    if (key === 'Enter') {
      const form = el.closest('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      }
    }
    
    return true;
  }

  private static executeCheckbox(el: HTMLElement, checked: boolean): boolean {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.checked !== checked) {
        el.click();
      }
      return true;
    }
    return false;
  }

  private static async executeScroll(el: HTMLElement, position?: any, speedMultiplier: number = 1): Promise<boolean> {
    if (!position || (position.scrollX === undefined && position.scrollY === undefined)) return false;
    
    // If it's the document/html/body, scroll the window
    if (el === document.documentElement || el === document.body) {
      window.scrollTo({
        left: position.scrollX || 0,
        top: position.scrollY || 0,
        behavior: 'auto'
      });
    } else {
      el.scrollTo({
        left: position.scrollX || 0,
        top: position.scrollY || 0,
        behavior: 'auto'
      });
      // Fallback for some custom scroll containers
      el.scrollLeft = position.scrollX || 0;
      el.scrollTop = position.scrollY || 0;
    }

    // Wait for scroll to settle
    await new Promise(res => setTimeout(res, 300 / speedMultiplier));
    return true;
  }
}
