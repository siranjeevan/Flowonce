import { describe, it, expect, beforeEach } from 'vitest';
import { OutputExtractor } from '../src/replay/OutputExtractor';
import type { OutputExtractionConfig } from '../src/shared/types/workflow';

describe('Phase 7: OutputExtractor (DOM Output Extraction & Value Getters)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('1. Extracts text_content and inner_text from elements', async () => {
    const div = document.createElement('div');
    div.id = 'status-msg';
    div.innerHTML = '  Order <strong>#12345</strong> confirmed!  ';
    document.body.appendChild(div);

    const config: OutputExtractionConfig = {
      id: 'ext_1',
      type: 'text_content',
      variableName: 'orderStatus',
      target: { id: 'status-msg' },
    };

    const result = await OutputExtractor.extract(config);
    expect(result.success).toBe(true);
    expect(result.value).toBe('Order #12345 confirmed!');
    expect(result.variableName).toBe('orderStatus');
  });

  it('2. Extracts element attributes (e.g. data attributes)', async () => {
    const card = document.createElement('div');
    card.id = 'item-card';
    card.setAttribute('data-product-sku', 'SKU-998877');
    document.body.appendChild(card);

    const config: OutputExtractionConfig = {
      id: 'ext_2',
      type: 'attribute',
      attributeName: 'data-product-sku',
      variableName: 'productSku',
      target: { id: 'item-card' },
    };

    const result = await OutputExtractor.extract(config);
    expect(result.success).toBe(true);
    expect(result.value).toBe('SKU-998877');
  });

  it('3. Extracts input_value for input elements and textareas', async () => {
    const input = document.createElement('input');
    input.id = 'coupon-input';
    input.value = 'DISCOUNT50';
    document.body.appendChild(input);

    const config: OutputExtractionConfig = {
      id: 'ext_3',
      type: 'input_value',
      variableName: 'appliedCoupon',
      target: { id: 'coupon-input' },
    };

    const result = await OutputExtractor.extract(config);
    expect(result.success).toBe(true);
    expect(result.value).toBe('DISCOUNT50');
  });

  it('4. Extracts checked_state as boolean from checkbox', async () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'terms-agree';
    checkbox.checked = true;
    document.body.appendChild(checkbox);

    const config: OutputExtractionConfig = {
      id: 'ext_4',
      type: 'checked_state',
      variableName: 'termsAccepted',
      target: { id: 'terms-agree' },
    };

    const result = await OutputExtractor.extract(config);
    expect(result.success).toBe(true);
    expect(result.value).toBe(true);
  });

  it('5. Extracts selected_value from select dropdown', async () => {
    const select = document.createElement('select');
    select.id = 'country-select';
    select.innerHTML = `
      <option value="US">United States</option>
      <option value="CA" selected>Canada</option>
      <option value="MX">Mexico</option>
    `;
    document.body.appendChild(select);

    const config: OutputExtractionConfig = {
      id: 'ext_5',
      type: 'selected_value',
      variableName: 'selectedCountry',
      target: { id: 'country-select' },
    };

    const result = await OutputExtractor.extract(config);
    expect(result.success).toBe(true);
    expect(result.value).toBe('CA');
  });

  it('6. Extracts document_title and current_url without requiring target', async () => {
    document.title = 'Checkout Complete - Acme Store';

    const titleConfig: OutputExtractionConfig = {
      id: 'ext_6_title',
      type: 'document_title',
      variableName: 'pageTitle',
    };
    const titleResult = await OutputExtractor.extract(titleConfig);
    expect(titleResult.success).toBe(true);
    expect(titleResult.value).toBe('Checkout Complete - Acme Store');

    const urlConfig: OutputExtractionConfig = {
      id: 'ext_6_url',
      type: 'current_url',
      variableName: 'currentUrl',
    };
    const urlResult = await OutputExtractor.extract(urlConfig);
    expect(urlResult.success).toBe(true);
    expect(typeof urlResult.value).toBe('string');
  });

  it('7. Sanitizes sensitive extracted values in diagnosticInfo', async () => {
    const input = document.createElement('input');
    input.id = 'card-token';
    input.value = 'tok_visa_4242424242424242';
    document.body.appendChild(input);

    const config: OutputExtractionConfig = {
      id: 'ext_7',
      type: 'input_value',
      variableName: 'cardToken',
      target: { id: 'card-token' },
    };

    const result = await OutputExtractor.extract(config, { isSensitive: true });
    expect(result.success).toBe(true);
    // Raw value is preserved for workflow execution
    expect(result.value).toBe('tok_visa_4242424242424242');
    // But masked in diagnostic logs
    expect(result.diagnosticInfo).toContain('••••••••');
    expect(result.diagnosticInfo).not.toContain('tok_visa_4242424242424242');
  });

  it('8. Returns failure result gracefully when element cannot be found', async () => {
    const config: OutputExtractionConfig = {
      id: 'ext_8',
      type: 'text_content',
      variableName: 'missingEl',
      target: { id: 'non-existent-element-12345' },
      timeoutMs: 100,
    };

    const result = await OutputExtractor.extract(config);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.value).toBeNull();
  });
});
