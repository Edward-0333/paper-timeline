/** Normalize common model LaTeX delimiters only for display; keep code and saved messages unchanged. */
export function normalizeChatMath(content: string): string {
  let result = '', index = 0;
  while (index < content.length) {
    const tail = content.slice(index);
    if (index === 0 || content[index - 1] === '\n') {
      const fence = /^( {0,3})(~{3,})([^\n]*\n|[^\n]*$)/.exec(tail);
      if (fence) {
        const end = new RegExp('^ {0,3}~{' + fence[2].length + ',}[ \\t]*\\r?$', 'gm');
        end.lastIndex = index + fence[0].length;
        const closing = end.exec(content);
        const stop = closing ? closing.index + closing[0].length : content.length;
        result += content.slice(index, stop); index = stop; continue;
      }
      const indented = /^(?: {4}|\t)[^\n]*(?:\n|$)/.exec(tail);
      if (indented) { result += indented[0]; index += indented[0].length; continue; }
    }
    const backticks = /^`+/.exec(tail);
    if (backticks) {
      const delimiter = backticks[0];
      let end = content.indexOf(delimiter, index + delimiter.length);
      while (end >= 0 && (content[end - 1] === '`' || content[end + delimiter.length] === '`')) end = content.indexOf(delimiter, end + delimiter.length);
      const stop = end < 0 ? content.length : end + delimiter.length;
      result += content.slice(index, stop); index = stop; continue;
    }
    if (content[index] === '\\') {
      if (content[index + 1] === '\\' || content[index + 1] === '`') { result += content.slice(index, index + 2); index += 2; continue; }
      const opening = content[index + 1];
      if (opening === '(' || opening === '[') {
        const closing = opening === '(' ? '\\)' : '\\]';
        const end = content.indexOf(closing, index + 2);
        if (end >= 0) {
          const formula = content.slice(index + 2, end);
          result += opening === '(' ? `$$${formula}$$` : `\n$$\n${formula}\n$$\n`;
          index = end + 2; continue;
        }
      }
    }
    result += content[index++];
  }
  return result;
}
