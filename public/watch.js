function getWatchId() {
  const params = new URLSearchParams(window.location.search);
  return Number(params.get('id'));
}

function renderWatchPlayer(video) {
  if (video.source_type === 'google_drive' || video.source_type === 'youtube') {
    return `
      <iframe
        class="watch-player"
        src="${escapeHtml(video.video_path)}"
        title="${escapeHtml(video.title)}"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen>
      </iframe>
    `;
  }

  return `
    <video class="watch-player" controls autoplay src="${escapeHtml(video.video_path)}"></video>
  `;
}

function renderWatchDetails(video) {
  const main = document.querySelector('#watchMain');
  main.innerHTML = `
    ${renderWatchPlayer(video)}
    <div class="watch-details">
      <h1>${escapeHtml(video.title)}</h1>
      <div class="meta">
        <span class="pill">${sourceLabel(video.source_type)}</span>
        ${video.category ? `<span class="pill">${escapeHtml(video.category)}</span>` : ''}
        ${video.tags ? `<span>${escapeHtml(video.tags)}</span>` : ''}
        <span>${video.views} views</span>
        <span>${formatDate(video.created_at)}</span>
      </div>
      <p>${escapeHtml(video.description || 'Tidak ada deskripsi.')}</p>
      <a class="secondary-button back-home-link" href="/">Kembali ke Home</a>
    </div>
  `;
}

function renderRecommendations(currentVideo, allVideos) {
  const list = document.querySelector('#recommendationList');
  const recommendations = allVideos
    .filter((video) => video.id !== currentVideo.id && video.category === currentVideo.category)
    .slice(0, 6);

  if (recommendations.length === 0) {
    list.innerHTML = '<p class="empty-state">Belum ada rekomendasi.</p>';
    return;
  }

  list.innerHTML = recommendations.map((video) => {
    const thumb = video.thumbnail_path
      ? `<img src="${escapeHtml(video.thumbnail_path)}" alt="${escapeHtml(video.title)}" />`
      : '<div class="recommendation-placeholder">Video</div>';

    return `
      <a class="recommendation-item" href="/watch.html?id=${video.id}">
        ${thumb}
        <div>
          <h3>${escapeHtml(video.title)}</h3>
          <p>${video.views} views</p>
          ${video.category ? `<span class="pill">${escapeHtml(video.category)}</span>` : ''}
        </div>
      </a>
    `;
  }).join('');
}

function renderNotFound() {
  document.querySelector('#watchMain').innerHTML = `
    <div class="watch-error">
      <h1>Video tidak ditemukan</h1>
      <a class="secondary-button back-home-link" href="/">Kembali ke Home</a>
    </div>
  `;
  document.querySelector('#recommendationList').innerHTML = '';
}

async function incrementWatchView(id) {
  try {
    return await requestJson(`/api/videos/${id}/views`, { method: 'POST' });
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function initWatchPage() {
  await loadConfig();
  await initAuth();

  const id = getWatchId();
  if (!id) {
    renderNotFound();
    return;
  }

  try {
    let video = await requestJson(`/api/videos/${id}`);
    const updatedVideo = await incrementWatchView(id);
    if (updatedVideo) {
      video = updatedVideo;
    }

    const allVideos = await requestJson('/api/videos');
    renderWatchDetails(video);
    renderRecommendations(video, allVideos);
  } catch (error) {
    renderNotFound();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initWatchPage();
});
