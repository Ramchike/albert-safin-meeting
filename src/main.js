import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { openingScript, sections, sources } from "./content.js";
import "./style.css";

const params = new URLSearchParams(location.search);
const room = params.get("room") || crypto.randomUUID().slice(0, 8);
if (!params.get("room")) {
  params.set("room", room);
  history.replaceState(null, "", `${location.pathname}?${params}${location.hash}`);
}

const palette = ["#F05D3D", "#4766E7", "#B159C7", "#278B70", "#CB7D13"];
const participant = {
  name: localStorage.getItem("coach-name") || `Участник ${Math.floor(Math.random() * 90 + 10)}`,
  color: localStorage.getItem("coach-color") || palette[Math.floor(Math.random() * palette.length)],
};

const doc = new Y.Doc();
const items = doc.getMap("items");
const meta = doc.getMap("meta");
let provider;
let realtime = false;

const defaults = sections.flatMap((section) =>
  section.questions.map((question) => ({
    ...question,
    sectionId: section.id,
    custom: false,
  })),
);

function readSnapshot() {
  const encoded = params.get("snapshot");
  if (!encoded) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(encoded))));
  } catch {
    return null;
  }
}

function initialState() {
  const snapshot = readSnapshot();
  const local = localStorage.getItem(`coach-state:${room}`);
  if (snapshot?.items) return snapshot;
  if (local) {
    try {
      return JSON.parse(local);
    } catch {
      // Fall through to defaults.
    }
  }
  return {
    items: defaults.map((item) => ({ ...item, checked: false, notes: "" })),
    sessionNotes: "",
  };
}

doc.transact(() => {
  const state = initialState();
  state.items.forEach((item) => {
    if (!items.has(item.id)) items.set(item.id, item);
  });
  if (!meta.has("sessionNotes")) meta.set("sessionNotes", state.sessionNotes || "");
});

try {
  provider = new WebrtcProvider(`safin-meeting-${room}`, doc);
  provider.awareness.setLocalStateField("user", participant);
  realtime = true;
} catch (error) {
  console.warn("Совместный режим недоступен, продолжаем локально.", error);
}

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

function persist() {
  const state = {
    items: itemList(),
    sessionNotes: meta.get("sessionNotes") || "",
  };
  localStorage.setItem(`coach-state:${room}`, JSON.stringify(state));
}

function progress() {
  const all = itemList();
  const done = all.filter((item) => item.checked).length;
  return { done, total: all.length, percent: all.length ? Math.round((done / all.length) * 100) : 0 };
}

