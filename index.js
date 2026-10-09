import { getRequestHeaders } from '../../../../script.js';
import {
    SceneInputError,
    buildSceneMessages,
    buildSceneTranscript,
    cleanImagePrompt,
    extractMessageText,
    formatStatusError,
    normalizeAttempts,
    normalizeSettings,
    normalizeTemperature,
    parseGeneratedImage,
} from './map.js';

const EXTENSION_NAME = 'LocationMap';
const PLUGIN_SESSION_URL = '/api/plugins/location-map/session';
const PLUGIN_START_URL = '/api/plugins/location-map/start';
const TEXT_TIMEOUT_MS = 45_000;
const IMAGE_TIMEOUT_MS = 120_000;
const TOAST_OPTIONS = Object.freeze({
    timeOut: 10_000,
    extendedTimeOut: 3_000,
    preventDuplicates: false,
});

let settings = normalizeSettings(null);
let session = null;
let events = null;
let hostId = null;
let leaderId = null;
let activeAbort = null;
let reconnectTimer = 0;

function notifyError(message, error) {
    const details = formatStatusError(error);
    console.error(`[${EXTENSION_NAME}] ${message}`, error);
    toastr.error(details ? `${message}: ${details}` : message, EXTENSION_NAME, TOAST_OPTIONS);
}

function isAbort(error) {
    return error?.name === 'AbortError';
}

function loadSettings() {
    const context = SillyTavern.getContext();
    context.extensionSettings[EXTENSION_NAME] ??= {};
    settings = normalizeSettings(context.extensionSettings[EXTENSION_NAME]);
    Object.assign(context.extensionSettings[EXTENSION_NAME], settings);
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.extensionSettings[EXTENSION_NAME] = { ...settings };
    context.saveSettingsDebounced();
}

function windowUrl() {
    if (!session?.origin || !session?.token) {
        return '';
    }
    const url = new URL('/', session.origin);
    url.searchParams.set('token', session.token);
    return url.toString();
}

function updateSettingsUi() {
    $('#location_map_image_model').val(settings.imageModel);
    $('#location_map_prompt_model').val(settings.promptModel);
    $('#location_map_temperature').val(settings.temperature);
    $('#location_map_prompt').val(settings.prompt);
    $('#location_map_attempts').val(settings.attempts);
    updateWindowUi();
}

function updateWindowUi() {
    const input = document.querySelector('#location_map_url');
    const button = document.querySelector('#location_map_open');
    const hint = document.querySelector('#location_map_hint');
    if (!input || !button || !hint) {
        return;
    }
    const url = windowUrl();
    input.value = url;
    button.disabled = !url;
    hint.hidden = Boolean(url);
}

function bindSettingsUi() {
    $('#location_map_image_model').on('change', event => {
        settings.imageModel = String(event.target.value || '').trim() || normalizeSettings(null).imageModel;
        event.target.value = settings.imageModel;
        saveSettings();
    });

    $('#location_map_prompt_model').on('change', event => {
        settings.promptModel = String(event.target.value || '').trim() || normalizeSettings(null).promptModel;
        event.target.value = settings.promptModel;
        saveSettings();
    });

    $('#location_map_temperature').on('change', event => {
        settings.temperature = normalizeTemperature(event.target.value);
        event.target.value = settings.temperature;
        saveSettings();
    });

    $('#location_map_prompt').on('change', event => {
        settings.prompt = String(event.target.value ?? '').trim() || normalizeSettings(null).prompt;
        event.target.value = settings.prompt;
        saveSettings();
    });

    $('#location_map_attempts').on('change', event => {
        settings.attempts = normalizeAttempts(event.target.value);
        event.target.value = settings.attempts;
        saveSettings();
    });

    $('#location_map_open').on('click', () => {
        const url = windowUrl();
        if (!url) {
            return;
        }
        window.open(url, '_blank');
    });

    $('#location_map_start').on('click', () => {
        void startWindowServer();
    });
}

