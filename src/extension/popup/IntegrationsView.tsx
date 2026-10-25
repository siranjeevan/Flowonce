import React, { useState, useEffect } from 'react';
import type { IntegrationConfig, IntegrationExecutionResult } from '../../integrations/integration-types';
import { IntegrationRegistry } from '../../integrations/IntegrationRegistry';
import { IntegrationExecutor } from '../../integrations/IntegrationExecutor';

export const IntegrationsView: React.FC = () => {
  const [configs, setConfigs] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [testResult, setTestResult] = useState<IntegrationExecutionResult | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Form State
  const [integrationType, setIntegrationType] = useState('webhook-dispatcher');
  const [name, setName] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [method, setMethod] = useState<'POST' | 'GET'>('POST');
  const [idempotencyHeaderKey, setIdempotencyHeaderKey] = useState('Idempotency-Key');

  const loadData = React.useCallback(async () => {
    try {
      const res = await IntegrationRegistry.getAllConfigs();
      setConfigs(res);
    } catch (err) {
      console.error('Failed to load integrations:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    IntegrationRegistry.getAllConfigs()
      .then((res) => {
        if (!active) return;
        setConfigs(res);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load integrations:', err);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleTest = React.useCallback(async (config: IntegrationConfig) => {
    setTestingId(config.id);
    setTestResult(null);
    try {
      const res = await IntegrationExecutor.execute(config, {
        payload: {
          test: true,
          timestamp: new Date().toISOString(),
          source: 'FlowOnce Integration Tester',
        },
      });
      setTestResult(res);
    } catch (err: any) {
      setTestResult({
        success: false,
        durationMs: 0,
        error: err.message || 'Execution error',
      });
    } finally {
      setTestingId(null);
    }
  }, []);

  const handleDelete = async (id: string) => {
    if (window.confirm('Delete this integration configuration?')) {
      await IntegrationRegistry.deleteConfig(id);
      await loadData();
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const newConfig: IntegrationConfig = {
      id: `int_${Date.now().toString(36)}`,
      integrationId: integrationType,
      name: name.trim() || 'Webhook Endpoint',
      endpointUrl: endpointUrl.trim(),
      method,
      idempotencyHeaderKey: idempotencyHeaderKey.trim() || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await IntegrationRegistry.saveConfig(newConfig);
      setShowAddModal(false);
      setName('');
      setEndpointUrl('');
      await loadData();
    } catch (err: any) {
      alert(`Validation error: ${err.message}`);
    }
  };

  return (
    <div className="w-full flex flex-col space-y-3 text-xs text-[#CDE4E6]">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm text-[#F9DF9F] flex items-center gap-1.5">
          <span>🔌</span> API Integrations
        </h3>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-2.5 py-1 rounded bg-[#F9DF9F] text-[#263056] font-bold text-[11px] hover:bg-[#e6cc8e] shadow-sm"
        >
          + Add Integration
        </button>
      </div>

      <div className="p-2 rounded bg-[#1A2240] border border-[#CDE4E6]/10 text-[10px] text-[#CDE4E6]/70 leading-relaxed">
        🔒 Extensible API boundaries. Strictly enforced timeouts, response size bounds (512 KB), no <code>eval</code>, and automatic idempotency keys.
      </div>

      {loading ? (
        <div className="py-8 text-center text-[#CDE4E6]/50">Loading integrations...</div>
      ) : configs.length === 0 ? (
        <div className="py-8 text-center text-[#CDE4E6]/50">
          No integrations configured. Set up a Webhook or REST collector to transmit workflow events.
        </div>
      ) : (
        <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
          {configs.map((c) => (
            <div
              key={c.id}
              className="p-3 rounded-lg bg-[#1A2240] border border-[#CDE4E6]/10 flex flex-col gap-2"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-xs text-[#F9DF9F]">{c.name}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#263056] font-mono text-[#38bdf8]">
                      {c.method}
                    </span>
                  </div>
                  <p className="text-[10px] font-mono text-[#CDE4E6]/60 truncate max-w-[200px] mt-0.5">
                    {c.endpointUrl}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTest(c)}
                    disabled={testingId === c.id}
                    className="px-2 py-0.5 rounded bg-[#263056] hover:bg-white/10 text-[10px] font-semibold text-[#38bdf8]"
                  >
                    {testingId === c.id ? 'Testing...' : 'Test'}
                  </button>
                  <button
                    onClick={() => handleDelete(c.id)}
                    className="text-red-400 hover:text-red-300 text-xs px-1"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {c.idempotencyHeaderKey && (
                <div className="text-[9px] text-[#CDE4E6]/50 flex items-center gap-1">
                  <span>🔑 Idempotency Header:</span>
                  <span className="font-mono text-[#F9DF9F]">{c.idempotencyHeaderKey}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Test Execution Result Dialog */}
      {testResult && (
        <div className="p-2.5 rounded-lg bg-[#263056] border border-[#CDE4E6]/20 space-y-1.5 text-[11px]">
          <div className="flex items-center justify-between">
            <span
              className={`font-bold uppercase text-[10px] ${
                testResult.success ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {testResult.success ? '✓ Test Successful' : '✕ Test Failed'}
            </span>
            <button onClick={() => setTestResult(null)} className="text-[#CDE4E6]/60 hover:text-white">
              ✕
            </button>
          </div>
          <div className="text-[10px] text-[#CDE4E6]/70">
            HTTP Status: <span className="font-mono text-white">{testResult.statusCode ?? 'N/A'}</span> | Duration: <span className="font-mono text-white">{testResult.durationMs}ms</span>
          </div>
          {testResult.idempotencyKey && (
            <div className="text-[10px] text-[#CDE4E6]/60 truncate font-mono">
              Key: {testResult.idempotencyKey}
            </div>
          )}
          {testResult.error && (
            <div className="text-[10px] text-red-300 font-mono bg-red-950/40 p-1.5 rounded">
              {testResult.error}
            </div>
          )}
        </div>
      )}

      {/* Add Integration Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3">
          <form
            onSubmit={handleSave}
            className="bg-[#1A2240] border border-[#F9DF9F]/30 rounded-xl p-4 max-w-sm w-full space-y-3 text-xs text-[#CDE4E6]"
          >
            <div className="flex items-center justify-between border-b border-[#F9DF9F]/10 pb-2">
              <h4 className="font-bold text-sm text-[#F9DF9F]">Add API Integration</h4>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Integration Type
              </label>
              <select
                value={integrationType}
                onChange={(e) => setIntegrationType(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
              >
                <option value="webhook-dispatcher">Webhook Dispatcher (POST)</option>
                <option value="rest-collector">REST Data Collector (GET)</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Configuration Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Zapier Lead Alert"
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                required
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#F9DF9F] uppercase mb-1">
                Endpoint URL
              </label>
              <input
                type="url"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                placeholder="https://hooks.zapier.com/hooks/catch/..."
                className="w-full px-2.5 py-1.5 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs font-mono text-[11px] outline-none"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Method</label>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as any)}
                  className="w-full px-2 py-1 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none"
                >
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] text-[#CDE4E6]/80 mb-1">Idempotency Header</label>
                <input
                  type="text"
                  value={idempotencyHeaderKey}
                  onChange={(e) => setIdempotencyHeaderKey(e.target.value)}
                  placeholder="Idempotency-Key"
                  className="w-full px-2 py-1 bg-[#263056] rounded border border-[#CDE4E6]/20 text-xs outline-none font-mono text-[10px]"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#F9DF9F]/10">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="px-3 py-1.5 rounded bg-[#263056] font-semibold text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 rounded bg-[#F9DF9F] text-[#263056] font-bold text-xs"
              >
                Save Integration
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
