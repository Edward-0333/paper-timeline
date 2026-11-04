import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { PaperTag } from '../shared/types';
import { tagKey, type TagFilterOption } from '../shared/paper-tags';

const colors = [
  ['绿色', '#BFE4C4'], ['青色', '#BDE4E6'], ['蓝色', '#C8DBFA'], ['紫色', '#DED0F4'],
  ['粉色', '#F2CCDC'], ['橙色', '#F7D5BD'], ['黄色', '#F5E5AD'], ['灰色', '#E3E6EB'],
];

export function tagTextColor(background: string) {
  const values = background.slice(1).match(/.{2}/g)!.map(part => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722 > 0.179 ? '#000000' : '#FFFFFF';
}

export default function TagDialog({ tag, tagOptions, onClose, onSave }: {
  tag?: PaperTag; tagOptions: readonly TagFilterOption[]; onClose: () => void; onSave: (text: string, color: string) => Promise<unknown>;
}) {
  const [text, setText] = useState(tag?.text || '');
  const [color, setColor] = useState(tag?.color || colors[0][1]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const existingColor = tagOptions.find(option => option.key === tagKey(text))?.color;
  const reuseColor = existingColor && (!tag || tagKey(text) !== tagKey(tag.text));
  const selectedColor = reuseColor ? existingColor : color;
  useEffect(() => { form.current?.querySelector<HTMLInputElement>('#tag-text')?.focus(); }, []);

  return <div className="modal-backdrop"><form ref={form} className="edit-modal tag-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-dialog-title"
    onKeyDown={event => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const fields = [...form.current!.querySelectorAll<HTMLElement>('button, input')].filter(field => !field.matches(':disabled'));
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)!.focus(); }
      if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
    }}
    onSubmit={async event => {
      event.preventDefault();
      if (!text.trim()) { setError('请输入标签文字'); return; }
      setSaving(true); setError('');
      try { await onSave(text.trim(), selectedColor); onClose(); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setSaving(false); }
    }}>
    <div className="modal-heading"><h2 id="tag-dialog-title">{tag ? '编辑标签' : '添加标签'}</h2><button type="button" className="icon-button" aria-label="关闭标签编辑" disabled={saving} onClick={onClose}><X size={18} /></button></div>
    <div className="modal-fields">
      <label htmlFor="tag-text">标签文字</label><input id="tag-text" required maxLength={80} placeholder="例如：单一网络、视觉-动作" disabled={saving} value={text} onChange={event => setText(event.target.value)} />
      <fieldset className="tag-colors" disabled={saving || Boolean(reuseColor)} aria-describedby="tag-color-help"><legend>背景颜色</legend><div className="tag-palette">{colors.map(([name, value]) =>
        <button key={value} type="button" className="tag-swatch" style={{ backgroundColor: value, color: tagTextColor(value) }} aria-label={`${name}背景`} aria-pressed={selectedColor.toUpperCase() === value} title={name} onClick={() => setColor(value)}>{selectedColor.toUpperCase() === value && <Check size={18} />}</button>
      )}</div><div className="tag-custom-color"><label htmlFor="tag-color">自定义颜色</label><input id="tag-color" type="color" value={selectedColor} onChange={event => setColor(event.target.value.toUpperCase())} /><span>{selectedColor.toUpperCase()}</span></div></fieldset>
      <p id="tag-color-help" className="tag-color-help">{reuseColor ? '已使用文献库中同名标签的统一颜色。' : '修改颜色会同步到所有同名标签。'}</p>
      <div className="tag-preview"><span className="tag-preview-label">预览</span><span className="paper-tag" style={{ backgroundColor: selectedColor, color: tagTextColor(selectedColor) }}>{text.trim() || '标签文字'}</span></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer"><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving ? '保存中…' : '保存标签'}</button></div>
  </form></div>;
}