function render() {
  const current = sections.find((section) => section.id === activeSection) || sections[0];
  const allItems = itemList();
  const currentItems = allItems.filter(
    (item) =>
      item.sectionId === current.id &&
      (filter === "all" || (filter === "open" ? !item.checked : item.checked)),
  );
  const stats = progress();
  const peers = realtime ? provider.awareness.getStates().size : 1;

  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#top" aria-label="К началу">
        <span class="brand-mark">НГ</span>
        <span>Не потерять главное</span>
      </a>
      <button class="presence" data-action="identity" title="Участники в этой комнате">
        <span class="pulse"></span>
        <span id="presence-count">${realtime ? `${peers} в комнате` : "локальный режим"}</span>
      </button>
      <button class="button button-dark" data-action="share">Поделиться</button>
    </header>

    <main id="top">
      <section class="hero">
        <div class="hero-kicker">Шпаргалка к встрече · комната ${escapeHtml(room)}</div>
        <h1>Не получить ответы.<br><em>Научиться действовать.</em></h1>
        <p class="hero-lead">
          Вопросы к Альберту Сафину, собранные из ваших слов. Цитаты — дословные;
          пересказы и выводы — явно помечены.
        </p>
        <div class="hero-grid">
          <div class="progress-card">
            <div class="progress-label"><span>Пройдено</span><strong>${stats.done}/${stats.total}</strong></div>
            <div class="progress-track"><span style="width:${stats.percent}%"></span></div>
            <p>${stats.percent}% вопросов отмечено</p>
          </div>
          <button class="brief-card" data-action="brief">
            <span>Вводная на 60 секунд</span>
            <strong>Открыть текст →</strong>
          </button>
        </div>
      </section>

      <section class="workspace">
        <aside class="rail">
          <div class="rail-label">Маршрут разговора</div>
          <nav>
            ${sections
              .map((section) => {
                const sectionItems = allItems.filter((item) => item.sectionId === section.id);
                const done = sectionItems.filter((item) => item.checked).length;
                return `
                  <button class="nav-item ${section.id === current.id ? "active" : ""}" data-section="${section.id}">
                    <span>${section.number}</span>
                    <div><strong>${section.short}</strong><small>${done}/${sectionItems.length}</small></div>
                  </button>
                `;
              })
              .join("")}
          </nav>
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
            <button data-action="quotes">${showAllQuotes ? "Свернуть цитаты" : `Ещё ${current.quotes.length - 1} цитаты`}</button>
          </div>

          <div class="questions-toolbar">
            <h3>Что спросить</h3>
            <div class="filters" role="group" aria-label="Фильтр вопросов">
              ${[
                ["all", "Все"],
                ["open", "Открытые"],
                ["done", "Отмеченные"],
              ]
                .map(
                  ([value, label]) =>
                    `<button class="${filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`,
                )
                .join("")}
            </div>
          </div>

          <div class="question-list">
            ${
              currentItems.length
                ? currentItems
                    .map(
                      (item) => `
                        <article class="question ${item.checked ? "checked" : ""}" data-id="${escapeHtml(item.id)}">
                          <label class="check">
                            <input type="checkbox" ${item.checked ? "checked" : ""} data-check="${escapeHtml(item.id)}">
                            <span></span>
                          </label>
                          <div class="question-body">
                            <div class="question-meta">${item.custom ? "Добавлено командой" : "Вопрос к Альберту"}</div>
                            <h4>${escapeHtml(item.text)}</h4>
                            ${item.why ? `<p><strong>Зачем:</strong> ${escapeHtml(item.why)}</p>` : ""}
                            <textarea data-notes="${escapeHtml(item.id)}" placeholder="Записать ответ или мысль…">${escapeHtml(item.notes || "")}</textarea>
                          </div>
                          ${item.custom ? `<button class="delete" data-delete="${escapeHtml(item.id)}" aria-label="Удалить вопрос">×</button>` : ""}
                        </article>
                      `,
                    )
                    .join("")
                : `<div class="empty">Здесь пока нет вопросов с таким состоянием.</div>`
            }
          </div>

          <form class="add-form" id="add-form">
            <label for="new-question">Добавить свой вопрос в эту тему</label>
            <div>
              <input id="new-question" name="question" maxlength="280" placeholder="Например: как понять, что…" required>
              <button class="button button-accent">Добавить</button>
            </div>
          </form>

          <div class="session-notes">
            <label for="session-notes">Общий вывод по теме</label>
            <textarea id="session-notes" placeholder="Что решили сделать после встречи…">${escapeHtml(meta.get(`notes:${current.id}`) || "")}</textarea>
          </div>
        </section>
      </section>

      <section class="method-note">
        <div>
          <span class="eyebrow">Как собрана шпаргалка</span>
          <h2>От слов команды — к наблюдаемому действию</h2>
        </div>
        <div class="method-grid">
          <p><strong>1. Не додумывать.</strong> Цитаты сохранены отдельно от пересказа. Субъективные оценки команды названы гипотезами.</p>
          <p><strong>2. Уточнить результат.</strong> Каждый широкий запрос превращён в вопрос про ситуацию, поведение и признак «стало лучше».</p>
          <p><strong>3. Унести практику.</strong> Финал встречи — две практики на 30 дней и дата разбора, а не список вдохновляющих идей.</p>
        </div>
      </section>
    </main>

    <footer class="footer">
      <p>Собрано для живого разговора. Не психологическое заключение и не дословный протокол встречи.</p>
      <button data-action="reset">Сбросить мои отметки</button>
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

function updateItem(id, patch) {
  const item = items.get(id);
  if (!item) return;
  items.set(id, { ...item, ...patch });
  persist();
}

function bindEvents() {
  document.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      activeSection = button.dataset.section;
      showAllQuotes = false;
      render();
      scrollTo({ top: document.querySelector(".workspace").offsetTop - 70, behavior: "smooth" });
    });
  });
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      render();
    });
  });
  document.querySelectorAll("[data-check]").forEach((input) => {
    input.addEventListener("change", () => updateItem(input.dataset.check, { checked: input.checked }));
  });
  document.querySelectorAll("[data-notes]").forEach((textarea) => {
    textarea.addEventListener("change", () => updateItem(textarea.dataset.notes, { notes: textarea.value }));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      items.delete(button.dataset.delete);
      persist();
    });
  });

  document.querySelector("#add-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.question;
    const id = `custom-${crypto.randomUUID()}`;
    items.set(id, {
      id,
      sectionId: activeSection,
      text: input.value.trim(),
      why: "",
      checked: false,
      notes: "",
      custom: true,
    });
    input.value = "";
    persist();
  });

  document.querySelector("#session-notes")?.addEventListener("change", (event) => {
    meta.set(`notes:${activeSection}`, event.target.value);
    persist();
  });
  document.querySelector('[data-action="quotes"]')?.addEventListener("click", () => {
    showAllQuotes = !showAllQuotes;
    render();
  });
  document.querySelector('[data-action="brief"]')?.addEventListener("click", showBrief);
  document.querySelector('[data-action="sources"]')?.addEventListener("click", showSources);
  document.querySelector('[data-action="share"]')?.addEventListener("click", share);
  document.querySelector('[data-action="identity"]')?.addEventListener("click", showIdentity);
  document.querySelector('[data-action="export"]')?.addEventListener("click", exportState);
  document.querySelector('[data-action="import"]')?.addEventListener("change", importState);
  document.querySelector('[data-action="reset"]')?.addEventListener("click", resetState);
  document.querySelector('[data-action="close"]')?.addEventListener("click", closeDialog);
}

