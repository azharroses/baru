const state = {
  videos: [],
  config: {
    allow_local_uploads: true,
    enable_youtube: true,
    default_source: 'local'
  }
};

const rupiahDate = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeStyle: 'short'
});

function getPreferredTheme() {
  const savedTheme = localStorage.getItem('videoLibraryTheme');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = document.querySelector('#themeToggle');
  if (toggle) {
    toggle.textContent = theme === 'dark' ? 'Terang' : 'Gelap';
    toggle.setAttribute('aria-label', theme === 'dark' ? 'Gunakan tema terang' : 'Gunakan tema gelap');
  }
}

function initTheme() {
  applyTheme(getPreferredTheme());
  document.querySelector('#themeToggle')?.addEventListener('click', () => {
    const currentTheme = document.documentElement.dataset.theme || 'light';
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('videoLibraryTheme', nextTheme);
    applyTheme(nextTheme);
  });
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : {};

  if (!response.ok) {
    throw new Error(data.message || 'Request gagal.');
  }

  return data;
}

async function loadVideos() {
  state.videos = await requestJson('/api/videos');
}

async function loadConfig() {
  try {
    state.config = await requestJson('/api/config');
  } catch (error) {
    console.warn('Config tidak bisa dimuat, memakai default lokal.', error);
  }
}

function formatDate(value) {
  if (!value) return '-';
  return rupiahDate.format(new Date(value.replace(' ', 'T')));
}

function sourceLabel(sourceType) {
  if (sourceType === 'youtube') return 'YouTube';
  if (sourceType === 'google_drive') return 'Google Drive';
  return 'Lokal';
}

function getYouTubeId(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.split('/').filter(Boolean)[0];
    }
    if (url.pathname.startsWith('/shorts/')) {
      return url.pathname.split('/').filter(Boolean)[1];
    }
    if (url.pathname.startsWith('/embed/')) {
      return url.pathname.split('/').filter(Boolean)[1];
    }
    return url.searchParams.get('v');
  } catch (error) {
    return null;
  }
}

function getGoogleDriveId(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.pathname.includes('/folders/')) {
      return null;
    }
    const filePathMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    return filePathMatch?.[1] || url.searchParams.get('id');
  } catch (error) {
    return null;
  }
}

function getVideoUrlError(sourceType, urlValue) {
  if (sourceType === 'local') return '';
  const trimmedUrl = urlValue.trim();

  if (!trimmedUrl) {
    return sourceType === 'google_drive'
      ? 'URL Google Drive wajib diisi.'
      : 'URL YouTube wajib diisi.';
  }

  try {
    const url = new URL(trimmedUrl);
    if (sourceType === 'google_drive') {
      if (url.pathname.includes('/folders/')) {
        return 'Itu link folder Google Drive. Buka file videonya, klik Share, lalu salin link file video.';
      }
      if (!getGoogleDriveId(trimmedUrl)) {
        return 'URL Google Drive harus berupa link file, contoh https://drive.google.com/file/d/FILE_ID/view.';
      }
    }

    if (sourceType === 'youtube' && !getYouTubeId(trimmedUrl)) {
      return 'URL YouTube harus berupa link video, contoh https://www.youtube.com/watch?v=VIDEO_ID.';
    }
  } catch (error) {
    return 'URL harus lengkap, contoh https://drive.google.com/file/d/FILE_ID/view.';
  }

  return '';
}

function renderPlayer(video) {
  if (video.source_type === 'youtube' || video.source_type === 'google_drive') {
    return `
      <iframe
        src="${escapeHtml(video.video_path)}"
        title="${escapeHtml(video.title)}"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen
        loading="lazy"
        data-count-view
        data-id="${video.id}">
      </iframe>
    `;
  }

  const thumbnail = video.thumbnail_path
    ? `poster="${escapeHtml(video.thumbnail_path)}"`
    : '';

  return `
    <video controls preload="metadata" ${thumbnail} data-count-view data-id="${video.id}">
      <source src="${escapeHtml(video.video_path)}" />
    </video>
  `;
}

