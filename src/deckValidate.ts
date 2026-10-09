// Допустимые коды колод и пути к аудио. Колоды читаются из data/decks/*.json.

export const DECK_ID_RE = /^[A-Za-z0-9_-]{1,30}$/;
// Аудио: путь внутри сайта (audio/имя.mp3) или file_id Telegram; чужие адреса запрещены.
export const AUDIO_RE = /^(?:[A-Za-z0-9_-]{20,}|audio\/[A-Za-z0-9._-]+\.(?:mp3|ogg|oga|opus|m4a|wav))$/;
