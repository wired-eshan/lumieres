/**
 * AI settings: provider, per-provider key, endpoint, model and reasoning effort.
 *
 * Keys are stored per provider in this browser only and are never written into
 * the canvas document or an export. Switching the provider in this dialog is a
 * draft operation; Save makes it active, so unsent chat composer text (which
 * lives outside this dialog) is never lost by a configuration change.
 *
 * The dialog is also where capability uncertainty is communicated. The effort
 * selector offers only levels the selected model advertises; a saved level that
 * the current model does not support stays visible and blocks Save with an
 * actionable message rather than being silently replaced.
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
  API_PROTOCOL_LABELS,
  CUSTOM_PROTOCOLS,
  PROVIDER_ORDER,
  PROVIDERS,
  endpointUrlForConfig,
  getProviderDefinition,
  isValidBaseUrl,
  normalizeBaseUrl,
  protocolForProvider,
  type ApiProtocol,
  type ProviderDefinition,
  type ProviderEffortMetadata,
  type ProviderId,
  type ProviderProfile,
} from '../../ai/provider';
import { mapEffortForRequest, type EffortCapability } from '../../ai/effort';
import {
  clearAIKey,
  getAISettings,
  getProviderProfile,
  normalizeProviderProfile,
  saveAISettings,
} from '../../ai/settings';
import {
  fetchProviderModels,
  pickModelId,
  seedProviderModels,
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

interface Draft {
  providerId: ProviderId;
  customProtocol: ApiProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort | '';
  /** Saved capability for the selected model, used until a fresh catalogue loads. */
  storedCapability: ProviderEffortMetadata | null;
}

function draftFor(
  providerId: ProviderId,
  customProtocol: ApiProtocol,
  settings: ReturnType<typeof getAISettings>,
): Draft {
  const definition = getProviderDefinition(providerId);
  const profile = getProviderProfile(settings, providerId);
  return {
    providerId,
    customProtocol,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl || definition.defaultBaseUrl,
    model: profile.model || definition.defaultModel,
    reasoningEffort: profile.reasoningEffort,
    storedCapability: profile.effortCapability,
  };
}

/**
 * A provider's public catalogue is tied to its documented endpoint. If the
 * profile overrides the base URL (for a gateway), discovery needs the key and
 * should target the override instead.
 */
function canUsePublicCatalogue(
  definition: ProviderDefinition,
  baseUrl: string,
  protocol: ApiProtocol,
): boolean {
  return (
    definition.publicCatalogue &&
    normalizeBaseUrl(baseUrl, definition.defaultBaseUrl, protocol) ===
      definition.defaultBaseUrl
  );
}