function renderVideoCard(video) {
  return `
    <article class="video-card" data-watch-id="${video.id}">
      ${renderPlayer(video)}
      <div class="video-info">
        <h2>${escapeHtml(video.title)}</h2>
        <p>${escapeHtml(video.description || 'Tidak ada deskripsi.')}</p>
        <div class="meta">
          <span class="pill">${sourceLabel(video.source_type)}</span>
          ${video.category ? `<span class="pill">${escapeHtml(video.category)}</span>` : ''}
          ${video.tags ? `<span>${escapeHtml(video.tags)}</span>` : ''}
          <span>${video.views} views</span>
          <span>${formatDate(video.created_at)}</span>
        </div>
        <a class="watch-link" href="/watch.html?id=${video.id}">Tonton</a>
      </div>
    </article>
  `;
}

function renderPublicVideos() {
  const grid = document.querySelector('#videoGrid');
  const emptyState = document.querySelector('#emptyState');
  const searchValue = document.querySelector('#searchInput')?.value.toLowerCase() || '';

  if (!grid) return;

  const videos = state.videos.filter((video) => {
    const haystack = `${video.title} ${video.description} ${video.category} ${video.tags} ${sourceLabel(video.source_type)}`.toLowerCase();
    return haystack.includes(searchValue);
  });

  grid.innerHTML = videos.map(renderVideoCard).join('');
  emptyState.hidden = videos.length > 0;

  grid.querySelectorAll('video[data-count-view]').forEach((player) => {
    const eventName = 'play';
    player.addEventListener(eventName, async () => countView(player), { once: true });
  });

  grid.querySelectorAll('.video-card').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('video, iframe, a, button')) return;
      window.location.href = `/watch.html?id=${card.dataset.watchId}`;
    });
  });
}

async function countView(player) {
  const id = player.dataset.id;
  if (player.dataset.counted) return;
  player.dataset.counted = 'true';

  try {
    await requestJson(`/api/videos/${id}/views`, { method: 'POST' });
  } catch (error) {
    console.error(error);
  }
}

function renderAdminItem(video) {
  const media = video.thumbnail_path && !video.thumbnail_path.includes('drive.google.com')
    ? `<img src="${escapeHtml(video.thumbnail_path)}" alt="${escapeHtml(video.title)}" />`
    : renderPlayer(video).replace('controls ', '').replace('data-count-view', '');

  return `
    <article class="admin-item">
      ${media}
      <div>
        <h2>${escapeHtml(video.title)}</h2>
        <p>${escapeHtml(video.description || 'Tidak ada deskripsi.')}</p>
        <div class="meta">
          <span class="pill">${sourceLabel(video.source_type)}</span>
          ${video.category ? `<span class="pill">${escapeHtml(video.category)}</span>` : ''}
          ${video.tags ? `<span>${escapeHtml(video.tags)}</span>` : ''}
          <span>${video.views} views</span>
        </div>
        <div class="admin-actions">
          <button class="secondary-button" type="button" data-action="edit" data-id="${video.id}">Edit</button>
          <button class="danger-button" type="button" data-action="delete" data-id="${video.id}">Hapus</button>
        </div>
      </div>
    </article>
  `;
}

function renderAdminList() {
  const list = document.querySelector('#adminList');
  const emptyState = document.querySelector('#adminEmptyState');

  if (!list) return;

  list.innerHTML = state.videos.map(renderAdminItem).join('');
  emptyState.hidden = state.videos.length > 0;
}

function resetForm() {
  const form = document.querySelector('#videoForm');
  if (!form) return;

  form.reset();
  delete form.dataset.originalSource;
  document.querySelector('#videoId').value = '';
  document.querySelector('#sourceType').value = state.config.default_source || 'local';
  document.querySelector('#formTitle').textContent = 'Tambah Video';
  document.querySelector('#formMessage').textContent = '';
  updateSourceFields();
}

