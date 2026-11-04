export type MineruTier = 'basic' | 'standard' | 'flash';
export interface MineruEnvironment { ready: boolean; executable?: string; version?: string; message: string }
export interface MineruResult {
  runId: string;
  pdfHash: string;
  tier: MineruTier;
  mineruVersion: string;
  completedAt: string;
  markdown: string;
  json: string;
  images: number;
}
export interface MineruState {
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  startedAt?: string;
  result: MineruResult | null;
}
export const MINERU_TIERS: { value: MineruTier; label: string; help: string }[] = [
  { value: 'basic', label: '基础解析 · OCR / 表格 / 公式', help: '使用本机 CPU 解析，首次使用需下载模型，较长论文可能需要数分钟。' },
  { value: 'standard', label: '标准解析 · 复杂版式', help: '增加视觉模型，首次需下载更大的模型，对内存和显卡要求更高。' },
  { value: 'flash', label: '快速提取 · 仅文字层', help: '无需推理模型，适合有文字层的 PDF；不识别扫描页，复杂表格和公式效果有限。' },
];
