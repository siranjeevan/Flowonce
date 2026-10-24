import type { TargetDescriptor } from '../shared/types/workflow';

export interface ResolutionResult {
  element: Element | null;
  score: number;
  reason?: string;
}

export class TargetResolver {
  
  static resolve(descriptor: TargetDescriptor): ResolutionResult {
    // 1. High confidence testId match
    if (descriptor.testId) {
      try {
        const el = document.querySelector(`[data-testid="${CSS.escape(descriptor.testId)}"]`);
        if (el) return { element: el, score: 100 };
      } catch {}
    }

    // 2. High confidence ID match (if ID is not purely random digits)
    if (descriptor.id && !/\d{4,}/.test(descriptor.id)) {
      const el = document.getElementById(descriptor.id);
      if (el) {
        const elText = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!descriptor.text || !elText || elText.includes(descriptor.text) || descriptor.text.includes(elText)) {
          return { element: el, score: 95 };
        }
      }
    }

    // 3. TARGETED SEARCH BY HREF (Critical for links & repositories like GitHub!)
    // If descriptor has an href (e.g. "/siranjeevan/Git-puch-extension"):
    if (descriptor.href && descriptor.href !== '#' && !descriptor.href.startsWith('javascript:')) {
      try {
        const cleanHref = descriptor.href.replace(/^https?:\/\/[^\/]+/, '');
        // Search for exact href or ending with the repo path
        const linkEl = document.querySelector(`a[href="${descriptor.href}"], a[href="${cleanHref}"], a[href$="${cleanHref}"]`);
        if (linkEl) {
          // If text was also recorded, make sure it's not a completely different link
          const linkText = (linkEl.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (!descriptor.text || !linkText || linkText.includes(descriptor.text.toLowerCase()) || descriptor.text.toLowerCase().includes(linkText)) {
            return { element: linkEl, score: 98 };
          }
        }
      } catch {}
    }

    // 4. TARGETED SEARCH BY EXACT TEXT (Critical for buttons, menu items, and repo names)
    if (descriptor.text && descriptor.text.trim().length > 1) {
      const targetText = descriptor.text.trim().toLowerCase();
      // Look through all interactive elements (links, buttons, menu items) for exact text match
      const interactives = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], li, span'));
      for (const el of interactives) {
        const elText = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (elText === targetText) {
          // If descriptor had an href, ensure it doesn't conflict
          if (descriptor.href) {
            const elHref = el.getAttribute('href') || el.closest('a')?.getAttribute('href');
            if (elHref && !elHref.includes(descriptor.href) && !descriptor.href.includes(elHref)) {
              continue;
            }
          }
          const clickable = el.closest('a, button, [role="button"], [role="link"]') || el;
          return { element: clickable, score: 96 };
        }
      }
    }

    // 5. TARGETED SEARCH BY PLACEHOLDER (Critical for search boxes)
    if (descriptor.placeholder) {
      try {
        const inputEl = document.querySelector(`input[placeholder="${CSS.escape(descriptor.placeholder)}"], textarea[placeholder="${CSS.escape(descriptor.placeholder)}"]`);
        if (inputEl) {
          return { element: inputEl, score: 95 };
        }
      } catch {}
    }

    // 6. Candidate search with tag or general interactive elements
    let candidates: Element[] = [];
    if (descriptor.tag) {
      try {
        candidates = Array.from(document.querySelectorAll(descriptor.tag));
      } catch {}
    }

    if (candidates.length === 0) {
      candidates = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [tabindex], *'));
    }
    
    let bestElement: Element | null = null;
    let bestScore = -1;

    for (const el of candidates) {
      const score = this.calculateScore(el, descriptor);
      if (score > bestScore) {
        bestScore = score;
        bestElement = el;
      }
    }

    // Fallback: If tag search scored low (< 45), search all interactive elements
    if (bestScore < 45 && descriptor.tag) {
      const allCandidates = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [tabindex], *'));
      for (const el of allCandidates) {
        const score = this.calculateScore(el, descriptor);
        if (score > bestScore) {
          bestScore = score;
          bestElement = el;
        }
      }
    }

