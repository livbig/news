// Фронтенд агрегатора: без сборки и зависимостей. Токен — из ?token= и localStorage.
const params = new URLSearchParams(location.search);
const token = params.get('token') || localStorage.getItem('news_token') || '';
if (params.get('token')) localStorage.setItem('news_token', params.get('token'));

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const when = (iso) => {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const date = new Date(ms);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

function toast(message, error = false) {
  const line = $('stats-line');
  line.textContent = message;
  line.className = error ? 'error-text' : '';
  setTimeout(loadState, 1500);
}

let busy = false;
async function withBusy(button, run) {
  if (busy) return;
  busy = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    await run();
  } catch (error) {
    toast(String(error.message || error), true);
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = label;
  }
}

async function loadState() {
  try {
    const state = await api('/api/state');
    $('last-collect').textContent = when(state.lastCollectAt);
    $('last-analyze').textContent = when(state.lastAnalyzeAt);
    $('last-digest').textContent = when(state.lastDigestAt);
    $('next-slot').textContent = state.nextSlot ? `${state.nextSlot.time} (${when(new Date(state.nextSlot.ms).toISOString())})` : '—';
    $('model').textContent = state.model;
    const stats = state.stats || {};
    const analysis = state.analysis || {};
    $('stats-line').textContent =
      `источников ${stats.sources ?? 0} · новостей ${stats.items ?? 0} · за сутки ${stats.fresh ?? 0} · разобрано ${analysis.analyzed ?? 0}/${analysis.total ?? 0} · сводок ${stats.digests ?? 0}`;
    $('who').textContent = `слоты ${state.sendTimes.join(' / ')}`;
  } catch (error) {
    toast(`нет связи со службой: ${error.message}`, true);
  }
}

async function loadDigests() {
  const data = await api('/api/digests?limit=30');
  const list = $('digested');
  list.innerHTML = '';
  if (!data.digests.length) {
    list.innerHTML = '<li class="muted">Сводок пока нет.</li>';
    return;
  }
  for (const digest of data.digests) {
    const li = document.createElement('li');
    const kind = digest.kind === 'scheduled' ? (digest.slot || 'плановая') : 'ручная';
    li.innerHTML = `<b>#${digest.id}</b> ${esc(when(digest.createdAt))} <span class="meta">${esc(kind)} · ${digest.itemCount} пунктов</span>`;
    li.onclick = () => openDigest(digest.id);
    list.append(li);
  }
  openDigest(data.digests[0].id);
}

// Сводка — наш HTML, но в ней бывают заголовки из внешних фидов: режем опасное.
function safeHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

async function openDigest(id) {
  const data = await api(`/api/digests/${id}`);
  const view = $('digest-view');
  view.classList.remove('muted');
  view.innerHTML = safeHtml(data.digest.messageText);
}

async function loadSources() {
  const data = await api('/api/sources');
  const body = $('sources').querySelector('tbody');
  body.innerHTML = '';
  for (const source of data.sources) {
    const tr = document.createElement('tr');
    const status = source.status === 'error' ? `<span class="error-text" title="${esc(source.statusMsg || '')}">ошибка</span>` : 'ок';
    tr.innerHTML = `
      <td>${esc(source.title)}<div class="muted small">${esc(source.url)}</div></td>
      <td>${esc(source.kind)}</td>
      <td>${source.total}</td>
      <td>${source.fresh}</td>
      <td>${status}</td>
      <td>
        <button class="btn" data-toggle="${source.id}" data-enabled="${source.enabled ? 0 : 1}">${source.enabled ? 'Выключить' : 'Включить'}</button>
        <button class="btn btn-danger" data-delete="${source.id}">Удалить</button>
      </td>`;
    body.append(tr);
  }
  $('sources-hint').textContent = `Всего ${data.sources.length}; ошибки видны по статусу, подробности — в статусе источника.`;
  body.querySelectorAll('[data-toggle]').forEach((button) => {
    button.onclick = async () => {
      await api(`/api/sources/${button.dataset.toggle}`, { method: 'POST', body: JSON.stringify({ enabled: button.dataset.enabled === '1' }) });
      await loadSources();
    };
  });
  body.querySelectorAll('[data-delete]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('Удалить источник вместе с его новостями?')) return;
      await api(`/api/sources/${button.dataset.delete}`, { method: 'DELETE' });
      await loadSources();
      await loadState();
    };
  });
}

async function loadInterests() {
  const data = await api('/api/interests');
  const list = $('interests');
  list.innerHTML = '';
  for (const term of data.terms) {
    const li = document.createElement('li');
    li.innerHTML = `${esc(term)} <button title="убрать">×</button>`;
    li.querySelector('button').onclick = async () => {
      await api('/api/interests', { method: 'POST', body: JSON.stringify({ action: 'remove', terms: [term] }) });
      await loadInterests();
      await loadState();
    };
    list.append(li);
  }
  $('interests-text').textContent = data.text || 'Профиль пуст — будет использован профиль по умолчанию.';
}

$('source-form').onsubmit = async (event) => {
  event.preventDefault();
  const url = $('source-url').value.trim();
  const title = $('source-title').value.trim();
  if (!url) return;
  try {
    await api('/api/sources', { method: 'POST', body: JSON.stringify({ url, title }) });
    $('source-url').value = '';
    $('source-title').value = '';
    await loadSources();
    toast('источник добавлен');
  } catch (error) {
    toast(error.message, true);
  }
};

$('interest-form').onsubmit = async (event) => {
  event.preventDefault();
  const term = $('interest-term').value.trim();
  if (!term) return;
  await api('/api/interests', { method: 'POST', body: JSON.stringify({ terms: [term] }) });
  $('interest-term').value = '';
  await loadInterests();
  toast('тема добавлена, источник Google News создан');
};

$('search-form').onsubmit = async (event) => {
  event.preventDefault();
  const query = $('search-q').value.trim();
  if (!query) return;
  const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
  const list = $('search-results');
  list.innerHTML = data.results.length ? '' : '<li class="muted">Ничего не нашлось.</li>';
  for (const row of data.results) {
    const li = document.createElement('li');
    li.innerHTML = `<a href="${esc(row.url)}" target="_blank" rel="noopener">${esc(row.title)}</a><div class="muted small">${esc(row.gist || '')}</div>`;
    list.append(li);
  }
};

$('collect').onclick = (event) => withBusy(event.target, async () => {
  const result = await api('/api/collect', { method: 'POST', body: '{}' });
  toast(`сбор: +${result.added} новостей, источников ${result.sources}, ошибок ${result.errors.length}`);
  await loadSources();
});

$('digest').onclick = (event) => withBusy(event.target, async () => {
  const result = await api('/api/digest', { method: 'POST', body: JSON.stringify({ send: true }) });
  toast(result.empty ? 'новостей за сутки нет — так и сказано в чате' : `сводка #${result.digestId}: ${result.items} пунктов отправлено`);
  await loadDigests();
  await loadState();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.toggle('active', other === tab));
    document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'sources') loadSources();
    if (tab.dataset.tab === 'interests') loadInterests();
  };
});

if (!token) {
  document.body.insertAdjacentHTML('afterbegin', '<p class="error-text" style="padding:12px 20px">Открой страницу с токеном: /?token=…</p>');
} else {
  loadState();
  loadDigests();
  setInterval(loadState, 30_000);
}
