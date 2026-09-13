"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateHarnessDeps = validateHarnessDeps;
const REQUIRED_DEPS_KEYS = [
    'llm',
    'constitutionalBuilder',
    'memoryInjector',
    'dynamicContext',
    'historyProvider',
];
function validateHarnessDeps(deps) {
    const missing = REQUIRED_DEPS_KEYS.filter((key) => deps[key] === undefined || deps[key] === null);
    return { valid: missing.length === 0, missing: missing };
}
