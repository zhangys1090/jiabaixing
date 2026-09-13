"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VectorDatabaseFactory = exports.VectorDatabase = void 0;
class VectorDatabase {
    dimension = 1536;
    metric = 'cosine';
    constructor(config) {
        this.dimension = config?.dimension ?? 1536;
        this.metric = config?.metric ?? 'cosine';
    }
    async storeVector() { }
    async searchVectors() {
        return [];
    }
    async add() { }
    async search() {
        return [];
    }
    async delete() { }
    async close() { }
}
exports.VectorDatabase = VectorDatabase;
class VectorDatabaseFactory {
    static createVectorDatabase(config) {
        return new VectorDatabase(config);
    }
    static create(config) {
        return new VectorDatabase(config);
    }
}
exports.VectorDatabaseFactory = VectorDatabaseFactory;
