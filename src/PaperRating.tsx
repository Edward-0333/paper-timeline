import { useRef, useState } from 'react';
import { Star } from 'lucide-react';
import type { PaperRating } from '../shared/types';

const levels: PaperRating[] = [1, 2, 3, 4, 5];

export function RatingStars({ rating }: { rating: PaperRating }) {
  return <span className="rating-stars" role="img" aria-label={`${rating} 星`} title={`${rating} 星`}>
    {levels.slice(0, rating).map(level => <Star key={level} size={13} aria-hidden="true" />)}
  </span>;
}

export default function PaperRatingEditor({ rating, onChange }: {
  rating?: PaperRating;
  onChange: (rating: PaperRating | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PaperRating | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);

  async function save(next: PaperRating | null) {
    if (pending.current || next === (rating ?? null)) return;
    pending.current = true; setSaving(true); setError(''); setPreview(null);
    try { await onChange(next); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setSaving(false); }
  }

  return <section className="detail-rating" aria-label="论文评分" aria-busy={saving}>
    <div className="detail-rating-heading"><h3>评分</h3>
      {rating && <button className="text-button" disabled={saving} onClick={() => void save(null)}>清除评分</button>}
    </div>
    <div className="rating-editor-row">
      <div className="rating-choices" role="group" aria-label="选择星级" onMouseLeave={() => setPreview(null)}>
        {levels.map(level => <button key={level} type="button" aria-label={`评为 ${level} 星`} title={`${level} 星`}
          aria-pressed={rating === level} disabled={saving} className={(preview ?? rating ?? 0) >= level ? 'filled' : ''}
          onMouseEnter={() => { if (!saving) setPreview(level); }} onClick={() => void save(level)}>
          <Star size={23} aria-hidden="true" />
        </button>)}
      </div>
      <span className="rating-value" role="status">{saving ? '保存中…' : rating ? `${rating} 星` : '未评分'}</span>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
