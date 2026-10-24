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

    // Poll for the element to appear (up to 15 seconds)
    while (!el && attempts < 75) {
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
        const targetDesc = step.target.text ? `"${step.target.text}"` : (step.target.selector || step.target.id || step.target.name || 'element');
        throw new Error(`Could not find ${targetDesc} after 15s`);
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
    if (typeof el.focus === 'function') {
      try { el.focus(); } catch {}
    }
    
    // Find closest clickable ancestor (button, anchor, or custom role)
    const clickable = (el.closest('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]') as HTMLElement) || el;

    if (clickable !== el && typeof clickable.focus === 'function') {
      try { clickable.focus(); } catch {}
    }

    // Dispatch a complete sequence of pointer and mouse events
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

    // If clickable parent is different, also dispatch click event directly to it
    if (clickable !== el) {
      const event = new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true,
        buttons: 0
      });
      clickable.dispatchEvent(event);
    }

    // Call native click method to invoke native button actions or form submissions
    try {
      if (typeof clickable.click === 'function') {
        clickable.click();
      } else if (typeof el.click === 'function') {
        el.click();
      }
    } catch {}

    // If target is or is inside an <a> link, ensure it navigates in the current tab
    const link = el.closest('a') || (clickable instanceof HTMLAnchorElement ? clickable : null);
    if (link && link.href && !link.href.startsWith('javascript:')) {
      if (link.target === '_blank') link.target = '_self';
      try { link.click(); } catch {}
    }
    
    return true;
  }

  private static executeInput(el: HTMLElement, value: string): boolean {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      
      // Use prototype setter to trigger React/Vue/Angular change trackers
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } else if (el.isContentEditable) {
      el.focus();
      el.innerText = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
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
    
    // Always attempt window scroll
    window.scrollTo({
      left: position.scrollX || 0,
      top: position.scrollY || 0,
      behavior: 'auto'
    });

    // Also attempt to scroll the specific element
    if (el && el !== document.documentElement && el !== document.body) {
      try {
        el.scrollTo({
          left: position.scrollX || 0,
          top: position.scrollY || 0,
          behavior: 'auto'
        });
        el.scrollLeft = position.scrollX || 0;
        el.scrollTop = position.scrollY || 0;
      } catch (e) {}
    } else {
      // If we fell back to window (or the target was window), let's ALSO scroll any major scrollable container
      // This fixes virtualization issues on SPAs (like Meesho) where the main body isn't the true scroll container
      const scrollables = Array.from(document.querySelectorAll('*')).filter(e => {
        if (e === document.documentElement || e === document.body) return false;
        const style = window.getComputedStyle(e);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && e.scrollHeight > e.clientHeight;
      });
      
      // Sort by size (largest scrollable areas first)
      scrollables.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      
      // Apply the scroll to the top 3 largest scrollable areas
      scrollables.slice(0, 3).forEach(s => {
        s.scrollLeft = position.scrollX || 0;
        s.scrollTop = position.scrollY || 0;
      });
    }

    // Wait for scroll to settle
    await new Promise(res => setTimeout(res, 300 / speedMultiplier));
    return true;
  }
}