    if (bestScore < 30) {
      return { element: null, score: bestScore, reason: 'TARGET_NOT_FOUND' };
    }

    return { element: bestElement, score: bestScore };
  }

  private static calculateScore(el: Element, descriptor: TargetDescriptor): number {
    let score = 0;

    // 1. Selector match
    if (descriptor.selector) {
      try {
        if (el.matches(descriptor.selector)) {
          score += 40;
        }
      } catch {
        // invalid selector, ignore
      }
    }

    // 2. Text Content Match (CRITICAL for distinguishing buttons, links, and tabs)
    if (descriptor.text) {
      const rawText = el.textContent || '';
      const elText = rawText.replace(/\s+/g, ' ').trim();
      const targetText = descriptor.text.trim();

      if (elText && targetText) {
        if (elText === targetText) {
          // Exact text match
          score += 85;
        } else if (elText.includes(targetText) || targetText.includes(elText)) {
          score += 55;
        } else {
          // Fuzzy word matching (splitting on spaces, slashes, dashes, and underscores)
          const descWords = targetText.toLowerCase().split(/[\s/_-]+/).filter(w => w.length > 2);
          if (descWords.length > 0) {
            let matchCount = 0;
            const elTextLower = elText.toLowerCase();
            for (const w of descWords) {
              if (elTextLower.includes(w)) matchCount++;
            }
            if (matchCount > 0) {
              score += Math.floor(45 * (matchCount / descWords.length));
            } else if (['button', 'a'].includes(el.tagName.toLowerCase())) {
              // Heavy penalty if this button or link has completely DIFFERENT text!
              score -= 80;
            }
          }
        }
      }
    }

    // 3. Links / Href Match & Penalty
    if (descriptor.href) {
      const elHref = el.getAttribute('href') || el.closest('a')?.getAttribute('href');
      if (elHref) {
        const cleanTargetHref = descriptor.href.replace(/^https?:\/\/[^\/]+/, '');
        const cleanElHref = elHref.replace(/^https?:\/\/[^\/]+/, '');
        if (cleanElHref === cleanTargetHref) {
          score += 80;
        } else if (cleanElHref.includes(cleanTargetHref) || cleanTargetHref.includes(cleanElHref)) {
          score += 50;
        } else {
          // If this is an <a> tag pointing to a completely different repository or page:
          score -= 90;
        }
      }
    }

    // 4. Placeholder Match & Penalty (for search boxes)
    if (descriptor.placeholder) {
      const elPlaceholder = el.getAttribute('placeholder');
      if (elPlaceholder) {
        if (elPlaceholder === descriptor.placeholder) {
          score += 80;
        } else if (elPlaceholder.includes(descriptor.placeholder) || descriptor.placeholder.includes(elPlaceholder)) {
          score += 40;
        } else {
          score -= 70;
        }
      }
    }

    // 5. Accessibility & Labels
    const aria = el.getAttribute('aria-label') || el.closest('[aria-label]')?.getAttribute('aria-label');
    if (descriptor.ariaLabel) {
      if (aria === descriptor.ariaLabel) {
        score += 65;
      } else if (aria && (aria.includes(descriptor.ariaLabel) || descriptor.ariaLabel.includes(aria))) {
        score += 40;
      }
    }

    // 6. Test ID, ID, and Name
    if (descriptor.testId && el.getAttribute('data-testid') === descriptor.testId) score += 70;
    if (descriptor.id && el.id === descriptor.id) score += 60;
    if (descriptor.name && el.getAttribute('name') === descriptor.name) score += 50;

    // 7. Role & Tag
    if (descriptor.role && el.getAttribute('role') === descriptor.role) score += 20;
    if (descriptor.tag && el.tagName.toLowerCase() === descriptor.tag) score += 15;

    return score;
  }
}
