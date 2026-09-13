"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReplanProposerResolver = getReplanProposerResolver;
exports.resetReplanProposerResolver = resetReplanProposerResolver;
const Logger_1 = require("../utils/Logger");
class ReplanProposerResolverImpl {
    registry = new Map();
    initialRegistry = new Map();
    recoveryRegistry = new Map();
    register(domain, proposers) {
        this.registry.set(domain, proposers);
        Logger_1.Logger.info(`ReplanProposerResolver: registered ${proposers.map((p) => p.proposerId).join(', ')} for domain "${domain}"`, 'ReplanProposerResolver');
    }
    registerInitial(domain, proposers) {
        this.initialRegistry.set(domain, proposers);
        Logger_1.Logger.info(`ReplanProposerResolver: registered INITIAL proposers ${proposers.map((p) => p.proposerId).join(', ')} for domain "${domain}"`, 'ReplanProposerResolver');
    }
    registerRecovery(domain, proposers) {
        this.recoveryRegistry.set(domain, proposers);
        Logger_1.Logger.info(`ReplanProposerResolver: registered RECOVERY proposers ${proposers.map((p) => p.proposerId).join(', ')} for domain "${domain}"`, 'ReplanProposerResolver');
    }
    resolve(domain, phase) {
        if (phase === 'initial') {
            const proposers = this.initialRegistry.get(domain);
            if (!proposers || proposers.length === 0) {
                Logger_1.Logger.warn(`ReplanProposerResolver: no initial proposers for domain "${domain}" - falling back to legacy registry`, 'ReplanProposerResolver');
                return this.registry.get(domain) || [];
            }
            return proposers;
        }
        if (phase === 'recovery') {
            const proposers = this.recoveryRegistry.get(domain);
            if (!proposers || proposers.length === 0) {
                Logger_1.Logger.warn(`ReplanProposerResolver: no recovery proposers for domain "${domain}" - falling back to legacy registry`, 'ReplanProposerResolver');
                return this.registry.get(domain) || [];
            }
            return proposers;
        }
        const proposers = this.registry.get(domain);
        if (!proposers || proposers.length === 0) {
            Logger_1.Logger.warn(`ReplanProposerResolver: no proposers registered for domain "${domain}" - cannot generate candidates`, 'ReplanProposerResolver');
            return [];
        }
        return proposers;
    }
}
let instance = null;
function getReplanProposerResolver() {
    if (!instance) {
        instance = new ReplanProposerResolverImpl();
    }
    return instance;
}
function resetReplanProposerResolver() {
    instance = null;
}
