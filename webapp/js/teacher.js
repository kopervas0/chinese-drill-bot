import { API_URL, DEV } from "./teacher-config.js";

// Редактор для учителя. Данные входа (initData) отправляются только на сервер бота
// (адрес в teacher-config.js), который проверяет подпись Telegram и список учителей.
const tg = window.Telegram?.WebApp;
const app = document.getElementById("app");
const sheetRoot = document.getElementById("sheet-root");
const toastEl = document.getElementById("toast");
const $ = (sel) => document.querySelector(sel);

const initData = tg?.initData || (DEV ? localStorage.getItem("devInitData") : "") || "";

const state = {
  screen: "loading",
  decks: [],
  deck: null, // { id, isNew, sha, data, original, dropped }
  tab: "cards",
  filter: "",
  audioFiles: [],
  sheet: null, // { kind, index, draft, error }
  saving: false,
};

const TABS = [
  { key: "cards", label: "Карточки" },
  { key: "tests", label: "Тесты" },
  { key: "pairs", label: "Пары" },
  { key: "cloze", label: "Пропуски" },
];
const DECK_ID_RE = /^[A-Za-z0-9_-]{1,30}$/;

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

function ask(message) {
  return new Promise((resolve) => {
    // внутри Telegram (и только если клиент это умеет) — родное окно, иначе обычное confirm
    if (tg?.initData && tg.showConfirm && tg.isVersionAtLeast?.("6.2")) tg.showConfirm(message, (ok) => resolve(!!ok));
    else resolve(window.confirm(message));
  });
}

const haptic = {
  ok: () => tg?.HapticFeedback?.notificationOccurred("success"),
  err: () => tg?.HapticFeedback?.notificationOccurred("error"),
};

// ---------- запросы к серверу ----------

