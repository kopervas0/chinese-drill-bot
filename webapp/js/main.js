import {
  MODES,
  MODE_ORDER,
  buildOptions,
  canStart,
  createSession,
  currentIndex,
  decodeProgress,
  deckSignature,
  eligible,
  encodeProgress,
  finishSession,
  isFinished,
  matchPick,
  nextRound,
  pinyinTokens,
  record,
  roundComplete,
} from "./logic.js";

// Данные пользователя Telegram (initData) намеренно не читаются и никуда не
// отправляются. Прогресс хранится только в localStorage этого устройства.
const tg = window.Telegram?.WebApp;
const app = document.getElementById("app");
const sheetRoot = document.getElementById("sheet-root");
const toastEl = document.getElementById("toast");
const $ = (sel) => document.querySelector(sel);

const state = {
  decks: [],
  byId: new Map(),
  known: new Map(),
  tts: false,
  screen: "home",
  session: null,
  deck: null,
  lastRun: null,
  sheet: null,
  opts: null,
  answered: false,
  busy: false,
  finishing: false,
};

const ICON_SPEAKER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function pinyinHtml(pinyin) {
  return pinyinTokens(pinyin)
    .map((t) => (t.tone === null ? esc(t.text) : `<span class="t${t.tone}">${esc(t.text)}</span>`))
    .join("");
}

const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred("light"),
  ok: () => tg?.HapticFeedback?.notificationOccurred("success"),
  err: () => tg?.HapticFeedback?.notificationOccurred("error"),
};

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {}
    ta.remove();
  }
  toast("Код скопирован");
}

// ---------- озвучка (если в устройстве есть китайский голос) ----------

function detectTts() {
  if (!("speechSynthesis" in window)) return;
  const update = () => {
    const has = speechSynthesis.getVoices().some((v) => /^zh/i.test(v.lang));
    if (has !== state.tts) {
      state.tts = has;
      if (state.screen === "home" && !state.sheet) renderHome();
      if (state.sheet) drawSheet();
    }
  };
  update();
  speechSynthesis.addEventListener?.("voiceschanged", update);
}

