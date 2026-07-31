import * as Y from "yjs";
import mqtt from "mqtt";
import { keyRequests, openingScript, sections, sources } from "./content.js";
import "./style.css";

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const SHARED_ROOM =
  (isLocal && new URLSearchParams(location.search).get("test-room")) ||
  "albert-safin-team-meeting-v2";
const STORAGE_KEY = `coach-state:${SHARED_ROOM}`;
const palette = ["#F05D3D", "#4766E7", "#B159C7", "#278B70", "#CB7D13"];

const participant = {
  id: localStorage.getItem("coach-id") || crypto.randomUUID(),
  name: localStorage.getItem("coach-name") || `Участник ${Math.floor(Math.random() * 90 + 10)}`,
  color: localStorage.getItem("coach-color") || palette[Math.floor(Math.random() * palette.length)],
};
localStorage.setItem("coach-id", participant.id);
localStorage.setItem("coach-color", participant.color);

const doc = new Y.Doc();
const items = doc.getMap("items");
const notes = doc.getMap("notes");
const meta = doc.getMap("meta");
let provider;
let connected = false;
let initialized = false;
const people = new Map();
const TOPIC_ROOT = `ramchike-sites/coach-guide-7f3a2d/${SHARED_ROOM}`;
const STATE_TOPIC = `${TOPIC_ROOT}/state`;
const UPDATE_TOPIC = `${TOPIC_ROOT}/updates`;
const PRESENCE_TOPIC = `${TOPIC_ROOT}/presence/${participant.id}`;
let heartbeatTimer;

const defaults = sections.flatMap((section) =>
  section.questions.map((question) => ({
    ...question,
    sectionId: section.id,
    custom: false,
    checked: false,
    checkedBy: "",
  })),
);

const app = document.querySelector("#app");
let activeSection = sections[0].id;
let filter = "all";
let showAllQuotes = false;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function itemList() {
  return Array.from(items.values());
}

function noteList(itemId) {
  return Array.from(notes.values())
    .filter((note) => note.itemId === itemId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function localState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function seedIfEmpty() {
  if (initialized) return;
  initialized = true;
  const saved = localState();
  doc.transact(() => {
    if (items.size === 0) {
      (saved?.items || defaults).forEach((item) => {
        items.set(item.id, {
          ...item,
          notes: undefined,
          checkedBy: item.checkedBy || "",
        });
      });
    }
    if (notes.size === 0) {
      (saved?.notes || []).forEach((note) => notes.set(note.id, note));
    }
    Object.entries(saved?.meta || {}).forEach(([key, value]) => {
      if (!meta.has(key)) meta.set(key, value);
    });
  });
  render();
}

function persist() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      items: itemList(),
      notes: Array.from(notes.values()),
      meta: Object.fromEntries(meta.entries()),
    }),
  );
}

function connect() {
  try {
    provider = mqtt.connect("wss://broker.emqx.io:8084/mqtt", {
      clientId: `coach_${participant.id.replaceAll("-", "").slice(0, 20)}_${Math.random().toString(16).slice(2, 8)}`,
      clean: true,
      connectTimeout: 8_000,
      reconnectPeriod: 2_000,
      keepalive: 15,
      will: {
        topic: PRESENCE_TOPIC,
        payload: JSON.stringify({ ...participant, online: false, lastSeen: Date.now() }),
        qos: 0,
        retain: true,
      },
    });

    provider.on("connect", () => {
      connected = true;
      provider.subscribe([STATE_TOPIC, UPDATE_TOPIC, `${TOPIC_ROOT}/presence/+`], { qos: 0 }, () => {
        publishPresence();
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(publishPresence, 12_000);
        setTimeout(seedIfEmpty, 900);
      });
      updatePresence();
    });

    provider.on("reconnect", () => {
      connected = false;
      updatePresence();
    });

    provider.on("offline", () => {
      connected = false;
      updatePresence();
    });

    provider.on("error", (error) => {
      console.warn("Ошибка общей синхронизации.", error);
      connected = false;
      updatePresence();
    });

    provider.on("message", (topic, payload) => {
      if (topic === STATE_TOPIC || topic === UPDATE_TOPIC) {
        try {
          Y.applyUpdate(doc, new Uint8Array(payload), "mqtt");
          seedIfEmpty();
        } catch (error) {
          console.warn("Не удалось применить общее состояние.", error);
        }
        return;
      }

      if (topic.startsWith(`${TOPIC_ROOT}/presence/`)) {
        try {
          const person = JSON.parse(payload.toString());
          if (person.online) people.set(person.id, person);
          else people.delete(person.id);
          prunePeople();
          updatePresence();
          renderCursors();
        } catch {
          // Ignore malformed messages on the public topic.
        }
      }
    });
  } catch (error) {
    console.warn("Общая синхронизация недоступна, продолжаем локально.", error);
    seedIfEmpty();
  }
  setTimeout(seedIfEmpty, 2500);
}