function metadataFor(modelId: string, capability: EffortCapability): ProviderEffortMetadata {
  return {
    modelId,
    efforts: [...capability.efforts],
    source: capability.source,
    defaultEffort: capability.defaultEffort,
    mandatory: capability.mandatory,
    note: capability.note,
  };
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps): ReactNode {
  const settings = useAISettings();
  const [providerId, setProviderId] = useState<ProviderId>(settings.providerId);
  const [customProtocol, setCustomProtocol] = useState<ApiProtocol>(settings.customProtocol);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | ''>('');
  const [storedCapability, setStoredCapability] = useState<ProviderEffortMetadata | null>(null);
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
  /** Tracks live model input so a slow catalogue response cannot overwrite typing. */
  const modelRef = useRef(model);
  modelRef.current = model;

  const definition = getProviderDefinition(providerId);
  const protocol = protocolForProvider(providerId, customProtocol);

  const loadModels = useCallback(
    async (
      nextProviderId: ProviderId,
      nextProtocol: ApiProtocol,
      key: string,
      url: string,
      preferredModel: string,
    ): Promise<void> => {
      // Abort any previous catalogue request before the early returns too:
      // switching to a provider that cannot load must not let the old
      // provider's response populate the new picker.
      loadAbort.current?.abort();
      loadAbort.current = null;

      const trimmedKey = key.trim();
      const nextDefinition = getProviderDefinition(nextProviderId);
      const effectiveUrl = url.trim() || nextDefinition.defaultBaseUrl;
      if (
        !canUsePublicCatalogue(nextDefinition, effectiveUrl, nextProtocol) &&
        trimmedKey.length === 0
      ) {
        setModelsStatus('idle');
        setModelsError(null);
        return;
      }
      if (!isValidBaseUrl(effectiveUrl)) {
        setModelsStatus('error');
        setModelsError('Enter a valid http(s) base URL before loading models.');
        return;
      }

      const controller = new AbortController();
      loadAbort.current = controller;
      setModelsStatus('loading');
      setModelsError(null);

      try {
        const fetched = await fetchProviderModels({
          providerId: nextProviderId,
          protocol: nextProtocol,
          apiKey: trimmedKey,
          baseUrl: normalizeBaseUrl(
            effectiveUrl,
            nextDefinition.defaultBaseUrl,
            nextProtocol,
          ),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;

        if (fetched.length === 0) {
          setModelsStatus('error');
          setModelsError(
            'The provider catalogue returned no models. The documented starting models remain available.',
          );
          return;
        }

        setModels(fetched);
        setModelsStatus('ready');
        // A fresh catalogue is authoritative; discard the saved capability view.
        setStoredCapability(null);

        const chosen = pickModelId(
          fetched,
          preferredModel,
          nextDefinition.defaultModel,
        );
        if (modelRef.current === preferredModel) {
          setModel(chosen);
          modelRef.current = chosen;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setModelsStatus('error');
        setModelsError(
          describeError(error, {
            secrets: [trimmedKey],
            providerLabel: getProviderDefinition(nextProviderId).label,
          }),
        );
      }
    },
    [],
  );

  const hydrate = useCallback(
    (nextProviderId: ProviderId, nextProtocol: ApiProtocol, currentSettings: ReturnType<typeof getAISettings>): void => {
      const draft = draftFor(nextProviderId, nextProtocol, currentSettings);
      setProviderId(nextProviderId);
      setCustomProtocol(nextProtocol);
      setApiKey(draft.apiKey);
      setBaseUrl(draft.baseUrl);
      setModel(draft.model);
      modelRef.current = draft.model;
      setReasoningEffort(draft.reasoningEffort);
      setStoredCapability(draft.storedCapability);
      setCustomModel(false);
      setReveal(false);
      setSaved(false);
      setFormError(null);
      setModels(seedProviderModels(nextProviderId, nextProtocol));
      setModelsStatus('idle');
      setModelsError(null);
      // A provider switch always invalidates the previous provider's request.
      loadAbort.current?.abort();
      loadAbort.current = null;

      const canLoad =
        canUsePublicCatalogue(
          getProviderDefinition(nextProviderId),
          draft.baseUrl,
          nextProtocol,
        ) ||
        (draft.apiKey.trim().length > 0 && isValidBaseUrl(draft.baseUrl));
      if (canLoad) {
        void loadModels(
          nextProviderId,
          nextProtocol,
          draft.apiKey,
          draft.baseUrl,
          draft.model,
        );
      }
    },
    [loadModels],
  );

  // Seed the form when the dialog opens, not when Save itself updates settings
  // (that would immediately clear the "Saved" confirmation).
  useEffect(() => {
    if (open && !wasOpen.current) {
      hydrate(settings.providerId, settings.customProtocol, settings);
    }
    wasOpen.current = open;
  }, [open, settings, hydrate]);

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
    // Do not leave the draft key in React state after the dialog closes; the
    // saved profile remains the only copy, and hydrate restores it on reopen.
    setApiKey('');
    setReveal(false);
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

  // Seed models are a useful picker starting point, not capability metadata.
  // Only a successful provider catalogue may suppress the documented fallback.
  const loadedCatalogue = modelsStatus === 'ready' ? models : [];
  const effortResolution = mapEffortForRequest({
    providerId,
    protocol,
    modelId: model,
    requested: reasoningEffort,
    catalogue: loadedCatalogue,
    stored: storedCapability,
  });
  const capability = effortResolution.capability;
  const effortUnsupported =
    reasoningEffort !== '' && !capability.efforts.includes(reasoningEffort);
  const selectedModel = models.find((option) => option.id === model) ?? null;
  const endpoint = normalizeBaseUrl(
    baseUrl || definition.defaultBaseUrl,
    definition.defaultBaseUrl,
    protocol,
  );
  const continuationAvailable =
    definition.capabilities.supportsPreviousResponseId &&
    (providerId !== 'openai' || endpoint === definition.defaultBaseUrl);
  const configured = apiKey.trim().length > 0;
  const displayEndpoint =
    endpoint && isValidBaseUrl(baseUrl || definition.defaultBaseUrl)
      ? endpointUrlForConfig({ baseUrl: endpoint, protocol })
      : '';

  const resetCatalogue = (): void => {
    loadAbort.current?.abort();
    loadAbort.current = null;
    setModels(seedProviderModels(providerId, protocol));
    setModelsStatus('idle');
    setModelsError(null);
    setCustomModel(false);
    setStoredCapability(null);
  };

  const changeProvider = (next: ProviderId): void => {
    if (next === providerId) return;
    setProviderId(next);
    hydrate(next, customProtocol, getAISettings());
  };

  const changeProtocol = (next: ApiProtocol): void => {
    setCustomProtocol(next);
    setSaved(false);
    setFormError(null);
    setModels(seedProviderModels(providerId, next));
    setModelsStatus('idle');
    setModelsError(null);
    setStoredCapability(null);
    loadAbort.current?.abort();
    if (apiKey.trim().length > 0 && isValidBaseUrl(baseUrl)) {
      void loadModels(providerId, next, apiKey, baseUrl, model);
    }
  };

  const changeModel = (value: string): void => {
    setModel(value);
    modelRef.current = value;
    setSaved(false);
    setFormError(null);
    // Deliberately do not clear an effort the new model does not support. It
    // stays visible with a warning and blocks Save until the user chooses.
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setFormError(null);

    const rawBase = baseUrl.trim();
    const effectiveBase = rawBase.length > 0 ? rawBase : definition.defaultBaseUrl;
    if (definition.requiresBaseUrl && effectiveBase.length === 0) {
      setFormError('Enter the custom endpoint’s base URL.');
      return;
    }
    if (effectiveBase.length > 0 && !isValidBaseUrl(effectiveBase)) {
      setFormError('Enter a valid http(s) base URL, for example https://api.openai.com/v1.');
      return;
    }
    const normalizedBase = normalizeBaseUrl(
      effectiveBase,
      definition.defaultBaseUrl,
      protocol,
    );
    if (definition.requiresBaseUrl && normalizedBase.length === 0) {
      setFormError('Enter a valid custom base URL.');
      return;
    }

    const effectiveModel = model.trim() || definition.defaultModel;
    if (definition.requiresModel && effectiveModel.length === 0) {
      setFormError('Choose or enter a model id for the custom endpoint.');
      return;
    }

    const effectiveCapability = mapEffortForRequest({
      providerId,
      protocol,
      modelId: effectiveModel,
      requested: reasoningEffort,
      catalogue: loadedCatalogue,
      stored: storedCapability,
    }).capability;
    if (
      reasoningEffort !== '' &&
      !effectiveCapability.efforts.includes(reasoningEffort)
    ) {
      setFormError(
        `The reasoning effort “${reasoningEffort}” is not supported by “${effectiveModel}”. Choose Provider default or one of: ${effectiveCapability.efforts.join(', ')}.`,
      );
      return;
    }

    const profile: ProviderProfile = {
      apiKey: apiKey.trim(),
      baseUrl:
        normalizedBase === definition.defaultBaseUrl ? '' : normalizedBase,
      model: effectiveModel,
      reasoningEffort,
      effortCapability:
        effectiveCapability.efforts.length > 0 || effectiveCapability.source === 'none'
          ? metadataFor(effectiveModel, effectiveCapability)
          : null,
    };

    const current = getAISettings();
    const savedSettings = saveAISettings({
      ...current,
      providerId,
      customProtocol,
      profiles: {
        ...current.profiles,
        [providerId]: normalizeProviderProfile(providerId, profile, customProtocol),
      },
    });

    const savedProfile = getProviderProfile(savedSettings, providerId);
    setApiKey(savedProfile.apiKey);
    setBaseUrl(savedProfile.baseUrl || definition.defaultBaseUrl);
    setModel(savedProfile.model);
    setReasoningEffort(savedProfile.reasoningEffort);
    setStoredCapability(savedProfile.effortCapability);
    setSaved(true);
  };

  const modelsHint = (() => {
    if (modelsStatus === 'loading') return 'Loading the model catalogue…';
    if (modelsStatus === 'error') return modelsError ?? 'Could not load models.';
    if (modelsStatus === 'ready') {
      if (models.length === 0) {
        return modelsError ?? 'The model catalogue returned no models.';
      }
      const count = models.length.toLocaleString('en-US');
      const context = selectedModel?.contextLength
        ? ` ${selectedModel.contextLength.toLocaleString('en-US')} token context.`
        : '';
      return `${count} model${models.length === 1 ? '' : 's'} loaded from ${definition.label}’s model catalogue.${context}`;
    }
    if (models.length > 0) {
      return 'These are documented starting models. Load the provider catalogue for the full list; a custom model id is always allowed.';
    }
    return 'Load models, or type the model id your endpoint accepts.';
  })();

  const effortHint = (() => {
    if (effortUnsupported) {
      return `“${reasoningEffort}” is not supported by this model. Choose Provider default or one of: ${capability.efforts.join(', ')}. Requests are blocked by Save until this is resolved.`;
    }
    if (effortResolution.applied && effortResolution.mappedFrom && effortResolution.note) {
      return effortResolution.note;
    }
    if (capability.efforts.length === 0) {
      return `${capability.note} Requests omit the effort parameter and use the provider default.`;
    }
    const source =
      capability.source === 'metadata'
        ? 'Advertised by the provider for this model.'
        : capability.source === 'declared'
          ? capability.note
          : capability.source === 'inferred'
            ? capability.note
            : capability.note;
    const mandatory = capability.mandatory
      ? ' Reasoning is required for this model, so “none” is not offered.'
      : '';
    const fallback = capability.defaultEffort
      ? ` The provider default is “${capability.defaultEffort}”.`
      : '';
    return `${source}${fallback}${mandatory}`;
  })();

  const effortOptions = [...capability.efforts];
  const showUnsupportedEffort =
    reasoningEffort !== '' && !effortOptions.includes(reasoningEffort);
  const canLoad =
    canUsePublicCatalogue(definition, baseUrl, protocol) ||
    (apiKey.trim().length > 0 && isValidBaseUrl(baseUrl || definition.defaultBaseUrl));

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
              Chat windows call the provider selected below directly from this browser using your
              own API key. Each provider keeps its own key, endpoint, model and effort in this
              browser&apos;s local storage; none of it is written to the canvas file or an export,
              and a key is sent only to the provider it belongs to. Anyone with access to this
              browser profile could read the keys.
            </p>
          </div>

          <label className="settings__field">
            <span className="settings__label">Provider</span>
            <select
              id="ai-provider-select"
              className="settings__input"
              value={providerId}
              onChange={(event) => changeProvider(event.target.value as ProviderId)}
              aria-describedby="settings-provider-help"
            >
              {PROVIDER_ORDER.map((id) => (
                <option key={id} value={id}>
                  {PROVIDERS[id].label}
                  {PROVIDERS[id].selectableProtocol ? ' (choose a protocol)' : ''}
                </option>
              ))}
            </select>
            <span className="settings__hint" id="settings-provider-help">
              {definition.label} uses {API_PROTOCOL_LABELS[protocol]}. Changing this control loads
              that provider&apos;s saved profile; press Save to make it the provider new requests
              use.{' '}
              {continuationAvailable
                ? 'This endpoint supports response continuation, so replies are stored at the provider to continue a turn by id.'
                : 'This endpoint is treated as stateless; the full conversation history is sent on each turn.'}
            </span>
          </label>

          {definition.selectableProtocol ? (
            <label className="settings__field">
              <span className="settings__label">Custom API protocol</span>
              <select
                id="ai-protocol-select"
                className="settings__input"
                value={customProtocol}
                onChange={(event) => changeProtocol(event.target.value as ApiProtocol)}
                aria-describedby="settings-protocol-help"
              >
                {CUSTOM_PROTOCOLS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {API_PROTOCOL_LABELS[candidate]}
                  </option>
                ))}
              </select>
              <span className="settings__hint" id="settings-protocol-help">
                A protocol must be chosen explicitly: a custom base URL does not prove which
                request, streaming or reasoning format the endpoint implements. Choose Responses
                for a modern OpenAI-compatible endpoint; Anthropic Messages for a native Claude
                proxy; Chat Completions only for a legacy endpoint.
              </span>
            </label>
          ) : null}

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
                  setStoredCapability(null);
                  // A discovery request made with the previous key should not
                  // keep running or replace the list for the new key.
                  loadAbort.current?.abort();
                  loadAbort.current = null;
                  setModels(seedProviderModels(providerId, protocol));
                  setModelsStatus('idle');
                  setModelsError(null);
                  setCustomModel(false);
                }}
                placeholder={definition.keyPlaceholder}
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
              {definition.keyHint} Keys are stored per provider and never copied to another
              provider&apos;s requests.
              {definition.apiKeyUrl ? (
                <>
                  {' '}
                  <a href={definition.apiKeyUrl} target="_blank" rel="noreferrer noopener">
                    Open the key page
                  </a>
                  .
                </>
              ) : null}
            </span>
          </label>

          <label className="settings__field">
            <span className="settings__label">
              API base URL{definition.requiresBaseUrl ? '' : ' (advanced)'}
            </span>
            <input
              type="url"
              className="settings__input"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setSaved(false);
                setStoredCapability(null);
                resetCatalogue();
              }}
              placeholder={definition.defaultBaseUrl || 'https://api.example.com/v1'}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="settings-base-url-help"
            />
            <span
              className={`settings__hint${endpoint.startsWith('http:') ? ' is-error' : ''}`}
              id="settings-base-url-help"
            >
              {definition.baseUrlHint} Do not paste the full endpoint; a pasted /responses,
              /v1/messages or /chat/completions suffix is removed so it is appended exactly once.
              {displayEndpoint ? <> Requests go to <code>{displayEndpoint}</code>.</> : null}
              {!definition.requiresBaseUrl &&
              endpoint.length > 0 &&
              endpoint !== definition.defaultBaseUrl
                ? ` This override sends the ${definition.label} key to that endpoint; use only a proxy you trust.`
                : null}
              {endpoint.startsWith('http:')
                ? ' This endpoint is not HTTPS; the API key would be sent without transport encryption.'
                : null}
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
                onClick={() =>
                  void loadModels(providerId, protocol, apiKey, baseUrl, model)
                }
                disabled={modelsStatus === 'loading' || !canLoad}
                title={canLoad ? 'Load the provider model catalogue' : 'Add a key first'}
              >
                {modelsStatus === 'loading'
                  ? 'Loading…'
                  : models.length > 0
                    ? 'Reload models'
                    : 'Load models'}
              </button>
            </div>
            {models.length > 0 && !customModel ? (
              <select
                id="ai-model-select"
                className="settings__input"
                value={model}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === CUSTOM_MODEL) {
                    setCustomModel(true);
                    setSaved(false);
                    return;
                  }
                  changeModel(value);
                }}
                aria-describedby="settings-model-help"
              >
                {model && !models.some((option) => option.id === model) ? (
                  <option value={model}>{model} — not in the loaded catalogue</option>
                ) : null}
                {models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.id}
                    {option.name && option.name !== option.id
                      ? ` — ${option.name}`
                      : option.ownedBy
                        ? ` — ${option.ownedBy}`
                        : ''}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>Custom model id…</option>
              </select>
            ) : null}
            {customModel || models.length === 0 ? (
              <input
                id={models.length === 0 || customModel ? 'ai-model-select' : undefined}
                className="settings__input"
                aria-label="Model id"
                value={model}
                onChange={(event) => changeModel(event.target.value)}
                placeholder={definition.defaultModel || 'model-id'}
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
              disabled={effortOptions.length === 0 && !showUnsupportedEffort}
              onChange={(event) => {
                setReasoningEffort(event.target.value as ReasoningEffort | '');
                setSaved(false);
                setFormError(null);
              }}
              aria-describedby="settings-effort-help"
            >
              <option value="">
                {capability.defaultEffort
                  ? `Provider default (${capability.defaultEffort})`
                  : 'Provider default'}
              </option>
              {effortOptions.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
              {showUnsupportedEffort ? (
                <option value={reasoningEffort} disabled>
                  {reasoningEffort} — not supported by this model
                </option>
              ) : null}
            </select>
            <span
              className={`settings__hint${effortUnsupported ? ' is-error' : ''}`}
              id="settings-effort-help"
              role={effortUnsupported ? 'alert' : undefined}
            >
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
                  : `A ${definition.label} key is required before a chat can send a message.`}
            </div>
          )}

          <div className="modal__actions settings__actions">
            {settings.profiles[providerId]?.apiKey ? (
              <button
                type="button"
                className="button settings__clear"
                onClick={() => {
                  clearAIKey(providerId);
                  setApiKey('');
                  setSaved(true);
                  setReveal(false);
                  setStoredCapability(null);
                }}
              >
                Remove {definition.label} key
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
