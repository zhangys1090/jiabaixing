"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenEstimator = void 0;
const CJK_RANGES = [
    [0x4e00, 0x9fff],
    [0x3400, 0x4dbf],
    [0xf900, 0xfaff],
    [0x3000, 0x30ff],
    [0xff00, 0xffef],
];
function isCJK(code) {
    for (const [lo, hi] of CJK_RANGES) {
        if (code >= lo && code <= hi)
            return true;
    }
    return false;
}
class TokenEstimator {
    static CHARS_PER_CJK_TOKEN = 1.5;
    static CHARS_PER_EN_TOKEN = 4;
    static estimateTextTokens(text) {
        if (!text || text.length === 0)
            return 0;
        const len = text.length;
        if (len > 10000) {
            return TokenEstimator._estimateSampled(text, len);
        }
        let cjkChars = 0;
        let otherChars = 0;
        for (let i = 0; i < len; i++) {
            if (isCJK(text.charCodeAt(i))) {
                cjkChars++;
            }
            else {
                otherChars++;
            }
        }
        return Math.ceil(cjkChars / TokenEstimator.CHARS_PER_CJK_TOKEN + otherChars / TokenEstimator.CHARS_PER_EN_TOKEN);
    }
    static _estimateSampled(text, len) {
        const sampleSize = 2000;
        const step = Math.floor(len / sampleSize);
        let cjkSample = 0;
        let otherSample = 0;
        for (let i = 0; i < len; i += step) {
            if (isCJK(text.charCodeAt(i))) {
                cjkSample++;
            }
            else {
                otherSample++;
            }
        }
        const sampleTotal = cjkSample + otherSample;
        const cjkRatio = sampleTotal > 0 ? cjkSample / sampleTotal : 0;
        const estimatedCjk = Math.round(len * cjkRatio);
        const estimatedOther = len - estimatedCjk;
        return Math.ceil(estimatedCjk / TokenEstimator.CHARS_PER_CJK_TOKEN + estimatedOther / TokenEstimator.CHARS_PER_EN_TOKEN);
    }
    static estimateMessagesTokens(messages) {
        let total = 0;
        for (const msg of messages) {
            total += 4;
            if (msg.content) {
                total += TokenEstimator.estimateTextTokens(msg.content);
            }
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    total += 4;
                    if (tc.function?.name) {
                        total += TokenEstimator.estimateTextTokens(tc.function.name);
                    }
                    if (tc.function?.arguments) {
                        total += TokenEstimator.estimateTextTokens(tc.function.arguments);
                    }
                }
            }
            if (msg.name) {
                total += TokenEstimator.estimateTextTokens(msg.name);
            }
        }
        return Math.ceil(total);
    }
}
exports.TokenEstimator = TokenEstimator;