function speak(text) {
  if (!state.tts) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-CN";
  u.rate = 0.85;
  const voice = speechSynthesis.getVoices().find((v) => /^zh/i.test(v.lang));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

const speakBtn = (text) =>
  state.tts ? `<button class="speak" data-act="speak" data-t="${esc(text)}" aria-label="Озвучить">${ICON_SPEAKER}</button>` : "";

// ---------- хранение прогресса ----------

const STORE_KEY = "drill.known.v1";

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

async function saveKnown(deck, known) {
  state.known.set(deck.id, known);
  const store = readStore();
  store[deck.id] = { sig: await deckSignature(deck), idx: [...known] };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {}
}

async function loadKnown() {
  const store = readStore();
  for (const deck of state.decks) {
    const saved = store[deck.id];
    const ok = saved && saved.sig === (await deckSignature(deck));
    state.known.set(deck.id, ok ? new Set(saved.idx) : new Set());
  }
}

const knownOf = (deck) => state.known.get(deck.id) ?? new Set();

// ---------- главный экран ----------

function renderHome() {
  window.scrollTo(0, 0);
  state.screen = "home";
  state.session = null;
  setBack(false);
  const cards = state.decks
    .map((deck, i) => {
      const known = knownOf(deck).size;
      const pct = Math.round((known / deck.cards.length) * 100);
      return `<div class="deck" role="button" tabindex="0" data-act="open" data-id="${esc(deck.id)}" style="animation-delay:${i * 60}ms">
        <div class="deck-top">
          <div>
            <div class="deck-name">${esc(deck.name)}</div>
            <div class="deck-meta">Выучено ${known} из ${deck.cards.length}</div>
          </div>
          <div class="deck-glyph">${esc(deck.cards[0]?.hanzi ?? "字")}</div>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <button class="link" data-act="code" data-id="${esc(deck.id)}">Код прогресса</button>
      </div>`;
    })
    .join("");
  app.innerHTML = `<div class="app">
    <header class="hero">
      <div class="seal">学</div>
      <div><h1>Китайский тренажёр</h1><p>Выберите колоду и потренируйтесь</p></div>
    </header>
    <section class="decks">${cards}</section>
    <p class="note">Прогресс хранится только на этом устройстве.<br />Код прогресса подходит и для бота командой /code.</p>
  </div>`;
}

// ---------- окно выбора формата ----------

function openSheet(deckId, view = "start") {
  state.sheet = { deckId, view, mode: "cards", limit: 10 };
  drawSheet();
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

async function drawSheet() {
  const sh = state.sheet;
  if (!sh) return;
  const deck = state.byId.get(sh.deckId);
  let ov = sheetRoot.querySelector(".overlay");
  if (!ov) {
    sheetRoot.innerHTML = `<div class="overlay" data-act="sheet-bg"><div class="sheet"></div></div>`;
    ov = sheetRoot.querySelector(".overlay");
  }
  const panel = ov.querySelector(".sheet");

  if (sh.view === "code") {
    const code = await encodeProgress(deck, knownOf(deck));
    if (state.sheet !== sh) return;
    panel.innerHTML = `<div class="grab"></div>
      <h2>Код прогресса</h2>
      <p class="sub">${esc(deck.name)}. Код хранится только у вас, его можно перенести на другое устройство или в бота.</p>
      <div class="label">Ваш код</div>
      <div class="codebox">${esc(code)}</div>
      <button class="btn ghost" data-act="copy" data-code="${esc(code)}" style="margin-bottom:18px">Скопировать код</button>
      <div class="label">Загрузить код</div>
      <textarea class="codebox" id="code-in" placeholder="Вставьте код сюда" spellcheck="false"></textarea>
      <button class="btn primary" data-act="import" data-id="${esc(deck.id)}">Загрузить</button>`;
    return;
  }

  const opts = { tts: state.tts };
  const modes = MODE_ORDER.filter((m) => canStart(deck, m, opts));
  if (!modes.includes(sh.mode)) sh.mode = "cards";
  const total = eligible(deck, sh.mode).length;
  if (sh.limit && sh.limit >= total) sh.limit = 0;
  const lengths = [10, 20].filter((n) => n < total);
  const known = knownOf(deck).size;

  panel.innerHTML = `<div class="grab"></div>
    <h2>${esc(deck.name)}</h2>
    <p class="sub">Выучено ${known} из ${deck.cards.length}${known ? ". Сначала пойдут новые слова." : ""}</p>
    <div class="label">Формат</div>
    <div class="modes">${modes
      .map(
        (m) => `<button class="mode${m === sh.mode ? " sel" : ""}" data-act="mode" data-m="${m}">
          <span class="g">${MODES[m].glyph}</span><div><b>${MODES[m].label}</b><span>${MODES[m].hint}</span></div>
        </button>`,
      )
      .join("")}</div>
    <div class="label">Сколько карточек</div>
    <div class="seg">${[...lengths, 0]
      .map(
        (n) =>
          `<button class="${(sh.limit || 0) === n ? "sel" : ""}" data-act="limit" data-n="${n}">${n === 0 ? `Все (${total})` : n}</button>`,
      )
      .join("")}</div>
    <button class="btn primary" data-act="start">Начать</button>`;
}

// ---------- занятие ----------

function begin(deckId, mode, limit) {
  const deck = state.byId.get(deckId);
  state.deck = deck;
  state.lastRun = { deckId, mode, limit };
  state.finishing = false;
  state.session = createSession(deck, mode, limit || null, knownOf(deck));
  closeSheet();
  renderSession();
}

function renderSession() {
  window.scrollTo(0, 0);
  state.screen = "session";
  setBack(true);
  app.innerHTML = `<div class="app">
    <div class="top">
      <button class="x" data-act="quit" aria-label="Закончить">&times;</button>
      <div class="bar"><i id="pb"></i></div>
      <div class="count" id="cnt"></div>
    </div>
    <main class="stage" id="stage"></main>
  </div>`;
  showQuestion();
}

function updateTop() {
  const s = state.session;
  let frac;
  let label;
  if (s.mode === "match") {
    const m = s.match;
    frac = (m.round + m.done.size / m.rounds[m.round].length) / m.rounds.length;
    label = `${Math.min(m.round + 1, m.rounds.length)}/${m.rounds.length}`;
  } else {
    frac = s.position / s.order.length;
    label = `${Math.min(s.position + 1, s.order.length)}/${s.order.length}`;
  }
  $("#pb").style.width = `${Math.round(frac * 100)}%`;
  $("#cnt").textContent = label;
}

function freshStage() {
  const stage = $("#stage");
  stage.style.animation = "none";
  void stage.offsetWidth;
  stage.style.animation = "";
  return stage;
}

function showQuestion() {
  window.scrollTo(0, 0);
  const s = state.session;
  if (s.mode !== "match" && isFinished(s)) {
    finish();
    return;
  }
  state.answered = false;
  state.busy = false;
  updateTop();
  const stage = freshStage();
  if (s.mode === "match") renderMatch(stage);
  else if (s.mode === "cards") renderCard(stage);
  else renderChoice(stage);
}

function advance() {
  state.session.position += 1;
  showQuestion();
}

// --- карточки ---

function renderCard(stage) {
  const card = state.deck.cards[currentIndex(state.session)];
  stage.innerHTML = `
    <div class="card-wrap" id="cw">
      <div class="flip-inner">
        <div class="face front">
          <div class="hanzi">${esc(card.hanzi)}</div>
          <div class="tap-hint">нажмите, чтобы перевернуть</div>
        </div>
        <div class="face back">
          <div class="hanzi sm">${esc(card.hanzi)}</div>
          <div class="pinyin">${pinyinHtml(card.pinyin)}</div>
          <div class="translation">${esc(card.translation)}</div>
          ${speakBtn(card.hanzi)}
          <div class="tint" id="tint"></div>
        </div>
      </div>
    </div>
    <div class="actions off" id="acts">
      <button class="btn bad" data-act="again">Ещё раз</button>
      <button class="btn good" data-act="know">Знаю</button>
    </div>`;
  bindCard();
}

function bindCard() {
  const cw = $("#cw");
  const acts = $("#acts");
  const tint = $("#tint");
  let flipped = false;
  let drag = false;
  let moved = false;
  let sx = 0;
  let dx = 0;

  const reset = () => {
    cw.classList.remove("dragging");
    cw.style.transition = "transform 0.25s ease";
    cw.style.transform = "";
    tint.style.opacity = 0;
  };

  cw.addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-act]") || state.busy) return;
    drag = true;
    moved = false;
    sx = e.clientX;
    dx = 0;
    cw.style.transition = "";
    cw.setPointerCapture(e.pointerId);
  });
  cw.addEventListener("pointermove", (e) => {
    if (!drag) return;
    dx = e.clientX - sx;
    if (Math.abs(dx) > 10) moved = true;
    if (flipped && moved) {
      cw.classList.add("dragging");
      cw.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
      tint.style.background = dx > 0 ? "var(--good)" : "var(--bad)";
      tint.style.opacity = Math.min(Math.abs(dx) / 220, 0.35);
    }
  });
  cw.addEventListener("pointerup", () => {
    if (!drag) return;
    drag = false;
    if (!moved) {
      flipped = !flipped;
      cw.classList.toggle("flipped", flipped);
      acts.classList.toggle("off", !flipped);
      haptic.tap();
      return;
    }
    if (flipped && Math.abs(dx) > 90) answerCard(dx > 0);
    else reset();
  });
  cw.addEventListener("pointercancel", () => {
    drag = false;
    reset();
  });
}

