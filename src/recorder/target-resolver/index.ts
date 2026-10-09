import type { TargetDescriptor, Position } from '../../shared/types/workflow';

export function extractTargetInfo(el: Element): TargetDescriptor {
  const descriptor: TargetDescriptor = {
    tag: el.tagName.toLowerCase(),
  };

  if (el.id) descriptor.id = el.id;
  
  const testId = el.getAttribute('data-testid');
  if (testId) descriptor.testId = testId;
  
  const name = el.getAttribute('name');
  if (name) descriptor.name = name;
  
  const role = el.getAttribute('role');
  if (role) descriptor.role = role;
  
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) descriptor.ariaLabel = ariaLabel;
  
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) descriptor.placeholder = placeholder;
  
  // Basic text content (trim and limit length)
  const text = el.textContent?.trim();
  if (text && text.length > 0 && text.length < 100) {
    descriptor.text = text;
  }
  
  descriptor.selector = generateCssSelector(el);
  
  return descriptor;
}

export function calculateRelativePosition(el: Element, clientX: number, clientY: number): Position {
  const rect = el.getBoundingClientRect();
  const relativeX = (clientX - rect.left) / rect.width;
  const relativeY = (clientY - rect.top) / rect.height;
  
  return {
    clientX,
    clientY,
    relativeX: Math.max(0, Math.min(1, relativeX)),
    relativeY: Math.max(0, Math.min(1, relativeY))
  };
}

function generateCssSelector(el: Element): string {
  if (el.tagName.toLowerCase() === 'html') return 'html';
  if (el.id) return `#${el.id}`;
  
  const parts: string[] = [];
  let current: Element | null = el;
  
  while (current && current.tagName.toLowerCase() !== 'html') {
    let selector = current.tagName.toLowerCase();
    
    // 1. Check for ID
    if (current.id) {
      parts.unshift(`#${current.id}`);
      break; 
    }
    
    // 2. Check for common testing attributes
    const testAttr = ['data-testid', 'data-test', 'data-cy'].find(attr => current!.getAttribute(attr));
    if (testAttr) {
      parts.unshift(`[${testAttr}="${current.getAttribute(testAttr)}"]`);
      break; // Safe to stop at a test ID
    }
    
    // 3. Try to use stable classes
    let hasValidClass = false;
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.split(/\s+/).filter(c => 
        c.length > 0 && 
        !c.includes(':') && // Ignore tailwind pseudo-selectors
        !c.match(/^[a-zA-Z0-9_-]{1,3}$/) && // Ignore minified classes like 'a', 'b', 'xyz'
        !c.match(/\d+/) // Ignore classes with numbers (often dynamically generated like css-1x2y)
      );
      
      if (classes.length > 0) {
        selector += `.${classes.join('.')}`;
        hasValidClass = true;
      }
    }
    
    // 4. Fallback to nth-of-type if no useful classes exist, OR to ensure uniqueness among siblings
    if (!hasValidClass) {
      let sibling = current.previousElementSibling;
      let nth = 1;
      while (sibling) {
        if (sibling.tagName.toLowerCase() === current.tagName.toLowerCase()) {
          nth++;
        }
        sibling = sibling.previousElementSibling;
      }
      if (nth > 1) {
        selector += `:nth-of-type(${nth})`;
      }
    }
    
    parts.unshift(selector);
    current = current.parentElement;
  }
  
  return parts.join(' > ');
}
