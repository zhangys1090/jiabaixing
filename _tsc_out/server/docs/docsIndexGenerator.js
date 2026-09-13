"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocsIndexGenerator = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../../utils/Logger");
class DocsIndexGenerator {
    projectRoot;
    docsDir;
    indexCache = null;
    lastIndexTime = 0;
    INDEX_CACHE_TTL = 5 * 60 * 1000;
    constructor(projectRoot) {
        this.projectRoot = projectRoot;
        this.docsDir = path.join(projectRoot, 'docs');
    }
    /**
     * 扫描docs目录，构建文档索引
     */
    async buildIndex(force = false) {
        const now = Date.now();
        if (!force &&
            this.indexCache &&
            now - this.lastIndexTime < this.INDEX_CACHE_TTL) {
            return this.indexCache;
        }
        try {
            const entries = [];
            await this.scanDirectory(this.docsDir, entries);
            this.indexCache = entries.sort((a, b) => b.modified - a.modified);
            this.lastIndexTime = now;
            Logger_1.Logger.info(`文档索引构建完成: ${entries.length}个文件`, 'DocsIndexGenerator');
            return this.indexCache;
        }
        catch (error) {
            Logger_1.Logger.error('构建文档索引失败', error, 'DocsIndexGenerator');
            return [];
        }
    }
    async scanDirectory(dir, entries, basePath = '') {
        const files = await fs.promises.readdir(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = await fs.promises.stat(fullPath);
            if (stat.isDirectory()) {
                if (!['node_modules', '.git', '.idea'].includes(file)) {
                    const subBase = basePath ? `${basePath}/${file}` : file;
                    await this.scanDirectory(fullPath, entries, subBase);
                }
            }
            else if (this.isSupportedDocFile(file)) {
                const entry = await this.parseDocFile(fullPath, stat, basePath);
                if (entry) {
                    entries.push(entry);
                }
            }
        }
    }
    isSupportedDocFile(filename) {
        const ext = path.extname(filename).toLowerCase();
        return ['.md', '.txt', '.rst', '.html'].includes(ext);
    }
    async parseDocFile(fullPath, stat, basePath) {
        try {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            const filename = path.basename(fullPath);
            const relativePath = basePath ? `${basePath}/${filename}` : filename;
            const { title, description, tags, category } = this.extractMetadata(content, filename, relativePath);
            return {
                path: relativePath,
                title,
                description,
                category,
                size: stat.size,
                modified: stat.mtimeMs,
                tags,
            };
        }
        catch {
            return null;
        }
    }
    extractMetadata(content, filename, relativePath) {
        // 从Frontmatter或第一行提取标题
        const firstLine = content.split('\n')[0] || '';
        let title = filename;
        if (firstLine.startsWith('# ')) {
            title = firstLine.substring(2).trim();
        }
        else if (firstLine.startsWith('## ')) {
            title = firstLine.substring(3).trim();
        }
        // 尝试从目录结构推断分类
        const category = this.inferCategory(relativePath);
        // 提取前100个非空字符作为描述
        const cleanContent = content
            .replace(/^---[\s\S]*?---\n?/, '') // 移除frontmatter
            .replace(/^#+\s*/gm, '') // 移除标题标记
            .replace(/\s+/g, ' ') // 压缩空白
            .trim();
        const description = cleanContent.substring(0, 120) + (cleanContent.length > 120 ? '...' : '');
        // 提取标签
        const tags = this.extractTags(content, relativePath);
        return { title, description, tags, category };
    }
    inferCategory(relativePath) {
        const parts = relativePath.split('/');
        if (parts.length > 1) {
            return parts[0]; // 使用第一级目录作为分类
        }
        return 'general';
    }
    extractTags(content, relativePath) {
        const tags = [];
        // 从路径中提取
        if (relativePath.includes('api'))
            tags.push('api');
        if (relativePath.includes('test'))
            tags.push('testing');
        if (relativePath.includes('integration'))
            tags.push('integration');
        if (relativePath.includes('development'))
            tags.push('development');
        if (relativePath.includes('evolution'))
            tags.push('evolution');
        if (relativePath.includes('superpowers'))
            tags.push('superpowers');
        // 从内容中提取常见标签词
        const tagKeywords = [
            'todo',
            'important',
            'deprecated',
            'plan',
            'guide',
            'reference',
            'architecture',
        ];
        const lowerContent = content.toLowerCase();
        for (const keyword of tagKeywords) {
            if (lowerContent.includes(keyword)) {
                tags.push(keyword);
            }
        }
        return tags.slice(0, 8); // 限制标签数量
    }
    /**
     * 生成llms.txt - 精选索引（精简版，<30KB）
     */
    async generateLLMSTxt() {
        const index = await this.buildIndex();
        const lines = [];
        lines.push(`# Jiabaixing Documentation Index`);
        lines.push(`# Generated: ${new Date().toISOString()}`);
        lines.push(`# Total Documents: ${index.length}`);
        lines.push(``);
        // 按分类分组
        const groups = {};
        for (const entry of index) {
            if (!groups[entry.category])
                groups[entry.category] = [];
            groups[entry.category].push(entry);
        }
        for (const [category, entries] of Object.entries(groups).sort()) {
            lines.push(`## ${category}`);
            // 每个分类只放最近修改的15个
            for (const entry of entries.slice(0, 15)) {
                const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(',')}]` : '';
                const sizeStr = this.formatSize(entry.size);
                lines.push(`- /docs/${entry.path}: ${entry.title}${tagStr} (${sizeStr})`);
                lines.push(`  ${entry.description}`);
            }
            lines.push(``);
        }
        return lines.join('\n');
    }
    /**
     * 生成llms-full.txt - 完整文档合集（<2MB）
     */
    async generateLLMSFullTxt() {
        const index = await this.buildIndex();
        const parts = [];
        parts.push(`# Jiabaixing Full Documentation`);
        parts.push(`# Generated: ${new Date().toISOString()}`);
        parts.push(`# Total Documents: ${index.length}`);
        parts.push(``);
        parts.push(`---`);
        parts.push(``);
        let totalSize = 0;
        const MAX_SIZE = 1.8 * 1024 * 1024; // 1.8MB 留出余量
        for (const entry of index) {
            const fullPath = path.join(this.docsDir, entry.path);
            try {
                const content = await fs.promises.readFile(fullPath, 'utf8');
                // 检查大小
                if (totalSize + content.length > MAX_SIZE) {
                    parts.push(`[... remaining ${index.indexOf(entry)} documents omitted due to size limit ...]`);
                    break;
                }
                parts.push(`# DOCUMENT: /docs/${entry.path}`);
                parts.push(`# Title: ${entry.title}`);
                parts.push(`# Modified: ${new Date(entry.modified).toISOString()}`);
                parts.push(`# Size: ${this.formatSize(entry.size)}`);
                parts.push(``);
                parts.push(content);
                parts.push(``);
                parts.push(`---`);
                parts.push(``);
                totalSize += content.length;
            }
            catch {
                // 跳过无法读取的文件
            }
        }
        return parts.join('\n');
    }
    formatSize(bytes) {
        if (bytes < 1024)
            return `${bytes}B`;
        if (bytes < 1024 * 1024)
            return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
    }
    /**
     * 生成并写入静态文件到public目录
     */
    async writeStaticFiles() {
        try {
            const publicDir = path.join(this.projectRoot, 'public');
            if (!fs.existsSync(publicDir)) {
                await fs.promises.mkdir(publicDir, { recursive: true });
            }
            const llmsTxt = await this.generateLLMSTxt();
            await fs.promises.writeFile(path.join(publicDir, 'llms.txt'), llmsTxt, 'utf8');
            Logger_1.Logger.info('已生成: public/llms.txt', 'DocsIndexGenerator');
            const llmsFullTxt = await this.generateLLMSFullTxt();
            await fs.promises.writeFile(path.join(publicDir, 'llms-full.txt'), llmsFullTxt, 'utf8');
            Logger_1.Logger.info('已生成: public/llms-full.txt', 'DocsIndexGenerator');
        }
        catch (error) {
            Logger_1.Logger.error('写入文档索引失败', error, 'DocsIndexGenerator');
        }
    }
    /**
     * 获取单个文档内容
     */
    async getDocContent(docPath) {
        const fullPath = path.join(this.docsDir, docPath);
        try {
            return await fs.promises.readFile(fullPath, 'utf8');
        }
        catch {
            return null;
        }
    }
}
exports.DocsIndexGenerator = DocsIndexGenerator;
