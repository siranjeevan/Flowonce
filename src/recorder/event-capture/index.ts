import type { WorkflowStep, ActionType } from '../../shared/types/workflow';
import { extractTargetInfo, calculateRelativePosition } from '../target-resolver';

type StepCallback = (step: WorkflowStep) => void;

export class Recorder {
  private isRecording = false;
  private stepCount = 0;
  private onStepRecorded: StepCallback | null = null;
  private sessionStartTime = 0;
  private scrollTimeout: number | null = null;

  constructor(onStepRecorded?: StepCallback) {
    if (onStepRecorded) this.onStepRecorded = onStepRecorded;
    this.bindEvents();
  }

  public start() {
    this.isRecording = true;
    this.stepCount = 0;
    this.sessionStartTime = Date.now();
    console.log("FlowOnce: Recording started");
  }

  public stop() {
    this.isRecording = false;
    console.log("FlowOnce: Recording stopped");
  }

  private bindEvents() {
    document.addEventListener('click', this.handleClick, true);
    document.addEventListener('input', this.handleInput, true);
    document.addEventListener('keydown', this.handleKeydown, true);
    document.addEventListener('scroll', this.handleScroll, true);
  }

  public unbindEvents() {
    document.removeEventListener('click', this.handleClick, true);
    document.removeEventListener('input', this.handleInput, true);
    document.removeEventListener('keydown', this.handleKeydown, true);
    document.removeEventListener('scroll', this.handleScroll, true);
    if (this.scrollTimeout) clearTimeout(this.scrollTimeout);
  }

  private recordAction(type: ActionType, event: Event, extraData: Partial<WorkflowStep> = {}, customTarget?: Element) {
    if (!this.isRecording) return;
    
    const target = customTarget || (event.target as Element);
    if (!target) return;

    // Ignore events from the extension itself if applicable
    
    this.stepCount++;
    const step: WorkflowStep = {
      id: `step_${Date.now()}_${this.stepCount}`,
      sequence: this.stepCount,
      type,
      timestamp: Date.now() - this.sessionStartTime,
      url: window.location.href,
      title: document.title,
      target: extractTargetInfo(target),
      ...extraData
    };

    if (this.onStepRecorded) {
      this.onStepRecorded(step);
    }
  }

  private handleClick = (e: MouseEvent) => {
    if (!this.isRecording) return;
    const target = e.target as Element;
    const position = calculateRelativePosition(target, e.clientX, e.clientY);
    
    this.recordAction('click', e, { position });
  };

  private isSensitiveElement(el: HTMLInputElement | HTMLTextAreaElement): boolean {
    if (el.type === 'password' || el.type === 'hidden') return true;
    
    const sensitiveKeywords = [
      'password', 'ccv', 'cvv', 'creditcard', 'card', 'token', 'apikey', 'api-key', 'secret',
      'otp', 'securitycode', 'auth'
    ];
    
    const attributesToCheck = [
      el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.placeholder, el.dataset.sensitive
    ];

    for (const attr of attributesToCheck) {
      if (!attr) continue;
      const lowerAttr = attr.toLowerCase();
      if (sensitiveKeywords.some(keyword => lowerAttr.includes(keyword))) {
        return true;
      }
    }
    
    return false;
  }

  private handleInput = (e: Event) => {
    if (!this.isRecording) return;
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    
    const isSensitive = this.isSensitiveElement(target);
    
    if (isSensitive) {
      this.recordAction('input', e, { value: target.value, sensitive: true });
    } else {
      this.recordAction('input', e, { value: target.value, sensitive: false });
    }
  };

  private handleKeydown = (e: KeyboardEvent) => {
    if (!this.isRecording) return;
    
    // Only record special keys that represent actions, like Enter, Escape, Tab, and Arrow keys for navigation
    if (['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      this.recordAction('keydown', e, { key: e.key });
    }
  };

  private handleScroll = (e: Event) => {
    if (!this.isRecording) return;

    if (this.scrollTimeout) {
      clearTimeout(this.scrollTimeout);
    }

    // Debounce scroll events by 500ms so we only record the final position
    this.scrollTimeout = setTimeout(() => {
      const target = e.target as HTMLElement | Document;
      
      let scrollX = 0;
      let scrollY = 0;
      let targetElement: Element | null = null;

      if (target === document || target === document.documentElement || target === document.body) {
        scrollX = window.scrollX;
        scrollY = window.scrollY;
        targetElement = document.documentElement;
      } else if (target instanceof HTMLElement) {
        scrollX = target.scrollLeft;
        scrollY = target.scrollTop;
        targetElement = target;
      }

      if (targetElement) {
        this.recordAction('scroll', e, { position: { scrollX, scrollY } }, targetElement);
      }
    }, 500);
  };
}
