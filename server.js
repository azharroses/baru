const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const VIDEOS_DIR = path.join(ROOT_DIR, 'videos');
const THUMBNAILS_DIR = path.join(ROOT_DIR, 'thumbnails');
const DB_PATH = path.join(ROOT_DIR, 'database.db');
const ALLOW_LOCAL_UPLOADS = process.env.ALLOW_LOCAL_UPLOADS !== 'false';
const ENABLE_YOUTUBE = process.env.ENABLE_YOUTUBE !== 'false';
const DEFAULT_SOURCE = process.env.DEFAULT_SOURCE || (ALLOW_LOCAL_UPLOADS ? 'local' : 'google_drive');

[PUBLIC_DIR, VIDEOS_DIR, THUMBNAILS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

let db;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use('/videos', express.static(VIDEOS_DIR));
app.use('/thumbnails', express.static(THUMBNAILS_DIR));

function safeName(name) {
  const ext = path.extname(name);
  const base = path
    .basename(name, ext)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';

  return `${Date.now()}-${base}${ext.toLowerCase()}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      if (file.fieldname === 'thumbnail') {
        cb(null, THUMBNAILS_DIR);
        return;
      }

      cb(null, VIDEOS_DIR);
    },
    filename(req, file, cb) {
      cb(null, safeName(file.originalname));
    }
  }),
  fileFilter(req, file, cb) {
    if (file.fieldname === 'video' && !file.mimetype.startsWith('video/')) {
      cb(new Error('File video harus bertipe video.'));
      return;
    }

    if (file.fieldname === 'thumbnail' && !file.mimetype.startsWith('image/')) {
      cb(new Error('Thumbnail harus bertipe gambar.'));
      return;
    }

    cb(null, true);
  },
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

function filePathForUrl(urlPath) {
  if (!urlPath) return null;
  if (urlPath.startsWith('/videos/')) {
    return path.join(VIDEOS_DIR, path.basename(urlPath));
  }
  if (urlPath.startsWith('/thumbnails/')) {
    return path.join(THUMBNAILS_DIR, path.basename(urlPath));
  }
  return null;
}

function removeFile(urlPath) {
  const filePath = filePathForUrl(urlPath);
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function normalizeSourceType(value) {
  const allowed = ['local', 'google_drive', 'youtube'];
  if (!allowed.includes(value)) return DEFAULT_SOURCE;
  if (value === 'local' && !ALLOW_LOCAL_UPLOADS) return 'google_drive';
  if (value === 'youtube' && !ENABLE_YOUTUBE) return 'google_drive';
  return value;
}

function normalizeStoredSourceType(value) {
  const allowed = ['local', 'google_drive', 'youtube'];
  return allowed.includes(value) ? value : 'local';
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
    const filePathMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    return filePathMatch?.[1] || url.searchParams.get('id');
  } catch (error) {
    return null;
  }
}

function buildExternalVideoPath(sourceType, videoUrl) {
  if (sourceType === 'youtube') {
    const id = getYouTubeId(videoUrl);
    if (!id) return null;
    return `https://www.youtube.com/embed/${id}`;
  }

  if (sourceType === 'google_drive') {
    const id = getGoogleDriveId(videoUrl);
    if (!id) return null;
    return `https://drive.google.com/file/d/${id}/preview`;
  }

  return null;
}

function buildDefaultThumbnailPath(sourceType, videoUrl) {
  if (sourceType !== 'youtube') return '';
  const id = getYouTubeId(videoUrl);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : '';
}

function saveDatabase() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function selectAll(sql, params = []) {
  const result = db.exec(sql, params);
  if (result.length === 0) return [];

  const { columns, values } = result[0];
  return values.map((valueSet) => {
    return columns.reduce((row, column, index) => {
      row[column] = valueSet[index];
      return row;
    }, {});
  });
}

function selectOne(sql, params = []) {
  return selectAll(sql, params)[0];
}

function normalizeVideo(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    tags: row.tags,
    source_type: normalizeStoredSourceType(row.source_type),
    video_path: row.video_path,
    thumbnail_path: row.thumbnail_path,
    created_at: row.created_at,
    views: row.views
  };
}

app.get('/api/videos', (req, res) => {
  const videos = selectAll('SELECT * FROM videos ORDER BY datetime(created_at) DESC, id DESC')
    .map(normalizeVideo);

  res.json(videos);
});

app.get('/api/config', (req, res) => {
  res.json({
    allow_local_uploads: ALLOW_LOCAL_UPLOADS,
    enable_youtube: ENABLE_YOUTUBE,
    default_source: normalizeSourceType(DEFAULT_SOURCE)
  });
});

