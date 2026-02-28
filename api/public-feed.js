const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://secure.almostcrackd.ai';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function pickImageUrl(record = {}) {
  const candidates = [
    record.cdn_url,
    record.public_url,
    record.image_url,
    record.url
  ];
  for (const candidate of candidates) {
    const clean = String(candidate || '').trim();
    if (clean && /^(https?:)?\/\//i.test(clean)) return clean;
  }
  return null;
}

function parseUploaderUserIdFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const match = raw.match(/https?:\/\/[^/]+\/([^/?#]+)\//i);
  return match ? String(match[1] || '').trim() : '';
}

function toTitleCase(value) {
  return String(value || '')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function deriveNameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  return toTitleCase(local.replace(/[._-]+/g, ' ').trim() || email || 'Uploader');
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate=120');
  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY env var' });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const requested = Number(req.query?.limit);
    const limit = Number.isFinite(requested) ? Math.max(500, Math.min(50000, requested)) : 20000;

    const pageSize = 500;
    const maxPages = Math.ceil(limit / pageSize);
    let captions = [];
    for (let page = 0; page < maxPages; page += 1) {
      const from = page * pageSize;
      const to = Math.min(from + pageSize - 1, limit - 1);
      const { data, error } = await supabase
        .from('captions')
        .select('*')
        .order('created_datetime_utc', { ascending: false })
        .range(from, to);
      if (error) throw error;
      if (!data || !data.length) break;
      captions = captions.concat(data);
      if (data.length < pageSize) break;
    }

    const imageIds = Array.from(new Set(captions.map(c => String(c.image_id || '').trim()).filter(Boolean)));
    const images = {};
    const imageUploaderById = {};
    for (const batch of chunkArray(imageIds, 150)) {
      const { data, error } = await supabase
        .from('images')
        .select('*')
        .in('id', batch);
      if (error) throw error;
      (data || []).forEach((img) => {
        const id = String(img.id || '').trim();
        const url = pickImageUrl(img);
        if (id && url) images[id] = url;
        if (id) imageUploaderById[id] = parseUploaderUserIdFromUrl(url || img.url || '');
      });
    }

    const userIdsToResolve = Array.from(new Set(
      captions
        .map((row) => {
          const existingUserId = String(row.uploader_user_id || row.uploaded_by_user_id || row.created_by_user_id || '').trim();
          if (existingUserId) return existingUserId;
          const imageId = String(row.image_id || '').trim();
          return String(imageUploaderById[imageId] || '').trim();
        })
        .filter(Boolean)
    )).slice(0, 400);

    const userEmailById = {};
    for (const uid of userIdsToResolve) {
      const { data } = await supabase.auth.admin.getUserById(uid);
      const email = String(data?.user?.email || '').trim();
      if (email) userEmailById[uid] = email;
    }

    captions = captions.map((row) => {
      const imageId = String(row.image_id || '').trim();
      const userId = String(
        row.uploader_user_id ||
        row.uploaded_by_user_id ||
        row.created_by_user_id ||
        imageUploaderById[imageId] ||
        ''
      ).trim();
      const existingEmail = String(row.uploader_email || row.uploaded_by_email || row.created_by_email || '').trim();
      const email = existingEmail || userEmailById[userId] || '';
      const name = String(row.uploader_name || row.uploaded_by_name || row.created_by_name || '').trim() || deriveNameFromEmail(email);
      return {
        ...row,
        uploader_user_id: userId || row.uploader_user_id || null,
        uploader_email: email || row.uploader_email || null,
        uploader_name: name || row.uploader_name || null
      };
    });

    return res.status(200).json({ captions, images });
  } catch (error) {
    return res.status(500).json({ error: String(error && error.message ? error.message : error) });
  }
};