function publishState(update) {
  if (!connected || !provider) return;
  if (update) provider.publish(UPDATE_TOPIC, update, { qos: 0, retain: false });
  provider.publish(STATE_TOPIC, Y.encodeStateAsUpdate(doc), { qos: 0, retain: true });
}

function publishPresence(cursor) {
  if (!connected || !provider) return;
  const current = {
    ...participant,
    online: true,
    lastSeen: Date.now(),
    cursor: cursor || people.get(participant.id)?.cursor || null,
  };
  people.set(participant.id, current);
  provider.publish(PRESENCE_TOPIC, JSON.stringify(current), { qos: 0, retain: true });
  updatePresence();
}

function prunePeople() {
  const cutoff = Date.now() - 40_000;
  people.forEach((person, id) => {
    if (person.lastSeen < cutoff) people.delete(id);
  });
}

function progress() {
  const all = itemList();
  const done = all.filter((item) => item.checked).length;
  return {
    done,
    total: all.length,
    percent: all.length ? Math.round((done / all.length) * 100) : 0,
  };
}

function render() {
  if (!initialized) {
    app.innerHTML = `<div class="loading-screen"><span></span><p>Подключаем общую доску…</p></div>`;
    return;
  }

  const current = sections.find((section) => section.id === activeSection) || sections[0];
  const allItems = itemList();
  const currentItems = allItems.filter(
    (item) =>
      item.sectionId === current.id &&
      (filter === "all" || (filter === "open" ? !item.checked : item.checked)),
  );
  const stats = progress();

  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#top" aria-label="К началу">
        <span class="brand-mark">НГ</span>
        <span>Не потерять главное</span>
      </a>
      <button class="presence" data-action="identity" title="Кто сейчас на странице">
        <span class="pulse ${connected ? "" : "offline"}"></span>
        <span id="presence-count">${presenceText()}</span>
      </button>
      <button class="button button-dark" data-action="share">Скопировать ссылку</button>
    </header>

    <main id="top">
      <section class="hero hero-compact">
        <div class="hero-copy">
          <div class="hero-kicker">Одна рабочая страница на всё выступление · около 30 участников</div>
          <h1>Встреча с<br><em>Альбертом Сафиным.</em></h1>
          <p class="hero-lead">
            Начните с четырёх главных запросов, затем открывайте уточнения по темам. Отметки и заметки сразу видны вашей команде.
            Цитаты — дословные, пересказы помечены.
          </p>
        </div>
        <div class="hero-tools">
          <div class="progress-card progress-compact">
            <div class="progress-label"><span>Обсудили</span><strong>${stats.done}/${stats.total}</strong></div>
            <div class="progress-track"><span style="width:${stats.percent}%"></span></div>
          </div>
          <button class="brief-card brief-compact" data-action="brief">
            <span>Начать встречу</span>
            <strong>Вводная на 60 секунд →</strong>
          </button>
        </div>
      </section>

      <section class="meeting-now">
        <div class="meeting-now-head">
          <div>
            <div class="eyebrow">С этого начинаем, когда нам дадут слово</div>
            <h2>Четыре главных запроса</h2>
          </div>
          <button class="button button-dark" data-action="brief">Открыть вводную о команде</button>
        </div>
        <ol class="key-requests">
          ${keyRequests.map((request) => `<li><span></span><p>${escapeHtml(request)}</p></li>`).join("")}
        </ol>
        <p class="meeting-now-hint">Не обязательно успеть всё. Если Альберт углубится в один запрос и даст применимую практику — это уже полезный результат.</p>
      </section>

      <section class="topic-bar" aria-label="Темы встречи">
        <div class="topic-label">Все запросы из расшифровки</div>
        <div class="topic-tabs">
          ${sections
            .map((section) => {
              const sectionItems = allItems.filter((item) => item.sectionId === section.id);
              const done = sectionItems.filter((item) => item.checked).length;
              return `
                <button class="topic-tab ${section.id === current.id ? "active" : ""}" data-section="${section.id}">
                  <span>${section.number}</span>
                  <strong>${section.short}</strong>
                  <small>${done}/${sectionItems.length}</small>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>

      <section class="workspace workspace-simple">
        <aside class="rail rail-simple">
          <div class="rail-label">Какие вопросы показать</div>
          <div class="filters filters-vertical" role="group" aria-label="Какие вопросы показать">
            ${[
              ["all", "Все вопросы"],
              ["open", "Осталось обсудить"],
              ["done", "Уже обсудили"],
            ]
              .map(
                ([value, label]) =>
                  `<button class="${filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`,
              )
              .join("")}
          </div>
          <div class="rail-actions">
            <button data-action="export">Скачать итог</button>
            <label class="import-label">Загрузить итог<input type="file" accept="application/json" data-action="import"></label>
            <button data-action="sources">Источники</button>
          </div>
        </aside>

        <section class="content">
          <div class="section-head">
            <span>${current.number}</span>
            <div>
              <div class="eyebrow">Тема встречи</div>
              <h2>${current.title}</h2>
              <p>${current.summary}</p>
            </div>
          </div>

          <div class="quote-strip">
            ${current.quotes
              .slice(0, showAllQuotes ? current.quotes.length : 1)
              .map(
                (quote) => `
                  <blockquote>
                    <p>«${quote.text}»</p>
                    <footer>${quote.author} · ${quote.time}</footer>
                  </blockquote>
                `,
              )
              .join("")}
            <button data-action="quotes">${showAllQuotes ? "Свернуть цитаты" : `Показать ещё ${current.quotes.length - 1}`}</button>
          </div>

          <div class="questions-toolbar">
            <h3>${filter === "all" ? "Все вопросы" : filter === "open" ? "Осталось обсудить" : "Уже обсудили"}</h3>
            <span>${currentItems.length} шт.</span>
          </div>

          <div class="question-list">
            ${
              currentItems.length
                ? currentItems.map(renderQuestion).join("")
                : `<div class="empty">Здесь пока ничего нет.</div>`
            }
          </div>

          <div class="session-notes">
            <label for="session-notes">Общий вывод по теме</label>
            <textarea id="session-notes" placeholder="Что команда решила сделать после встречи…">${escapeHtml(meta.get(`notes:${current.id}`) || "")}</textarea>
          </div>
        </section>
      </section>
    </main>

    <button class="new-request-fab" data-action="new-request" aria-label="Добавить новый запрос">
      <span>+</span><strong>Новый запрос</strong>
    </button>

    <footer class="footer footer-simple">
      <p>Одна общая доска для всех посетителей этой страницы.</p>
      <p>Публичный прототип: не записывайте секретные сведения.</p>
    </footer>

    <div id="cursor-layer" aria-hidden="true"></div>
    <div id="toast" role="status" aria-live="polite"></div>
    <dialog id="dialog">
      <button class="dialog-close" data-action="close" aria-label="Закрыть">×</button>
      <div id="dialog-content"></div>
    </dialog>
  `;

  bindEvents();
  renderCursors();
}

function renderQuestion(item) {
  const itemNotes = noteList(item.id);
  return `
    <article class="question ${item.checked ? "checked" : ""}" data-id="${escapeHtml(item.id)}">
      <label class="check">
        <input type="checkbox" ${item.checked ? "checked" : ""} data-check="${escapeHtml(item.id)}">
        <span></span>
      </label>
      <div class="question-body">
        <div class="question-meta">${item.custom ? `Запрос от ${escapeHtml(item.createdByName || "команды")}` : "Вопрос к Альберту"}</div>
        <h4>${escapeHtml(item.text)}</h4>
        ${item.why ? `<p><strong>Зачем:</strong> ${escapeHtml(item.why)}</p>` : ""}
        ${item.checkedBy ? `<div class="checked-by">Отметил: ${escapeHtml(item.checkedBy)}</div>` : ""}

        <div class="team-notes">
          ${
            itemNotes.length
              ? itemNotes
                  .map(
                    (note) => `
                      <div class="team-note" style="--note-color:${escapeHtml(note.color)}">
                        <div><strong>${escapeHtml(note.author)}</strong><time>${formatTime(note.createdAt)}</time></div>
                        <p>${escapeHtml(note.text)}</p>
                        ${
                          note.authorId === participant.id
                            ? `<button data-delete-note="${escapeHtml(note.id)}" aria-label="Удалить заметку">×</button>`
                            : ""
                        }
                      </div>
                    `,
                  )
                  .join("")
              : `<span class="no-notes">Пока нет заметок команды</span>`
          }
          <form class="note-form" data-note-form="${escapeHtml(item.id)}">
            <input name="note" maxlength="500" placeholder="Добавить заметку от ${escapeHtml(participant.name)}…" required>
            <button aria-label="Отправить заметку">↑</button>
          </form>
        </div>
      </div>
      ${
        item.custom && item.createdBy === participant.id
          ? `<button class="delete" data-delete="${escapeHtml(item.id)}" aria-label="Удалить запрос">×</button>`
          : ""
      }
    </article>
  `;
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat("ru", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function presenceText() {
  if (!provider) return "локальный режим";
  prunePeople();
  const count = people.size;
  if (!connected) return "переподключаемся…";
  return `${count} ${count === 1 ? "участник" : count < 5 ? "участника" : "участников"}`;
}

function updatePresence() {
  const node = document.querySelector("#presence-count");
  if (node) node.textContent = presenceText();
  const pulse = document.querySelector(".pulse");
  if (pulse) pulse.classList.toggle("offline", !connected);
}

function updateItem(id, patch) {
  const item = items.get(id);
  if (!item) return;
  items.set(id, { ...item, ...patch });
}

function bindEvents() {
  document.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      activeSection = button.dataset.section;
      showAllQuotes = false;
      render();
      document.querySelector(".workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      render();
    });
  });
  document.querySelectorAll("[data-check]").forEach((input) => {
    input.addEventListener("change", () =>
      updateItem(input.dataset.check, {
        checked: input.checked,
        checkedBy: input.checked ? participant.name : "",
      }),
    );
  });
  document.querySelectorAll("[data-note-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = form.elements.note.value.trim();
      if (!text) return;
      const id = crypto.randomUUID();
      notes.set(id, {
        id,
        itemId: form.dataset.noteForm,
        text,
        author: participant.name,
        authorId: participant.id,
        color: participant.color,
        createdAt: new Date().toISOString(),
      });
      form.reset();
    });
  });
  document.querySelectorAll("[data-delete-note]").forEach((button) => {
    button.addEventListener("click", () => notes.delete(button.dataset.deleteNote));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.delete;
      doc.transact(() => {
        items.delete(id);
        noteList(id).forEach((note) => notes.delete(note.id));
      });
    });
  });
  document.querySelector("#session-notes")?.addEventListener("change", (event) => {
    meta.set(`notes:${activeSection}`, event.target.value);
  });
  document.querySelector('[data-action="quotes"]')?.addEventListener("click", () => {
    showAllQuotes = !showAllQuotes;
    render();
  });
  document.querySelector('[data-action="new-request"]')?.addEventListener("click", showNewRequest);
  document.querySelectorAll('[data-action="brief"]').forEach((button) => {
    button.addEventListener("click", showBrief);
  });
  document.querySelector('[data-action="sources"]')?.addEventListener("click", showSources);
  document.querySelector('[data-action="share"]')?.addEventListener("click", share);
  document.querySelector('[data-action="identity"]')?.addEventListener("click", showIdentity);
  document.querySelector('[data-action="export"]')?.addEventListener("click", exportState);
  document.querySelector('[data-action="import"]')?.addEventListener("change", importState);
  document.querySelector('[data-action="close"]')?.addEventListener("click", closeDialog);
}

function openDialog(content, className = "") {
  const dialog = document.querySelector("#dialog");
  dialog.className = className;
  document.querySelector("#dialog-content").innerHTML = content;
  dialog.showModal();
}

function closeDialog() {
  document.querySelector("#dialog")?.close();
}

function showNewRequest() {
  openDialog(
    `
      <div class="dialog-kicker">Новый пункт на общей доске</div>
      <h2>Что ещё спросить?</h2>
      <form id="request-form" class="request-form">
        <label>Тема
          <select name="section">
            ${sections
              .map(
                (section) =>
                  `<option value="${section.id}" ${section.id === activeSection ? "selected" : ""}>${section.short}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label>Запрос
          <textarea name="question" maxlength="280" placeholder="Например: как понять, что практика прижилась?" required autofocus></textarea>
        </label>
        <button class="button button-accent">Добавить для всех</button>
      </form>
    `,
    "request-dialog",
  );
  const form = document.querySelector("#request-form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = `custom-${crypto.randomUUID()}`;
    const sectionId = form.elements.section.value;
    items.set(id, {
      id,
      sectionId,
      text: form.elements.question.value.trim(),
      why: "",
      checked: false,
      checkedBy: "",
      custom: true,
      createdBy: participant.id,
      createdByName: participant.name,
    });
    activeSection = sectionId;
    filter = "all";
    closeDialog();
    toast("Запрос добавлен для всей команды");
  });
  setTimeout(() => form.elements.question.focus(), 50);
}

function showBrief() {
  openDialog(`
    <div class="dialog-kicker">Можно прочитать вслух</div>
    <h2>Вводная на 60 секунд</h2>
    <ol class="brief-list">${openingScript.map((line) => `<li>${line}</li>`).join("")}</ol>
    <button class="button button-accent" data-copy-brief>Скопировать вводную</button>
  `);
  document.querySelector("[data-copy-brief]").addEventListener("click", async () => {
    await navigator.clipboard.writeText(openingScript.join("\n\n"));
    toast("Вводная скопирована");
  });
}

function showSources() {
  openDialog(`
    <div class="dialog-kicker">Проверено по открытым материалам</div>
    <h2>Почему эти вопросы подходят Альберту</h2>
    <div class="source-list">
      ${sources
        .map(
          (source) => `
            <a href="${source.url}" target="_blank" rel="noreferrer">
              <strong>${source.title}</strong><span>${source.note}</span><i>↗</i>
            </a>
          `,
        )
        .join("")}
    </div>
  `);
}

function showIdentity() {
  openDialog(`
    <div class="dialog-kicker">Ваши заметки и указатель</div>
    <h2>Как вас подписать?</h2>
    <form id="identity-form" class="identity-form">
      <input name="name" maxlength="40" value="${escapeHtml(participant.name)}" required>
      <button class="button button-accent">Сохранить</button>
    </form>
  `);
  document.querySelector("#identity-form").addEventListener("submit", (event) => {
    event.preventDefault();
    participant.name = event.currentTarget.elements.name.value.trim();
    localStorage.setItem("coach-name", participant.name);
    publishPresence();
    closeDialog();
    toast("Имя сохранено");
  });
}

async function share() {
  const url = `${location.origin}${location.pathname}`;
  await navigator.clipboard.writeText(url);
  toast("Короткая ссылка скопирована");
}

function exportState() {
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      items: itemList(),
      notes: Array.from(notes.values()),
      meta: Object.fromEntries(meta.entries()),
    },
    null,
    2,
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  link.download = `vstrecha-s-safinym-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importState(event) {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    doc.transact(() => {
      payload.items?.forEach((item) => items.set(item.id, item));
      payload.notes?.forEach((note) => notes.set(note.id, note));
      Object.entries(payload.meta || {}).forEach(([key, value]) => meta.set(key, value));
    });
    toast("Итог загружен для всей команды");
  } catch {
    toast("Не удалось прочитать файл");
  }
}

function toast(message) {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2200);
}

function renderCursors() {
  const layer = document.querySelector("#cursor-layer");
  if (!layer || !provider) return;
  prunePeople();
  layer.innerHTML = Array.from(people.values())
    .filter((person) => person.id !== participant.id && person.cursor)
    .map(
      (person) => `
        <div class="remote-cursor" data-client="${escapeHtml(person.id)}" style="transform:translate(${person.cursor.x}px,${person.cursor.y}px);--cursor:${person.color}">
          <svg viewBox="0 0 24 24"><path d="M4 2l15 9-7 2-3 7L4 2z"/></svg>
          <span>${escapeHtml(person.name)}</span>
        </div>
      `,
    )
    .join("");
}

let cursorFrame;
window.addEventListener("pointermove", (event) => {
  if (!connected || cursorFrame) return;
  cursorFrame = requestAnimationFrame(() => {
    publishPresence({ x: event.clientX, y: event.clientY });
    cursorFrame = null;
  });
});

items.observe(() => {
  persist();
  render();
});
notes.observe(() => {
  persist();
  render();
});
meta.observe(() => persist());
doc.on("update", (update, origin) => {
  if (origin !== "mqtt") publishState(update);
});

window.addEventListener("beforeunload", () => {
  if (!provider) return;
  provider.publish(
    PRESENCE_TOPIC,
    JSON.stringify({ ...participant, online: false, lastSeen: Date.now() }),
    { qos: 0, retain: true },
  );
});

render();
connect();