function openDialog(content) {
  document.querySelector("#dialog-content").innerHTML = content;
  document.querySelector("#dialog").showModal();
}

function closeDialog() {
  document.querySelector("#dialog")?.close();
}

function showBrief() {
  openDialog(`
    <div class="dialog-kicker">Можно прочитать вслух</div>
    <h2>Вводная на 60 секунд</h2>
    <ol class="brief-list">
      ${openingScript.map((line) => `<li>${line}</li>`).join("")}
    </ol>
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
    <p class="dialog-lead">В его материалах есть именно ваши темы: переносимость неопределённости, наблюдаемая точка Б, граница между развитием людей и системной проблемой, стратегическое мышление.</p>
    <div class="source-list">
      ${sources
        .map(
          (source) => `
            <a href="${source.url}" target="_blank" rel="noreferrer">
              <strong>${source.title}</strong>
              <span>${source.note}</span>
              <i>↗</i>
            </a>
          `,
        )
        .join("")}
    </div>
  `);
}

function showIdentity() {
  openDialog(`
    <div class="dialog-kicker">Совместная комната</div>
    <h2>Как вас подписать?</h2>
    <p class="dialog-lead">Это имя увидят рядом с вашим указателем мыши только участники комнаты.</p>
    <form id="identity-form" class="identity-form">
      <input name="name" maxlength="40" value="${escapeHtml(participant.name)}" required>
      <button class="button button-accent">Сохранить</button>
    </form>
  `);
  document.querySelector("#identity-form").addEventListener("submit", (event) => {
    event.preventDefault();
    participant.name = event.currentTarget.elements.name.value.trim();
    localStorage.setItem("coach-name", participant.name);
    provider?.awareness.setLocalStateField("user", participant);
    closeDialog();
    toast("Имя сохранено");
  });
}

async function share() {
  const state = {
    items: itemList(),
    sessionNotes: meta.get("sessionNotes") || "",
  };
  const snapshot = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
  const url = new URL(location.href);
  url.searchParams.set("room", room);
  url.searchParams.set("snapshot", snapshot);
  await navigator.clipboard.writeText(url.toString());
  toast("Ссылка на общую комнату скопирована");
}

function exportState() {
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      room,
      items: itemList(),
      notes: Object.fromEntries(meta.entries()),
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
      Object.entries(payload.notes || {}).forEach(([key, value]) => meta.set(key, value));
    });
    persist();
    toast("Итог загружен");
  } catch {
    toast("Не удалось прочитать файл");
  }
}

function resetState() {
  if (!confirm("Снять все отметки и удалить заметки в этой комнате?")) return;
  doc.transact(() => {
    Array.from(items.keys()).forEach((id) => items.delete(id));
    defaults.forEach((item) => items.set(item.id, { ...item, checked: false, notes: "" }));
    Array.from(meta.keys()).forEach((key) => meta.delete(key));
  });
  persist();
  toast("Отметки сброшены");
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
  const ownClient = doc.clientID;
  layer.innerHTML = Array.from(provider.awareness.getStates().entries())
    .filter(([clientId, state]) => clientId !== ownClient && state.cursor && state.user)
    .map(
      ([clientId, state]) => `
        <div class="remote-cursor" data-client="${clientId}" style="transform:translate(${state.cursor.x}px,${state.cursor.y}px);--cursor:${state.user.color}">
          <svg viewBox="0 0 24 24"><path d="M4 2l15 9-7 2-3 7L4 2z"/></svg>
          <span>${escapeHtml(state.user.name)}</span>
        </div>
      `,
    )
    .join("");
}

let cursorFrame;
window.addEventListener("pointermove", (event) => {
  if (!provider || cursorFrame) return;
  cursorFrame = requestAnimationFrame(() => {
    provider.awareness.setLocalStateField("cursor", { x: event.clientX, y: event.clientY });
    cursorFrame = null;
  });
});

items.observe(() => {
  persist();
  render();
});
meta.observe(() => {
  persist();
});
provider?.awareness.on("change", () => {
  const count = document.querySelector("#presence-count");
  if (count) count.textContent = `${provider.awareness.getStates().size} в комнате`;
  renderCursors();
});

render();
