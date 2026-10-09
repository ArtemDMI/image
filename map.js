export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-lite-image';
export const DEFAULT_PROMPT_MODEL = 'google/gemini-3.8-flash';
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_ATTEMPTS = 2;
export const ATTEMPTS_MIN = 1;
export const ATTEMPTS_MAX = 5;

export const DEFAULT_SCENE_PROMPT = `You write one image prompt in English and nothing else. No title, no markdown, no notes, no quotes around the prompt.

The chat is the scene, in order. "user" is the player. "character" is a story character. Use the latest moment: where everyone is, what they are doing, and which place and objects were just established. Older lines matter only to name the place and the people still there.

Describe a strict top-down schematic of that place. Primitive flat plan. Thick black wall outline. Simple flat fills. No faces, no bodies, no clothes, no illustrated characters. It must read as a game map, not a painting.

Hard rules:
- Every person present is only a colored circle. One color per person, and every color is different. Put a short color name under each circle. No heads, hands, cloaks, or bodies.
- The room is never a square and never a rectangle. Make an irregular polygon: one wall skewed, one corner cut, one side sticking out as a bay or notch, the far end a different width from the near end, all sides different lengths, the plan asymmetric.
- If the chat does not specify a shape, an exit, or the furniture, invent plain details that fit the place.
- Add at least ten extra things someone could grab or use as a landmark. Each one sits in its own spot and has a short English label. Use doors, exits, passages, stairs, a hatch, a window, a column, a niche, a chest, a railing, or other fittings that match the place.
- Place every object and every person that the scene actually mentions. Say where each one is: left, right, center, near, far, and against which wall.
- The floor is a simple fill with sparse hatching. Light is only a couple of flat spots, such as a window and a lamp. Style: crude schematic realism.

Write continuous English prose in this order: the view and the rules, the room shape, the people as circles, the main furniture, then the ten labeled anchors. Do not copy a sample room. Build this room from the chat.`.trim();

const DEFAULT_SETTINGS = Object.freeze({
    imageModel: DEFAULT_IMAGE_MODEL,
    promptModel: DEFAULT_PROMPT_MODEL,
    temperature: DEFAULT_TEMPERATURE,
    prompt: DEFAULT_SCENE_PROMPT,
    attempts: DEFAULT_ATTEMPTS,
});

// Narration stays: a place is often described there, not in a spoken line.
// These rows are interface chrome and would invent a room that is not on screen.
const SKIPPED_TURN_TYPES = new Set([
    'comment',
    'help',
    'welcome',
    'empty',
    'generic',
    'slash_commands',
    'formatting',
    'hotkeys',
    'macros',
    'welcome_prompt',
    'assistant_note',
    'assistant_message',
]);

const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

export class SceneInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SceneInputError';
    }
}

function normalizeModel(value, fallback) {
    const model = String(value ?? '').trim();
    return model || fallback;
}

export function normalizeTemperature(value) {
    if (value === null || value === undefined) {
        return DEFAULT_TEMPERATURE;
    }
    const raw = String(value).trim().replace(',', '.');
    if (!raw) {
        return DEFAULT_TEMPERATURE;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_TEMPERATURE;
    }
    return Math.min(2, Math.max(0, parsed));
}

export function normalizeAttempts(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_ATTEMPTS;
    }
    return Math.min(ATTEMPTS_MAX, Math.max(ATTEMPTS_MIN, parsed));
}

export function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        imageModel: normalizeModel(source.imageModel, DEFAULT_SETTINGS.imageModel),
        promptModel: normalizeModel(source.promptModel, DEFAULT_SETTINGS.promptModel),
        temperature: normalizeTemperature(source.temperature),
        prompt: String(source.prompt ?? '').trim() || DEFAULT_SCENE_PROMPT,
        attempts: normalizeAttempts(source.attempts),
    };
}

export function isSceneTurn(message) {
    if (!message || message.is_system || typeof message.is_user !== 'boolean') {
        return false;
    }
    // Prompt injections have no speaker. A real turn always names the user or the character.
    if (!String(message.name ?? '').trim()) {
        return false;
    }
    const kind = message.extra?.type;
    if (typeof kind === 'string' && SKIPPED_TURN_TYPES.has(kind)) {
        return false;
    }
    if (Array.isArray(message.extra?.tool_invocations) && message.extra.tool_invocations.length > 0) {
        return false;
    }
    return Boolean(String(message.mes ?? '').trim());
}

export function buildSceneTranscript(chat) {
    const lines = [];
    for (const message of Array.isArray(chat) ? chat : []) {
        if (!isSceneTurn(message)) {
            continue;
        }
        const role = message.is_user ? 'user' : 'character';
        const name = String(message.name).trim();
        // One physical line per turn, otherwise a linebreak inside a message looks like the next speaker.
        const text = String(message.mes).trim().replace(/\s+/g, ' ');
        lines.push(`${role} (${name}): ${text}`);
    }
    return lines.join('\n');
}

export function buildSceneMessages(transcript, instruction) {
    const prompt = String(instruction ?? '').trim() || DEFAULT_SCENE_PROMPT;
    return [
        { role: 'system', content: prompt },
        { role: 'user', content: `<chat>\n${transcript}\n</chat>` },
    ];
}

export function extractMessageText(data) {
    const content = data?.choices?.[0]?.message?.content;
    let text = '';
    if (Array.isArray(content)) {
        text = content
            .filter(part => part?.type === 'text' && typeof part?.text === 'string')
            .map(part => part.text)
            .join('');
    } else if (typeof content === 'string') {
        text = content;
    }
    if (!text.trim()) {
        throw new Error('Текстовая модель не вернула текст');
    }
    return text;
}

export function cleanImagePrompt(text) {
    let value = String(text ?? '').trim();
    value = value.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
    const wrapped = (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith('«') && value.endsWith('»'));
    if (wrapped && value.length > 2) {
        value = value.slice(1, -1).trim();
    }
    value = value.replace(/^prompt:\s*/i, '').trim();
    if (value.length < 40) {
        throw new Error('Текстовая модель вернула пустой промпт');
    }
    return value;
}

export function parseGeneratedImage(data) {
    const format = String(data?.format ?? '').trim().toLowerCase();
    const image = String(data?.image ?? '').replace(/\s+/g, '');
    if (!IMAGE_FORMATS.has(format)) {
        throw new Error('Сервер картинки вернул неизвестный формат');
    }
    if (image.length < 32) {
        throw new Error('Сервер картинки вернул пустой файл');
    }
    // jpg is a filename extension. The browser only treats image/jpeg as a JPEG.
    const mime = format === 'jpg' ? 'image/jpeg' : `image/${format}`;
    return { mime, base64: image };
}

export function formatStatusError(error) {
    const text = error instanceof Error ? error.message : String(error ?? '');
    return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Ошибка генерации';
}
