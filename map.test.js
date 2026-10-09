import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ATTEMPTS_MAX,
    DEFAULT_ATTEMPTS,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_PROMPT_MODEL,
    DEFAULT_SCENE_PROMPT,
    DEFAULT_TEMPERATURE,
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

test('keeps the full chat in order and drops interface rows', () => {
    const chat = [
        { is_user: false, name: 'Mira', mes: 'The library is cold.' },
        { is_user: true, name: 'Alex', mes: 'I sit at the table.' },
        { is_system: true, is_user: false, name: 'System', mes: 'hidden instruction' },
        { is_user: false, name: '', mes: 'jailbreak' },
        { is_user: false, name: 'Mira', mes: '   ' },
        { is_user: false, name: 'Note', mes: 'comment', extra: { type: 'comment' } },
        { is_user: false, name: 'Tool', mes: 'call', extra: { tool_invocations: [{}] } },
        { is_user: false, name: 'Narrator', mes: 'A door stands open\non the left.', extra: { type: 'narrator' } },
    ];

    assert.equal(buildSceneTranscript(chat), [
        'character (Mira): The library is cold.',
        'user (Alex): I sit at the table.',
        'character (Narrator): A door stands open on the left.',
    ].join('\n'));
});

test('asks the text model for a prompt and keeps the chat behind one fence', () => {
    const messages = buildSceneMessages('user (Alex): Hello.', '  Write the room.  ');
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'Write the room.');
    assert.equal(messages[1].content, '<chat>\nuser (Alex): Hello.\n</chat>');
    assert.equal(buildSceneMessages('user (Alex): Hello.', '   ')[0].content, DEFAULT_SCENE_PROMPT);
});

test('default prompt requires a primitive top-down plan', () => {
    assert.match(DEFAULT_SCENE_PROMPT, /English/);
    assert.match(DEFAULT_SCENE_PROMPT, /colored circle/);
    assert.match(DEFAULT_SCENE_PROMPT, /never a square/);
    assert.match(DEFAULT_SCENE_PROMPT, /ten/);
    assert.match(DEFAULT_SCENE_PROMPT, /top-down/);
});

test('normalizes settings and keeps an entered zero temperature', () => {
    assert.deepEqual(normalizeSettings(null), {
        imageModel: DEFAULT_IMAGE_MODEL,
        promptModel: DEFAULT_PROMPT_MODEL,
        temperature: DEFAULT_TEMPERATURE,
        prompt: DEFAULT_SCENE_PROMPT,
        attempts: DEFAULT_ATTEMPTS,
    });
    assert.equal(normalizeTemperature('0,2'), 0.2);
    assert.equal(normalizeTemperature(0), 0);
    assert.equal(normalizeTemperature(9), 2);
    assert.equal(normalizeAttempts(0), 1);
    assert.equal(normalizeAttempts(99), ATTEMPTS_MAX);
    assert.equal(normalizeSettings({ imageModel: '  custom/image  ', prompt: '   ' }).imageModel, 'custom/image');
    assert.equal(normalizeSettings({ prompt: '   ' }).prompt, DEFAULT_SCENE_PROMPT);
});

test('reads text parts and strips a fenced prompt', () => {
    const text = extractMessageText({
        choices: [{
            message: {
                content: [
                    { type: 'text', text: '```text\n' },
                    { type: 'text', text: '"Prompt: Strict top-down schematic of a long irregular library with colored circles."' },
                    { type: 'text', text: '\n```' },
                ],
            },
        }],
    });
    assert.equal(
        cleanImagePrompt(text),
        'Strict top-down schematic of a long irregular library with colored circles.',
    );
    assert.throws(() => cleanImagePrompt('too short'), /пустой промпт/);
    assert.throws(() => extractMessageText({ choices: [{ message: { content: '  ' } }] }), /не вернула текст/);
});

test('accepts a raw image payload and maps jpg to jpeg', () => {
    const png = parseGeneratedImage({ format: 'png', image: 'a'.repeat(40) });
    assert.equal(png.mime, 'image/png');
    assert.equal(parseGeneratedImage({ format: 'jpg', image: 'b'.repeat(40) }).mime, 'image/jpeg');
    assert.throws(() => parseGeneratedImage({ format: 'bmp', image: 'c'.repeat(40) }), /формат/);
    assert.throws(() => parseGeneratedImage({ format: 'png', image: 'short' }), /пустой файл/);
});

test('scene input error stays distinct from a model failure', () => {
    const error = new SceneInputError('В чате нет реплик для схемы');
    assert.equal(error.name, 'SceneInputError');
    assert.equal(formatStatusError(error), 'В чате нет реплик для схемы');
    assert.equal(formatStatusError('  line\nbreak  '), 'line break');
});
