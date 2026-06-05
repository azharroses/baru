const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const initSqlJs = require('sql.js');
const { createClient } = require('@supabase/supabase-js');

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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';

[PUBLIC_DIR, VIDEOS_DIR, THUMBNAILS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

let db;
let videoStore;
let supabaseAdmin;

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
    if (url.pathname.includes('/folders/')) {
      return null;
    }
    const filePathMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    return filePathMatch?.[1] || url.searchParams.get('id');
  } catch (error) {
    return null;
  }
}

function getExternalUrlError(sourceType, videoUrl) {
  if (!videoUrl) {
    return sourceType === 'google_drive'
      ? 'URL Google Drive wajib diisi.'
      : 'URL YouTube wajib diisi.';
  }

  try {
    const url = new URL(videoUrl);
    if (sourceType === 'google_drive') {
      if (url.pathname.includes('/folders/')) {
        return 'Link yang dipakai adalah link folder Google Drive. Buka file videonya, lalu salin link file video, bukan link folder.';
      }
      if (!getGoogleDriveId(videoUrl)) {
        return 'URL Google Drive tidak valid. Gunakan format https://drive.google.com/file/d/FILE_ID/view.';
      }
    }

    if (sourceType === 'youtube' && !getYouTubeId(videoUrl)) {
      return 'URL YouTube tidak valid. Gunakan format https://www.youtube.com/watch?v=VIDEO_ID.';
    }
  } catch (error) {
    return 'URL harus lengkap, contoh https://drive.google.com/file/d/FILE_ID/view.';
  }

  return '';
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

function createSqliteStore() {
  return {
    async listVideos() {
      return selectAll('SELECT * FROM videos ORDER BY datetime(created_at) DESC, id DESC');
    },
    async getVideo(id) {
      return selectOne('SELECT * FROM videos WHERE id = ?', [id]);
    },
    async createVideo(video) {
      db.run(`
        INSERT INTO videos (title, description, category, tags, source_type, video_path, thumbnail_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        video.title,
        video.description,
        video.category,
        video.tags,
        video.source_type,
        video.video_path,
        video.thumbnail_path
      ]);
      saveDatabase();
      return selectOne('SELECT * FROM videos ORDER BY id DESC LIMIT 1');
    },
    async updateVideo(id, video) {
      db.run(`
        UPDATE videos
        SET title = ?, description = ?, category = ?, tags = ?, source_type = ?, video_path = ?, thumbnail_path = ?
        WHERE id = ?
      `, [
        video.title,
        video.description,
        video.category,
        video.tags,
        video.source_type,
        video.video_path,
        video.thumbnail_path,
        id
      ]);
      saveDatabase();
      return selectOne('SELECT * FROM videos WHERE id = ?', [id]);
    },
    async deleteVideo(id) {
      db.run('DELETE FROM videos WHERE id = ?', [id]);
      saveDatabase();
    },
    async incrementViews(id) {
      db.run('UPDATE videos SET views = views + 1 WHERE id = ?', [id]);
      saveDatabase();
      const changes = selectOne('SELECT changes() AS total');
      if (!changes || changes.total === 0) return null;
      return selectOne('SELECT * FROM videos WHERE id = ?', [id]);
    }
  };
}

function createSupabaseStore() {
  const supabase = supabaseAdmin || createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false
    }
  });

  function throwIfError(error) {
    if (error) {
      throw new Error(error.message);
    }
  }

  return {
    async listVideos() {
      const { data, error } = await supabase
        .from('videos')
        .select('*')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
      throwIfError(error);
      return data || [];
    },
    async getVideo(id) {
      const { data, error } = await supabase
        .from('videos')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      throwIfError(error);
      return data;
    },
    async createVideo(video) {
      const { data, error } = await supabase
        .from('videos')
        .insert([video])
        .select('*')
        .single();
      throwIfError(error);
      return data;
    },
    async updateVideo(id, video) {
      const { data, error } = await supabase
        .from('videos')
        .update(video)
        .eq('id', id)
        .select('*')
        .single();
      throwIfError(error);
      return data;
    },
    async deleteVideo(id) {
      const { error } = await supabase
        .from('videos')
        .delete()
        .eq('id', id);
      throwIfError(error);
    },
    async incrementViews(id) {
      const current = await this.getVideo(id);
      if (!current) return null;
      return this.updateVideo(id, {
        title: current.title,
        description: current.description,
        category: current.category,
        tags: current.tags,
        source_type: current.source_type,
        video_path: current.video_path,
        thumbnail_path: current.thumbnail_path,
        views: Number(current.views || 0) + 1
      });
    }
  };
}

function splitTags(value = '') {
  return String(value)
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

function canSeeVideo(video, profile) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return true;
  if (profile?.role === 'superadmin') return true;

  const allowedTags = splitTags(profile?.allowed_tags || 'public');
  if (allowedTags.includes('*')) return true;

  const videoTags = splitTags(video.tags);
  return videoTags.some((tag) => allowedTags.includes(tag));
}

async function getAuthContext(req) {
  if (!supabaseAdmin) {
    return { user: null, profile: { role: 'superadmin', allowed_tags: '*' } };
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return { user: null, profile: null };
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return { user: null, profile: null };
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) {
    throw new Error(profileError.message);
  }

  return {
    user: userData.user,
    profile: profile || {
      id: userData.user.id,
      email: userData.user.email,
      role: 'user_b',
      allowed_tags: 'public'
    }
  };
}

async function requireSuperadmin(req, res) {
  const auth = await getAuthContext(req);
  if (auth.profile?.role !== 'superadmin') {
    res.status(403).json({ message: 'Akses hanya untuk superadmin.' });
    return null;
  }
  return auth;
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
    views: Number(row.views || 0)
  };
}

app.get('/api/videos', async (req, res, next) => {
  try {
    const auth = await getAuthContext(req);
    const videos = (await videoStore.listVideos())
      .filter((video) => canSeeVideo(video, auth.profile))
      .map(normalizeVideo);
    res.json(videos);
  } catch (error) {
    next(error);
  }
});

app.get('/api/videos/:id', async (req, res, next) => {
  const id = Number(req.params.id);

  try {
    const auth = await getAuthContext(req);
    const video = await videoStore.getVideo(id);
    if (!video || !canSeeVideo(video, auth.profile)) {
      res.status(404).json({ message: 'Video tidak ditemukan' });
      return;
    }

    res.json(normalizeVideo(video));
  } catch (error) {
    next(error);
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    allow_local_uploads: ALLOW_LOCAL_UPLOADS,
    enable_youtube: ENABLE_YOUTUBE,
    default_source: normalizeSourceType(DEFAULT_SOURCE),
    supabase_url: SUPABASE_URL || '',
    supabase_publishable_key: SUPABASE_PUBLISHABLE_KEY,
    auth_enabled: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY)
  });
});

app.get('/api/me', async (req, res, next) => {
  try {
    const auth = await getAuthContext(req);
    if (!auth.user) {
      res.status(401).json({ message: 'Belum login.' });
      return;
    }

    res.json({
      id: auth.user.id,
      email: auth.user.email,
      role: auth.profile?.role || 'user_b',
      allowed_tags: auth.profile?.allowed_tags || 'public'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/videos', uploadFields, async (req, res, next) => {
  const { title, description = '', category = '', tags = '', video_url = '' } = req.body;
  const sourceType = normalizeSourceType(req.body.source_type);
  const videoFile = req.files?.video?.[0];
  const thumbnailFile = req.files?.thumbnail?.[0];

  try {
    const auth = await requireSuperadmin(req, res);
    if (!auth) {
      if (videoFile) removeFile(`/videos/${videoFile.filename}`);
      if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
      return;
    }

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

    const externalUrlError = sourceType === 'local' ? '' : getExternalUrlError(sourceType, video_url.trim());
    if (externalUrlError) {
      if (videoFile) removeFile(`/videos/${videoFile.filename}`);
      if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
      res.status(400).json({ message: externalUrlError });
      return;
    }

    if (!videoPath) {
      if (videoFile) removeFile(`/videos/${videoFile.filename}`);
      if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
      res.status(400).json({ message: 'URL video tidak valid.' });
      return;
    }

    const thumbnailPath = thumbnailFile
      ? `/thumbnails/${thumbnailFile.filename}`
      : buildDefaultThumbnailPath(sourceType, video_url.trim());

    const video = await videoStore.createVideo({
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      tags: tags.trim(),
      source_type: sourceType,
      video_path: videoPath,
      thumbnail_path: thumbnailPath
    });
    if (!video) {
      throw new Error('Metadata video gagal disimpan.');
    }

    res.status(201).json(normalizeVideo(video));
  } catch (error) {
    if (videoFile) removeFile(`/videos/${videoFile.filename}`);
    if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
    next(error);
  }
});

app.put('/api/videos/:id', uploadFields, async (req, res, next) => {
  const id = Number(req.params.id);

  try {
    const auth = await requireSuperadmin(req, res);
    if (!auth) return;

    const current = await videoStore.getVideo(id);

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

    const externalUrlError = sourceType === 'local' || !externalUrl ? '' : getExternalUrlError(sourceType, externalUrl);
    if (externalUrlError) {
      if (videoFile) removeFile(`/videos/${videoFile.filename}`);
      if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
      res.status(400).json({ message: externalUrlError });
      return;
    }

    if (!nextVideoPath) {
      if (videoFile) removeFile(`/videos/${videoFile.filename}`);
      if (thumbnailFile) removeFile(`/thumbnails/${thumbnailFile.filename}`);
      res.status(400).json({ message: 'URL video tidak valid.' });
      return;
    }

    const nextThumbnailPath = thumbnailFile
      ? `/thumbnails/${thumbnailFile.filename}`
      : (sourceType === 'youtube' && externalUrl
        ? buildDefaultThumbnailPath(sourceType, externalUrl)
        : current.thumbnail_path);

    const updated = await videoStore.updateVideo(id, {
      title: (req.body.title || current.title).trim(),
      description: (req.body.description || '').trim(),
      category: (req.body.category || '').trim(),
      tags: (req.body.tags || '').trim(),
      source_type: sourceType,
      video_path: nextVideoPath,
      thumbnail_path: nextThumbnailPath
    });

    if (videoFile || sourceType !== normalizeSourceType(current.source_type)) removeFile(current.video_path);
    if (thumbnailFile && current.thumbnail_path) removeFile(current.thumbnail_path);

    res.json(normalizeVideo(updated));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/videos/:id', async (req, res, next) => {
  const id = Number(req.params.id);

  try {
    const auth = await requireSuperadmin(req, res);
    if (!auth) return;

    const video = await videoStore.getVideo(id);

    if (!video) {
      res.status(404).json({ message: 'Video tidak ditemukan.' });
      return;
    }

    await videoStore.deleteVideo(id);
    removeFile(video.video_path);
    removeFile(video.thumbnail_path);

    res.json({ message: 'Video berhasil dihapus.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/videos/:id/views', async (req, res, next) => {
  const id = Number(req.params.id);

  try {
    const auth = await getAuthContext(req);
    const current = await videoStore.getVideo(id);
    if (!current || !canSeeVideo(current, auth.profile)) {
      res.status(404).json({ message: 'Video tidak ditemukan.' });
      return;
    }

    const video = await videoStore.incrementViews(id);

    if (!video) {
      res.status(404).json({ message: 'Video tidak ditemukan.' });
      return;
    }

    res.json(normalizeVideo(video));
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  if (err) {
    res.status(400).json({ message: err.message || 'Terjadi kesalahan.' });
    return;
  }
  next();
});

async function startServer() {
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false
      }
    });
    videoStore = createSupabaseStore();
    console.log('Metadata video memakai Supabase.');
  } else {
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
    videoStore = createSqliteStore();
    console.log('Metadata video memakai SQLite lokal.');
  }

  app.listen(PORT, () => {
    console.log(`Video Library berjalan di http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Gagal menjalankan server:', error);
  process.exit(1);
});
