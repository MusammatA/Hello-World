const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://secure.almostcrackd.ai';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function pickImageUrl(record = {}) {
  const candidates = [record.cdn_url, record.public_url, record.image_url, record.url];
  for (const c of candidates) {
    const clean = String(c || '').trim();
    if (clean && /^(https?:)?\/\//i.test(clean)) return clean;
  }
  return null;
}

function getCaptionText(row = {}) {
  const candidates = [
    row.content,
    row.caption_text,
    row.caption,
    row.text,
    row.generated_caption,
    row.meme_text,
    row.output
  ];
  for (const c of candidates) {
    const text = String(c ?? '').trim();
    if (text) return text;
  }
  return '';
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY env var' });

  const term = String(req.query?.term || '').trim().toLowerCase();
  const limit = Math.max(20, Math.min(1000, Number(req.query?.limit) || 400));
  if (!term) return res.status(200).json({ memes: [] });

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const pageSize = 1000;
    const maxScanRows = 50000;
    const maxPages = Math.ceil(maxScanRows / pageSize);

    const matched = [];
    for (let page = 0; page < maxPages; page += 1) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const { data, error } = await supabase
        .from('captions')
        .select('*')
        .order('created_datetime_utc', { ascending: false })
        .range(from, to);
      if (error) throw error;
      if (!data || !data.length) break;

      for (const row of data) {
        const text = getCaptionText(row).toLowerCase();
        if (!text.includes(term)) continue;
        matched.push(row);
        if (matched.length >= limit) break;
      }
      if (matched.length >= limit) break;
      if (data.length < pageSize) break;
    }

    const imageIds = Array.from(new Set(matched.map(r => String(r.image_id || '').trim()).filter(Boolean)));
    const imageMap = {};
    for (const batch of chunkArray(imageIds, 150)) {
      const { data, error } = await supabase.from('images').select('*').in('id', batch);
      if (error) throw error;
      (data || []).forEach((img) => {
        const id = String(img.id || '').trim();
        const url = pickImageUrl(img);
        if (id && url) imageMap[id] = url;
      });
    }

    const memes = matched.map((row) => {
      const imageId = String(row.image_id || '').trim();
      return {
        ...row,
        content: getCaptionText(row),
        image_id: row.image_id,
        imageUrl: imageMap[imageId] || row.image_url || row.cdn_url || row.public_url || row.url || null
      };
    }).filter(m => m.content && m.imageUrl);

    return res.status(200).json({ memes });
  } catch (error) {
    return res.status(500).json({ error: String(error && error.message ? error.message : error) });
  }
};