async function api(path, { method = "GET", body, raw, headers } = {}) {
  let res;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        Authorization: `tma ${initData}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw Object.assign(new Error("Нет связи с сервером. Проверьте интернет и повторите."), { status: 0 });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ */
  }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error ?? `Ошибка ${res.status}`), { status: res.status, errors: data?.errors });
  }
  return data;
}

// ---------- рабочая копия колоды ----------

const emptyData = () => ({ name: "", cards: [], tests: [], pairs: [], cloze: [] });

function payload(data) {
  const out = { name: data.name.trim() };
  for (const key of ["cards", "tests", "pairs", "cloze"]) if (data[key].length) out[key] = data[key];
  return out;
}

const snapshot = () => JSON.stringify(payload(state.deck.data)) + "|" + state.deck.id;
const isDirty = () => !!state.deck && (state.deck.isNew || snapshot() !== state.deck.original);

function cardsChanged() {
  const d = state.deck;
  return !d.isNew && JSON.stringify(d.originalCards) !== JSON.stringify(d.data.cards.map((c) => c.hanzi));
}

function syncClosingConfirmation() {
  if (!tg) return;
  if (isDirty()) tg.enableClosingConfirmation?.();
  else tg.disableClosingConfirmation?.();
}

// ---------- экраны ----------

function renderLoading(text = "Подключаюсь к серверу…") {
  state.screen = "loading";
  app.innerHTML = `<div class="app"><div class="center"><div class="spinner"></div><div id="ld">${esc(text)}</div></div></div>`;
}

function renderMessage(title, text, actions = "") {
  app.innerHTML = `<div class="app"><div class="center"><h2>${esc(title)}</h2><p>${esc(text)}</p>${actions}</div></div>`;
}

function renderDenied(text) {
  state.screen = "denied";
  renderMessage("Нет доступа", text);
}

function summary(d) {
  const parts = [];
  if (d.cards) parts.push(`карточек ${d.cards}`);
  if (d.tests) parts.push(`тестов ${d.tests}`);
  if (d.pairs) parts.push(`пар ${d.pairs}`);
  if (d.cloze) parts.push(`пропусков ${d.cloze}`);
  return parts.join(" · ") || "пусто";
}

function renderList() {
  window.scrollTo(0, 0);
  state.screen = "list";
  state.deck = null;
  syncClosingConfirmation();
  tg?.BackButton?.hide();
  app.innerHTML = `<div class="app">
    <header class="hero">
      <div class="seal">编</div>
      <div><h1>Редактор заданий</h1><p>Колоды, карточки, тесты, пары, пропуски</p></div>
    </header>
    <button class="btn primary" data-act="new-deck" style="margin-bottom:16px">Новая колода</button>
    ${state.decks
      .map(
        (d) => `<button class="deck-row" data-act="open-deck" data-id="${esc(d.id)}">
          <b>${esc(d.name)}</b><span>${esc(d.id)} · ${esc(summary(d))}</span></button>`,
      )
      .join("")}
    <p class="note">Изменения сохраняются в репозиторий и появляются у учеников<br />через несколько минут после сохранения.</p>
  </div>`;
}

const rowHtml = {
  cards: (c, i) => `<div class="it"><div class="it-main"><span class="h">${esc(c.hanzi)}</span><span class="p">${esc(c.pinyin)}</span><span class="t">${esc(c.translation)}</span></div>${btns(i)}</div>`,
  tests: (t, i) => `<div class="it"><div class="it-main"><span class="q">${esc(t.question)}</span><span class="t">верный ответ: ${esc(t.options[t.answer])}${t.audio ? " · аудио" : ""}</span></div>${btns(i)}</div>`,
  pairs: (p, i) => `<div class="it"><div class="it-main"><span class="p">${esc(p.left)}</span><span class="t">—</span><span class="p">${esc(p.right)}</span></div>${btns(i)}</div>`,
  cloze: (c, i) => `<div class="it"><div class="it-main"><span class="q">${esc(c.text)}</span><span class="t">верный: ${esc(c.options[c.answer])}</span></div>${btns(i)}</div>`,
};
const btns = (i) =>
  `<button class="ib" data-act="edit-item" data-i="${i}" aria-label="Изменить">&#9998;</button><button class="ib del" data-act="del-item" data-i="${i}" aria-label="Удалить">&times;</button>`;

function itemText(kind, item) {
  if (kind === "cards") return `${item.hanzi} ${item.pinyin} ${item.translation}`;
  if (kind === "tests") return `${item.question} ${item.options.join(" ")}`;
  if (kind === "pairs") return `${item.left} ${item.right}`;
  return item.text;
}

function itemsHtml() {
  const kind = state.tab;
  const q = state.filter.trim().toLowerCase();
  return state.deck.data[kind]
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => !q || itemText(kind, item).toLowerCase().includes(q))
    .map(({ item, i }) => rowHtml[kind](item, i))
    .join("");
}

function tabsHtml() {
  const d = state.deck.data;
  return TABS.map((t) => `<button class="tab${t.key === state.tab ? " sel" : ""}" data-act="tab" data-tab="${t.key}">${t.label}<b>${d[t.key].length}</b></button>`).join("");
}

function renderDeck() {
  window.scrollTo(0, 0);
  state.screen = "deck";
  const d = state.deck;
  tg?.BackButton?.show();
  const kind = state.tab;
  const bulk = kind === "cards" || kind === "pairs";
  app.innerHTML = `<div class="app editor">
    <div class="top">
      <button class="x" data-act="back" aria-label="Назад">&lsaquo;</button>
      <div class="ttl">${d.isNew ? "Новая колода" : esc(d.id)}</div>
    </div>
    ${d.dropped ? `<div class="banner warn">В файле ${d.dropped} заданий с неверным форматом, при сохранении они будут удалены.</div>` : ""}
    <div id="errs"></div>
    <div class="fld"><label for="f-name">Название колоды (видят ученики)</label><input id="f-name" maxlength="80" value="${esc(d.data.name)}" autocomplete="off" /></div>
    ${d.isNew ? `<div class="fld"><label for="f-id">Код колоды (латиница, цифры, - и _)</label><input id="f-id" maxlength="30" value="${esc(d.id)}" placeholder="например, hsk4" autocomplete="off" autocapitalize="none" /><p class="hint">Код нельзя изменить после сохранения.</p></div>` : ""}
    <div class="tabs" id="tabs">${tabsHtml()}</div>
    <div class="toolbar">
      <button class="btn ghost" data-act="add-item">Добавить</button>
      ${bulk ? `<button class="btn ghost" data-act="bulk">Списком</button>` : ""}
    </div>
    ${state.deck.data[kind].length > 8 ? `<input class="search" id="f-search" placeholder="Поиск" value="${esc(state.filter)}" autocomplete="off" />` : ""}
    <div class="items" id="items">${itemsHtml()}</div>
    <div class="savebar"><button class="btn primary" id="save" data-act="save">Сохранить</button></div>
    ${d.isNew ? "" : `<button class="link danger" data-act="delete-deck">Удалить колоду</button>`}
  </div>`;
  refreshSave();
}