async function installSettingsUi() {
    const response = await fetch(new URL('./settings.html', import.meta.url));
    if (!response.ok) {
        throw new Error(`settings.html: HTTP ${response.status}`);
    }

    const html = await response.text();
    const container = document.querySelector('#extensions_settings');
    if (!container) {
        throw new Error('SillyTavern extension settings container was not found');
    }

    container.querySelector('.location-map-settings')?.remove();
    container.insertAdjacentHTML('beforeend', html);
    updateSettingsUi();
    bindSettingsUi();
}

async function fetchWithTimeout(url, options, timeoutMs, jobSignal) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const onJobAbort = () => controller.abort();
    if (jobSignal?.aborted) {
        controller.abort();
    } else {
        jobSignal?.addEventListener('abort', onJobAbort, { once: true });
    }

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (jobSignal?.aborted) {
            throw error;
        }
        if (controller.signal.aborted) {
            throw new Error(`Нет ответа за ${Math.round(timeoutMs / 1000)} с`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        jobSignal?.removeEventListener('abort', onJobAbort);
    }
}

async function requestImagePrompt(messages, signal) {
    // quiet: other extensions must not treat this helper call as a story turn.
    const response = await fetchWithTimeout('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            type: 'quiet',
            chat_completion_source: 'openrouter',
            model: settings.promptModel,
            messages,
            temperature: settings.temperature,
            max_tokens: 1500,
            stream: false,
            include_reasoning: false,
        }),
    }, TEXT_TIMEOUT_MS, signal);

    const body = await response.text();
    if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error('Текстовая модель вернула не JSON');
    }
    if (data?.error) {
        throw new Error(data.error.message || String(data.error));
    }
    return cleanImagePrompt(extractMessageText(data));
}