function fillForm(video) {
  const form = document.querySelector('#videoForm');
  form.dataset.originalSource = video.source_type || 'local';
  document.querySelector('#videoId').value = video.id;
  document.querySelector('#title').value = video.title;
  document.querySelector('#description').value = video.description || '';
  document.querySelector('#category').value = video.category || '';
  document.querySelector('#tags').value = video.tags || '';
  document.querySelector('#sourceType').value = video.source_type || 'local';
  document.querySelector('#videoUrl').value = video.source_type === 'local' ? '' : video.video_path;
  document.querySelector('#video').required = false;
  document.querySelector('#thumbnail').value = '';
  document.querySelector('#video').value = '';
  updateSourceFields(true);
  document.querySelector('#formTitle').textContent = 'Edit Video';
  document.querySelector('#formMessage').textContent = 'Mode edit aktif. Kosongkan file jika tidak ingin mengganti.';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateSourceFields(isEditing = Boolean(document.querySelector('#videoId')?.value)) {
  const sourceType = document.querySelector('#sourceType')?.value || 'local';
  const videoField = document.querySelector('#video');
  const videoUrlField = document.querySelector('#videoUrlField');
  const videoUrl = document.querySelector('#videoUrl');
  const videoFileField = document.querySelector('#videoFileField');
  const form = document.querySelector('#videoForm');
  const originalSource = form?.dataset.originalSource || 'local';

  if (!videoField || !videoUrlField || !videoUrl || !videoFileField) return;

  const isLocal = sourceType === 'local';
  videoFileField.hidden = !isLocal;
  videoUrlField.hidden = isLocal;
  videoField.required = isLocal && (!isEditing || originalSource !== 'local');
  videoUrl.required = !isLocal && (!isEditing || originalSource !== sourceType);

  if (isLocal) {
    videoUrl.value = '';
  } else {
    videoField.value = '';
  }
}

function applySourceConfig() {
  const sourceType = document.querySelector('#sourceType');
  if (!sourceType) return;

  sourceType.querySelector('option[value="local"]').hidden = !state.config.allow_local_uploads;
  sourceType.querySelector('option[value="youtube"]').hidden = !state.config.enable_youtube;

  if (!state.config.allow_local_uploads && sourceType.value === 'local') {
    sourceType.value = state.config.default_source || 'google_drive';
  }

  if (!state.config.enable_youtube && sourceType.value === 'youtube') {
    sourceType.value = state.config.default_source || 'google_drive';
  }

  updateSourceFields();
}

async function handleSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const id = document.querySelector('#videoId').value;
  const message = document.querySelector('#formMessage');
  const formData = new FormData(form);
  const url = id ? `/api/videos/${id}` : '/api/videos';
  const method = id ? 'PUT' : 'POST';
  const sourceType = document.querySelector('#sourceType')?.value || 'local';
  const videoUrl = document.querySelector('#videoUrl')?.value || '';
  const urlError = getVideoUrlError(sourceType, videoUrl);

  message.textContent = 'Menyimpan...';

  if (urlError) {
    message.textContent = urlError;
    return;
  }

  try {
    await requestJson(url, {
      method,
      body: formData
    });

    await loadVideos();
    renderAdminList();
    resetForm();
    message.textContent = 'Video berhasil disimpan.';
  } catch (error) {
    message.textContent = error.message;
  }
}

async function handleAdminClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const id = Number(button.dataset.id);
  const video = state.videos.find((item) => item.id === id);

  if (button.dataset.action === 'edit' && video) {
    fillForm(video);
    return;
  }

  if (button.dataset.action === 'delete' && video) {
    const confirmed = confirm(`Hapus video "${video.title}"?`);
    if (!confirmed) return;

    await requestJson(`/api/videos/${id}`, { method: 'DELETE' });
    await loadVideos();
    renderAdminList();
    resetForm();
  }
}

async function initPublicPage() {
  await loadConfig();
  await loadVideos();
  renderPublicVideos();
  document.querySelector('#searchInput')?.addEventListener('input', renderPublicVideos);
}

async function initAdminPage() {
  await loadConfig();
  document.querySelector('#videoForm')?.addEventListener('submit', handleSubmit);
  document.querySelector('#resetButton')?.addEventListener('click', resetForm);
  document.querySelector('#adminList')?.addEventListener('click', handleAdminClick);
  document.querySelector('#sourceType')?.addEventListener('change', () => updateSourceFields());

  applySourceConfig();
  await loadVideos();
  renderAdminList();
  resetForm();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  if (document.querySelector('#videoGrid')) {
    initPublicPage().catch(console.error);
  }

  if (document.querySelector('#videoForm')) {
    initAdminPage().catch(console.error);
  }
});
