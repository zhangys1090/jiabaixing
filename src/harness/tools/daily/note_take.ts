/**
 * Harness Tool: note_take - 快速笔记
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

interface NoteEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export const NOTE_TAKE_DEF: ToolDefinition = {
  name: 'note_take',
  description:
    '快速记录和管理笔记。支持写入、读取、列表、删除和搜索笔记。适用场景：用户需要快速记录想法、备忘、会议纪要等。不适用：任务管理、提醒设置。',
  category: ToolCategory.DAILY,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: ['write', 'read', 'list', 'delete', 'search'],
    },
    note_id: {
      type: 'string',
      description: '笔记ID',
    },
    title: {
      type: 'string',
      description: '笔记标题',
    },
    content: {
      type: 'string',
      description: '笔记内容',
    },
    tags: {
      type: 'array',
      description: '标签',
      items: { type: 'string', description: '标签名' },
    },
    query: {
      type: 'string',
      description: '搜索关键词',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.MEMORY_WRITE],
  riskLevel: 'low',
  idempotent: false,
  timeout: 5000,
};

export interface NoteTakeDeps {
  noteStore: {
    getNotes(): Promise<NoteEntry[]>;
    saveNote(note: NoteEntry): Promise<void>;
    deleteNote(id: string): Promise<void>;
  };
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN');
}

function formatNoteList(notes: NoteEntry[]): string {
  if (notes.length === 0) return '暂无笔记';
  return notes
    .map((n) => {
      const tagStr = n.tags.length > 0 ? ` [${n.tags.join(',')}]` : '';
      return `📝 [${n.id}] ${n.title}${tagStr} 📅${formatDate(n.updatedAt)}`;
    })
    .join('\n');
}

export function createNoteTakeExecutor(deps: NoteTakeDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'write': {
          const title = String(params.title || '');
          const content = String(params.content || '');
          if (!title && !content) {
            return {
              success: false,
              output: null,
              error: '写入笔记需要提供标题或内容',
              duration: 0,
              validated: false,
            };
          }
          const now = Date.now();
          const noteId = params.note_id ? String(params.note_id) : undefined;
          let note: NoteEntry;
          if (noteId) {
            const notes = await deps.noteStore.getNotes();
            const existing = notes.find((n) => n.id === noteId);
            if (existing) {
              existing.title = title || existing.title;
              existing.content = content || existing.content;
              if (Array.isArray(params.tags))
                existing.tags = params.tags.map(String);
              existing.updatedAt = now;
              note = existing;
            } else {
              note = {
                id: noteId,
                title: title || '无标题',
                content,
                tags: Array.isArray(params.tags) ? params.tags.map(String) : [],
                createdAt: now,
                updatedAt: now,
              };
            }
          } else {
            note = {
              id: generateId(),
              title: title || '无标题',
              content,
              tags: Array.isArray(params.tags) ? params.tags.map(String) : [],
              createdAt: now,
              updatedAt: now,
            };
          }
          await deps.noteStore.saveNote(note);
          return {
            success: true,
            output: `笔记已保存: [${note.id}] ${note.title}`,
            duration: 0,
            validated: false,
          };
        }

        case 'read': {
          const noteId = String(params.note_id || '');
          if (!noteId) {
            return {
              success: false,
              output: null,
              error: '读取笔记需要提供note_id',
              duration: 0,
              validated: false,
            };
          }
          const notes = await deps.noteStore.getNotes();
          const note = notes.find((n) => n.id === noteId);
          if (!note) {
            return {
              success: false,
              output: null,
              error: `笔记不存在: ${noteId}`,
              duration: 0,
              validated: false,
            };
          }
          const tagStr =
            note.tags.length > 0 ? `\n标签: ${note.tags.join(', ')}` : '';
          return {
            success: true,
            output: `📝 ${note.title}${tagStr}\n\n${note.content}\n\n创建: ${formatDate(note.createdAt)} | 更新: ${formatDate(note.updatedAt)}`,
            duration: 0,
            validated: false,
          };
        }

        case 'list': {
          const notes = await deps.noteStore.getNotes();
          return {
            success: true,
            output: formatNoteList(notes),
            duration: 0,
            validated: false,
          };
        }

        case 'delete': {
          const noteId = String(params.note_id || '');
          if (!noteId) {
            return {
              success: false,
              output: null,
              error: '删除笔记需要提供note_id',
              duration: 0,
              validated: false,
            };
          }
          await deps.noteStore.deleteNote(noteId);
          return {
            success: true,
            output: `笔记已删除: ${noteId}`,
            duration: 0,
            validated: false,
          };
        }

        case 'search': {
          const query = String(params.query || '').toLowerCase();
          if (!query) {
            return {
              success: false,
              output: null,
              error: '搜索需要提供query',
              duration: 0,
              validated: false,
            };
          }
          const notes = await deps.noteStore.getNotes();
          const matched = notes.filter(
            (n) =>
              n.title.toLowerCase().includes(query) ||
              n.content.toLowerCase().includes(query) ||
              n.tags.some((t) => t.toLowerCase().includes(query))
          );
          if (matched.length === 0) {
            return {
              success: true,
              output: `未找到匹配"${params.query}"的笔记`,
              duration: 0,
              validated: false,
            };
          }
          return {
            success: true,
            output: formatNoteList(matched),
            duration: 0,
            validated: false,
          };
        }

        default:
          return {
            success: false,
            output: null,
            error: `未知操作: ${action}`,
            duration: 0,
            validated: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `笔记操作失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