function answerCard(correct) {
  if (state.busy) return;
  state.busy = true;
  record(state.session, correct);
  correct ? haptic.ok() : haptic.err();
  const cw = $("#cw");
  cw.classList.add("dragging");
  cw.style.transition = "transform 0.28s ease, opacity 0.28s";
  cw.style.transform = `translateX(${correct ? 120 : -120}%) rotate(${correct ? 16 : -16}deg)`;
  cw.style.opacity = 0;
  setTimeout(advance, 260);
}

// --- квиз, тоны, на слух ---

function renderChoice(stage) {
  const s = state.session;
  const card = state.deck.cards[currentIndex(s)];
  const options = buildOptions(s, state.deck);
  state.opts = options;

  let head;
  if (s.mode === "quiz") {
    head = `<div class="center-col"><div class="hanzi md">${esc(card.hanzi)}</div>
      <div class="pinyin">${pinyinHtml(card.pinyin)}</div>${speakBtn(card.hanzi)}</div>
      <div class="prompt-note">Выберите перевод</div>`;
  } else if (s.mode === "quizrev") {
    head = `<div class="center-col"><div class="prompt-tr">${esc(card.translation)}</div></div>
      <div class="prompt-note">Выберите иероглиф</div>`;
  } else if (s.mode === "tones") {
    head = `<div class="center-col"><div class="hanzi md">${esc(card.hanzi)}</div>
      <div class="translation">${esc(card.translation)}</div></div>
      <div class="prompt-note">Выберите правильный пиньинь</div>`;
  } else {
    head = `<div class="center-col"><button class="speak big" data-act="speak" data-t="${esc(card.hanzi)}" aria-label="Прослушать">${ICON_SPEAKER}</button></div>
      <div class="prompt-note">Что вы услышали? Выберите перевод</div>`;
  }

  const han = s.mode === "quizrev" ? " han" : "";
  stage.innerHTML = `${head}
    <div id="fb"></div>
    <div class="opts">${options
      .map((o, i) => `<button class="opt${han}" data-act="pick" data-i="${i}">${esc(o.label)}</button>`)
      .join("")}</div>`;
  if (s.mode === "listen") setTimeout(() => speak(card.hanzi), 250);
}

