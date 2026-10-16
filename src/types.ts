export interface CatalogEntry {
  id: string;
  title: string;
  author?: string;
  description?: string;
  file: string;
  format: 'txt' | 'epub';
  encoding?: 'utf-8' | 'gb18030';
  version: string;
  chunks?: string;
}

export type Block =
  | { kind: 'paragraph' | 'heading' | 'quote'; text: string; anchor?: string }
  | { kind: 'image'; path: string; alt: string; anchor?: string };

export interface Chapter {
  title: string;
  blocks: Block[];
  path?: string;
}

export interface Book {
  chapters: Chapter[];
  chunked?: { groups: string[]; groupSize: number; loaded: Set<number> };
  title?: string;
  author?: string;
  /** Only vetted PNG / JPEG / GIF / WebP bytes; never external URLs or SVG. */
  images: Map<string, { bytes: Uint8Array; mime: string }>;
  warnings: string[];
}

export interface Progress {
  version: string;
  chapter: number;
  block: number;
  fraction: number;
  percent: number;
  updatedAt: number;
}
