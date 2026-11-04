export const MAX_BRIEF_NOTE_LENGTH = 1000;

export function briefNoteText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_BRIEF_NOTE_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) {
    throw new Error(`精简笔记最多 ${MAX_BRIEF_NOTE_LENGTH} 个字符，不能包含控制字符`);
  }
  return value.replace(/\r\n?/g, '\n').trim();
}
