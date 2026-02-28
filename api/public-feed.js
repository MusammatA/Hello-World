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
    const limit = Number.isFinite(requested) ? Math.max(200, Math.min(10000, requested)) : 3000;

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
      });
    }

    return res.status(200).json({ captions, images });
  } catch (error) {
    return res.status(500).json({ error: String(error && error.message ? error.message : error) });
  }
};
