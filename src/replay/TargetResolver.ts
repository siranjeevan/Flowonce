import type { TargetDescriptor } from '../shared/types/workflow';

export type ResolutionStatus =
  | 'FOUND'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'CONTEXT_MISMATCH'
  | 'NOT_INTERACTABLE';

export type ResolutionMethod =
  | 'exact_test_id'
  | 'exact_id'
  | 'exact_href'
  | 'exact_text'
  | 'exact_placeholder'
  | 'exact_aria_label'
  | 'container_context'
  | 'multi_attribute_scoring'
  | 'css_selector'
  | 'fallback';

export interface CandidateInfo {
  tag: string;
  id?: string;
  name?: string;
  textSnippet?: string;
  score: number;
}

export interface ResolutionOptions {
  allowAmbiguous?: boolean;
  rootDocument?: Document;
}

export interface ResolutionResult {
  status: ResolutionStatus;
  element: HTMLElement | null;
  score: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
  method?: ResolutionMethod;
  matchedAttributes?: string[];
  caveats?: string[];
  reason?: string;
  isAmbiguous?: boolean;
  candidatesCount?: number;
  competingCandidates?: CandidateInfo[];
  diagnostics?: {
    totalCandidatesExamined?: number;
    hardConstraintRejections?: number;
    topCandidateScore?: number;
    secondCandidateScore?: number;
    contextMatched?: boolean;
    invalidDescriptor?: boolean;
    frameAccessible?: boolean;
  };
}

