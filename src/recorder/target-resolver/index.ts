import type { TargetDescriptor, Position } from '../../shared/types/workflow';

export function extractTargetInfo(el: Element): TargetDescriptor {
  // If clicked inside or on an interactive element (button, link, input, select, etc.),
  // the interactive element IS the primary target the user intended to interact with!
  const interactive = el.closest('a, button, [role="button"], [role="link"], input, select, textarea');
  const targetEl = interactive || el;

  const descriptor: TargetDescriptor = {
    tag: targetEl.tagName.toLowerCase(),
  };

  // 1. IDs (check targetEl first, fallback to child el)
  const id = targetEl.id || el.id;
  if (id) descriptor.id = id;

  // 2. Test IDs
  const testId = targetEl.getAttribute('data-testid') || el.getAttribute('data-testid');
  if (testId) descriptor.testId = testId;

  // 3. Name & Role
  const name = targetEl.getAttribute('name') || el.getAttribute('name');
  if (name) descriptor.name = name;

  const role = targetEl.getAttribute('role') || el.getAttribute('role');
  if (role) descriptor.role = role;

  // 4. Aria Label & Title
  const ariaLabel = targetEl.getAttribute('aria-label') || el.getAttribute('aria-label') || targetEl.getAttribute('title') || el.getAttribute('title');
  if (ariaLabel) descriptor.ariaLabel = ariaLabel;

  // 5. Placeholder
  const placeholder = targetEl.getAttribute('placeholder') || el.getAttribute('placeholder');
  if (placeholder) descriptor.placeholder = placeholder;

  // 6. Href (Critical for links like GitHub repos!)
  const href = targetEl.getAttribute('href') || (targetEl instanceof HTMLAnchorElement ? targetEl.pathname : null) || el.getAttribute('href');
  if (href) descriptor.href = href;

  // 7. Src (for images)
  const src = targetEl.getAttribute('src') || el.getAttribute('src');
  if (src) descriptor.src = src;

  // 8. Text Content (Critical for buttons, menu items, repo links!)
  // Normalize whitespace:
  const rawTargetText = targetEl.textContent?.replace(/\s+/g, ' ')?.trim();
  const rawElText = el.textContent?.replace(/\s+/g, ' ')?.trim();
  
  // Prefer targetEl's text (e.g. "siranjeevan / Git-puch-extension"), fallback to child text
  const text = rawTargetText || rawElText;
  if (text && text.length > 0) {
    descriptor.text = text.substring(0, 100);
  }

  // 9. Container Context (Critical for disambiguating repeated items in tables, cards, lists!)
  try {
    const container =
      targetEl.closest(
        'tr, [role="row"], li, [role="listitem"], article, [data-card], .card, .panel, section, [role="region"], fieldset, form, [role="group"]'
      ) || targetEl.parentElement;
    if (container && container !== targetEl && container !== document.body && container !== document.documentElement) {
      const heading = container.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], strong, b, .title');
      const headingText = heading?.textContent?.replace(/\s+/g, ' ')?.trim();
      if (headingText && headingText.length > 1 && headingText !== descriptor.text) {
        descriptor.containerText = headingText.substring(0, 80);
      } else {
        const rawContainer = container.textContent?.replace(/\s+/g, ' ')?.trim() || '';
        if (rawContainer && rawContainer !== descriptor.text) {
          const snippet = rawContainer.replace(descriptor.text || '', '').trim();
          if (snippet.length > 1) {
            descriptor.containerText = snippet.substring(0, 80);
          }
        }
      }
    }
  } catch {}

  // 10. Frame Context (if target resides in an accessible iframe)
  try {
    if (typeof window !== 'undefined' && targetEl.ownerDocument && targetEl.ownerDocument !== window.document) {
      const iframes = Array.from(window.document.querySelectorAll('iframe'));
      for (const iframe of iframes) {
        try {
          if (iframe.contentDocument === targetEl.ownerDocument) {
            descriptor.frameSelector = iframe.id
              ? `#${iframe.id}`
              : iframe.name
              ? `iframe[name="${iframe.name}"]`
              : generateCssSelector(iframe);
            break;
          }
        } catch {}
      }
    }
  } catch {}

  // 11. Context Snippet (e.g. associated form label)
  if (targetEl.id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(targetEl.id)}"]`);
      if (label?.textContent) {
        descriptor.contextSnippet = label.textContent.replace(/\s+/g, ' ').trim().substring(0, 60);
      }
    } catch {}
  }

  // 12. Generate CSS Selector for the primary target element
  descriptor.selector = generateCssSelector(targetEl);

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
  if (el.id) {
    const isDynamic = /\d{3,}/.test(el.id) || el.id.length > 35;
    if (!isDynamic) {
      try { return `#${CSS.escape(el.id)}`; } catch { return `#${el.id}`; }
    }
  }

  // Fast check: If element is an <a> tag with unique href:
  if (el.tagName.toLowerCase() === 'a') {
    const href = el.getAttribute('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:') && href.length < 120) {
      try {
        const selector = `a[href="${CSS.escape(href)}"]`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      } catch {}
    }
  }

  // Fast check: If element is a button with unique aria-label or name:
  if (el.tagName.toLowerCase() === 'button') {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 60 && !/\d{4,}/.test(aria)) {
      try {
        const selector = `button[aria-label="${CSS.escape(aria)}"]`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      } catch {}
    }
    const name = el.getAttribute('name');
    if (name && !/\d{4,}/.test(name)) {
      try {
        const selector = `button[name="${CSS.escape(name)}"]`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      } catch {}
    }
  }
  
  const parts: string[] = [];
  let current: Element | null = el;
  
  while (current && current.tagName.toLowerCase() !== 'html') {
    let selector = current.tagName.toLowerCase();
    
    // 1. Check for ID
    if (current.id) {
      const isDynamic = /\d{3,}/.test(current.id) || current.id.length > 35;
      if (!isDynamic) {
        try {
          parts.unshift(`#${CSS.escape(current.id)}`);
          break;
        } catch {}
      }
    }
    
    // 2. Check for common testing attributes
    const testAttr = ['data-testid', 'data-test', 'data-cy'].find(attr => current!.getAttribute(attr));
    if (testAttr) {
      const val = current.getAttribute(testAttr)!;
      try {
        parts.unshift(`[${testAttr}="${CSS.escape(val)}"]`);
        break;
      } catch {}
    }

    // 3. For interactive elements, check for stable aria-label, name, or href
    if (['button', 'input', 'a', 'select'].includes(current.tagName.toLowerCase())) {
      const aria = current.getAttribute('aria-label');
      if (aria && aria.length < 50 && !/\d{4,}/.test(aria)) {
        try {
          parts.unshift(`${current.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`);
          break;
        } catch {}
      }
      const name = current.getAttribute('name');
      if (name && !/\d{4,}/.test(name)) {
        try {
          parts.unshift(`${current.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`);
          break;
        } catch {}
      }
      if (current.tagName.toLowerCase() === 'a') {
        const href = current.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:') && href.length < 80) {
          try {
            parts.unshift(`a[href="${CSS.escape(href)}"]`);
            break;
          } catch {}
        }
      }
    }
    
    // 4. Try to use stable classes
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.split(/\s+/).filter(c => 
        c.length > 0 && 
        !c.includes(':') && // Ignore tailwind pseudo-selectors
        !c.includes('/') &&
        !c.includes('[') &&
        !c.match(/^[a-zA-Z0-9_-]{1,2}$/) && // Ignore minified single-letter classes
        !c.match(/\d{3,}/) && // Ignore classes with 3+ digits (dynamically generated)
        !c.startsWith('sc-') && 
        !c.startsWith('css-')
      );
      
      if (classes.length > 0) {
        try {
          selector += `.${classes.slice(0, 3).map(c => CSS.escape(c)).join('.')}`;
        } catch {}
      }
    }
    
    // 5. Calculate exact index among same-tag siblings to guarantee uniqueness
    let sibling = current.previousElementSibling;
    let nth = 1;
    while (sibling) {
      if (sibling.tagName.toLowerCase() === current.tagName.toLowerCase()) {
        nth++;
      }
      sibling = sibling.previousElementSibling;
    }
    selector += `:nth-of-type(${nth})`;
    
    parts.unshift(selector);
    current = current.parentElement;
  }
  
  return parts.join(' > ');
}
