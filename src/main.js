import * as Y from "yjs";
import mqtt from "mqtt";
import { openingScript, sections, sources } from "./content.js";
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
  if (initialized) {
    migrateContent();
    return;
  }
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
  migrateContent();
  render();
}

function migrateContent() {
  const legacySections = {
    team: "program",
    conflict: "program",
    result: "program",
    scale: "program",
    certainty: "program",
    uncertainty: "program",
  };

  doc.transact(() => {
    defaults.forEach((next) => {
      const current = items.get(next.id);
      if (!current) {
        items.set(next.id, next);
        return;
      }
      if (
        current.sectionId !== next.sectionId ||
        current.text !== next.text ||
        current.why !== next.why
      ) {
        items.set(next.id, {
          ...current,
          sectionId: next.sectionId,
          text: next.text,
          why: next.why,
        });
      }
    });

    items.forEach((item, id) => {
      if (!item.custom || !legacySections[item.sectionId]) return;
      items.set(id, { ...item, sectionId: legacySections[item.sectionId] });
    });
  }, "content-migration");
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
  const validSections = new Set(sections.map((section) => section.id));
  const all = itemList().filter((item) => validSections.has(item.sectionId));
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

  const allItems = itemList();
  const stats = progress();
  const visibleItems = (sectionId) =>
    allItems.filter(
      (item) =>
        item.sectionId === sectionId &&
        (filter === "all" || (filter === "open" ? !item.checked : item.checked)),
    );

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
      <section class="meeting-header">
        <div>
          <div class="hero-kicker">Бриф к программе · отправляем за две недели до выступления</div>
          <h1>Запросы к программе Альберта Сафина</h1>
          <p>Пять направлений, которые отправляем за две недели до выступления.</p>
        </div>
        <div class="meeting-header-actions">
          <div class="mini-progress">
            <span>Согласовано</span><strong>${stats.done}/${stats.total}</strong>
            <i><b style="width:${stats.percent}%"></b></i>
          </div>
        </div>
      </section>

      <section class="team-context">
        <div class="team-context-head">
          <div><span>Контекст для Альберта</span><h2>Коротко о команде</h2></div>
          <div class="board-actions">
            <button data-action="export">Скачать бриф</button>
            <button data-action="sources">Источники</button>
          </div>
        </div>
        ${openingScript.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
      </section>

      <section class="zones-grid">
        ${sections
          .map((section) => {
            const sectionItems = allItems.filter((item) => item.sectionId === section.id);
            const shown = visibleItems(section.id);
            const done = sectionItems.filter((item) => item.checked).length;
            const quote = section.quotes[0];
            return `
              <section class="zone zone-${section.id}">
                <header class="zone-head">
                  <div>
                    <span>${section.number}</span>
                    <h2>${section.title}</h2>
                    <p>${section.summary}</p>
                  </div>
                  <strong>${done}/${sectionItems.length}</strong>
                </header>
                <div class="compact-question-list">
                  ${
                    shown.length
                      ? shown.map(renderQuestion).join("")
                      : `<div class="empty">В этой зоне ничего не найдено.</div>`
                  }
                </div>
                <label class="zone-summary">
                  <span>Комментарий к брифу</span>
                  <textarea data-zone-notes="${section.id}" placeholder="Что ещё важно учесть Альберту…">${escapeHtml(meta.get(`notes:${section.id}`) || "")}</textarea>
                </label>
              </section>
            `;
          })
          .join("")}
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
    <article class="question program-request ${item.checked ? "checked" : ""}" data-id="${escapeHtml(item.id)}">
      <label class="check program-check" title="Согласовать запрос">
        <input type="checkbox" ${item.checked ? "checked" : ""} data-check="${escapeHtml(item.id)}">
        <span></span>
      </label>
      <div class="question-body">
        ${item.custom ? `<div class="question-meta">Добавил ${escapeHtml(item.createdByName || "участник")}</div>` : ""}
        <h3>${escapeHtml(item.title || "Дополнительный запрос")}</h3>
        <p class="program-request-text">${escapeHtml(item.text)}</p>
        ${
          item.context || item.outcome
            ? `<div class="program-request-details">
                <div><strong>Контекст</strong><p>${escapeHtml(item.context || "")}</p></div>
                <div><strong>Результат программы</strong><p>${escapeHtml(item.outcome || "")}</p></div>
              </div>`
            : ""
        }
        ${
          item.quote
            ? `<blockquote class="request-quote">«${escapeHtml(item.quote)}» <small>${escapeHtml(item.quoteAuthor || "")}</small></blockquote>
               <div class="request-source">${escapeHtml(item.why || "")}</div>`
            : ""
        }
        <details class="team-notes team-notes-collapsed" ${itemNotes.length ? "open" : ""}>
          <summary>${itemNotes.length ? `${itemNotes.length} комментариев` : "Добавить комментарий"}</summary>
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
              : ""
          }
          <form class="note-form" data-note-form="${escapeHtml(item.id)}">
            <input name="note" maxlength="500" placeholder="Комментарий от ${escapeHtml(participant.name)}…" required>
            <button aria-label="Отправить комментарий">↑</button>
          </form>
        </details>
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
  document.querySelectorAll("[data-zone-notes]").forEach((field) => {
    field.addEventListener("change", () => {
      meta.set(`notes:${field.dataset.zoneNotes}`, field.value);
    });
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
      <div class="dialog-kicker">Дополнение к брифу</div>
      <h2>Новый запрос к программе</h2>
      <form id="request-form" class="request-form">
        <input type="hidden" name="section" value="${sections[0].id}">
        <label>Запрос
          <textarea name="question" maxlength="500" placeholder="Что Альберт должен помочь команде понять или изменить?" required autofocus></textarea>
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
      title: "Дополнительный запрос",
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
    <div class="dialog-kicker">Контекст для подготовки программы</div>
    <h2>Коротко о команде</h2>
    <ol class="brief-list">${openingScript.map((line) => `<li>${line}</li>`).join("")}</ol>
    <button class="button button-accent" data-copy-brief>Скопировать контекст</button>
  `);
  document.querySelector("[data-copy-brief]").addEventListener("click", async () => {
    await navigator.clipboard.writeText(openingScript.join("\n\n"));
    toast("Контекст скопирован");
  });
}

function showSources() {
  openDialog(`
    <div class="dialog-kicker">Проверено по открытым материалам</div>
    <h2>Материалы Альберта по нашим запросам</h2>
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
meta.observe(() => {
  persist();
  render();
});
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
