import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';

/**
 * Bóc Markdown thành các đoạn văn "nói được" (mỗi phần tử = một đoạn):
 * bỏ ký hiệu định dạng, giữ chữ của tiêu đề/đoạn/danh sách/trích dẫn/liên kết/in đậm-nghiêng/mã nội dòng;
 * bỏ khối mã, HTML, hình ảnh, thanh ngang và front matter.
 */

type MdNode = {
  type: string;
  value?: string;
  alt?: string;
  children?: MdNode[];
};

/** Văn bản của các nút nội dòng (không xuống dòng). */
function inlineText(node: MdNode): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value ?? '';
    case 'break':
      return ' ';
    case 'image':
    case 'html':
    case 'footnoteReference':
      return '';
    default:
      return (node.children ?? []).map(inlineText).join('');
  }
}

function collect(node: MdNode, out: string[]): void {
  switch (node.type) {
    case 'root':
    case 'blockquote':
    case 'list':
    case 'listItem':
      for (const c of node.children ?? []) collect(c, out);
      return;
    case 'heading':
    case 'paragraph': {
      const t = inlineText(node).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
      return;
    }
    case 'table':
      // mỗi ô là một đoạn riêng, đọc lần lượt theo hàng
      for (const row of node.children ?? []) {
        for (const cell of row.children ?? []) {
          const t = inlineText(cell).replace(/\s+/g, ' ').trim();
          if (t) out.push(t);
        }
      }
      return;
    case 'code':
    case 'html':
    case 'thematicBreak':
    case 'yaml':
    case 'definition':
    case 'footnoteDefinition':
      return; // không đọc
    default:
      for (const c of node.children ?? []) collect(c, out);
  }
}

export function markdownToParagraphs(markdown: string): string[] {
  // Bỏ front matter YAML ở đầu tệp
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  // GFM: bảng, gạch ngang chữ (~~x~~), danh sách công việc, liên kết tự động
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as unknown as MdNode;
  const out: string[] = [];
  collect(tree, out);
  return out;
}
