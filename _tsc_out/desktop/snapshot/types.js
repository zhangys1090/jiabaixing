"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotStatus = exports.SnapshotTriggerType = void 0;
var SnapshotTriggerType;
(function (SnapshotTriggerType) {
    SnapshotTriggerType["MANUAL"] = "manual";
    SnapshotTriggerType["SCHEDULED"] = "scheduled";
    SnapshotTriggerType["PRE_ACTION"] = "pre_action";
    SnapshotTriggerType["POST_ACTION"] = "post_action";
    SnapshotTriggerType["AUTO_CHECKPOINT"] = "auto_checkpoint";
})(SnapshotTriggerType || (exports.SnapshotTriggerType = SnapshotTriggerType = {}));
var SnapshotStatus;
(function (SnapshotStatus) {
    SnapshotStatus["ACTIVE"] = "active";
    SnapshotStatus["RESTORED"] = "restored";
    SnapshotStatus["EXPIRED"] = "expired";
    SnapshotStatus["CORRUPTED"] = "corrupted";
})(SnapshotStatus || (exports.SnapshotStatus = SnapshotStatus = {}));