function pick(i) {
  if (state.answered) return;
  state.answered = true;
  const s = state.session;
  const card = state.deck.cards[currentIndex(s)];
  const option = state.opts[i];
  record(s, option.correct);

  document.querySelectorAll(".opt").forEach((el, idx) => {
    const o = state.opts[idx];
    if (o.correct) el.classList.add("correct");
    else if (idx === i) el.classList.add("wrong");
    else el.classList.add("dim");
  });

  if (option.correct) {
    haptic.ok();
    setTimeout(advance, 800);
    return;
  }
  haptic.err();
  // показываем только то, чего ещё нет на экране
  let reveal = "";
  if (s.mode === "quizrev") {
    reveal = `<div class="pinyin">${pinyinHtml(card.pinyin)}</div>`;
  } else if (s.mode === "tones") {
    reveal = `<div class="pinyin">${pinyinHtml(card.pinyin)}</div>`;
  } else if (s.mode === "listen") {
    reveal = `<div class="row"><div class="hanzi sm">${esc(card.hanzi)}</div></div>
      <div class="pinyin">${pinyinHtml(card.pinyin)}</div>
      <div class="translation">${esc(card.translation)}</div>`;
  }
  $("#fb").innerHTML = `${reveal ? `<div class="reveal">${reveal}</div>` : ""}
    <button class="btn primary" data-act="next" style="margin-top:12px">Дальше</button>`;
  $("#fb").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// --- матч-игра ---

function tileHtml(s, side, pos) {
  const m = s.match;
  const card = (side === "l" ? m.left : m.right)[pos];
  const c = state.deck.cards[card];
  const cls = ["tile", side === "l" ? "han" : ""];
  if (m.done.has(card)) cls.push("done");
  if (m.picked && m.picked.side === side && m.picked.card === card) cls.push("sel");
  const text = side === "l" ? c.hanzi : c.translation;
  return `<button class="${cls.join(" ")}" data-act="tile" data-side="${side}" data-pos="${pos}">${esc(text)}</button>`;
}

function matchGrid(s) {
  return s.match.left.map((_, i) => tileHtml(s, "l", i) + tileHtml(s, "r", i)).join("");
}

function renderMatch(stage) {
  const s = state.session;
  const m = s.match;
  stage.innerHTML = `<div class="prompt-note">Раунд ${m.round + 1} из ${m.rounds.length}: найдите пары</div>
    <div class="match" id="mt">${matchGrid(s)}</div>`;
}

function onTile(side, pos) {
  const s = state.session;
  if (state.busy) return;
  const res = matchPick(s, side, pos);
  if (res.result === "ignored") return;
  haptic.tap();
  $("#mt").innerHTML = matchGrid(s);
  updateTop();

  if (res.result === "wrong") {
    haptic.err();
    const m = s.match;
    for (const { side: sd, card } of [res.first, res.second]) {
      const p = (sd === "l" ? m.left : m.right).indexOf(card);
      const el = document.querySelector(`.tile[data-side="${sd}"][data-pos="${p}"]`);
      el?.classList.add("wrong");
      setTimeout(() => el?.classList.remove("wrong"), 450);
    }
  }
  if (res.result === "matched" && roundComplete(s)) {
    state.busy = true;
    haptic.ok();
    setTimeout(() => {
      if (nextRound(s)) showQuestion();
      else finish();
    }, 650);
  }
}

// ---------- итог ----------

async function finish() {
  if (state.finishing) return;
  state.finishing = true;
  const s = state.session;
  const deck = state.deck;
  const { known, answered } = finishSession(s, knownOf(deck));
  if (answered === 0) {
    renderHome();
    return;
  }
  await saveKnown(deck, known);
  const code = await encodeProgress(deck, known);
  renderResult(s, deck, known, answered, code);
}

function renderResult(s, deck, known, answered, code) {
  window.scrollTo(0, 0);
  state.screen = "result";
  setBack(true);
  const ratio = s.right.size / answered;
  const pct = Math.round(ratio * 100);
  const title =
    ratio >= 0.9 ? "Отлично!" : ratio >= 0.7 ? "Хороший результат" : ratio >= 0.4 ? "Неплохо, есть что повторить" : "Повторение всё исправит";
  const missed = [...s.missed].map((i) => deck.cards[i]);
  const missedHtml = missed.length
    ? `<div class="label">Стоит повторить</div><div class="missed">${missed
        .slice(0, 10)
        .map(
          (c) => `<div class="m"><div class="h">${esc(c.hanzi)}</div>
            <div class="p">${pinyinHtml(c.pinyin)}</div><div class="t">${esc(c.translation)}</div></div>`,
        )
        .join("")}</div>${missed.length > 10 ? `<p class="sub">…и ещё ${missed.length - 10}</p>` : ""}`
    : "";

  app.innerHTML = `<div class="app"><div class="result">
    <div class="ring" style="--p:${pct}"><div><span>${s.right.size}/${answered}<small>с первого раза</small></span></div></div>
    <h2>${title}</h2>
    <p class="sub">Выучено в колоде: ${known.size} из ${deck.cards.length}</p>
    ${missedHtml}
    <div class="label">Код прогресса</div>
    <div class="codebox">${esc(code)}</div>
    <div class="btns">
      <button class="btn primary" data-act="again-run">Ещё раз</button>
      <button class="btn ghost" data-act="copy" data-code="${esc(code)}">Скопировать код</button>
      <button class="btn ghost" data-act="home">К колодам</button>
    </div>
    <p class="note" style="padding-top:8px">Прогресс уже сохранён на этом устройстве.<br />Код можно ввести в боте командой /code.</p>
  </div></div>`;
  if (ratio >= 0.8) confetti();
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#cf3f31", "#2a9d6a", "#3b82f6", "#a855f7", "#f5b942"];
  const box = document.createElement("div");
  box.className = "confetti";
  for (let i = 0; i < 44; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = `${2.2 + Math.random() * 1.8}s`;
    p.style.animationDelay = `${Math.random() * 0.5}s`;
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4800);
}

function quit() {
  if (state.screen === "session") finish();
  else renderHome();
}

// ---------- кнопка «Назад» Telegram ----------

function setBack(visible) {
  const bb = tg?.BackButton;
  if (!bb) return;
  visible ? bb.show() : bb.hide();
}

// ---------- события ----------

const actions = {
  open: (el) => openSheet(el.dataset.id),
  code: (el) => openSheet(el.dataset.id, "code"),
  "sheet-bg": (el, e) => {
    if (e.target === el) closeSheet();
  },
  mode: (el) => {
    state.sheet.mode = el.dataset.m;
    drawSheet();
  },
  limit: (el) => {
    state.sheet.limit = Number(el.dataset.n);
    drawSheet();
  },
  start: () => begin(state.sheet.deckId, state.sheet.mode, state.sheet.limit),
  copy: (el) => copyText(el.dataset.code),
  import: async (el) => {
    const input = $("#code-in");
    const res = await decodeProgress(input.value, state.byId);
    if (!res.ok) {
      toast(res.reason);
      haptic.err();
      return;
    }
    await saveKnown(res.deck, res.known);
    haptic.ok();
    toast(`Загружено: выучено ${res.known.size} из ${res.deck.cards.length}`);
    closeSheet();
    renderHome();
  },
  quit: () => quit(),
  again: () => answerCard(false),
  know: () => answerCard(true),
  pick: (el) => pick(Number(el.dataset.i)),
  next: () => advance(),
  tile: (el) => onTile(el.dataset.side, Number(el.dataset.pos)),
  speak: (el) => speak(el.dataset.t),
  "again-run": () => begin(state.lastRun.deckId, state.lastRun.mode, state.lastRun.limit),
  home: () => renderHome(),
  reload: () => location.reload(),
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  actions[el.dataset.act]?.(el, e);
});

document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.('[role="button"]')) {
    e.preventDefault();
    e.target.click();
  }
});

// ---------- запуск ----------

function applyTheme() {
  if (tg?.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;
}

async function boot() {
  if (tg) {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    applyTheme();
    tg.onEvent?.("themeChanged", applyTheme);
    tg.BackButton?.onClick(() => {
      if (state.sheet) closeSheet();
      else quit();
    });
  }
  detectTts();
  try {
    const index = await (await fetch("decks/index.json")).json();
    state.decks = await Promise.all(
      index.map(async (d) => ({ id: d.id, ...(await (await fetch(`decks/${d.id}.json`)).json()) })),
    );
    state.byId = new Map(state.decks.map((d) => [d.id, d]));
    await loadKnown();
    renderHome();
  } catch {
    app.innerHTML = `<div class="app"><header class="hero"><div class="seal">学</div>
      <div><h1>Не удалось загрузить колоды</h1><p>Проверьте соединение и попробуйте ещё раз.</p></div></header>
      <button class="btn primary" data-act="reload">Повторить</button></div>`;
  }
}

boot();