async function requestSceneImage(prompt, signal) {
    const response = await fetchWithTimeout('/api/openrouter/image/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            model: settings.imageModel,
            prompt,
            // A square frame fights the "room is not a square" rule and crops a plan.
            aspect_ratio: '16:9',
        }),
    }, IMAGE_TIMEOUT_MS, signal);

    const body = await response.text();
    if (!response.ok) {
        throw new Error(`Картинка HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error('Сервер картинки вернул не JSON');
    }
    return parseGeneratedImage(data);
}

async function postWindow(pathname, body, signal) {
    if (!session?.origin || !session?.token) {
        throw new Error('Нет адреса окна');
    }
    const url = new URL(pathname, session.origin);
    url.searchParams.set('token', session.token);
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (response.status === 409) {
        return false;
    }
    if (!response.ok) {
        throw new Error(`Окно не приняло запрос: HTTP ${response.status}`);
    }
    return true;
}

async function report(jobId, phase, message, signal) {
    if (signal?.aborted) {
        return;
    }
    try {
        await postWindow('/progress', { jobId, phase, message }, signal);
    } catch (error) {
        if (signal?.aborted || isAbort(error)) {
            throw error;
        }
        console.warn(`[${EXTENSION_NAME}] Статус не дошёл до окна`, error);
    }
}

async function createSceneImage(signal, reportStatus) {
    const transcript = buildSceneTranscript(SillyTavern.getContext().chat);
    if (!transcript) {
        throw new SceneInputError('В чате нет реплик для схемы');
    }

    const messages = buildSceneMessages(transcript, settings.prompt);
    let imagePrompt = '';
    let lastError = null;
    for (let attempt = 1; attempt <= settings.attempts; attempt++) {
        await reportStatus('prompt', `Промпт, попытка ${attempt} из ${settings.attempts}`);
        try {
            imagePrompt = await requestImagePrompt(messages, signal);
            lastError = null;
            break;
        } catch (error) {
            if (signal.aborted || isAbort(error) || error instanceof SceneInputError) {
                throw error;
            }
            lastError = error;
        }
    }
    if (!imagePrompt) {
        throw lastError;
    }

    let image = null;
    lastError = null;
    for (let attempt = 1; attempt <= settings.attempts; attempt++) {
        await reportStatus('image', `Картинка, попытка ${attempt} из ${settings.attempts}`);
        try {
            image = await requestSceneImage(imagePrompt, signal);
            break;
        } catch (error) {
            if (signal.aborted || isAbort(error)) {
                throw error;
            }
            lastError = error;
            image = null;
        }
    }
    if (!image) {
        throw lastError;
    }
    return image;
}

async function runGeneration(jobId) {
    activeAbort?.abort();
    const controller = new AbortController();
    activeAbort = controller;
    const turns = buildSceneTranscript(SillyTavern.getContext().chat).split('\n').filter(Boolean).length;
    console.info(`[${EXTENSION_NAME}] Генерация схемы`, { jobId, turns });

    try {
        const image = await createSceneImage(controller.signal, (phase, message) => {
            return report(jobId, phase, message, controller.signal);
        });
        if (controller.signal.aborted) {
            return;
        }
        await postWindow('/result', {
            jobId,
            ok: true,
            mime: image.mime,
            image: image.base64,
        });
    } catch (error) {
        if (controller.signal.aborted || isAbort(error)) {
            return;
        }
        console.error(`[${EXTENSION_NAME}] Генерация схемы не удалась`, error);
        try {
            const accepted = await postWindow('/result', {
                jobId,
                ok: false,
                message: formatStatusError(error),
            });
            if (!accepted) {
                return;
            }
        } catch (postError) {
            notifyError('Окно схемы не обновилось', postError);
        }
    }
}

function openHostEvents() {
    events?.close();
    if (!session?.origin || !session?.token) {
        return;
    }

    const url = new URL('/events', session.origin);
    url.searchParams.set('token', session.token);
    url.searchParams.set('role', 'host');
    const source = new EventSource(url);
    events = source;

    source.addEventListener('hello', event => {
        hostId = JSON.parse(event.data).id;
    });
    source.addEventListener('leader', event => {
        leaderId = JSON.parse(event.data).leaderId;
    });
    source.addEventListener('generate', event => {
        const data = JSON.parse(event.data);
        // Only the newest SillyTavern tab may spend a generation. The map tab broadcasts to every open chat.
        if (!hostId || data.leaderId !== hostId) {
            return;
        }
        void runGeneration(data.jobId);
    });
    source.onerror = () => {
        source.close();
        if (events !== source) {
            return;
        }
        events = null;
        hostId = null;
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
            if (session) {
                openHostEvents();
            }
        }, 3000);
    };
}

function applySession(payload) {
    if (!payload?.origin || !payload?.token) {
        throw new Error('Сервер окна вернул пустой адрес');
    }
    session = payload;
    updateWindowUi();
    openHostEvents();
}

async function refreshSession() {
    const response = await fetch(PLUGIN_SESSION_URL, {
        method: 'GET',
        headers: getRequestHeaders(),
    });
    if (!response.ok) {
        session = null;
        updateWindowUi();
        return;
    }
    applySession(await response.json());
}

async function startWindowServer() {
    const button = document.querySelector('#location_map_start');
    if (button) {
        button.disabled = true;
    }
    try {
        const response = await fetch(PLUGIN_START_URL, {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        const body = await response.text();
        if (!response.ok) {
            // 404 means this SillyTavern process started before the plugin existed.
            const message = response.status === 404
                ? 'Плагин окна ещё не загружен. Перезапустите SillyTavern один раз.'
                : `HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`;
            throw new Error(message);
        }
        applySession(JSON.parse(body));
    } catch (error) {
        notifyError('Сервер окна не запустился', error);
    } finally {
        if (button) {
            button.disabled = false;
        }
    }
}

jQuery(async () => {
    try {
        loadSettings();
    } catch (error) {
        notifyError('Ошибка запуска расширения', error);
        return;
    }

    try {
        await installSettingsUi();
    } catch (error) {
        notifyError('Ошибка интерфейса настроек', error);
    }

    try {
        await refreshSession();
        console.log(`[${EXTENSION_NAME}] Ready`);
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] Адрес окна не прочитан`, error);
    }
});
