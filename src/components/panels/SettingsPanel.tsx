/**
 * AI settings: the user's own OpenAI-compatible key, endpoint, model and
 * reasoning effort.
 *
 * The key is stored in this browser only and is never written into the canvas
 * document or an export. The dialog says so plainly, because a browser-held key
 * is a real trade-off the user should understand.
 *
 * The model list is not hard-coded: it is loaded from the configured provider's
 * `GET /models` endpoint. The same response supplies any advertised reasoning-
 * effort levels for the selected model.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  clearAIKey,
  isValidBaseUrl,
  normalizeBaseUrl,
  saveAISettings,
} from '../../ai/settings';
import {
  effortsForModel,
  fetchProviderModels,
  pickModelId,
  type ProviderModel,
} from '../../ai/models';
import { describeError } from '../../ai/errors';
import type { ReasoningEffort } from '../../ai/reasoning';
import { useAISettings } from '../../hooks/useAISettings';
import { CloseIcon, KeyIcon } from '../icons';

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

type ModelsStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Sentinel option in the model `<select>`; it reveals the free-text input. */
const CUSTOM_MODEL = '__custom_model__';

export function SettingsPanel({ open, onClose }: SettingsPanelProps): ReactNode {
  const settings = useAISettings();
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model || DEFAULT_AI_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | ''>(
    settings.reasoningEffort,
  );
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus>('idle');
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(false);
  const loadAbort = useRef<AbortController | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);

  /**
   * Loads `/models` with the values currently in the form (which may not be
   * saved yet). Kept stable so the open effect does not refetch on every render.
   */
  const loadModels = useCallback(
    async (
      key: string,
      url: string,
      preferredModel: string,
      currentEffort: ReasoningEffort | '',
    ): Promise<void> => {
      const trimmedKey = key.trim();
      if (trimmedKey.length === 0) {
        setModelsStatus('error');
        setModelsError('Enter an API key before loading models.');
        return;
      }
      if (!isValidBaseUrl(url)) {
        setModelsStatus('error');
        setModelsError('Enter a valid http(s) base URL before loading models.');
        return;
      }

      loadAbort.current?.abort();
      const controller = new AbortController();
      loadAbort.current = controller;
      setModelsStatus('loading');
      setModelsError(null);

      try {
        const fetched = await fetchProviderModels({
          apiKey: trimmedKey,
          baseUrl: normalizeBaseUrl(url),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        setModels(fetched);
        setModelsStatus('ready');
        if (fetched.length === 0) {
          setModelsError('The provider returned no models.');
          return;
        }

        // Keep the current/saved model when the provider lists it; otherwise
        // choose a chat-capable model instead of an embedding/speech entry.
        const chosen = pickModelId(fetched, preferredModel);
        setModel(chosen);
        setCustomModel(false);
        const efforts = effortsForModel(fetched, chosen);
        if (currentEffort && !efforts.includes(currentEffort)) {
          setReasoningEffort('');
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setModelsStatus('error');
        setModelsError(describeError(error));
      }
    },
    [],
  );

  // Seed the form when the dialog opens, not when Save itself updates settings
  // (that would immediately clear the "Saved" confirmation).
  useEffect(() => {
    if (open && !wasOpen.current) {
      setApiKey(settings.apiKey);
      setBaseUrl(settings.baseUrl);
      setModel(settings.model || DEFAULT_AI_MODEL);
      setReasoningEffort(settings.reasoningEffort);
      setReveal(false);
      setSaved(false);
      setFormError(null);
      setModels([]);
      setModelsStatus('idle');
      setModelsError(null);
      setCustomModel(false);
      if (settings.apiKey.trim().length > 0) {
        void loadModels(
          settings.apiKey,
          settings.baseUrl,
          settings.model,
          settings.reasoningEffort,
        );
      }
    }
    wasOpen.current = open;
  }, [open, settings, loadModels]);

  // Stop an in-flight catalogue request when the dialog closes or unmounts.
  useEffect(() => {
    if (open) {
      return () => {
        loadAbort.current?.abort();
        loadAbort.current = null;
      };
    }
    loadAbort.current?.abort();
    loadAbort.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const availableEfforts = effortsForModel(models, model);
  const selectedModel = models.find((option) => option.id === model) ?? null;
  const endpoint = normalizeBaseUrl(baseUrl);
  const configured = apiKey.trim().length > 0;

  const resetCatalogue = (): void => {
    loadAbort.current?.abort();
    loadAbort.current = null;
    setModels([]);
    setModelsStatus('idle');
    setModelsError(null);
    setCustomModel(false);
  };

  const changeModel = (value: string): void => {
    setModel(value);
    setSaved(false);
    const efforts = effortsForModel(models, value);
    if (reasoningEffort && !efforts.includes(reasoningEffort)) setReasoningEffort('');
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFormError(null);

    if (apiKey.trim().length > 0 && !isValidBaseUrl(baseUrl)) {
      setFormError('Enter a valid http(s) base URL, such as https://api.openai.com/v1.');
      return;
    }

    const savedSettings = saveAISettings({
      apiKey: apiKey.trim(),
      baseUrl: normalizeBaseUrl(baseUrl),
      model: model.trim() || DEFAULT_AI_MODEL,
      reasoningEffort,
    });
    setApiKey(savedSettings.apiKey);
    setBaseUrl(savedSettings.baseUrl);
    setModel(savedSettings.model);
    setReasoningEffort(savedSettings.reasoningEffort);
    setSaved(true);
  };

  const modelsHint = (() => {
    if (modelsStatus === 'loading') return 'Loading models from the provider…';
    if (modelsStatus === 'error') return modelsError ?? 'Could not load models.';
    if (modelsStatus === 'ready') {
      if (models.length === 0) return modelsError ?? 'The provider returned no models.';
      const owner = selectedModel?.ownedBy ? ` Owned by ${selectedModel.ownedBy}.` : '';
      return `${models.length.toLocaleString('en-US')} model${models.length === 1 ? '' : 's'} loaded from ${endpoint}/models.${owner}`;
    }
    return 'Load the provider’s models to see what this key can use; you can also type a model id.';
  })();

  const effortModels = models.filter((option) => option.reasoningEfforts.length > 0);
  const effortHint = (() => {
    if (availableEfforts.length > 0) {
      if (selectedModel?.reasoningEffortSource === 'metadata') {
        return 'Advertised for this model by the provider’s /models response.';
      }
      if (selectedModel) {
        return 'Inferred from the model family; the provider’s /models response did not include capability metadata.';
      }
      return 'Inferred from the model family; load models to confirm what the provider supports.';
    }
    if (effortModels.length > 0) {
      return `This model has no effort levels. Choose a reasoning model such as ${effortModels[0]?.id} to select one.`;
    }
    return 'The selected model does not advertise reasoning-effort levels.';
  })();

  return (
    <div className="modal-backdrop" data-overlay="true" role="presentation" onClick={onClose}>
      <div
        className="modal is-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <h2 className="modal__title" id="settings-title">
            AI settings
          </h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </div>

        <form className="settings" onSubmit={submit}>
          <div className="settings__intro">
            <span className="settings__mark" aria-hidden="true">
              <KeyIcon />
            </span>
            <p>
              AI chat windows call the provider you configure here directly from this browser using
              your own API key. The key is stored in this browser&apos;s local storage, never in the
              canvas file or an export, and is sent only to that provider. Anyone with access to
              this browser profile could read it.
            </p>
          </div>

          <label className="settings__field">
            <span className="settings__label">API key</span>
            <span className="settings__key-row">
              <input
                ref={firstFieldRef}
                type={reveal ? 'text' : 'password'}
                className="settings__input"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setSaved(false);
                  resetCatalogue();
                }}
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="settings-key-help"
              />
              <button
                type="button"
                className="button settings__reveal"
                onClick={() => setReveal((value) => !value)}
                aria-pressed={reveal}
              >
                {reveal ? 'Hide' : 'Show'}
              </button>
            </span>
            <span className="settings__hint" id="settings-key-help">
              Works with any OpenAI-compatible service. Create a key in the provider&apos;s
              dashboard, then set its base URL below.
            </span>
          </label>

          <label className="settings__field">
            <span className="settings__label">API base URL</span>
            <input
              type="url"
              className="settings__input"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setSaved(false);
                resetCatalogue();
              }}
              placeholder={DEFAULT_AI_BASE_URL}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="settings-base-url-help"
            />
            <span className="settings__hint" id="settings-base-url-help">
              Include the version segment (usually <code>/v1</code>). Models are fetched from{' '}
              <code>{endpoint}/models</code>.
            </span>
          </label>

          <div className="settings__field">
            <div className="settings__label-row">
              <label className="settings__label" htmlFor="ai-model-select">
                Model
              </label>
              <button
                type="button"
                className="button settings__load"
                onClick={() => void loadModels(apiKey, baseUrl, model, reasoningEffort)}
                disabled={modelsStatus === 'loading'}
              >
                {modelsStatus === 'loading' ? 'Loading…' : models.length > 0 ? 'Reload models' : 'Load models'}
              </button>
            </div>
            {models.length > 0 ? (
              <select
                id="ai-model-select"
                className="settings__input"
                value={customModel ? CUSTOM_MODEL : model}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === CUSTOM_MODEL) {
                    setCustomModel(true);
                    setSaved(false);
                    return;
                  }
                  setCustomModel(false);
                  changeModel(value);
                }}
                aria-describedby="settings-model-help"
              >
                {!customModel && model && !models.some((option) => option.id === model) ? (
                  <option value={model}>{model} — not in provider list</option>
                ) : null}
                {models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.id}
                    {option.ownedBy ? ` — ${option.ownedBy}` : ''}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>Custom model id…</option>
              </select>
            ) : null}
            {customModel || models.length === 0 ? (
              <input
                id={models.length === 0 ? 'ai-model-select' : undefined}
                className="settings__input"
                aria-label="Custom model id"
                value={model}
                onChange={(event) => changeModel(event.target.value)}
                placeholder={DEFAULT_AI_MODEL}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="settings-model-help"
              />
            ) : null}
            <span
              className={`settings__hint${modelsStatus === 'error' ? ' is-error' : ''}`}
              id="settings-model-help"
              role="status"
              aria-live="polite"
            >
              {modelsHint}
            </span>
          </div>

          <label className="settings__field">
            <span className="settings__label">Reasoning effort</span>
            <select
              className="settings__input"
              value={reasoningEffort}
              disabled={availableEfforts.length === 0}
              onChange={(event) => {
                setReasoningEffort(event.target.value as ReasoningEffort | '');
                setSaved(false);
              }}
              aria-describedby="settings-effort-help"
            >
              <option value="">Provider default</option>
              {availableEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
            <span className="settings__hint" id="settings-effort-help">
              {effortHint}
            </span>
          </label>

          {formError ? (
            <div className="settings__status is-error" role="alert">
              {formError}
            </div>
          ) : (
            <div className="settings__status" role="status" aria-live="polite">
              {saved
                ? 'Saved. New requests will use these settings.'
                : configured
                  ? 'Press Save to apply.'
                  : 'A key is required before a chat can send a message.'}
            </div>
          )}

          <div className="modal__actions settings__actions">
            {settings.apiKey.length > 0 ? (
              <button
                type="button"
                className="button settings__clear"
                onClick={() => {
                  const next = clearAIKey();
                  setApiKey(next.apiKey);
                  setSaved(true);
                  setReveal(false);
                  resetCatalogue();
                }}
              >
                Remove key
              </button>
            ) : null}
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="button is-primary">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
