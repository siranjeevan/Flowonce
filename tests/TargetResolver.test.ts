import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TargetResolver } from '../src/replay/TargetResolver';
import { WaitManager } from '../src/replay/WaitManager';
import { ActionExecutor } from '../src/replay/ActionExecutor';
import type { TargetDescriptor, WorkflowStep } from '../src/shared/types/workflow';

describe('Phase 4: Deterministic Target Resolution & Collision Prevention', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // GROUP 1: Identity and Scoring (Tests 1-7)
  // =========================================================================
  describe('Group 1: Identity and Scoring', () => {
    it('1. Unique ID match resolves with high confidence', () => {
      const btn = document.createElement('button');
      btn.id = 'checkout-btn';
      btn.textContent = 'Checkout';
      document.body.appendChild(btn);

      const result = TargetResolver.resolve({ id: 'checkout-btn', text: 'Checkout' });
      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(btn);
      expect(result.confidence).toBe('high');
      expect(result.score).toBeGreaterThanOrEqual(95);
      expect(result.matchedAttributes).toContain('id');
    });

    it('2. Exact link destination match resolves to the specific anchor', () => {
      document.body.innerHTML = `
        <nav>
          <a href="/settings/profile">Profile Settings</a>
          <a href="/settings/billing">Billing</a>
          <a href="/settings/security">Security</a>
        </nav>
      `;
      const billingLink = document.querySelectorAll('a')[1];

      const result = TargetResolver.resolve({ href: '/settings/billing', text: 'Billing' });
      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(billingLink);
      expect(result.matchedAttributes).toContain('href');
      expect(result.confidence).toBe('high');
    });

    it('3. Exact accessible name match resolves to labelled element', () => {
      const closeBtn = document.createElement('button');
      closeBtn.setAttribute('aria-label', 'Close dialog');
      closeBtn.textContent = '✕';
      document.body.appendChild(closeBtn);

      const result = TargetResolver.resolve({ ariaLabel: 'Close dialog' });
      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(closeBtn);
      expect(result.matchedAttributes).toContain('ariaLabel');
    });

    it('4. Conflicting link destination is rejected by hard constraint', () => {
      document.body.innerHTML = `
        <div id="main">
          <a href="/logout" class="action">Log Out</a>
        </div>
      `;

      // Descriptor points to /dashboard with matching CSS selector
      const result = TargetResolver.resolve({
        href: '/dashboard',
        selector: '#main a.action',
      });

      // The /logout anchor must be rejected by hard constraint!
      expect(result.status).toBe('NOT_FOUND');
      expect(result.element).toBeNull();
      expect(result.diagnostics?.hardConstraintRejections).toBeGreaterThan(0);
    });

    it('5. Conflicting mandatory identity attribute is rejected', () => {
      document.body.innerHTML = `
        <div class="search-box">Search documentation</div>
      `;

      // Placeholder is a mandatory control attribute for text entry
      const result = TargetResolver.resolve({
        placeholder: 'Search documentation',
      });

      expect(result.status).toBe('NOT_FOUND');
      expect(result.element).toBeNull();
    });

    it('6. Stale CSS selector is healed by other strong attributes', () => {
      document.body.innerHTML = `
        <button id="save-settings" class="btn-new-v2">Save Changes</button>
      `;
      const saveBtn = document.querySelector('button')!;

      // Old stale selector from previous site version
      const result = TargetResolver.resolve({
        id: 'save-settings',
        text: 'Save Changes',
        selector: '.btn-old-v1-obsolete',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(saveBtn);
      expect(result.score).toBeGreaterThanOrEqual(90);
    });

    it('7. Missing recorded target returns structured NOT_FOUND', () => {
      const result = TargetResolver.resolve({});
      expect(result.status).toBe('NOT_FOUND');
      expect(result.element).toBeNull();
      expect(result.confidence).toBe('none');
      expect(result.diagnostics?.invalidDescriptor).toBe(true);
    });
  });

  // =========================================================================
  // GROUP 2: Repeated Structures (Tests 8-14)
  // =========================================================================
  describe('Group 2: Repeated Structures', () => {
    it('8. Third item in a repository list is correctly resolved without picking the first', () => {
      document.body.innerHTML = `
        <ul class="repo-list">
          <li><a href="/user/repo-1"><span>user / repo-1</span></a></li>
          <li><a href="/user/repo-2"><span>user / repo-2</span></a></li>
          <li><a href="/user/repo-3"><span>user / repo-3</span></a></li>
          <li><a href="/user/repo-4"><span>user / repo-4</span></a></li>
        </ul>
      `;
      const repo3 = document.querySelectorAll('a')[2];

      const result = TargetResolver.resolve({
        tag: 'a',
        href: '/user/repo-3',
        text: 'user / repo-3',
        selector: 'ul.repo-list > li > a', // generic selector matching all 4!
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(repo3);
    });

    it('9. Repeated product cards resolve specifically using containerText', () => {
      document.body.innerHTML = `
        <div class="card" data-card="1">
          <h3>Alpha Product</h3>
          <button class="add-to-cart">Add to Cart</button>
        </div>
        <div class="card" data-card="2">
          <h3>Beta Product</h3>
          <button class="add-to-cart">Add to Cart</button>
        </div>
        <div class="card" data-card="3">
          <h3>Gamma Product</h3>
          <button class="add-to-cart">Add to Cart</button>
        </div>
      `;
      const betaButton = document.querySelectorAll('.add-to-cart')[1];

      const result = TargetResolver.resolve({
        tag: 'button',
        text: 'Add to Cart',
        containerText: 'Beta Product',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(betaButton);
      expect(result.matchedAttributes).toContain('containerText');
    });

    it('10. Duplicate button labels without context are reported as AMBIGUOUS', () => {
      document.body.innerHTML = `
        <div class="row"><button class="del-btn">Delete</button></div>
        <div class="row"><button class="del-btn">Delete</button></div>
      `;

      const result = TargetResolver.resolve({
        tag: 'button',
        text: 'Delete',
      });

      expect(result.status).toBe('AMBIGUOUS');
      expect(result.isAmbiguous).toBe(true);
      expect(result.candidatesCount).toBe(2);
      expect(result.competingCandidates?.length).toBe(2);
    });

    it('11. Identical nested elements collapse to the primary interactive target', () => {
      document.body.innerHTML = `
        <a href="/home" id="home-link">
          <span>
            <span>
              <span>Home Page</span>
            </span>
          </span>
        </a>
      `;
      const anchor = document.getElementById('home-link')!;

      const result = TargetResolver.resolve({
        href: '/home',
        text: 'Home Page',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(anchor);
      expect(result.isAmbiguous).toBeFalsy();
    });

    it('12. Repeated table-row actions resolve to correct row based on row context', () => {
      document.body.innerHTML = `
        <table>
          <tbody>
            <tr><td>#101</td><td>Alice</td><td><button class="edit-btn">Edit</button></td></tr>
            <tr><td>#102</td><td>Bob</td><td><button class="edit-btn">Edit</button></td></tr>
            <tr><td>#103</td><td>Charlie</td><td><button class="edit-btn">Edit</button></td></tr>
          </tbody>
        </table>
      `;
      const bobEditBtn = document.querySelectorAll('.edit-btn')[1];

      const result = TargetResolver.resolve({
        tag: 'button',
        text: 'Edit',
        containerText: 'Bob',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(bobEditBtn);
    });

    it('13. Hidden duplicate controls: active visible control wins over hidden duplicate', () => {
      document.body.innerHTML = `
        <button id="desktop-login" style="display: none;">Log In</button>
        <button id="mobile-login" style="display: block;">Log In</button>
      `;
      const mobileBtn = document.getElementById('mobile-login')!;

      const result = TargetResolver.resolve({
        tag: 'button',
        text: 'Log In',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(mobileBtn);
    });

    it('14. Detached elements after rerender resolve to the fresh connected element', () => {
      const oldBtn = document.createElement('button');
      oldBtn.id = 'dynamic-btn';
      oldBtn.textContent = 'Action';
      document.body.appendChild(oldBtn);

      // Re-render: remove old, insert new
      document.body.removeChild(oldBtn);

      const freshBtn = document.createElement('button');
      freshBtn.id = 'dynamic-btn';
      freshBtn.textContent = 'Action';
      document.body.appendChild(freshBtn);

      const result = TargetResolver.resolve({
        id: 'dynamic-btn',
        text: 'Action',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(freshBtn);
      expect(result.element?.isConnected).toBe(true);
    });
  });

  // =========================================================================
  // GROUP 3: Ambiguity (Tests 15-19)
  // =========================================================================
  describe('Group 3: Ambiguity and Collision Prevention', () => {
    it('15. Two equally plausible candidates report AMBIGUOUS instead of clicking arbitrary item', () => {
      document.body.innerHTML = `
        <button class="confirm-btn">Confirm Order</button>
        <button class="confirm-btn">Confirm Order</button>
      `;

      const result = TargetResolver.resolve({
        text: 'Confirm Order',
        selector: '.confirm-btn',
      });

      expect(result.status).toBe('AMBIGUOUS');
      expect(result.element).toBeNull();
      expect(result.candidatesCount).toBe(2);
    });

    it('16. High-scoring candidate that contradicts recorded destination is rejected', () => {
      document.body.innerHTML = `
        <a href="/docs/getting-started" class="nav-item">Documentation Guide</a>
        <a href="/api/reference" class="nav-item">Documentation Guide</a>
      `;
      const docsLink = document.querySelectorAll('a')[0];

      // Second anchor matches text & class, but href points to /api/reference
      const result = TargetResolver.resolve({
        href: '/docs/getting-started',
        text: 'Documentation Guide',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(docsLink);
    });

    it('17. Unique candidate with weaker but consistent evidence returns FOUND with medium confidence', () => {
      document.body.innerHTML = `
        <button class="btn-checkout">Proceed to Checkout</button>
      `;
      const btn = document.querySelector('button')!;

      const result = TargetResolver.resolve({
        text: 'Checkout',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(btn);
      expect(['medium', 'high']).toContain(result.confidence);
    });

    it('18. Multiple candidates inside different containers are disambiguated by container text', () => {
      document.body.innerHTML = `
        <div class="panel">
          <h2>Billing Settings</h2>
          <button class="cfg-btn">Configure</button>
        </div>
        <div class="panel">
          <h2>Security Settings</h2>
          <button class="cfg-btn">Configure</button>
        </div>
      `;
      const secBtn = document.querySelectorAll('.cfg-btn')[1];

      const result = TargetResolver.resolve({
        tag: 'button',
        text: 'Configure',
        containerText: 'Security Settings',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(secBtn);
    });

    it('19. Duplicate DOM representations of the same logical control do not trigger false ambiguity', () => {
      document.body.innerHTML = `
        <button id="send-btn" class="primary-btn">
          <svg class="icon"><path d="M0 0h24v24H0z"/></svg>
          <span class="label">Send Message</span>
        </button>
      `;
      const sendBtn = document.getElementById('send-btn')!;

      const result = TargetResolver.resolve({
        text: 'Send Message',
        tag: 'button',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(sendBtn);
      expect(result.isAmbiguous).toBeFalsy();
    });

    it('19B. Duplicate navigation links to the exact same destination (like GitHub sidebar vs mobile drawer) resolve cleanly without reporting AMBIGUOUS', () => {
      document.body.innerHTML = `
        <aside class="sidebar">
          <h2>Top repositories</h2>
          <ul>
            <li><a id="sidebar-repo" href="/siranjeevan/Git-puch-extension">siranjeevan/Git-puch-extension</a></li>
          </ul>
        </aside>
        <div class="mobile-drawer">
          <a id="drawer-repo" href="/siranjeevan/Git-puch-extension">siranjeevan/Git-puch-extension</a>
        </div>
      `;
      const sidebarRepo = document.getElementById('sidebar-repo')!;

      const result = TargetResolver.resolve({
        tag: 'a',
        href: '/siranjeevan/Git-puch-extension',
        text: 'siranjeevan/Git-puch-extension',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).not.toBeNull();
      expect([sidebarRepo, document.getElementById('drawer-repo')!]).toContain(result.element);
      expect(result.isAmbiguous).toBeFalsy();
    });

    it('19C. Elements inside closed <dialog> or [aria-hidden="true"] containers are excluded from competing candidates', () => {
      document.body.innerHTML = `
        <aside class="sidebar">
          <a id="active-repo" href="/siranjeevan/Git-puch-extension">siranjeevan/Git-puch-extension</a>
        </aside>
        <dialog id="command-palette">
          <a id="hidden-palette-repo" href="/siranjeevan/Git-puch-extension">siranjeevan/Git-puch-extension</a>
        </dialog>
      `;
      const activeRepo = document.getElementById('active-repo')!;

      const result = TargetResolver.resolve({
        tag: 'a',
        href: '/siranjeevan/Git-puch-extension',
        text: 'siranjeevan/Git-puch-extension',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(activeRepo);
      expect(result.isAmbiguous).toBeFalsy();
    });

    it('19D. Specific repository link resolves to interactive anchor without AMBIGUOUS even when recorded without href and competing with query-builder/modal item', () => {
      document.body.innerHTML = `
        <aside class="sidebar">
          <h2>Top repositories</h2>
          <ul>
            <li><a id="sidebar-repo" href="/siranjeevan/Git-puch-extension">siranjeevan/Git-puch-extension</a></li>
          </ul>
        </aside>
        <div id="command-palette-pjax-container" class="qbsearch-modal">
          <div role="option" id="modal-option">
            <span>siranjeevan/Git-puch-extension</span>
          </div>
        </div>
      `;
      const sidebarRepo = document.getElementById('sidebar-repo')!;

      const result = TargetResolver.resolve({
        text: 'siranjeevan/Git-puch-extension',
      });

      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(sidebarRepo);
      expect(result.isAmbiguous).toBeFalsy();
    });
  });

  // =========================================================================
  // GROUP 4: Interactability and Hit Testing (Tests 20-25)
  // =========================================================================
  describe('Group 4: Interactability and Hit Testing', () => {
    it('20. Disabled target is detected as not enabled', () => {
      const btn = document.createElement('button');
      btn.disabled = true;
      btn.textContent = 'Submit';
      document.body.appendChild(btn);

      expect(WaitManager.isElementEnabled(btn)).toBe(false);
      expect(WaitManager.isElementInteractable(btn, 'click')).toBe(false);
    });

    it('21. Hidden target is detected as not visible', () => {
      const div = document.createElement('div');
      div.style.display = 'none';
      div.textContent = 'Hidden Content';
      document.body.appendChild(div);

      expect(WaitManager.isElementVisible(div)).toBe(false);
      expect(WaitManager.isElementInteractable(div, 'click')).toBe(false);
    });

    it('22. Obstructed target is detected by checkHitTarget', () => {
      const btn = document.createElement('button');
      btn.id = 'covered-btn';
      btn.textContent = 'Covered';
      document.body.appendChild(btn);

      // Mock bounding rect
      vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 80, height: 30, top: 100, left: 100, right: 180, bottom: 130, toJSON: () => {}
      });

      // Mock elementFromPoint to simulate a modal overlay obscuring the button
      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop';
      document.body.appendChild(overlay);

      document.elementFromPoint = vi.fn().mockReturnValue(overlay);

      const hit = TargetResolver.checkHitTarget(btn);
      expect(hit.isObstructed).toBe(true);
      expect(hit.reason).toContain('modal-backdrop');
    });

    it('23. Target that moves during scrolling is handled by waitForStableElement', async () => {
      const el = document.createElement('div');
      document.body.appendChild(el);

      let callCount = 0;
      vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => {
        callCount++;
        // Position changes initially, then stabilizes
        const top = callCount < 3 ? 100 + callCount * 10 : 130;
        return {
          x: 0, y: top, width: 100, height: 50, top, left: 0, right: 100, bottom: top + 50, toJSON: () => {}
        };
      });

      const stableEl = await WaitManager.waitForStableElement(el, { settleDelayMs: 40 });
      expect(stableEl).toBe(el);
    });

    it('24. Target replaced before execution re-resolves and executes successfully', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      const oldBtn = document.createElement('button');
      oldBtn.id = 'replace-target';
      oldBtn.textContent = 'Click Me';
      container.appendChild(oldBtn);

      const step: WorkflowStep = {
        id: 'step_replace',
        type: 'click',
        timestamp: Date.now(),
        url: 'http://localhost/test',
        sequence: 1,
        target: { id: 'replace-target', text: 'Click Me' },
      };

      // Mock scrollIntoView
      window.HTMLElement.prototype.scrollIntoView = vi.fn(() => {
        // Simulate DOM rerender detaching the element during scroll!
        container.innerHTML = `<button id="replace-target">Click Me</button>`;
      });

      const clickSpy = vi.fn();
      document.addEventListener('click', clickSpy);

      const success = await ActionExecutor.execute(step);
      expect(success).toBe(true);
    });

    it('25. Valid target inside an accessible interaction wrapper is executed properly', async () => {
      document.body.innerHTML = `
        <div role="button" tabindex="0" id="custom-wrapper">
          <span class="inner">Custom Button</span>
        </div>
      `;
      const wrapper = document.getElementById('custom-wrapper')!;

      const step: WorkflowStep = {
        id: 'step_custom',
        type: 'click',
        timestamp: Date.now(),
        url: 'http://localhost/test',
        sequence: 1,
        target: { text: 'Custom Button', role: 'button' },
      };

      const clickSpy = vi.fn();
      wrapper.addEventListener('click', clickSpy);

      const success = await ActionExecutor.execute(step);
      expect(success).toBe(true);
      expect(clickSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GROUP 5: Compatibility & Special Environments (Tests 26-30)
  // =========================================================================
  describe('Group 5: Compatibility and Special Environments', () => {
    it('26. Legacy target descriptors without new fields resolve seamlessly', () => {
      document.body.innerHTML = `
        <button class="legacy-btn">Submit Order</button>
      `;
      const btn = document.querySelector('button')!;

      // Legacy descriptor without containerText, frameSelector, etc.
      const legacyDescriptor: TargetDescriptor = {
        tag: 'button',
        selector: 'button.legacy-btn',
        text: 'Submit Order',
      };

      const result = TargetResolver.resolve(legacyDescriptor);
      expect(result.status).toBe('FOUND');
      expect(result.element).toBe(btn);
    });

    it('27. SPA route changes: waitForUrlChange detects URL navigation without full page reload', async () => {
      const initialUrl = window.location.href;

      setTimeout(() => {
        window.history.pushState({}, '', '/settings');
      }, 50);

      const newUrl = await WaitManager.waitForUrlChange(initialUrl, { timeoutMs: 1000, pollIntervalMs: 20 });
      expect(newUrl).toContain('/settings');
    });

    it('28. Supported iframe resolution finds target inside accessible frame', () => {
      const iframe = document.createElement('iframe');
      iframe.id = 'sub-frame';
      document.body.appendChild(iframe);

      const frameDoc = iframe.contentDocument;
      expect(frameDoc).toBeTruthy();

      if (frameDoc) {
        const frameBtn = frameDoc.createElement('button');
        frameBtn.id = 'frame-action';
        frameBtn.textContent = 'Frame Action';
        frameDoc.body.appendChild(frameBtn);

        const result = TargetResolver.resolve({
          frameSelector: '#sub-frame',
          id: 'frame-action',
          text: 'Frame Action',
        });

        expect(result.status).toBe('FOUND');
        expect(result.element).toBe(frameBtn);
      }
    });

    it('29. Inaccessible cross-origin frame returns structured CONTEXT_MISMATCH', () => {
      const iframe = document.createElement('iframe');
      iframe.id = 'cross-origin-frame';
      document.body.appendChild(iframe);

      // Simulate cross-origin security restriction
      Object.defineProperty(iframe, 'contentDocument', {
        get: () => {
          throw new Error('SecurityError: Blocked a frame with origin from accessing a cross-origin frame.');
        },
      });

      const result = TargetResolver.resolve({
        frameSelector: '#cross-origin-frame',
        id: 'external-target',
      });

      expect(result.status).toBe('CONTEXT_MISMATCH');
      expect(result.element).toBeNull();
      expect(result.reason).toBe('INACCESSIBLE_CROSS_ORIGIN_FRAME');
    });

    it('30. Resolver integrates with WaitManager: waitForElement synchronizes with delayed DOM rendering', async () => {
      setTimeout(() => {
        const delayedCard = document.createElement('div');
        delayedCard.className = 'card';
        delayedCard.innerHTML = `<h3>Generated Title</h3><button id="resolved-btn">Proceed</button>`;
        document.body.appendChild(delayedCard);
      }, 60);

      const el = await WaitManager.waitForElement(
        {
          id: 'resolved-btn',
          text: 'Proceed',
          containerText: 'Generated Title',
        },
        { timeoutMs: 2000, pollIntervalMs: 20 }
      );

      expect(el).toBeTruthy();
      expect(el.id).toBe('resolved-btn');
    });
  });
});
