# Simple Video Library

Video Library sederhana dengan frontend HTML/CSS/JavaScript, backend Node.js Express, SQLite untuk metadata, dan dukungan video eksternal Google Drive.

## Menjalankan dari awal

```bash
npm install
npm start
```

Buka:

- Halaman utama: `http://localhost:3000`
- Halaman admin: `http://localhost:3000/admin.html`
- Halaman tonton: `http://localhost:3000/watch.html?id=VIDEO_ID`

## Catatan storage

- Saat development lokal, file video bisa disimpan di folder `videos/`.
- Saat deploy ke Render Free, gunakan video eksternal Google Drive karena storage file upload tidak persistent.
- File thumbnail lokal disimpan di folder `thumbnails/`.
- SQLite hanya menyimpan metadata dan path file, bukan file video BLOB.
- Video dari Google Drive dan YouTube disimpan sebagai URL embed di metadata.
- File `database.db` akan dibuat otomatis saat `npm start` pertama kali dijalankan.

## Deploy ke Render Free + Google Drive

Project ini sudah menyertakan `render.yaml`.

Langkah umum:

1. Upload project ke GitHub.
2. Buka Render, pilih `New Web Service`.
3. Connect repository GitHub project ini.
4. Render akan membaca konfigurasi dari `render.yaml`.
5. Deploy.

Environment untuk Render:

```text
ALLOW_LOCAL_UPLOADS=false
ENABLE_YOUTUBE=false
DEFAULT_SOURCE=google_drive
```

Dengan konfigurasi itu, halaman admin akan fokus ke Google Drive dan field upload file video lokal disembunyikan.

Catatan penting: Render Free tidak menyediakan persistent disk gratis untuk file upload. SQLite lokal juga cocok untuk demo/testing, tetapi metadata bisa hilang saat instance dibuat ulang. Untuk produksi gratis yang lebih aman, pindahkan metadata ke database hosted seperti Supabase/Postgres.

## API

- `GET /api/videos`
- `GET /api/videos/:id`
- `POST /api/videos`
- `PUT /api/videos/:id`
- `DELETE /api/videos/:id`

Untuk `POST` dan `PUT`, gunakan `multipart/form-data`:

- `title`
- `description`
- `category`
- `tags`
- `video`
- `video_url`
- `thumbnail`

Gunakan `source_type` untuk menentukan sumber video:

- `local`: upload file lewat field `video`, hanya untuk development lokal
- `google_drive`: isi `video_url`, contoh `https://drive.google.com/file/d/FILE_ID/view`
- `youtube`: isi `video_url`, contoh `https://www.youtube.com/watch?v=VIDEO_ID`, bisa dimatikan di Render