app.post('/api/videos', uploadFields, (req, res) => {
  const { title, description = '', category = '', tags = '', video_url = '' } = req.body;
  const sourceType = normalizeSourceType(req.body.source_type);
  const videoFile = req.files?.video?.[0];
  const thumbnailFile = req.files?.thumbnail?.[0];

  if (!title) {
    if (videoFile) removeFile(`/videos/${videoFile.filename}`);
    if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
    res.status(400).json({ message: 'Title wajib diisi.' });
    return;
  }

  if (sourceType === 'local' && !ALLOW_LOCAL_UPLOADS) {
    if (videoFile) removeFile(`/videos/${videoFile.filename}`);
    if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
    res.status(400).json({ message: 'Upload lokal dimatikan di hosting ini. Gunakan Google Drive.' });
    return;
  }

  if (sourceType === 'local' && !videoFile) {
    if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
    res.status(400).json({ message: 'File video wajib diisi untuk sumber lokal.' });
    return;
  }

  const videoPath = sourceType === 'local'
    ? `/videos/${videoFile.filename}`
    : buildExternalVideoPath(sourceType, video_url.trim());

  if (!videoPath) {
    if (videoFile) removeFile(`/videos/${videoFile.filename}`);
    if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
    res.status(400).json({ message: 'URL Google Drive atau YouTube tidak valid.' });
    return;
  }

  const thumbnailPath = thumbnailFile
    ? `/thumbnails/${thumbnailFile.filename}`
    : buildDefaultThumbnailPath(sourceType, video_url.trim());

  try {
    db.run(`
      INSERT INTO videos (title, description, category, tags, source_type, video_path, thumbnail_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [title.trim(), description.trim(), category.trim(), tags.trim(), sourceType, videoPath, thumbnailPath]);
    saveDatabase();

    const video = selectOne('SELECT * FROM videos ORDER BY id DESC LIMIT 1');
    if (!video) {
      throw new Error('Metadata video gagal disimpan.');
    }

    res.status(201).json(normalizeVideo(video));
  } catch (error) {
    removeFile(videoPath);
    removeFile(thumbnailPath);
    res.status(500).json({ message: error.message || 'Upload video gagal.' });
  }
});

app.put('/api/videos/:id', uploadFields, (req, res) => {
  const id = Number(req.params.id);
  const current = selectOne('SELECT * FROM videos WHERE id = ?', [id]);

  if (!current) {
    res.status(404).json({ message: 'Video tidak ditemukan.' });
    return;
  }

  const sourceType = normalizeSourceType(req.body.source_type || current.source_type);
  const videoFile = req.files?.video?.[0];
  const thumbnailFile = req.files?.thumbnail?.[0];
  const externalUrl = (req.body.video_url || '').trim();
  let nextVideoPath = current.video_path;

  if (sourceType === 'local' && !ALLOW_LOCAL_UPLOADS) {
    if (videoFile) removeFile(`/videos/${videoFile.filename}`);
    if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
    res.status(400).json({ message: 'Upload lokal dimatikan di hosting ini. Gunakan Google Drive.' });
    return;
  }

  if (sourceType === 'local') {
    if (videoFile) {
      nextVideoPath = `/videos/${videoFile.filename}`;
    } else if (normalizeSourceType(current.source_type) !== 'local') {
      if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
      res.status(400).json({ message: 'File video wajib diisi saat pindah ke sumber lokal.' });
      return;
    }
  } else if (externalUrl) {
    nextVideoPath = buildExternalVideoPath(sourceType, externalUrl);
  } else if (sourceType !== normalizeSourceType(current.source_type)) {
    if (videoFile) removeFile(`/videos/${videoFile.filename}`);
    if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
    res.status(400).json({ message: 'URL wajib diisi saat mengganti sumber video.' });
    return;
  }

  if (!nextVideoPath) {
    if (videoFile) removeFile(`/videos/${videoFile.filename}`);
    if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
    res.status(400).json({ message: 'URL Google Drive atau YouTube tidak valid.' });
    return;
  }

  const nextThumbnailPath = thumbnailFile
    ? `/thumbnails/${thumbnailFile.filename}`
    : (sourceType === 'youtube' && externalUrl
      ? buildDefaultThumbnailPath(sourceType, externalUrl)
      : current.thumbnail_path);

  db.run(`
    UPDATE videos
    SET title = ?, description = ?, category = ?, tags = ?, source_type = ?, video_path = ?, thumbnail_path = ?
    WHERE id = ?
  `, [
    (req.body.title || current.title).trim(),
    (req.body.description || '').trim(),
    (req.body.category || '').trim(),
    (req.body.tags || '').trim(),
    sourceType,
    nextVideoPath,
    nextThumbnailPath,
    id
  ]);
  saveDatabase();

  if (videoFile || sourceType !== normalizeSourceType(current.source_type)) removeFile(current.video_path);
  if (thumbnailFile && current.thumbnail_path) removeFile(current.thumbnail_path);

  const updated = selectOne('SELECT * FROM videos WHERE id = ?', [id]);
  res.json(normalizeVideo(updated));
});

app.delete('/api/videos/:id', (req, res) => {
  const id = Number(req.params.id);
  const video = selectOne('SELECT * FROM videos WHERE id = ?', [id]);

  if (!video) {
    res.status(404).json({ message: 'Video tidak ditemukan.' });
    return;
  }

  db.run('DELETE FROM videos WHERE id = ?', [id]);
  saveDatabase();
  removeFile(video.video_path);
  removeFile(video.thumbnail_path);

  res.json({ message: 'Video berhasil dihapus.' });
});

app.post('/api/videos/:id/views', (req, res) => {
  const id = Number(req.params.id);
  db.run('UPDATE videos SET views = views + 1 WHERE id = ?', [id]);
  saveDatabase();
  const changes = selectOne('SELECT changes() AS total');

  if (changes.total === 0) {
    res.status(404).json({ message: 'Video tidak ditemukan.' });
    return;
  }

  const video = selectOne('SELECT * FROM videos WHERE id = ?', [id]);
  res.json(normalizeVideo(video));
});

app.use((err, req, res, next) => {
  if (err) {
    res.status(400).json({ message: err.message || 'Terjadi kesalahan.' });
    return;
  }
  next();
});

async function startServer() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(ROOT_DIR, 'node_modules', 'sql.js', 'dist', file)
  });

  db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'local',
      video_path TEXT NOT NULL,
      thumbnail_path TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      views INTEGER NOT NULL DEFAULT 0
    )
  `);
  const columns = selectAll('PRAGMA table_info(videos)').map((column) => column.name);
  if (!columns.includes('source_type')) {
    db.run("ALTER TABLE videos ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local'");
  }
  saveDatabase();

  app.listen(PORT, () => {
    console.log(`Video Library berjalan di http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Gagal menjalankan server:', error);
  process.exit(1);
});