function refreshSave() {
  const b = $("#save");
  if (b) b.disabled = state.saving || !isDirty();
  syncClosingConfirmation();
}

function refreshLists() {
  const tabs = $("#tabs");
  const items = $("#items");
  if (tabs) tabs.innerHTML = tabsHtml();
  if (items) items.innerHTML = itemsHtml();
  refreshSave();
}

function showErrors(title, lines = []) {
  const box = $("#errs");
  if (!box) return toast(title);
  box.innerHTML = `<div class="errbox"><b>${esc(title)}</b>${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}</div>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- окно редактирования задания ----------

const TEMPLATES = {
  cards: () => ({ hanzi: "", pinyin: "", translation: "" }),
  tests: () => ({ question: "", options: ["", ""], answer: 0, explain: "", audio: "" }),
  pairs: () => ({ left: "", right: "" }),
  cloze: () => ({ text: "", options: ["", ""], answer: 0, translation: "" }),
};
const KIND_TITLE = { cards: "Карточка", tests: "Тест", pairs: "Пара", cloze: "Пропуск" };

function openItem(index) {
  const kind = state.tab;
  const draft = index === null ? TEMPLATES[kind]() : structuredClone(state.deck.data[kind][index]);
  if (kind === "tests") {
    draft.explain ??= "";
    draft.audio ??= "";
  }
  if (kind === "cloze") draft.translation ??= "";
  state.sheet = { view: "item", kind, index, draft, error: "" };
  drawSheet();
  if (kind === "tests" && !state.audioFiles.length) loadAudioList();
}

function fieldHtml(label, f, value, { area = false, max = 300, hint = "", ph = "" } = {}) {
  const input = area
    ? `<textarea data-f="${f}" maxlength="${max}" placeholder="${esc(ph)}">${esc(value)}</textarea>`
    : `<input data-f="${f}" maxlength="${max}" value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off" />`;
  return `<div class="fld"><label>${label}</label>${input}${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
}

function optionsHtml(draft) {
  return `<div class="fld"><label>Варианты ответа (отметьте верный)</label>${draft.options
    .map(
      (o, i) => `<div class="orow"><input type="radio" name="correct" data-f="correct" data-i="${i}" ${draft.answer === i ? "checked" : ""} aria-label="Верный вариант" />
        <input type="text" data-f="opt" data-i="${i}" maxlength="100" value="${esc(o)}" placeholder="Вариант ${i + 1}" autocomplete="off" />
        ${draft.options.length > 2 ? `<button class="ib del" data-act="opt-del" data-i="${i}" aria-label="Убрать вариант">&times;</button>` : ""}</div>`,
    )
    .join("")}${draft.options.length < 6 ? `<button class="mini acc" data-act="opt-add">+ вариант</button>` : ""}</div>`;
}

function audioHtml(draft) {
  const list = state.audioFiles
    .map((p) => `<option value="${esc(p)}"${draft.audio === p ? " selected" : ""}>${esc(p)}</option>`)
    .join("");
  return `<div class="fld"><label>Аудио (необязательно)</label>
    <input data-f="audio" maxlength="200" value="${esc(draft.audio)}" placeholder="audio/имя.mp3 или file_id голосового" autocomplete="off" />
    <div style="margin-top:8px">
      <button class="mini acc" data-act="audio-pick">Загрузить файл</button>
      ${state.audioFiles.length ? `<select id="audio-sel" data-f="audio-sel" style="font:inherit;font-size:14.5px;max-width:100%;padding:8px;border-radius:12px;background:var(--surface);color:var(--text);border:0"><option value="">Выбрать из загруженных</option>${list}</select>` : ""}
    </div>
    <input type="file" id="audio-file" accept="audio/*,.mp3,.ogg,.m4a,.wav" hidden />
    <p class="hint">mp3, ogg, m4a или wav до 3 МБ. Файл появится на сайте через несколько минут после сохранения колоды. Путь работает в боте и в приложении, file_id только в боте.</p></div>`;
}

function drawSheet() {
  const sh = state.sheet;
  if (!sh) return;
  let ov = sheetRoot.querySelector(".overlay");
  if (!ov) {
    sheetRoot.innerHTML = `<div class="overlay" data-act="sheet-bg"><div class="sheet"></div></div>`;
    ov = sheetRoot.querySelector(".overlay");
  }
  const panel = ov.querySelector(".sheet");
  const err = sh.error ? `<div class="errbox">${esc(sh.error)}</div>` : "";

  if (sh.view === "bulk") {
    const cards = sh.kind === "cards";
    panel.innerHTML = `<div class="grab"></div><h2>Добавить списком</h2>
      <p class="sub">Каждая строка — ${cards ? "одна карточка: иероглиф ; пиньинь ; перевод" : "одна пара: левая часть ; правая часть"}. Разделитель — точка с запятой, вертикальная черта или Tab.</p>
      ${err}
      <div class="fld"><textarea id="bulk-text" rows="8" placeholder="${cards ? "你好 ; nǐ hǎo ; привет" : "一 ; один"}" style="min-height:160px"></textarea></div>
      <div class="btns"><button class="btn primary" data-act="bulk-apply">Добавить</button><button class="btn ghost" data-act="sheet-close">Отмена</button></div>`;
    return;
  }

  const d = sh.draft;
  let form = "";
  if (sh.kind === "cards") {
    form =
      fieldHtml("Иероглифы", "hanzi", d.hanzi, { max: 30 }) +
      fieldHtml("Пиньинь", "pinyin", d.pinyin, { max: 60, hint: "Со знаками тонов: nǐ hǎo, а не ni3 hao3." }) +
      fieldHtml("Перевод", "translation", d.translation, { max: 120 });
  } else if (sh.kind === "tests") {
    form =
      fieldHtml("Вопрос", "question", d.question, { area: true, max: 300 }) +
      optionsHtml(d) +
      fieldHtml("Пояснение (необязательно)", "explain", d.explain, { area: true, max: 400, hint: "Показывается ученику после ответа." }) +
      audioHtml(d);
  } else if (sh.kind === "pairs") {
    form = fieldHtml("Левая часть", "left", d.left, { max: 100 }) + fieldHtml("Правая часть", "right", d.right, { max: 100 });
  } else {
    form =
      fieldHtml("Предложение", "text", d.text, { area: true, max: 300, hint: "На месте пропуска поставьте ___ (три подчёркивания)." }) +
      `<button class="mini acc" data-act="insert-blank" style="margin:-6px 0 12px">Вставить ___ в конец</button>` +
      optionsHtml(d) +
      fieldHtml("Перевод предложения (необязательно)", "translation", d.translation, { max: 120 });
  }
  panel.innerHTML = `<div class="grab"></div><h2>${KIND_TITLE[sh.kind]}</h2><div style="height:6px"></div>${err}${form}
    <div class="btns"><button class="btn primary" data-act="item-save">Готово</button><button class="btn ghost" data-act="sheet-close">Отмена</button></div>`;
}

function closeSheet() {
  const ov = sheetRoot.querySelector(".overlay");
  state.sheet = null;
  if (!ov) return;
  ov.classList.add("closing");
  setTimeout(() => {
    if (!state.sheet) sheetRoot.innerHTML = "";
  }, 180);
}

// перенос введённого в поля значения в черновик (без перерисовки, чтобы не терять фокус)
function onSheetInput(e) {
  const sh = state.sheet;
  const t = e.target;
  if (!sh || !t.dataset?.f) return;
  const f = t.dataset.f;
  const i = Number(t.dataset.i);
  if (f === "opt") sh.draft.options[i] = t.value;
  else if (f === "correct") sh.draft.answer = i;
  else if (f === "audio-sel") {
    if (t.value) {
      sh.draft.audio = t.value;
      const inp = sheetRoot.querySelector('input[data-f="audio"]');
      if (inp) inp.value = t.value;
    }
  } else sh.draft[f] = t.value;
}

function draftError(kind, d) {
  const need = (v) => typeof v === "string" && v.trim() !== "";
  if (kind === "cards") {
    if (!need(d.hanzi)) return "Заполните иероглифы";
    if (!need(d.pinyin)) return "Заполните пиньинь";
    if (!need(d.translation)) return "Заполните перевод";
    return "";
  }
  if (kind === "pairs") return need(d.left) && need(d.right) ? "" : "Заполните обе части пары";
  if (kind === "tests" && !need(d.question)) return "Введите вопрос";
  if (kind === "cloze") {
    if (!need(d.text)) return "Введите предложение";
    if (d.text.split("___").length !== 2) return "В предложении должно быть ровно одно место пропуска ___";
  }
  const opts = d.options.map((o) => o.trim());
  if (opts.some((o) => !o)) return "Заполните все варианты ответа или уберите лишние";
  if (new Set(opts).size !== opts.length) return "Варианты ответа не должны повторяться";
  if (!(d.answer >= 0 && d.answer < opts.length)) return "Отметьте верный вариант";
  if (kind === "tests" && d.audio.trim() && !/^(?:[A-Za-z0-9_-]{20,}|audio\/[A-Za-z0-9._-]+\.(?:mp3|ogg|oga|opus|m4a|wav))$/.test(d.audio.trim())) {
    return "Аудио: путь вида audio/имя.mp3 или file_id голосового";
  }
  return "";
}

function cleanDraft(kind, d) {
  const t = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  if (kind === "cards") return { ...d, hanzi: t(d.hanzi), pinyin: t(d.pinyin), translation: t(d.translation) };
  if (kind === "pairs") return { left: t(d.left), right: t(d.right) };
  if (kind === "tests") {
    const out = { question: t(d.question), options: d.options.map(t), answer: d.answer };
    if (t(d.explain)) out.explain = t(d.explain);
    if (t(d.audio)) out.audio = t(d.audio);
    return out;
  }
  const out = { text: t(d.text), options: d.options.map(t), answer: d.answer };
  if (t(d.translation)) out.translation = t(d.translation);
  return out;
}

function saveItem() {
  const sh = state.sheet;
  const err = draftError(sh.kind, sh.draft);
  if (err) {
    sh.error = err;
    haptic.err();
    drawSheet();
    return;
  }
  const item = cleanDraft(sh.kind, sh.draft);
  const list = state.deck.data[sh.kind];
  if (sh.index === null) list.push(item);
  else list[sh.index] = item;
  closeSheet();
  refreshLists();
}

function applyBulk() {
  const sh = state.sheet;
  const text = $("#bulk-text").value;
  const cards = sh.kind === "cards";
  const need = cards ? 3 : 2;
  const items = [];
  const bad = [];
  text.split(/\r?\n/).forEach((line, n) => {
    if (!line.trim()) return;
    const parts = line.split(/[;|\t]/).map((s) => s.replace(/\s+/g, " ").trim());
    if (parts.length !== need || parts.some((p) => !p)) bad.push(n + 1);
    else items.push(cards ? { hanzi: parts[0], pinyin: parts[1], translation: parts[2] } : { left: parts[0], right: parts[1] });
  });
  if (bad.length) {
    sh.error = `Не удалось разобрать строки: ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? "…" : ""}. Нужно ${need} части через ;`;
    haptic.err();
    drawSheet();
    $("#bulk-text").value = text;
    return;
  }
  if (!items.length) {
    sh.error = "Нечего добавлять: введите хотя бы одну строку";
    drawSheet();
    return;
  }
  state.deck.data[sh.kind].push(...items);
  closeSheet();
  refreshLists();
  toast(`Добавлено: ${items.length}`);
}

// ---------- аудио ----------

async function loadAudioList() {
  try {
    const r = await api("/api/audio");
    state.audioFiles = r.files ?? [];
    if (state.sheet?.kind === "tests" && state.sheet.view === "item") {
      const current = sheetRoot.querySelector('input[data-f="audio"]')?.value;
      drawSheet();
      if (current !== undefined) {
        const inp = sheetRoot.querySelector('input[data-f="audio"]');
        if (inp) inp.value = current;
      }
    }
  } catch {
    /* список не критичен */
  }
}

async function uploadAudio(file) {
  const sh = state.sheet;
  const m = /\.(mp3|ogg|oga|opus|m4a|wav)$/i.exec(file.name);
  if (!m) return toast("Нужен файл mp3, ogg, m4a или wav");
  if (file.size > 3_000_000) return toast("Файл больше 3 МБ");
  const base = file.name.slice(0, -m[0].length).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "audio";
  const name = `${base}.${m[1].toLowerCase()}`;
  toast("Загружаю…");
  try {
    const r = await api(`/api/audio?name=${encodeURIComponent(name)}`, {
      method: "POST",
      raw: await file.arrayBuffer(),
      headers: { "Content-Type": file.type || "audio/mpeg" },
    });
    if (state.sheet === sh) {
      sh.draft.audio = r.path;
      state.audioFiles = [...new Set([...state.audioFiles, r.path])];
      drawSheet();
    }
    haptic.ok();
    toast("Аудио загружено");
  } catch (e) {
    haptic.err();
    toast(e.message);
  }
}

// ---------- действия ----------

async function loadList() {
  renderLoading();
  const slow = setTimeout(() => {
    const el = $("#ld");
    if (el) el.textContent = "Сервер просыпается, это может занять до минуты…";
  }, 4000);
  try {
    const r = await api("/api/decks");
    state.decks = r.decks;
    renderList();
  } catch (e) {
    if (e.status === 401 || e.status === 403) renderDenied(e.message);
    else {
      renderMessage("Не удалось загрузиться", e.message, `<button class="btn primary" data-act="retry" style="margin-top:12px">Повторить</button>`);
    }
  } finally {
    clearTimeout(slow);
  }
}

async function openDeck(id) {
  renderLoading("Открываю колоду…");
  try {
    const r = await api(`/api/decks/${encodeURIComponent(id)}`);
    const data = { name: r.deck.name, cards: r.deck.cards ?? [], tests: r.deck.tests ?? [], pairs: r.deck.pairs ?? [], cloze: r.deck.cloze ?? [] };
    state.deck = { id, isNew: false, sha: r.sha, data, original: "", originalCards: data.cards.map((c) => c.hanzi), dropped: r.dropped };
    state.deck.original = snapshot();
    state.tab = data.cards.length ? "cards" : TABS.find((t) => data[t.key].length)?.key ?? "cards";
    state.filter = "";
    renderDeck();
  } catch (e) {
    toast(e.message);
    renderList();
  }
}

function newDeck() {
  state.deck = { id: "", isNew: true, sha: undefined, data: emptyData(), original: "", originalCards: [], dropped: 0 };
  state.tab = "cards";
  state.filter = "";
  renderDeck();
}

async function leaveDeck() {
  if (isDirty() && !(await ask("Есть несохранённые изменения. Выйти без сохранения?"))) return;
  renderList();
}

async function save() {
  const d = state.deck;
  if (state.saving) return;
  d.data.name = ($("#f-name")?.value ?? d.data.name).trim();
  if (d.isNew) d.id = ($("#f-id")?.value ?? d.id).trim();
  const errs = [];
  if (!d.data.name) errs.push("Введите название колоды");
  if (d.isNew && !DECK_ID_RE.test(d.id)) errs.push("Код колоды: латиница, цифры, - и _, до 30 символов");
  const total = TABS.reduce((n, t) => n + d.data[t.key].length, 0);
  if (!total) errs.push("Добавьте хотя бы одно задание");
  if (d.data.pairs.length === 1) errs.push("Для пар нужно минимум 2");
  if (errs.length) {
    showErrors("Проверьте данные", errs);
    haptic.err();
    return;
  }
  if (cardsChanged() && !(await ask("Вы изменили список карточек. Коды прогресса учеников для этой колоды перестанут подходить, ученики начнут её заново. Сохранить?"))) return;

  state.saving = true;
  refreshSave();
  $("#errs").innerHTML = "";
  try {
    const r = await api(`/api/decks/${encodeURIComponent(d.id)}`, { method: "PUT", body: { deck: payload(d.data), sha: d.isNew ? undefined : d.sha } });
    d.sha = r.sha;
    d.isNew = false;
    d.dropped = 0;
    d.originalCards = d.data.cards.map((c) => c.hanzi);
    d.original = snapshot();
    haptic.ok();
    toast("Сохранено. У учеников появится через 3–5 минут.");
    renderDeck();
  } catch (e) {
    haptic.err();
    if (e.status === 409) showErrors(e.message, ["Вернитесь к списку и откройте колоду заново. Ваши правки на этом экране не пропадут, пока вы не выйдете."]);
    else showErrors(e.message, e.errors ?? []);
  } finally {
    state.saving = false;
    refreshSave();
  }
}

async function deleteDeck() {
  const d = state.deck;
  if (!(await ask(`Удалить колоду «${d.data.name}» целиком? Коды прогресса учеников для неё перестанут работать.`))) return;
  try {
    await api(`/api/decks/${encodeURIComponent(d.id)}?sha=${encodeURIComponent(d.sha)}`, { method: "DELETE" });
    haptic.ok();
    toast("Колода удалена");
    loadList();
  } catch (e) {
    showErrors(e.message);
  }
}

const actions = {
  "new-deck": () => newDeck(),
  "open-deck": (el) => openDeck(el.dataset.id),
  retry: () => loadList(),
  back: () => leaveDeck(),
  tab: (el) => {
    state.tab = el.dataset.tab;
    state.filter = "";
    renderDeck();
  },
  "add-item": () => openItem(null),
  "edit-item": (el) => openItem(Number(el.dataset.i)),
  "del-item": async (el) => {
    if (!(await ask("Удалить это задание?"))) return;
    state.deck.data[state.tab].splice(Number(el.dataset.i), 1);
    refreshLists();
  },
  bulk: () => {
    state.sheet = { view: "bulk", kind: state.tab, error: "" };
    drawSheet();
  },
  "bulk-apply": () => applyBulk(),
  "item-save": () => saveItem(),
  "sheet-close": () => closeSheet(),
  "sheet-bg": (el, e) => {
    if (e.target === el) closeSheet();
  },
  "opt-add": () => {
    const d = state.sheet.draft;
    if (d.options.length < 6) d.options.push("");
    drawSheet();
  },
  "opt-del": (el) => {
    const d = state.sheet.draft;
    const i = Number(el.dataset.i);
    if (d.options.length <= 2) return;
    d.options.splice(i, 1);
    if (d.answer === i) d.answer = 0;
    else if (d.answer > i) d.answer -= 1;
    drawSheet();
  },
  "insert-blank": () => {
    const inp = sheetRoot.querySelector('[data-f="text"]');
    if (!inp) return;
    inp.value = `${inp.value}${inp.value && !inp.value.endsWith(" ") ? " " : ""}___`;
    state.sheet.draft.text = inp.value;
  },
  "audio-pick": () => $("#audio-file")?.click(),
  save: () => save(),
  "delete-deck": () => deleteDeck(),
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  actions[el.dataset.act]?.(el, e);
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (sheetRoot.contains(t)) return onSheetInput(e);
  if (t.id === "f-name") {
    state.deck.data.name = t.value;
    refreshSave();
  } else if (t.id === "f-id") {
    state.deck.id = t.value.trim();
    refreshSave();
  } else if (t.id === "f-search") {
    state.filter = t.value;
    $("#items").innerHTML = itemsHtml();
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "audio-file" && t.files?.[0]) {
    uploadAudio(t.files[0]);
    t.value = "";
  } else if (sheetRoot.contains(t)) onSheetInput(e);
});

// ---------- запуск ----------

function boot() {
  if (tg) {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    if (tg.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;
    tg.BackButton?.onClick(() => {
      if (state.sheet) closeSheet();
      else if (state.screen === "deck") leaveDeck();
    });
  }
  if (!initData) {
    renderDenied("Откройте редактор через бота командой /teacher.");
    return;
  }
  loadList();
}

boot();