function normalize(str: string | null | undefined): string {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getCleanHrefPath(href: string | null | undefined): string {
  if (!href) return '';
  return href
    .trim()
    .replace(/^https?:\/\/[^/]+/, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .toLowerCase();
}

export class TargetResolver {
  /**
   * Resolves a TargetDescriptor to an element in the DOM using a strict
   * hierarchy: Hard Identity Constraints -> Candidate Generation ->
   * Multi-Attribute Scoring -> Ambiguity & Collision Prevention.
   */
  public static resolve(
    descriptor: TargetDescriptor,
    options?: ResolutionOptions
  ): ResolutionResult {
    // 0. Validate descriptor
    if (!descriptor || typeof descriptor !== 'object') {
      return {
        status: 'NOT_FOUND',
        element: null,
        score: 0,
        confidence: 'none',
        reason: 'TARGET_NOT_FOUND',
        diagnostics: { invalidDescriptor: true },
      };
    }

    const hasAnyIdentifyingInfo =
      Boolean(descriptor.testId) ||
      Boolean(descriptor.id) ||
      Boolean(descriptor.href) ||
      Boolean(descriptor.text) ||
      Boolean(descriptor.placeholder) ||
      Boolean(descriptor.ariaLabel) ||
      Boolean(descriptor.name) ||
      Boolean(descriptor.selector) ||
      Boolean(descriptor.tag);

    if (!hasAnyIdentifyingInfo) {
      return {
        status: 'NOT_FOUND',
        element: null,
        score: 0,
        confidence: 'none',
        reason: 'TARGET_NOT_FOUND',
        diagnostics: { invalidDescriptor: true },
      };
    }

    // 1. Resolve Document Context (Frames / iframes)
    let searchDoc: Document = options?.rootDocument || document;

    if (descriptor.frameSelector) {
      try {
        const iframe = (options?.rootDocument || document).querySelector(
          descriptor.frameSelector
        ) as HTMLIFrameElement | null;

        if (!iframe) {
          return {
            status: 'NOT_FOUND',
            element: null,
            score: 0,
            confidence: 'none',
            reason: 'FRAME_NOT_FOUND',
            caveats: [`Iframe '${descriptor.frameSelector}' not found in document`],
            diagnostics: { frameAccessible: false },
          };
        }

        try {
          const frameDoc = iframe.contentDocument;
          if (!frameDoc) {
            return {
              status: 'CONTEXT_MISMATCH',
              element: null,
              score: 0,
              confidence: 'none',
              reason: 'INACCESSIBLE_CROSS_ORIGIN_FRAME',
              caveats: ['Frame is cross-origin or inaccessible by script'],
              diagnostics: { frameAccessible: false },
            };
          }
          searchDoc = frameDoc;
        } catch {
          return {
            status: 'CONTEXT_MISMATCH',
            element: null,
            score: 0,
            confidence: 'none',
            reason: 'INACCESSIBLE_CROSS_ORIGIN_FRAME',
            caveats: ['SecurityError: Frame is cross-origin and cannot be accessed'],
            diagnostics: { frameAccessible: false },
          };
        }
      } catch (err: unknown) {
        return {
          status: 'CONTEXT_MISMATCH',
          element: null,
          score: 0,
          confidence: 'none',
          reason: 'FRAME_QUERY_FAILED',
          caveats: [String(err)],
          diagnostics: { frameAccessible: false },
        };
      }
    }

    // 2. High-Confidence Fast Paths (Checked against hard constraints)
    // 2A. Test ID
    if (descriptor.testId) {
      try {
        const testAttr = `[data-testid="${CSS.escape(descriptor.testId)}"]`;
        const testEl = searchDoc.querySelector(testAttr) as HTMLElement | null;
        if (testEl && this.checkHardConstraints(testEl, descriptor).passes) {
          return {
            status: 'FOUND',
            element: testEl,
            score: 100,
            confidence: 'high',
            method: 'exact_test_id',
            matchedAttributes: ['testId'],
          };
        }
      } catch {}
    }

    // 2B. Unique Stable ID
    if (descriptor.id && !/\d{4,}/.test(descriptor.id)) {
      try {
        const idMatches = Array.from(
          searchDoc.querySelectorAll(`[id="${CSS.escape(descriptor.id)}"]`)
        ) as HTMLElement[];

        const validIdMatches = idMatches.filter(
          (el) => this.checkHardConstraints(el, descriptor).passes
        );

        if (validIdMatches.length === 1) {
          const el = validIdMatches[0];
          const elText = normalize(el.textContent);
          const targetText = normalize(descriptor.text);
          const textMatches =
            !targetText || !elText || elText.includes(targetText) || targetText.includes(elText);

          if (textMatches) {
            return {
              status: 'FOUND',
              element: el,
              score: 98,
              confidence: 'high',
              method: 'exact_id',
              matchedAttributes: ['id'],
            };
          }
        }
      } catch {}
    }

    // 3. Candidate Generation
    const candidateSet = new Set<HTMLElement>();

    // 3A. Exact or partial Href anchors
    if (descriptor.href && descriptor.href !== '#' && !descriptor.href.startsWith('javascript:')) {
      const allAnchors = Array.from(searchDoc.querySelectorAll('a')) as HTMLElement[];
      for (const a of allAnchors) candidateSet.add(a);
    }

    // 3B. CSS Selector matches (supporting candidates)
    if (descriptor.selector) {
      try {
        const selectorMatches = Array.from(
          searchDoc.querySelectorAll(descriptor.selector)
        ) as HTMLElement[];
        for (const el of selectorMatches) candidateSet.add(el);
      } catch {}
    }

    // 3C. Specific tag matches
    if (descriptor.tag) {
      try {
        const tagMatches = Array.from(
          searchDoc.querySelectorAll(descriptor.tag)
        ) as HTMLElement[];
        for (const el of tagMatches) candidateSet.add(el);
      } catch {}
    }

    // 3D. Interactive elements
    const interactives = Array.from(
      searchDoc.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], label, [tabindex]'
      )
    ) as HTMLElement[];
    for (const el of interactives) candidateSet.add(el);

    // 3E. Text-containing elements if text is provided
    if (descriptor.text && descriptor.text.trim().length > 1) {
      const textElements = Array.from(
        searchDoc.querySelectorAll('span, b, strong, p, h1, h2, h3, h4, h5, h6, li, td, th')
      ) as HTMLElement[];
      for (const el of textElements) candidateSet.add(el);
    }

    // Fallback: If set is still empty, scan all elements
    if (candidateSet.size === 0) {
      const allElements = Array.from(searchDoc.querySelectorAll('*')) as HTMLElement[];
      for (const el of allElements) candidateSet.add(el);
    }

    // 4. Map candidates to primary interactive targets & deduplicate
    const mappedCandidates = new Set<HTMLElement>();
    for (const el of candidateSet) {
      const interactive =
        (el.closest(
          'a, button, [role="button"], [role="link"], input, select, textarea'
        ) as HTMLElement | null) || el;
      mappedCandidates.add(interactive);
    }

    // 5. Apply Hard Constraints
    const viableCandidates: HTMLElement[] = [];
    let hardConstraintRejections = 0;

    for (const candidate of mappedCandidates) {
      const constraint = this.checkHardConstraints(candidate, descriptor);
      if (constraint.passes) {
        viableCandidates.push(candidate);
      } else {
        hardConstraintRejections++;
      }
    }

    if (viableCandidates.length === 0) {
      return {
        status: 'NOT_FOUND',
        element: null,
        score: 0,
        confidence: 'none',
        reason: 'TARGET_NOT_FOUND',
        diagnostics: {
          totalCandidatesExamined: mappedCandidates.size,
          hardConstraintRejections,
        },
      };
    }

    // 6. Score Viable Candidates
    interface ScoredCandidate {
      el: HTMLElement;
      score: number;
      matchedAttributes: string[];
      caveats: string[];
    }

    const scoredList: ScoredCandidate[] = [];

    for (const el of viableCandidates) {
      const scored = this.calculateCandidateScore(el, descriptor);
      if (scored.score >= 25) {
        scoredList.push({
          el,
          score: scored.score,
          matchedAttributes: scored.matchedAttributes,
          caveats: scored.caveats,
        });
      }
    }

    if (scoredList.length === 0) {
      return {
        status: 'NOT_FOUND',
        element: null,
        score: 0,
        confidence: 'none',
        reason: 'TARGET_NOT_FOUND',
        diagnostics: {
          totalCandidatesExamined: mappedCandidates.size,
          hardConstraintRejections,
        },
      };
    }

    // Sort descending by score
    scoredList.sort((a, b) => b.score - a.score);

    const top = scoredList[0];
    if (top.score < 30) {
      return {
        status: 'NOT_FOUND',
        element: null,
        score: top.score,
        confidence: 'none',
        reason: 'TARGET_NOT_FOUND',
        diagnostics: {
          totalCandidatesExamined: mappedCandidates.size,
          hardConstraintRejections,
          topCandidateScore: top.score,
        },
      };
    }
    const second = scoredList[1];

    // 7. Ambiguity Evaluation
    if (second && !options?.allowAmbiguous) {
      // Check if top and second are genuinely distinct controls
      const isDistinct =
        top.el !== second.el &&
        !top.el.contains(second.el) &&
        !second.el.contains(top.el);

      const topVisible = this.isElementVisuallyAvailable(top.el);
      const secondVisible = this.isElementVisuallyAvailable(second.el);

      // If both are distinct, both are visible, second has high score, and score gap is narrow:
      if (
        isDistinct &&
        topVisible &&
        secondVisible &&
        second.score >= 70 &&
        top.score - second.score <= 8
      ) {
        // Collect all tied candidates within the ambiguity window
        const tiedCandidates = scoredList.filter(
          (c) =>
            top.score - c.score <= 8 &&
            this.isElementVisuallyAvailable(c.el) &&
            (c.el === top.el || (!top.el.contains(c.el) && !c.el.contains(top.el)))
        );

        if (tiedCandidates.length > 1) {
          const competingCandidates: CandidateInfo[] = tiedCandidates.slice(0, 5).map((c) => ({
            tag: c.el.tagName.toLowerCase(),
            id: c.el.id || undefined,
            name: c.el.getAttribute('name') || undefined,
            textSnippet: (c.el.textContent || '').trim().substring(0, 50),
            score: c.score,
          }));

          return {
            status: 'AMBIGUOUS',
            element: null,
            score: top.score,
            confidence: 'low',
            reason: 'TARGET_AMBIGUOUS',
            isAmbiguous: true,
            candidatesCount: tiedCandidates.length,
            competingCandidates,
            diagnostics: {
              totalCandidatesExamined: mappedCandidates.size,
              hardConstraintRejections,
              topCandidateScore: top.score,
              secondCandidateScore: second.score,
            },
          };
        }
      }
    }

    // 8. Winning Result Determination
    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (top.score >= 85) confidence = 'high';
    else if (top.score >= 50) confidence = 'medium';

    let method: ResolutionMethod = 'multi_attribute_scoring';
    if (top.matchedAttributes.includes('href')) method = 'exact_href';
    else if (top.matchedAttributes.includes('text')) method = 'exact_text';
    else if (top.matchedAttributes.includes('placeholder')) method = 'exact_placeholder';
    else if (top.matchedAttributes.includes('containerText')) method = 'container_context';
    else if (top.matchedAttributes.includes('selector')) method = 'css_selector';

    return {
      status: 'FOUND',
      element: top.el,
      score: top.score,
      confidence,
      method,
      matchedAttributes: top.matchedAttributes,
      caveats: top.caveats.length > 0 ? top.caveats : undefined,
      diagnostics: {
        totalCandidatesExamined: mappedCandidates.size,
        hardConstraintRejections,
        topCandidateScore: top.score,
        secondCandidateScore: second?.score,
        contextMatched: top.matchedAttributes.includes('containerText'),
      },
    };
  }

  /**
   * Evaluates essential identity constraints (Category 1).
   * Contradictory candidates are rejected rather than rescued by unrelated positive scores.
   */
  public static checkHardConstraints(
    el: HTMLElement,
    descriptor: TargetDescriptor
  ): { passes: boolean; reason?: string } {
    // 1. Conflicting Link Destination (Href)
    if (descriptor.href && descriptor.href !== '#' && !descriptor.href.startsWith('javascript:')) {
      const targetClean = getCleanHrefPath(descriptor.href);
      if (targetClean.length > 1) {
        const elHref =
          el.getAttribute('href') ||
          el.closest('a')?.getAttribute('href') ||
          (el instanceof HTMLAnchorElement ? el.pathname : null);

        if (elHref) {
          const elClean = getCleanHrefPath(elHref);
          // If candidate points to a completely different destination:
          if (
            elClean.length > 1 &&
            elClean !== targetClean &&
            !elClean.endsWith(targetClean) &&
            !targetClean.endsWith(elClean)
          ) {
            return {
              passes: false,
              reason: `Conflicting link destination: expected '${targetClean}', got '${elClean}'`,
            };
          }
        }
      }
    }

    // 2. Conflicting Stable ID
    if (descriptor.id && !/\d{4,}/.test(descriptor.id) && descriptor.id.length < 35) {
      if (el.id && el.id !== descriptor.id && !/\d{4,}/.test(el.id)) {
        // If element has a completely different stable ID:
        return {
          passes: false,
          reason: `Conflicting stable ID: expected '${descriptor.id}', got '${el.id}'`,
        };
      }
    }

    // 3. Incompatible Control for Placeholder
    if (descriptor.placeholder) {
      const isInput =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el.querySelector('input, textarea') !== null;
      if (!isInput) {
        return {
          passes: false,
          reason: `Element does not support placeholder '${descriptor.placeholder}'`,
        };
      }
    }

    return { passes: true };
  }

  /**
   * Calculates candidate score based on Categories 2, 3, and 4 evidence.
   */
  private static calculateCandidateScore(
    el: HTMLElement,
    descriptor: TargetDescriptor
  ): { score: number; matchedAttributes: string[]; caveats: string[] } {
    let score = 0;
    const matchedAttributes: string[] = [];
    const caveats: string[] = [];

    const targetNorm = normalize(descriptor.text || descriptor.name || descriptor.ariaLabel);

    // 1. Exact TestId match
    if (descriptor.testId && el.getAttribute('data-testid') === descriptor.testId) {
      score += 100;
      matchedAttributes.push('testId');
    }

    // 1B. Exact ID match
    if (descriptor.id && el.id === descriptor.id) {
      score += 90;
      matchedAttributes.push('id');
    }

    // 2. Exact or Partial Href match
    if (descriptor.href) {
      const cleanTarget = getCleanHrefPath(descriptor.href);
      const elHref =
        el.getAttribute('href') ||
        el.closest('a')?.getAttribute('href') ||
        (el instanceof HTMLAnchorElement ? el.pathname : null);

      if (elHref) {
        const cleanEl = getCleanHrefPath(elHref);
        if (cleanEl === cleanTarget) {
          score += 95;
          matchedAttributes.push('href');
        } else if (cleanEl.endsWith(cleanTarget) || cleanTarget.endsWith(cleanEl)) {
          score += 75;
          matchedAttributes.push('href_partial');
        }
      }
    }

    // 3. Text Content Match & Context Penalty
    if (targetNorm && targetNorm.length > 1) {
      const elText = el.textContent || '';
      const elNorm = normalize(elText);

      if (elNorm && elNorm === targetNorm) {
        score += 95;
        matchedAttributes.push('text');
      } else if (
        elNorm.length >= 3 &&
        targetNorm.length >= 3 &&
        (elNorm.startsWith(targetNorm) || targetNorm.startsWith(elNorm))
      ) {
        score += 70;
        matchedAttributes.push('text_prefix');
      } else if (
        elNorm.length >= 3 &&
        targetNorm.length >= 3 &&
        (elNorm.includes(targetNorm) || targetNorm.includes(elNorm))
      ) {
        score += 50;
        matchedAttributes.push('text_substring');
      } else {
        // Word level overlap
        const targetWords = (descriptor.text || '')
          .toLowerCase()
          .split(/[\s/_-]+/)
          .filter((w) => w.length > 2);

        if (targetWords.length > 0) {
          const elLower = elText.toLowerCase();
          let matchedWords = 0;
          for (const w of targetWords) {
            if (elLower.includes(w)) matchedWords++;
          }

          if (matchedWords > 0) {
            score += Math.floor(35 * (matchedWords / targetWords.length));
            matchedAttributes.push('text_word_overlap');
          } else if (elNorm.length > 3) {
            // Contradictory text penalty (element has text, but zero words match)
            score -= 60;
            caveats.push('Text mismatch');
          }
        }
      }
    }

    // 4. Container Context Match (Critical for repeated items in cards, tables, lists)
    if (descriptor.containerText && descriptor.containerText.trim().length > 1) {
      const containerNorm = normalize(descriptor.containerText);
      const container =
        el.closest(
          'tr, [role="row"], li, [role="listitem"], article, [data-card], .card, .panel, section, [role="region"], fieldset, form, [role="group"]'
        ) || el.parentElement;

      if (container && container !== document.body && container !== document.documentElement) {
        const containerTextNorm = normalize(container.textContent);
        if (containerTextNorm.includes(containerNorm)) {
          score += 85;
          matchedAttributes.push('containerText');
        } else {
          // If in a container whose text contradicts containerText, apply penalty:
          score -= 90;
          caveats.push('Container context mismatch');
        }
      }
    }

    // 5. Placeholder Match
    if (descriptor.placeholder) {
      const elPlaceholder = el.getAttribute('placeholder') || el.querySelector('input, textarea')?.getAttribute('placeholder');
      if (elPlaceholder) {
        if (elPlaceholder === descriptor.placeholder) {
          score += 85;
          matchedAttributes.push('placeholder');
        } else if (
          elPlaceholder.includes(descriptor.placeholder) ||
          descriptor.placeholder.includes(elPlaceholder)
        ) {
          score += 45;
          matchedAttributes.push('placeholder_partial');
        } else {
          score -= 50;
        }
      }
    }

    // 6. Accessible Name & Label Match
    const aria =
      el.getAttribute('aria-label') ||
      el.closest('[aria-label]')?.getAttribute('aria-label') ||
      el.getAttribute('title');

    if (descriptor.ariaLabel) {
      if (aria === descriptor.ariaLabel) {
        score += 75;
        matchedAttributes.push('ariaLabel');
      } else if (
        aria &&
        (aria.includes(descriptor.ariaLabel) || descriptor.ariaLabel.includes(aria))
      ) {
        score += 40;
        matchedAttributes.push('ariaLabel_partial');
      }
    }

    // 7. Form Name attribute
    if (descriptor.name && el.getAttribute('name') === descriptor.name) {
      score += 55;
      matchedAttributes.push('name');
    }

    // 8. Role and Tag
    if (descriptor.role && el.getAttribute('role') === descriptor.role) {
      score += 20;
      matchedAttributes.push('role');
    }
    if (descriptor.tag && el.tagName.toLowerCase() === descriptor.tag.toLowerCase()) {
      score += 15;
      matchedAttributes.push('tag');
    }

    // 9. CSS Selector Match (Supporting evidence, healed if classes changed)
    if (descriptor.selector) {
      try {
        if (el.matches(descriptor.selector)) {
          score += 25;
          matchedAttributes.push('selector');
        }
      } catch {
        // Invalid selector, ignore
      }
    }

    // 10. Visual Availability Bonus & Hidden Penalty
    if (this.isElementVisuallyAvailable(el)) {
      score += 10;
    } else {
      score -= 70;
      caveats.push('Element is hidden or has zero geometry');
    }

    return { score, matchedAttributes, caveats };
  }

  /**
   * Helper to check if an element is visually available (not display:none, opacity:0, or visibility:hidden)
   */
  private static isElementVisuallyAvailable(el: Element): boolean {
    if (!el || !el.isConnected) return false;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
      } catch {}
    }
    return true;
  }

  /**
   * Pre-execution hit testing.
   * Checks whether the element or its legitimate interactive ancestor/descendant
   * is reachable at its center or interaction coordinates, or if an overlay obscures it.
   */
  public static checkHitTarget(
    el: HTMLElement,
    rootDoc: Document = document
  ): {
    isObstructed: boolean;
    hitElement?: Element | null;
    interactionPoint?: { x: number; y: number };
    reason?: string;
  } {
    if (!el || !el.isConnected) {
      return { isObstructed: true, reason: 'Element is not connected to the document' };
    }

    // In environments without elementFromPoint (e.g. standard jsdom without layout), return unobstructed
    if (typeof rootDoc.elementFromPoint !== 'function') {
      return { isObstructed: false };
    }

    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        // Fallback for inline or virtual elements in test environment
        return { isObstructed: false };
      }

      const pointsToCheck = [
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        { x: rect.left + 5, y: rect.top + 5 },
        { x: rect.right - 5, y: rect.bottom - 5 },
      ];

      for (const pt of pointsToCheck) {
        if (pt.x < 0 || pt.y < 0) continue;
        const hit = rootDoc.elementFromPoint(pt.x, pt.y);

        if (!hit) continue;

        // If the hit element is the target itself, a descendant, or an ancestor wrapper
        if (hit === el || el.contains(hit) || hit.contains(el)) {
          return { isObstructed: false, hitElement: hit, interactionPoint: pt };
        }

        // Check if hit element is a legitimate clickable parent wrapper
        const clickableAncestor = hit.closest('a, button, [role="button"], [role="link"], label');
        if (clickableAncestor && (clickableAncestor === el || el.contains(clickableAncestor))) {
          return { isObstructed: false, hitElement: hit, interactionPoint: pt };
        }
      }

      // If all checked points hit something outside el's hierarchy, it is obstructed!
      const centerPt = pointsToCheck[0];
      const obstructingEl = rootDoc.elementFromPoint(centerPt.x, centerPt.y);

      return {
        isObstructed: true,
        hitElement: obstructingEl,
        interactionPoint: centerPt,
        reason: obstructingEl
          ? `Obstructed by <${obstructingEl.tagName.toLowerCase()}${
              obstructingEl.className ? ` class="${obstructingEl.className}"` : ''
            }>`
          : 'Obstructed by an external element',
      };
    } catch {
      return { isObstructed: false };
    }
  }
}
