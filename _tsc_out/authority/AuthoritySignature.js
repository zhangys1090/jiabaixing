"use strict";
/**
 * D4-I2 Post-Audit: authorityMeta HMAC 防伪造校验（TS 侧）。
 *
 * 与 Python 端 agent/core/authority_signature.py 算法逐字节一致：
 *   message = `${goalId}|${snapshotId}|${decisionId}|${planVersion}|${actionHash}`
 *   sig     = HMAC-SHA256(secret, message).hex
 *   actionHash = SHA-256(task).hex
 *
 * D7-3B: planVersion added to HMAC binding.
 *
 * 密钥：环境变量 AGENT_AUTHORITY_HMAC_SECRET，两端必须一致；
 * 未设置时回退内置开发默认值（生产必须显式设置，isProductionSecret() 供告警）。
 */
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
exports.isProductionSecret = isProductionSecret;
exports.actionHash = actionHash;
exports.signAuthorityMeta = signAuthorityMeta;
exports.verifyAuthorityMeta = verifyAuthorityMeta;
const crypto = __importStar(require("crypto"));
const DEV_FALLBACK_SECRET = 'jiabaixing-dev-authority-secret';
function getSecret() {
    return process.env.AGENT_AUTHORITY_HMAC_SECRET || DEV_FALLBACK_SECRET;
}
function isProductionSecret() {
    return Boolean(process.env.AGENT_AUTHORITY_HMAC_SECRET);
}
function actionHash(task) {
    return crypto.createHash('sha256').update(task, 'utf8').digest('hex');
}
function signAuthorityMeta(goalId, snapshotId, decisionId, planVersion, actionHashHex) {
    const message = `${goalId}|${snapshotId}|${decisionId}|${planVersion}|${actionHashHex}`;
    return crypto
        .createHmac('sha256', getSecret())
        .update(message, 'utf8')
        .digest('hex');
}
/**
 * 校验 delegated authorityMeta 的签名。
 *
 * 返回 true 才允许走 delegated 执行路径；false 时调用方必须
 * fail-safe 降级为 TS 本地 DecisionAuthority 决策链。
 */
function verifyAuthorityMeta(meta, task) {
    const goalId = String(meta['authority_goalId'] ?? '');
    const snapshotId = String(meta['authority_snapshotId'] ?? '');
    const decisionId = String(meta['authority_decisionId'] ?? '');
    const planVersion = Number(meta['authority_planVersion'] ?? 0);
    const sig = String(meta['authority_sig'] ?? '');
    const claimedHash = String(meta['authority_actionHash'] ?? '');
    if (!goalId || !snapshotId || !decisionId || !sig || planVersion === 0) {
        return false;
    }
    const expectedHash = claimedHash || actionHash(task);
    if (claimedHash && claimedHash !== actionHash(task)) {
        return false;
    }
    const expected = signAuthorityMeta(goalId, snapshotId, decisionId, planVersion, expectedHash);
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}
